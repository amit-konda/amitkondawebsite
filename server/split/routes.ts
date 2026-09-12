import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  splitBills,
  splitItemAllocations,
  splitItems,
  splitParticipants,
  splitPayments,
  splitReceiptFiles,
  splitSessions,
  splitUsers
} from "../db/schema.js";
import { ApiError, badRequest, conflict, forbidden, notFound, rateLimited } from "../errors.js";
import { checkRateLimit, clientKey } from "../rate-limit.js";
import type { Ctx, Handler, Router } from "../router.js";
import { allocateLargestRemainder, allocateReceiptTotals } from "./allocation.js";
import { optionalSplitUser, requireSplitUser, createSplitSession, revokeSplitSession, setSplitSessionCookie, googleConfigured, googleStartUrl, verifyGoogleState, googleCallback } from "./auth.js";
import { splitAudit } from "./audit.js";
import { clearSessionCookie, hashInviteToken, makeInviteToken, verifyInviteToken, SPLIT_INVITE_TTL_SECONDS, readCookie } from "./tokens.js";
import { decryptPhone, encryptPhone, normalizePhone, phoneHash } from "./phone.js";
import { checkPhoneVerification, startPhoneVerification } from "./sms.js";
import { extractReceipt } from "./ocr.js";
import { enqueueSms, processSmsOutbox } from "./outbox.js";
import { splitEnv } from "./env.js";

const SPLIT_AUTH_IP = { scope: "split_auth_ip", limit: 12, windowMs: 15 * 60_000, failClosed: true } as const;
const SPLIT_AUTH_PHONE = { scope: "split_auth_phone", limit: 6, windowMs: 15 * 60_000, failClosed: true } as const;

const uuid = z.string().uuid();
const cents = z.number().int().min(0).max(100_000_000);
const StartAuthSchema = z.object({ phone: z.string().min(7).max(40) });
const VerifyAuthSchema = StartAuthSchema.extend({ code: z.string().min(4).max(10), displayName: z.string().trim().min(1).max(80).optional() });
const LinkPhoneSchema = z.object({ phone: z.string().min(7).max(40) });
const LinkPhoneVerifySchema = LinkPhoneSchema.extend({ code: z.string().min(4).max(10) });
const BillSchema = z.object({
  requestKey: z.string().min(8).max(128),
  merchantName: z.string().trim().max(160).nullable().optional(),
  purchasedAt: z.coerce.date().nullable().optional(),
  subtotalCents: cents.default(0), taxCents: cents.default(0), tipCents: cents.default(0),
  feeCents: cents.default(0), discountCents: cents.default(0), totalCents: cents.default(0)
});
// Keep patch fields truly optional. Calling partial() on a schema containing
// defaults preserves those defaults, which would silently zero every omitted
// money field during a merchant/date-only edit.
const BillPatchSchema = z.object({
  version: z.number().int().positive(),
  merchantName: z.string().trim().max(160).nullable().optional(),
  purchasedAt: z.coerce.date().nullable().optional(),
  subtotalCents: cents.optional(),
  taxCents: cents.optional(),
  tipCents: cents.optional(),
  feeCents: cents.optional(),
  discountCents: cents.optional(),
  totalCents: cents.optional()
});
const ItemSchema = z.object({ description: z.string().trim().min(1).max(300), quantity: z.number().int().positive().max(1000), unitPriceCents: cents, lineTotalCents: cents, displayOrder: z.number().int().nonnegative() });
const ParticipantSchema = z.object({ displayName: z.string().trim().min(1).max(80), phone: z.string().min(7).max(40) });
const ClaimSchema = z.object({ allocations: z.array(z.object({
  itemId: uuid,
  kind: z.enum(["quantity", "equal_share", "manual"]),
  quantity: z.number().int().positive().optional(),
  shareUnits: z.number().int().positive().optional(),
  amountCents: cents.optional()
})).max(250) });

function route(router: Router, method: "get" | "post" | "patch" | "delete", path: string, handler: Handler): void {
  router[method](path, handler);
  router[method](`/api/split${path}`, handler);
}

export function registerSplitRoutes(router: Router): void {
  route(router, "post", "/auth/start", startAuth);
  route(router, "post", "/auth/verify", verifyAuth);
  route(router, "post", "/auth/logout", logout);
  route(router, "get", "/auth/status", authStatus);
  route(router, "post", "/auth/phone/link/start", linkPhoneStart);
  route(router, "post", "/auth/phone/link/verify", linkPhoneVerify);
  route(router, "get", "/auth/google", googleAuth);
  route(router, "get", "/auth/google/callback", googleAuthCallback);
  route(router, "get", "/dashboard", dashboard);
  route(router, "get", "/contacts", contacts);
  route(router, "post", "/bills", createBill);
  route(router, "get", "/bills/:billId", getBill);
  route(router, "patch", "/bills/:billId", patchBill);
  route(router, "post", "/bills/:billId/items", createItem);
  route(router, "patch", "/items/:itemId", patchItem);
  route(router, "delete", "/items/:itemId", deleteItem);
  route(router, "post", "/bills/:billId/participants", addParticipant);
  route(router, "post", "/bills/:billId/publish", publishBill);
  route(router, "get", "/invites/:token", getInvite);
  route(router, "post", "/invites/:token/accept", acceptInvite);
  route(router, "post", "/participants/:participantId/allocations", updateAllocations);
  route(router, "post", "/participants/:participantId/selection/complete", completeSelection);
  route(router, "post", "/bills/:billId/lock", lockBill);
  route(router, "post", "/participants/:participantId/report-paid", reportPaid);
  route(router, "post", "/participants/:participantId/payment-status", setPaymentStatus);
}

async function startAuth(ctx: Ctx) {
  const { phone } = StartAuthSchema.parse(ctx.body);
  const normalized = normalizePhone(phone);
  const [perIp, perPhone] = await Promise.all([
    checkRateLimit(db, SPLIT_AUTH_IP, clientKey(ctx.req)),
    checkRateLimit(db, SPLIT_AUTH_PHONE, phoneHash(normalized).slice(0, 32))
  ]);
  if (!perIp.ok || !perPhone.ok) throw rateLimited(Math.max(perIp.ok ? 0 : perIp.retryAfterSec, perPhone.ok ? 0 : perPhone.retryAfterSec));
  await startPhoneVerification(normalized);
  return { ok: true };
}

async function verifyAuth(ctx: Ctx) {
  const input = VerifyAuthSchema.parse(ctx.body);
  const phone = normalizePhone(input.phone);
  const limited = await checkRateLimit(db, SPLIT_AUTH_IP, clientKey(ctx.req));
  if (!limited.ok) throw rateLimited(limited.retryAfterSec);
  if (!await checkPhoneVerification(phone, input.code)) throw new ApiError(401, "invalid_code", "Invalid or expired verification code.");
  const lookup = phoneHash(phone);
  let [user] = await db.select().from(splitUsers).where(eq(splitUsers.phoneLookupHash, lookup)).limit(1);
  if (!user) {
    if (!input.displayName) throw badRequest("display_name_required", "Enter your name to create an account.");
    [user] = await db.insert(splitUsers).values({
      displayName: input.displayName, phoneEncrypted: encryptPhone(phone), phoneLookupHash: lookup, smsConsentAt: new Date()
    }).returning();
  }
  if (!user || user.status !== "active") throw new ApiError(403, "account_disabled", "This account is unavailable.");
  const token = await createSplitSession(user.id);
  setSplitSessionCookie(ctx, token);
  return { user: { id: user.id, displayName: user.displayName, hasPhone: true } };
}

async function linkPhoneStart(ctx: Ctx) {
  const user = await requireSplitUser(ctx);
  const { phone } = LinkPhoneSchema.parse(ctx.body);
  const normalized = normalizePhone(phone);
  const limited = await checkRateLimit(db, SPLIT_AUTH_PHONE, phoneHash(normalized).slice(0, 32));
  if (!limited.ok) throw rateLimited(limited.retryAfterSec);
  const [existing] = await db.select({ id: splitUsers.id }).from(splitUsers).where(eq(splitUsers.phoneLookupHash, phoneHash(normalized))).limit(1);
  if (existing && existing.id !== user.id) throw conflict("That phone number is already linked to another account.");
  await startPhoneVerification(normalized);
  return { ok: true };
}

async function linkPhoneVerify(ctx: Ctx) {
  const user = await requireSplitUser(ctx);
  const { phone, code } = LinkPhoneVerifySchema.parse(ctx.body);
  const normalized = normalizePhone(phone); const lookup = phoneHash(normalized);
  if (!await checkPhoneVerification(normalized, code)) throw new ApiError(401, "invalid_code", "Invalid or expired verification code.");
  const [existing] = await db.select({ id: splitUsers.id }).from(splitUsers).where(eq(splitUsers.phoneLookupHash, lookup)).limit(1);
  if (existing && existing.id !== user.id) throw conflict("That phone number is already linked to another account.");
  await db.update(splitUsers).set({ phoneEncrypted: encryptPhone(normalized), phoneLookupHash: lookup, smsConsentAt: new Date() }).where(eq(splitUsers.id, user.id));
  return { ok: true, hasPhone: true };
}

async function logout(ctx: Ctx) {
  await revokeSplitSession(ctx);
  ctx.res.setHeader("Set-Cookie", clearSessionCookie());
  return { ok: true };
}

async function authStatus(ctx: Ctx) { return { user: await optionalSplitUser(ctx) }; }

function requestOrigin(ctx: Ctx): string {
  // OAuth redirect URIs must be derived from our configured first-party origin,
  // never from an arbitrary Host/X-Forwarded-Host header supplied by a client.
  // This prevents redirect URI injection and keeps Google callbacks consistent
  // across the production apex/www aliases and preview deployments.
  return splitEnv().PUBLIC_APP_ORIGIN.replace(/\/$/, "");
}
async function googleAuth(ctx: Ctx) {
  if (!googleConfigured()) throw new ApiError(503, "google_not_configured", "Google sign-in is not configured yet.");
  const location = googleStartUrl(requestOrigin(ctx));
  const state = new URL(location).searchParams.get("state");
  ctx.res.setHeader("Set-Cookie", `split_oauth_state=${encodeURIComponent(state || "")}; Path=/api/split/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  ctx.res.statusCode = 302; ctx.res.setHeader("Location", location); ctx.res.end();
  return null;
}
async function googleAuthCallback(ctx: Ctx) {
  const code = ctx.query.get("code"); const state = ctx.query.get("state"); const origin = requestOrigin(ctx);
  const expected = readCookie(ctx.req.headers.cookie, "split_oauth_state");
  if (!code || !state || !verifyGoogleState(state, origin, expected || undefined)) throw new ApiError(400, "invalid_oauth_state", "That sign-in link has expired. Please try again.");
  const token = await googleCallback(code, origin); setSplitSessionCookie(ctx, token);
  ctx.res.statusCode = 302; ctx.res.setHeader("Location", `${origin}/split#/dashboard`); ctx.res.end(); return null;
}

async function dashboard(ctx: Ctx) {
  const user = await requireSplitUser(ctx);
  const organized = await db.select().from(splitBills).where(eq(splitBills.organizerUserId, user.id)).orderBy(desc(splitBills.createdAt)).limit(100);
  const participantCounts = organized.length ? await db.select({ billId: splitParticipants.billId, count: count() })
    .from(splitParticipants).where(inArray(splitParticipants.billId, organized.map((bill) => bill.id)))
    .groupBy(splitParticipants.billId) : [];
  const countByBill = new Map(participantCounts.map((row) => [row.billId, Number(row.count)]));
  const participantRows = await db.select({ participant: splitParticipants, bill: splitBills })
    .from(splitParticipants).innerJoin(splitBills, eq(splitParticipants.billId, splitBills.id))
    .where(eq(splitParticipants.userId, user.id)).orderBy(desc(splitBills.createdAt)).limit(100);
  const receivables = organized.length ? await db.select({ participant: splitParticipants }).from(splitParticipants)
    .where(and(inArray(splitParticipants.billId, organized.map((bill) => bill.id)), inArray(splitParticipants.paymentStatus, ["unpaid", "rejected", "reported_paid"]))) : [];
  return {
    organized: organized.map((bill) => ({ ...bill, participantCount: countByBill.get(bill.id) ?? 0 })),
    participating: participantRows,
    summary: {
      youOweCents: participantRows.filter((r) => ["unpaid", "rejected"].includes(r.participant.paymentStatus)).reduce((s, r) => s + r.participant.finalAmountCents, 0),
      owedToYouCents: receivables.filter((r) => ["unpaid", "rejected"].includes(r.participant.paymentStatus)).reduce((s, r) => s + r.participant.finalAmountCents, 0),
      reportedPaidCents: receivables.filter((r) => r.participant.paymentStatus === "reported_paid").reduce((s, r) => s + r.participant.finalAmountCents, 0)
      ,outstandingCount: participantRows.filter((r) => ["unpaid", "rejected"].includes(r.participant.paymentStatus)).length + receivables.length
    }
  };
}

/** Return the organizer's previously invited diners for quick, private lookup. */
async function contacts(ctx: Ctx) {
  const user = await requireSplitUser(ctx);
  const query = (ctx.query.get("q") || "").trim().slice(0, 80);
  const rows = await db.select({
    displayName: splitParticipants.displayName,
    phoneEncrypted: splitParticipants.invitedPhoneEncrypted,
    phoneHash: splitParticipants.invitedPhoneLookupHash
  }).from(splitParticipants).where(and(
    eq(splitParticipants.invitedByUserId, user.id),
    query ? ilike(splitParticipants.displayName, `%${query.replace(/[%_]/g, "\\$&")}%`) : undefined
  )).orderBy(desc(splitParticipants.createdAt)).limit(30);
  const seen = new Set<string>();
  const results = [] as Array<{ name: string; phone: string }>;
  for (const row of rows) {
    if (seen.has(row.phoneHash)) continue;
    try { results.push({ name: row.displayName, phone: decryptPhone(row.phoneEncrypted) }); seen.add(row.phoneHash); } catch (_) { /* ignore malformed legacy contact */ }
  }
  return { contacts: results };
}

async function createBill(ctx: Ctx) {
  const user = await requireSplitUser(ctx);
  const [account] = await db.select().from(splitUsers).where(eq(splitUsers.id, user.id)).limit(1);
  // Check this before inserting the draft so a Google-only account does not
  // leave an unusable orphaned bill when SMS identity is required.
  if (!account || !account.phoneEncrypted || !account.phoneLookupHash) {
    throw badRequest("phone_required", "Add a phone number before creating a split so guests can receive texts.");
  }
  const input = BillSchema.parse(ctx.body);
  assertReceiptMath(input);
  const [bill] = await db.insert(splitBills).values({
    organizerUserId: user.id, payerUserId: user.id, requestKey: input.requestKey,
    merchantName: input.merchantName, purchasedAt: input.purchasedAt,
    subtotalCents: input.subtotalCents, taxCents: input.taxCents, tipCents: input.tipCents,
    feeCents: input.feeCents, discountCents: input.discountCents, totalCents: input.totalCents,
    status: "review"
  }).onConflictDoNothing().returning();
  if (bill) {
    const participantId = randomUUID();
    const inviteToken = makeInviteToken(participantId);
    await db.insert(splitParticipants).values({
      id: participantId, billId: bill.id, userId: user.id, invitedByUserId: user.id,
      displayName: user.displayName, invitedPhoneEncrypted: account.phoneEncrypted,
      invitedPhoneLookupHash: account.phoneLookupHash, inviteTokenHash: hashInviteToken(inviteToken),
      invitationStatus: "accepted"
    });
    return { bill };
  }
  const [existing] = await db.select().from(splitBills).where(eq(splitBills.requestKey, input.requestKey)).limit(1);
  if (existing && existing.organizerUserId !== user.id) throw conflict("Request key is already in use.");
  return { bill: existing };
}

async function getBill(ctx: Ctx) {
  const user = await requireSplitUser(ctx);
  const bill = await accessibleBill(ctx.params.billId!, user.id);
  const [items, participants, allocations, latestReceipt] = await Promise.all([
    db.select().from(splitItems).where(eq(splitItems.billId, bill.id)).orderBy(asc(splitItems.displayOrder)),
    db.select().from(splitParticipants).where(eq(splitParticipants.billId, bill.id)).orderBy(asc(splitParticipants.createdAt)),
    db.select({ allocation: splitItemAllocations }).from(splitItemAllocations).innerJoin(splitItems, eq(splitItemAllocations.itemId, splitItems.id)).where(eq(splitItems.billId, bill.id)),
    db.select({ ocrRawJson: splitReceiptFiles.ocrRawJson }).from(splitReceiptFiles)
      .where(and(eq(splitReceiptFiles.billId, bill.id), eq(splitReceiptFiles.status, "ready")))
      .orderBy(desc(splitReceiptFiles.createdAt)).limit(1)
  ]);
  const raw = latestReceipt[0]?.ocrRawJson;
  const warnings = raw && typeof raw === "object" && !Array.isArray(raw) && "warnings" in raw && Array.isArray(raw.warnings)
    ? raw.warnings.filter((warning): warning is string => typeof warning === "string").slice(0, 20)
    : [];
  return { bill: { ...bill, warnings }, items, participants: participants.map(publicParticipant), allocations: allocations.map((r) => r.allocation) };
}

async function patchBill(ctx: Ctx) {
  const user = await requireSplitUser(ctx);
  const before = await organizerBill(ctx.params.billId!, user.id);
  if (!["review", "open"].includes(before.status)) throw conflict("This bill can no longer be edited.");
  const input = BillPatchSchema.parse(ctx.body);
  const next = { ...before, ...input };
  assertReceiptMath(next);
  const [bill] = await db.update(splitBills).set({ ...input, version: before.version + 1 })
    .where(and(eq(splitBills.id, before.id), eq(splitBills.version, input.version))).returning();
  if (!bill) throw conflict("The bill changed. Refresh and try again.");
  await splitAudit(db, { actorUserId: user.id, actorLabel: user.displayName, action: "bill.updated", entityType: "split_bill", entityId: bill.id, before, after: bill });
  return { bill };
}

async function scanReceipt(ctx: Ctx) {
  const user = await requireSplitUser(ctx);
  const bill = await organizerBill(ctx.params.billId!, user.id);
  if (bill.status !== "review") throw conflict("Receipt scanning is only available during review.");
  const input = z.object({ imageUrl: z.string().url(), blobPathname: z.string().min(1).max(1000), mimeType: z.string().regex(/^image\//), sizeBytes: z.number().int().positive().max(20 * 1024 * 1024), checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i) }).parse(ctx.body);
  const [receipt] = await db.insert(splitReceiptFiles).values({ billId: bill.id, blobPathname: input.blobPathname, mimeType: input.mimeType, sizeBytes: input.sizeBytes, checksumSha256: input.checksumSha256, status: "processing", retentionExpiresAt: new Date(Date.now() + 90 * 86400_000) }).returning();
  if (!receipt) throw new Error("receipt_insert_failed");
  try {
    const extraction = await extractReceipt(input.imageUrl);
    await db.transaction(async (tx) => {
      await tx.delete(splitItems).where(eq(splitItems.billId, bill.id));
      if (extraction.items.length) await tx.insert(splitItems).values(extraction.items.map((item, index) => ({
        billId: bill.id, description: item.description, quantity: item.quantity,
        unitPriceCents: item.unitPriceCents ?? Math.floor(item.lineTotalCents / item.quantity), lineTotalCents: item.lineTotalCents,
        displayOrder: index, ocrConfidenceBasisPoints: Math.round(item.confidence * 10_000)
      })));
      await tx.update(splitBills).set({
        merchantName: extraction.merchant, purchasedAt: extraction.purchasedAt ? new Date(extraction.purchasedAt) : null,
        currency: extraction.currency, subtotalCents: extraction.subtotalCents, taxCents: extraction.taxCents,
        tipCents: extraction.tipCents, feeCents: extraction.feesCents, discountCents: extraction.discountCents,
        totalCents: extraction.totalCents, version: bill.version + 1
      }).where(eq(splitBills.id, bill.id));
      await tx.update(splitReceiptFiles).set({ status: "ready", ocrProvider: "openai", ocrRawJson: extraction }).where(eq(splitReceiptFiles.id, receipt.id));
    });
    return { receiptId: receipt.id, extraction };
  } catch (error) {
    await db.update(splitReceiptFiles).set({ status: "failed", ocrErrorCode: "ocr_failed" }).where(eq(splitReceiptFiles.id, receipt.id));
    throw error;
  }
}

async function createItem(ctx: Ctx) {
  const user = await requireSplitUser(ctx); const bill = await organizerBill(ctx.params.billId!, user.id);
  if (bill.status !== "review") throw conflict("Items can only be edited during review.");
  const input = ItemSchema.parse(ctx.body);
  const [item] = await db.insert(splitItems).values({ ...input, billId: bill.id, organizerCorrected: true }).returning();
  return { item };
}

async function patchItem(ctx: Ctx) {
  const user = await requireSplitUser(ctx); const item = await ownedItem(ctx.params.itemId!, user.id);
  const input = ItemSchema.partial().parse(ctx.body);
  const [updated] = await db.update(splitItems).set({ ...input, organizerCorrected: true }).where(eq(splitItems.id, item.id)).returning();
  return { item: updated };
}

async function deleteItem(ctx: Ctx) {
  const user = await requireSplitUser(ctx); const item = await ownedItem(ctx.params.itemId!, user.id);
  await db.delete(splitItems).where(eq(splitItems.id, item.id)); return { ok: true };
}

async function addParticipant(ctx: Ctx) {
  const user = await requireSplitUser(ctx); const bill = await organizerBill(ctx.params.billId!, user.id);
  if (!["review", "open"].includes(bill.status)) throw conflict("Participants can no longer be added.");
  const input = ParticipantSchema.parse(ctx.body); const phone = normalizePhone(input.phone); const id = randomUUID();
  const phoneLookupHash = phoneHash(phone);
  const [existingParticipant] = await db.select({ id: splitParticipants.id }).from(splitParticipants).where(and(
    eq(splitParticipants.billId, bill.id),
    eq(splitParticipants.invitedPhoneLookupHash, phoneLookupHash)
  )).limit(1);
  if (existingParticipant) throw conflict("That person is already on this split.");
  const [existingUser] = await db.select({ id: splitUsers.id }).from(splitUsers).where(eq(splitUsers.phoneLookupHash, phoneLookupHash)).limit(1);
  const token = makeInviteToken(id);
  const [participant] = await db.insert(splitParticipants).values({
    id, billId: bill.id, userId: existingUser?.id ?? null, invitedByUserId: user.id,
    displayName: input.displayName, invitedPhoneEncrypted: encryptPhone(phone), invitedPhoneLookupHash: phoneLookupHash, inviteTokenHash: hashInviteToken(token)
  }).returning();
  return { participant: publicParticipant(participant!), inviteToken: token };
}

async function publishBill(ctx: Ctx) {
  const user = await requireSplitUser(ctx); const bill = await organizerBill(ctx.params.billId!, user.id);
  if (bill.status !== "review") throw conflict("This bill has already been published.");
  const participants = await db.select().from(splitParticipants).where(eq(splitParticipants.billId, bill.id));
  if (!participants.length) throw badRequest("missing_participants", "Add at least one diner.");
  await db.transaction(async (tx) => {
    await tx.update(splitBills).set({ status: "open", version: bill.version + 1 }).where(eq(splitBills.id, bill.id));
    for (const p of participants.filter((row) => row.userId !== bill.organizerUserId)) await enqueueSms(tx, {
      eventType: "invitation", billId: bill.id, participantId: p.id,
      phoneEncrypted: p.invitedPhoneEncrypted, phoneHash: p.invitedPhoneLookupHash,
      billVersion: bill.version + 1, idempotencyKey: `invitation:${p.id}:${bill.version + 1}`
    });
    await tx.update(splitParticipants).set({ invitationStatus: "queued" }).where(and(eq(splitParticipants.billId, bill.id), eq(splitParticipants.invitationStatus, "pending")));
  });
  const delivery = await processSmsOutbox(db, 50);
  return { ok: true, delivery };
}

async function getInvite(ctx: Ctx) {
  const participantId = verifyInviteToken(ctx.params.token!); if (!participantId) throw notFound();
  const [row] = await db.select({ participant: splitParticipants, bill: splitBills }).from(splitParticipants)
    .innerJoin(splitBills, eq(splitParticipants.billId, splitBills.id)).where(and(eq(splitParticipants.id, participantId), eq(splitParticipants.inviteTokenHash, hashInviteToken(ctx.params.token!)), gt(splitParticipants.createdAt, new Date(Date.now() - SPLIT_INVITE_TTL_SECONDS * 1000)))).limit(1);
  if (!row) throw notFound();
  const items = await db.select().from(splitItems).where(eq(splitItems.billId, row.bill.id)).orderBy(asc(splitItems.displayOrder));
  return { participant: publicParticipant(row.participant), bill: { id: row.bill.id, merchantName: row.bill.merchantName, purchasedAt: row.bill.purchasedAt, status: row.bill.status }, items };
}

async function acceptInvite(ctx: Ctx) {
  const user = await requireSplitUser(ctx); const participantId = verifyInviteToken(ctx.params.token!); if (!participantId) throw notFound();
  const [account] = await db.select({ phoneHash: splitUsers.phoneLookupHash }).from(splitUsers).where(eq(splitUsers.id, user.id)).limit(1);
  if (!account?.phoneHash) throw badRequest("phone_required", "Add a phone number before accepting an SMS invite.");
  const [participant] = await db.update(splitParticipants).set({ userId: user.id, invitationStatus: "accepted" })
    .where(and(eq(splitParticipants.id, participantId), eq(splitParticipants.inviteTokenHash, hashInviteToken(ctx.params.token!)), eq(splitParticipants.invitedPhoneLookupHash, account.phoneHash), gt(splitParticipants.createdAt, new Date(Date.now() - SPLIT_INVITE_TTL_SECONDS * 1000)), or(isNull(splitParticipants.userId), eq(splitParticipants.userId, user.id)))).returning();
  if (!participant) throw forbidden(); return { participant: publicParticipant(participant) };
}

async function updateAllocations(ctx: Ctx) {
  const user = await requireSplitUser(ctx); const participant = await selectableParticipant(ctx.params.participantId!, user.id, "selection");
  const input = ClaimSchema.parse(ctx.body);
  const ids = input.allocations.map((a) => a.itemId);
  const items = ids.length ? await db.select().from(splitItems).where(and(eq(splitItems.billId, participant.billId), inArray(splitItems.id, ids))) : [];
  if (items.length !== new Set(ids).size) throw badRequest("invalid_item", "One or more items are not on this bill.");
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const values = input.allocations.map((a) => {
    const item = itemMap.get(a.itemId)!;
    if (a.kind === "quantity" && (!a.quantity || a.quantity > item.quantity)) throw badRequest("invalid_quantity", "Claimed quantity is invalid.");
    if (a.kind === "equal_share" && !a.shareUnits) throw badRequest("invalid_share", "Share units are required.");
    if (a.kind === "manual" && a.amountCents === undefined) throw badRequest("invalid_amount", "Manual allocation amount is required.");
    return { itemId: a.itemId, participantId: participant.id, kind: a.kind, quantity: a.kind === "quantity" ? a.quantity! : null, shareUnits: a.kind === "equal_share" ? a.shareUnits! : null, amountCents: a.kind === "manual" ? a.amountCents! : 0 };
  });
  await db.transaction(async (tx) => {
    await tx.delete(splitItemAllocations).where(eq(splitItemAllocations.participantId, participant.id));
    if (values.length) await tx.insert(splitItemAllocations).values(values);
    await tx.update(splitParticipants).set({ selectionStatus: "selecting" }).where(eq(splitParticipants.id, participant.id));
  });
  return { ok: true };
}

async function completeSelection(ctx: Ctx) {
  const user = await requireSplitUser(ctx); const participant = await selectableParticipant(ctx.params.participantId!, user.id, "selection");
  await db.update(splitParticipants).set({ selectionStatus: "complete", selectionCompletedAt: new Date() }).where(eq(splitParticipants.id, participant.id));
  return { ok: true };
}

async function lockBill(ctx: Ctx) {
  const user = await requireSplitUser(ctx); const bill = await organizerBill(ctx.params.billId!, user.id);
  if (bill.status !== "open") throw conflict("Only an open bill can be locked.");
  const participants = await db.select().from(splitParticipants).where(eq(splitParticipants.billId, bill.id));
  if (!participants.length || participants.some((p) => p.selectionStatus !== "complete")) throw conflict("Everyone must finish selecting items first.");
  const items = await db.select().from(splitItems).where(eq(splitItems.billId, bill.id));
  const allocations = await db.select({ allocation: splitItemAllocations, item: splitItems }).from(splitItemAllocations)
    .innerJoin(splitItems, eq(splitItemAllocations.itemId, splitItems.id)).where(eq(splitItems.billId, bill.id));
  const computed = new Map<string, number>();
  const allocationAmounts = new Map<string, number>();
  for (const item of items) {
    const rows = allocations.filter((r) => r.item.id === item.id).map((r) => r.allocation);
    if (!rows.length) throw conflict(`Item \"${item.description}\" is unclaimed.`);
    const manual = rows.filter((r) => r.kind === "manual");
    const quantity = rows.filter((r) => r.kind === "quantity");
    const equal = rows.filter((r) => r.kind === "equal_share");
    if ([manual.length > 0, quantity.length > 0, equal.length > 0].filter(Boolean).length !== 1) throw conflict(`Item \"${item.description}\" mixes allocation types.`);
    let amounts: Map<string, number>;
    if (manual.length) {
      if (manual.reduce((s, r) => s + r.amountCents, 0) !== item.lineTotalCents) throw conflict(`Item \"${item.description}\" is not fully allocated.`);
      amounts = new Map(manual.map((r) => [r.participantId, r.amountCents]));
    } else if (quantity.length) {
      if (quantity.reduce((s, r) => s + (r.quantity ?? 0), 0) !== item.quantity) throw conflict(`Item \"${item.description}\" quantity is not fully claimed.`);
      amounts = allocateLargestRemainder(item.lineTotalCents, quantity.map((r) => ({ participantId: r.participantId, weight: r.quantity! })));
    } else {
      amounts = allocateLargestRemainder(item.lineTotalCents, equal.map((r) => ({ participantId: r.participantId, weight: r.shareUnits! })));
    }
    for (const row of rows) {
      const amount = amounts.get(row.participantId) ?? 0;
      allocationAmounts.set(row.id, amount);
      computed.set(row.participantId, (computed.get(row.participantId) ?? 0) + amount);
    }
  }
  if ([...computed.values()].reduce((s, n) => s + n, 0) !== bill.subtotalCents) throw conflict("Claimed item totals do not match the receipt subtotal.");
  const finals = allocateReceiptTotals(participants.map((p) => ({ participantId: p.id, subtotalCents: computed.get(p.id) ?? 0 })), { taxCents: bill.taxCents, tipCents: bill.tipCents, feesCents: bill.feeCents, discountCents: bill.discountCents });
  if (finals.reduce((s, f) => s + f.totalCents, 0) !== bill.totalCents) throw conflict("Participant totals do not reconcile to the receipt total.");
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const [id, amountCents] of allocationAmounts) await tx.update(splitItemAllocations).set({ amountCents }).where(eq(splitItemAllocations.id, id));
    for (const final of finals) {
      const p = participants.find((row) => row.id === final.participantId)!;
      const isPayer = p.userId === bill.payerUserId;
      await tx.update(splitParticipants).set({
        itemSubtotalCents: final.subtotalCents, taxCents: final.taxCents, tipCents: final.tipCents,
        feeCents: final.feesCents, discountCents: final.discountCents, finalAmountCents: final.totalCents,
        paymentStatus: isPayer || final.totalCents === 0 ? "confirmed" : "unpaid",
        nextReminderAt: isPayer || final.totalCents === 0 ? null : new Date(now.getTime() + 24 * 3600_000)
      }).where(eq(splitParticipants.id, p.id));
      if (!isPayer && final.totalCents > 0) await enqueueSms(tx, { eventType: "final_amount", billId: bill.id, participantId: p.id, phoneEncrypted: p.invitedPhoneEncrypted, phoneHash: p.invitedPhoneLookupHash, billVersion: bill.version + 1, idempotencyKey: `final:${p.id}:${bill.version + 1}` });
    }
    const locked = await tx.update(splitBills).set({ status: "locked", lockedAt: now, version: bill.version + 1 }).where(and(eq(splitBills.id, bill.id), eq(splitBills.version, bill.version), eq(splitBills.status, "open"))).returning({ id: splitBills.id });
    if (!locked.length) throw conflict("The bill changed. Refresh and try again.");
  });
  const delivery = await processSmsOutbox(db, 50);
  return { allocations: finals, delivery };
}

async function reportPaid(ctx: Ctx) {
  const user = await requireSplitUser(ctx); const participant = await selectableParticipant(ctx.params.participantId!, user.id, "payment");
  const input = z.object({ requestKey: z.string().min(8).max(128) }).parse(ctx.body);
  if (!["unpaid", "rejected"].includes(participant.paymentStatus)) {
    // A client may retry after a successful response was lost. Treat the
    // original request key as idempotent, while still rejecting a new key
    // against an already-reported payment.
    const [existing] = await db.select({ participantId: splitPayments.participantId }).from(splitPayments)
      .where(eq(splitPayments.requestKey, input.requestKey)).limit(1);
    if (existing?.participantId === participant.id) return { status: participant.paymentStatus };
    throw conflict("This payment is not outstanding.");
  }
  await db.transaction(async (tx) => {
    const [bill] = await tx.select({ payerUserId: splitBills.payerUserId }).from(splitBills).where(eq(splitBills.id, participant.billId)).limit(1);
    if (!bill) throw notFound();
    const inserted = await tx.insert(splitPayments).values({ billId: participant.billId, participantId: participant.id, payerUserId: bill.payerUserId, amountCents: participant.finalAmountCents, status: "reported_paid", reportSource: "web", requestKey: input.requestKey, reportedAt: new Date() }).onConflictDoNothing().returning({ participantId: splitPayments.participantId });
    if (!inserted.length) {
      const [existing] = await tx.select({ participantId: splitPayments.participantId }).from(splitPayments).where(eq(splitPayments.requestKey, input.requestKey)).limit(1);
      if (existing?.participantId !== participant.id) throw conflict("Request key is already in use.");
    }
    await tx.update(splitParticipants).set({ paymentStatus: "reported_paid", nextReminderAt: null }).where(eq(splitParticipants.id, participant.id));
  });
  return { status: "reported_paid" };
}

async function setPaymentStatus(ctx: Ctx) {
  const user = await requireSplitUser(ctx);
  const [participant] = await db.select().from(splitParticipants).where(eq(splitParticipants.id, ctx.params.participantId!)).limit(1); if (!participant) throw notFound();
  await organizerBill(participant.billId, user.id);
  const input = z.object({ status: z.enum(["confirmed", "rejected", "unpaid"]), snoozedUntil: z.coerce.date().nullable().optional() }).parse(ctx.body);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(splitParticipants).set({ paymentStatus: input.status, remindersSnoozedUntil: input.snoozedUntil, nextReminderAt: input.status === "confirmed" ? null : new Date(now.getTime() + 24 * 3600_000) }).where(eq(splitParticipants.id, participant.id));
    await tx.update(splitPayments).set({ status: input.status, confirmedAt: input.status === "confirmed" ? now : null, rejectedAt: input.status === "rejected" ? now : null }).where(and(eq(splitPayments.participantId, participant.id), eq(splitPayments.status, "reported_paid")));
    if (input.status !== "confirmed") {
      await tx.update(splitBills).set({ status: "locked", settledAt: null }).where(and(eq(splitBills.id, participant.billId), eq(splitBills.status, "settled")));
    }
    if (input.status === "confirmed") {
      const remaining = await tx.select({ id: splitParticipants.id }).from(splitParticipants).where(and(
        eq(splitParticipants.billId, participant.billId),
        inArray(splitParticipants.paymentStatus, ["unpaid", "rejected", "reported_paid"])
      )).limit(1);
      if (!remaining.length) await tx.update(splitBills).set({ status: "settled", settledAt: now }).where(eq(splitBills.id, participant.billId));
    }
  });
  return { status: input.status };
}

async function organizerBill(id: string, userId: string) {
  const [bill] = await db.select().from(splitBills).where(and(eq(splitBills.id, id), eq(splitBills.organizerUserId, userId))).limit(1);
  if (!bill) throw notFound(); return bill;
}

async function accessibleBill(id: string, userId: string) {
  const [bill] = await db.select().from(splitBills).where(eq(splitBills.id, id)).limit(1); if (!bill) throw notFound();
  if (bill.organizerUserId !== userId) {
    const [p] = await db.select({ id: splitParticipants.id }).from(splitParticipants).where(and(eq(splitParticipants.billId, id), eq(splitParticipants.userId, userId))).limit(1);
    if (!p) throw notFound();
  }
  return bill;
}

async function ownedItem(id: string, userId: string) {
  const [row] = await db.select({ item: splitItems, bill: splitBills }).from(splitItems).innerJoin(splitBills, eq(splitItems.billId, splitBills.id)).where(eq(splitItems.id, id)).limit(1);
  if (!row || row.bill.organizerUserId !== userId || row.bill.status !== "review") throw notFound(); return row.item;
}

async function selectableParticipant(id: string, userId: string, purpose: "selection" | "payment") {
  const [p] = await db.select().from(splitParticipants).where(eq(splitParticipants.id, id)).limit(1); if (!p) throw notFound();
  const [bill] = await db.select().from(splitBills).where(eq(splitBills.id, p.billId)).limit(1); if (!bill) throw notFound();
  if (p.userId !== userId && bill.organizerUserId !== userId) throw forbidden();
  if (purpose === "selection" && bill.status !== "open") throw conflict("Item selection is closed.");
  if (purpose === "payment" && bill.status !== "locked") throw conflict("This bill is not awaiting payment.");
  return p;
}

function publicParticipant(p: typeof splitParticipants.$inferSelect) {
  const { invitedPhoneEncrypted: _phone, invitedPhoneLookupHash: _hash, inviteTokenHash: _token, ...safe } = p;
  return safe;
}

function assertReceiptMath(input: { subtotalCents: number; taxCents: number; tipCents: number; feeCents: number; discountCents: number; totalCents: number }): void {
  if (input.subtotalCents + input.taxCents + input.tipCents + input.feeCents - input.discountCents !== input.totalCents) {
    throw badRequest("total_mismatch", "Receipt amounts do not add up to the total.");
  }
}

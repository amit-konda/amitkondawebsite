/**
 * Outbox sender — claim-based, idempotent, concurrency-safe delivery.
 *
 * Design notes:
 * - Every send is a CLAIM first: an atomic UPDATE takes the row from
 *   queued/failed into `processing` with a fresh claim_id and a lease
 *   timestamp, and bumps `attempts`. Only the claim owner may complete
 *   (`sent`) or release (re-queue / dead-letter) it, because every follow-up
 *   UPDATE is guarded by `WHERE claim_id = <claim>`. A concurrent pump run,
 *   the admin retry route, or a crashed worker therefore cannot double-send.
 * - A crashed claim is reclaimable after 10 minutes (CLAIM_LEASE_MS): a row
 *   stuck in `processing` with an expired lease is claimable again.
 * - Every PRODUCTION send passes `Idempotency-Key: poker-delivery-<id>`
 *   (via the Resend SDK options), so even a timed-out HTTP request that the
 *   provider retries cannot deliver the email twice.
 * - DEV MODE: when RESEND_API_KEY is unset or starts with "re_dev"/"re_test_",
 *   we log the recipient and the receipt link (the ONE documented
 *   token-bearing log line) and mark the delivery "sent" without calling the
 *   provider.
 * - Failures are recorded as safe error codes only ("no_token",
 *   "unsupported_event", "render_error", "provider_error") — never provider
 *   message text, and never email bodies, in logs.
 * - These functions NEVER throw into their callers (notify.ts and the admin
 *   retry route rely on that); failures stay in the outbox for retry.
 */
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL
} from "drizzle-orm";
import { Resend } from "resend";
import { db } from "../db/client.js";
import {
  auditEvents,
  disputeTokens,
  disputes,
  emailDeliveries,
  members,
  pokerSessions,
  sessionResults
} from "../db/schema.js";
import type { EmailDeliveryRow } from "../db/schema.js";
import type { Db } from "./outbox.js";
import { generateToken, hashToken, TOKEN_TTL_DAYS } from "../domain/tokens.js";
import { env } from "../env.js";
import {
  renderDisputeAckEmail,
  renderDisputeDismissedEmail,
  renderDisputeOpenedEmail,
  renderDisputeResolvedEmail,
  renderMemberEmail,
  renderReceiptEmail,
  renderResolutionEmail,
  renderResultsCorrectedEmail,
  renderSessionUpdatedEmail,
  renderSessionVoidedEmail,
  type DisputeNoticeEmailData,
  type ReceiptEmailData,
  type ResultsCorrectedEmailData,
  type RenderedEmail,
  type WithoutTokenReceiptData
} from "./templates.js";

const DEV_KEY_PREFIX = "re_dev";
// Resend test/dummy keys use the "re_test_" prefix (as in tests/setup-env.ts).
const TEST_KEY_PREFIX = "re_test_";
const DAY_MS = 86_400_000;

/** A claimed (`processing`) row becomes reclaimable after this long. */
export const CLAIM_LEASE_MS = 10 * 60 * 1000;
/** Give up after this many failed send attempts (row becomes dead_letter). */
export const MAX_ATTEMPTS = 6;

interface EmailContent {
  subject: string;
  html: string;
  text: string;
  /** Receipt link (token-bearing) — used only by the dev-mode log line. */
  link: string | null;
}

type BuiltContent = { ok: true; content: EmailContent } | { ok: false; errorCode: string };

// ---------------------------------------------------------------------------
// Template contracts (server/email/templates.ts)
// ---------------------------------------------------------------------------

/** Renderer input for the participant-side dispute notices. */
export type DisputeAckEmailData = Omit<DisputeNoticeEmailData, "memberName">;

// ---------------------------------------------------------------------------
// Claim lifecycle
// ---------------------------------------------------------------------------

/**
 * Atomically claim one delivery row for send. Returns the claimed row
 * (status `processing`, fresh claim_id, attempts already bumped) or null when
 * the row is not claimable: already sent/delivered/dead-lettered, held by a
 * live lease, or (unless `ignoreBackoff`) still inside its retry backoff.
 * The 10-minute lease makes crashed claims reclaimable.
 */
export async function claimDelivery(
  dbx: Db,
  deliveryId: string,
  opts: { ignoreBackoff?: boolean } = {}
): Promise<EmailDeliveryRow | null> {
  const claimId = randomUUID();
  const now = new Date();
  const claimable: (SQL | undefined)[] = [
    inArray(emailDeliveries.status, ["queued", "failed", "processing"]),
    or(
      isNull(emailDeliveries.claimedAt),
      lt(emailDeliveries.claimedAt, sql`now() - interval '10 minutes'`)
    )
  ];
  if (!opts.ignoreBackoff) {
    claimable.push(
      or(isNull(emailDeliveries.nextAttemptAt), lte(emailDeliveries.nextAttemptAt, now))
    );
  }
  const rows = await dbx
    .update(emailDeliveries)
    .set({
      status: "processing",
      claimId,
      claimedAt: now,
      attempts: sql`${emailDeliveries.attempts} + 1`,
      lastAttemptAt: now
    })
    .where(and(eq(emailDeliveries.id, deliveryId), ...claimable))
    .returning();
  return rows[0] ?? null;
}

/**
 * Complete a claim: mark the delivery sent with the provider message id.
 * Guarded by claim_id so only the claim owner can complete. Returns false if
 * the claim was lost (another process superseded it).
 */
export async function completeClaim(
  dbx: Db,
  deliveryId: string,
  claimId: string,
  providerId: string | null
): Promise<boolean> {
  const rows = await dbx
    .update(emailDeliveries)
    .set({
      status: "sent",
      sentAt: new Date(),
      providerId,
      errorCode: null,
      claimId: null,
      claimedAt: null
    })
    .where(and(eq(emailDeliveries.id, deliveryId), eq(emailDeliveries.claimId, claimId)))
    .returning({ id: emailDeliveries.id });
  return rows.length > 0;
}

/**
 * Release a failed claim: either re-queue with exponential backoff
 * (30s * 2^attempts, capped at 1h) or dead-letter after MAX_ATTEMPTS, or land
 * in `failed` when retrying can never succeed (terminal error codes). The
 * claim fields are always cleared so the row is claimable again.
 */
export async function releaseClaim(
  dbx: Db,
  deliveryId: string,
  claimId: string,
  errorCode: string,
  opts: { terminal?: boolean } = {}
): Promise<void> {
  await dbx
    .update(emailDeliveries)
    .set({
      status: opts.terminal
        ? "failed"
        : sql`case when ${emailDeliveries.attempts} >= ${MAX_ATTEMPTS} then 'dead_letter'::email_status else 'queued'::email_status end`,
      errorCode,
      nextAttemptAt: opts.terminal
        ? null
        : sql`case when ${emailDeliveries.attempts} >= ${MAX_ATTEMPTS} then null else now() + (least(3600, (2 ^ ${emailDeliveries.attempts}) * 30) * interval '1 second') end`,
      claimId: null,
      claimedAt: null
    })
    .where(and(eq(emailDeliveries.id, deliveryId), eq(emailDeliveries.claimId, claimId)));
}

// ---------------------------------------------------------------------------
// Pump + single-send entry points
// ---------------------------------------------------------------------------

/**
 * Deliver every claimable row for one entity (and optional version), oldest
 * first. Rows are claimed one at a time; the send happens outside any
 * transaction, and the claim is completed/released afterwards. Never throws.
 */
export async function processOutboxFor(
  entityType: string,
  entityId: string,
  version?: number
): Promise<void> {
  try {
    const conditions = [
      eq(emailDeliveries.entityType, entityType),
      eq(emailDeliveries.entityId, entityId),
      // `processing` is included so rows whose lease expired (crashed claim)
      // are picked up again; claimDelivery re-checks eligibility atomically.
      inArray(emailDeliveries.status, ["queued", "failed", "processing"])
    ];
    if (version !== undefined) {
      conditions.push(eq(emailDeliveries.version, version));
    }
    const rows = await db
      .select()
      .from(emailDeliveries)
      .where(and(...conditions))
      .orderBy(asc(emailDeliveries.createdAt), asc(emailDeliveries.id));
    for (const row of rows) {
      const claimed = await claimDelivery(db, row.id);
      if (!claimed) continue; // raced by another worker or inside backoff
      await attemptDelivery(claimed);
    }
  } catch (err) {
    console.error(
      `email outbox query failed for ${entityType}/${entityId} (${errName(err)})`
    );
  }
}

/**
 * Send one delivery by id, ignoring backoff (admin retry). Never throws.
 * Returns the claimed row (null when the claim was lost to a concurrent
 * pump/retry or the row is not claimable).
 */
export async function sendOneDelivery(deliveryId: string): Promise<EmailDeliveryRow | null> {
  try {
    const claimed = await claimDelivery(db, deliveryId, { ignoreBackoff: true });
    if (!claimed) return null;
    await attemptDelivery(claimed); // never throws
    return claimed;
  } catch (err) {
    console.error(`email delivery send failed for ${deliveryId} (${errName(err)})`);
    return null;
  }
}

/**
 * Send a claimed row's email, then complete or release the claim. Never
 * throws.
 */
export async function attemptDelivery(row: EmailDeliveryRow): Promise<void> {
  if (!row.claimId) return; // not claimed — the claim flow drives this row

  const built = await buildContent(row); // never throws
  if (!built.ok) {
    // Terminal build errors (no live token / unsupported event) land in
    // `failed` (admin-retryable); transient ones re-queue with backoff.
    const terminal =
      built.errorCode === "no_token" || built.errorCode === "unsupported_event";
    await releaseClaim(db, row.id, row.claimId, built.errorCode, { terminal });
    return;
  }

  const apiKey = currentApiKey();
  if (!apiKey || isDevKey(apiKey)) {
    // Dev mode — no provider call. The link is the documented exception to
    // the no-token-in-logs rule; it exists so developers can click through.
    const suffix = built.content.link ? ` link=${built.content.link}` : "";
    console.log(`[poker-email-dev] to=${row.recipientEmail}${suffix}`);
    await completeClaim(db, row.id, row.claimId, null);
    return;
  }

  try {
    const providerId = await sendViaProvider(
      {
        from: env().POKER_EMAIL_FROM,
        to: row.recipientEmail,
        subject: built.content.subject,
        html: built.content.html,
        text: built.content.text
      },
      `poker-delivery-${row.id}`
    );
    await completeClaim(db, row.id, row.claimId, providerId);
  } catch (err) {
    console.error(`email provider call failed for ${row.id} (${errName(err)})`);
    await releaseClaim(db, row.id, row.claimId, "provider_error");
  }
}

// ---------------------------------------------------------------------------
// Provider boundary
// ---------------------------------------------------------------------------

export interface ProviderSendInput {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * One production send to Resend. The idempotency key is the delivery id, so
 * a retry of a timed-out request cannot double-send. Throws on failure; the
 * caller converts errors into safe error codes. Exported so tests can stub
 * the provider boundary.
 */
export async function sendViaProvider(
  input: ProviderSendInput,
  idempotencyKey: string
): Promise<string> {
  const apiKey = currentApiKey();
  if (!apiKey) throw new Error("missing_api_key");
  const resend = new Resend(apiKey);
  const response = await resend.emails.send(
    {
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text
    },
    { idempotencyKey }
  );
  if (response.error || !response.data?.id) {
    throw new Error("provider_error");
  }
  return response.data.id;
}

/**
 * Live API key read from process.env (not the env() cache) so tests can flip
 * dev/production mode per case and ops can rotate keys without a restart.
 * An empty/absent key means dev mode, matching env()'s optional field.
 */
function currentApiKey(): string | undefined {
  const key = process.env.RESEND_API_KEY;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

function isDevKey(key: string): boolean {
  return key.startsWith(DEV_KEY_PREFIX) || key.startsWith(TEST_KEY_PREFIX);
}

// ---------------------------------------------------------------------------
// Content building
// ---------------------------------------------------------------------------

async function buildContent(row: EmailDeliveryRow): Promise<BuiltContent> {
  switch (row.eventType) {
    case "session_receipt":
    case "dispute_resolution":
      return buildReceiptContent(row);
    case "member_approved":
    case "member_welcome":
      return buildMemberContent(row);
    case "dispute_opened":
    case "dispute_opened_ack":
    case "dispute_resolved":
    case "dispute_dismissed":
      return buildDisputeNoticeContent(row);
    case "session_updated":
    case "session_voided":
      return buildSessionNoticeContent(row);
    case "results_corrected":
      return buildResultsCorrectedContent(row);
    default:
      return { ok: false, errorCode: "unsupported_event" };
  }
}

interface SessionResultsContext {
  session: typeof pokerSessions.$inferSelect;
  results: Array<{ name: string; amountCents: number; isRecipient: boolean }>;
  totalCents: number;
  recipientName: string | null;
  recordedByName: string | null;
}

/** Session row + ordered results + recipient/recorder names (shared loader). */
async function loadSessionWithResults(
  entityId: string,
  recipientMemberId: string
): Promise<SessionResultsContext | null> {
  const [session] = await db
    .select()
    .from(pokerSessions)
    .where(eq(pokerSessions.id, entityId))
    .limit(1);
  if (!session) return null;
  const resultRows = await db
    .select({
      memberId: sessionResults.memberId,
      name: members.displayName,
      amountCents: sessionResults.amountCents
    })
    .from(sessionResults)
    .innerJoin(members, eq(members.id, sessionResults.memberId))
    .where(eq(sessionResults.sessionId, entityId))
    .orderBy(desc(sessionResults.amountCents));
  const [recipient] = await db
    .select({ name: members.displayName })
    .from(members)
    .where(eq(members.id, recipientMemberId))
    .limit(1);
  const [recorder] = session.recordedByMemberId
    ? await db
        .select({ name: members.displayName })
        .from(members)
        .where(eq(members.id, session.recordedByMemberId))
        .limit(1)
    : [null];
  return {
    session,
    results: resultRows.map((r) => ({
      name: r.name,
      amountCents: r.amountCents,
      isRecipient: r.memberId === recipientMemberId
    })),
    totalCents: resultRows.reduce((sum, r) => sum + r.amountCents, 0),
    recipientName: recipient?.name ?? null,
    recordedByName: recorder?.name ?? null
  };
}

async function buildReceiptContent(row: EmailDeliveryRow): Promise<BuiltContent> {
  if (!row.recipientMemberId) {
    return { ok: false, errorCode: "no_token" };
  }
  try {
    // The CURRENT token: the newest unrevoked, unused row for this pair.
    // Corrections revoke old rows, so the unrevoked one is authoritative.
    const tokenRow =
      (
        await db
          .select()
          .from(disputeTokens)
          .where(
            and(
              eq(disputeTokens.sessionId, row.entityId),
              eq(disputeTokens.memberId, row.recipientMemberId),
              isNull(disputeTokens.revokedAt),
              isNull(disputeTokens.usedAt)
            )
          )
          .orderBy(desc(disputeTokens.createdAt))
          .limit(1)
      )[0] ?? null;
    if (!tokenRow) {
      return { ok: false, errorCode: "no_token" };
    }

    // Rotate the live row's hash to a freshly minted raw token (the only one
    // that will be emailed), and give it a full TTL from send time.
    const token = generateToken();
    await db
      .update(disputeTokens)
      .set({
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + TOKEN_TTL_DAYS * DAY_MS)
      })
      .where(eq(disputeTokens.id, tokenRow.id));

    const ctx = await loadSessionWithResults(row.entityId, row.recipientMemberId);
    if (!ctx) return { ok: false, errorCode: "render_error" };

    const origin = env().PUBLIC_APP_ORIGIN;
    const data: ReceiptEmailData = {
      origin,
      memberName: ctx.recipientName ?? row.recipientEmail,
      session: {
        id: ctx.session.id,
        playedAt: ctx.session.playedAt,
        title: ctx.session.title,
        version: ctx.session.version,
        status: ctx.session.status
      },
      recordedBy: ctx.recordedByName ? { name: ctx.recordedByName } : null,
      results: ctx.results,
      totalCents: ctx.totalCents,
      token
    };
    const rendered =
      row.eventType === "dispute_resolution"
        ? renderResolutionEmail(data)
        : renderReceiptEmail(data);
    return {
      ok: true,
      content: { ...rendered, link: `${origin}/poker?token=${encodeURIComponent(token)}` }
    };
  } catch (err) {
    console.error(`email content build failed for ${row.id} (${errName(err)})`);
    return { ok: false, errorCode: "render_error" };
  }
}

async function buildMemberContent(row: EmailDeliveryRow): Promise<BuiltContent> {
  try {
    const member =
      (
        await db
          .select()
          .from(members)
          .where(eq(members.id, row.entityId))
          .limit(1)
      )[0] ?? null;
    if (!member) return { ok: false, errorCode: "render_error" };
    const rendered = renderMemberEmail({
      memberName: member.displayName,
      kind: row.eventType === "member_approved" ? "approved" : "welcome"
    });
    return { ok: true, content: { ...rendered, link: null } };
  } catch (err) {
    console.error(`email content build failed for ${row.id} (${errName(err)})`);
    return { ok: false, errorCode: "render_error" };
  }
}

/** Dispute lifecycle notices (entity = dispute; the row's task is implicit). */
async function buildDisputeNoticeContent(row: EmailDeliveryRow): Promise<BuiltContent> {
  try {
    const [dispute] = await db
      .select()
      .from(disputes)
      .where(eq(disputes.id, row.entityId))
      .limit(1);
    if (!dispute) return { ok: false, errorCode: "render_error" };
    const [session] = await db
      .select()
      .from(pokerSessions)
      .where(eq(pokerSessions.id, dispute.sessionId))
      .limit(1);
    if (!session) return { ok: false, errorCode: "render_error" };
    const [member] = await db
      .select({ name: members.displayName })
      .from(members)
      .where(eq(members.id, dispute.memberId))
      .limit(1);
    if (!member) return { ok: false, errorCode: "render_error" };

    const origin = env().PUBLIC_APP_ORIGIN;
    const common: DisputeAckEmailData = {
      origin,
      reason: dispute.reason,
      sessionTitle: session.title,
      playedAt: session.playedAt,
      sessionId: session.id
    };
    let rendered: RenderedEmail;
    switch (row.eventType) {
      case "dispute_opened":
        // Recipient is the admin (no recipient_member_id on the row).
        rendered = renderDisputeOpenedEmail({
          ...common,
          memberName: member.name
        } satisfies DisputeNoticeEmailData);
        break;
      case "dispute_opened_ack":
        rendered = renderDisputeAckEmail(common);
        break;
      case "dispute_resolved":
        rendered = renderDisputeResolvedEmail({
          ...common,
          memberName: member.name
        } satisfies DisputeNoticeEmailData);
        break;
      default: // dispute_dismissed
        rendered = renderDisputeDismissedEmail({
          ...common,
          memberName: member.name
        } satisfies DisputeNoticeEmailData);
        break;
    }
    return { ok: true, content: { ...rendered, link: null } };
  } catch (err) {
    console.error(`email content build failed for ${row.id} (${errName(err)})`);
    return { ok: false, errorCode: "render_error" };
  }
}

/** Session updated/voided notices — token-free receipt-shaped data. */
async function buildSessionNoticeContent(row: EmailDeliveryRow): Promise<BuiltContent> {
  if (!row.recipientMemberId) return { ok: false, errorCode: "render_error" };
  try {
    const ctx = await loadSessionWithResults(row.entityId, row.recipientMemberId);
    if (!ctx) return { ok: false, errorCode: "render_error" };
    const data: WithoutTokenReceiptData = {
      origin: env().PUBLIC_APP_ORIGIN,
      memberName: ctx.recipientName ?? row.recipientEmail,
      session: {
        id: ctx.session.id,
        playedAt: ctx.session.playedAt,
        title: ctx.session.title,
        version: ctx.session.version,
        status: ctx.session.status
      },
      recordedBy: ctx.recordedByName ? { name: ctx.recordedByName } : null,
      results: ctx.results,
      totalCents: ctx.totalCents
    };
    const rendered =
      row.eventType === "session_voided"
        ? renderSessionVoidedEmail(data)
        : renderSessionUpdatedEmail(data);
    return { ok: true, content: { ...rendered, link: null } };
  } catch (err) {
    console.error(`email content build failed for ${row.id} (${errName(err)})`);
    return { ok: false, errorCode: "render_error" };
  }
}

/**
 * Correction notice: per-recipient delta between the pre-correction and
 * post-correction results, taken from the latest session.edit /
 * session.correction audit row.
 */
async function buildResultsCorrectedContent(row: EmailDeliveryRow): Promise<BuiltContent> {
  if (!row.recipientMemberId) return { ok: false, errorCode: "render_error" };
  try {
    const ctx = await loadSessionWithResults(row.entityId, row.recipientMemberId);
    if (!ctx) return { ok: false, errorCode: "render_error" };

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, "session"),
          eq(auditEvents.entityId, row.entityId),
          inArray(auditEvents.action, ["session.edit", "session.correction"])
        )
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    if (!audit) return { ok: false, errorCode: "render_error" };

    const beforeResults = parseAuditResults(audit.beforeJson);
    const afterResults = parseAuditResults(audit.afterJson);
    if (!beforeResults || !afterResults) {
      return { ok: false, errorCode: "render_error" };
    }
    const before = beforeResults.find((r) => r.memberId === row.recipientMemberId);
    const after = afterResults.find((r) => r.memberId === row.recipientMemberId);
    if (!before || !after) return { ok: false, errorCode: "render_error" };

    const rendered = renderResultsCorrectedEmail({
      origin: env().PUBLIC_APP_ORIGIN,
      memberName: ctx.recipientName ?? row.recipientEmail,
      session: {
        id: ctx.session.id,
        playedAt: ctx.session.playedAt,
        title: ctx.session.title,
        version: ctx.session.version,
        status: ctx.session.status
      },
      beforeAmountCents: before.amountCents,
      afterAmountCents: after.amountCents,
      changeCents: after.amountCents - before.amountCents,
      totalCents: ctx.totalCents
    });
    return { ok: true, content: { ...rendered, link: null } };
  } catch (err) {
    console.error(`email content build failed for ${row.id} (${errName(err)})`);
    return { ok: false, errorCode: "render_error" };
  }
}

/** Audit beforeJson/afterJson.results → [{ memberId, amountCents }] or null. */
function parseAuditResults(
  json: unknown
): Array<{ memberId: string; amountCents: number }> | null {
  if (typeof json !== "object" || json === null) return null;
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  const out: Array<{ memberId: string; amountCents: number }> = [];
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) return null;
    const { memberId, amountCents } = entry as { memberId?: unknown; amountCents?: unknown };
    if (typeof memberId !== "string" || typeof amountCents !== "number") return null;
    out.push({ memberId, amountCents });
  }
  return out;
}

/** Error class name only — never messages (provider text may be sensitive). */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown error";
}

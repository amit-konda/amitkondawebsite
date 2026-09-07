/**
 * Settlements — a self-attested "I paid this outside the app" record.
 *
 * The app never moves money itself: Venmo (and every other mainstream
 * payment platform) has no API for a third-party app to confirm a peer
 * payment landed, and poker/gambling money movement is explicitly against
 * the acceptable-use policy of Stripe, PayPal, and similar processors even
 * for a private friend-group ledger like this one. So a settlement just
 * records that a payment (almost always Venmo) happened outside the app:
 * it starts "pending" when the payer submits it, and becomes "confirmed"
 * once someone taps confirm — at that point it nets against the ledger
 * exactly the way a settled handshake bet already does.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireGroup, requireViewer } from "../auth.js";
import { db } from "../db/client.js";
import { members, settlements } from "../db/schema.js";
import { writeAudit } from "../domain/audit.js";
import { MAX_AMOUNT_CENTS } from "../domain/money.js";
import { badRequest, notFound } from "../errors.js";
import type { Ctx, Router } from "../router.js";

const createSchema = z.object({
  requestKey: z.string().min(8).max(64),
  fromMemberId: z.string().uuid(),
  toMemberId: z.string().uuid(),
  amountCents: z.number().int().positive().max(MAX_AMOUNT_CENTS),
  method: z.string().trim().min(1).max(30).optional(),
  note: z.string().trim().max(500).optional()
});

function isRequestKeyViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; cause?: unknown; message?: unknown };
  const cause = (e.cause ?? null) as { code?: unknown; message?: unknown } | null;
  const code = e.code ?? cause?.code;
  const msg = `${String(e.message ?? "")} ${String(cause?.message ?? "")}`;
  return code === "23505" && msg.includes("request_key");
}

export function registerSettlementRoutes(router: Router): void {
  // GET /api/poker/settlements/ledger — confirmed settlements only, netted
  // per active member. A settlement pays DOWN whatever a member already
  // owes elsewhere, so the sign is the opposite of a fresh debt: the payer
  // (from) moves toward zero (+amount) and the payee (to) moves toward
  // zero from the other side (-amount) — e.g. someone down $30 in poker who
  // pays that $30 via Venmo nets back to exactly $0 once this is confirmed.
  router.get("/api/poker/settlements/ledger", async (ctx: Ctx) => {
    const claims = requireGroup(ctx);
    const active = await db
      .select({ id: members.id, name: members.displayName })
      .from(members)
      .where(eq(members.status, "active"));
    const confirmed = await db
      .select({ from: settlements.fromMemberId, to: settlements.toMemberId, amount: settlements.amountCents })
      .from(settlements)
      .where(eq(settlements.status, "confirmed"));
    const totals = new Map(active.map((m) => [m.id, 0]));
    for (const s of confirmed) {
      const amount = Number(s.amount);
      totals.set(s.from, (totals.get(s.from) ?? 0) + amount);
      totals.set(s.to, (totals.get(s.to) ?? 0) - amount);
    }
    const rows = active.map((m) => ({ memberId: m.id, name: m.name, netCents: totals.get(m.id) ?? 0, isViewer: m.id === claims.mid }));
    rows.sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name));
    return { totalCents: rows.reduce((s, r) => s + r.netCents, 0), rows };
  });

  // GET /api/poker/settlements — recent settlements of every status, newest
  // first, so pending ones can be surfaced for confirmation.
  router.get("/api/poker/settlements", async (ctx: Ctx) => {
    requireGroup(ctx);
    const rows = await db
      .select({
        id: settlements.id,
        fromMemberId: settlements.fromMemberId,
        toMemberId: settlements.toMemberId,
        amountCents: settlements.amountCents,
        method: settlements.method,
        note: settlements.note,
        status: settlements.status,
        createdAt: settlements.createdAt,
        confirmedAt: settlements.confirmedAt
      })
      .from(settlements)
      .orderBy(desc(settlements.createdAt))
      .limit(50);
    const ids = [...new Set(rows.flatMap((r) => [r.fromMemberId, r.toMemberId]))];
    const names = new Map(
      (ids.length ? await db.select({ id: members.id, name: members.displayName }).from(members).where(inArray(members.id, ids)) : []).map((m) => [m.id, m.name])
    );
    return {
      settlements: rows.map((r) => ({
        id: r.id,
        fromMemberId: r.fromMemberId,
        fromName: names.get(r.fromMemberId) ?? "Unknown",
        toMemberId: r.toMemberId,
        toName: names.get(r.toMemberId) ?? "Unknown",
        amountCents: Number(r.amountCents),
        method: r.method,
        note: r.note,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null
      }))
    };
  });

  // POST /api/poker/settlements — record a pending payment (idempotent via
  // requestKey, same pattern as session creation).
  router.post("/api/poker/settlements", async (ctx: Ctx) => {
    const claims = requireViewer(ctx);
    const body = createSchema.parse(ctx.body);
    if (body.fromMemberId === body.toMemberId) throw badRequest("same_member", "Choose two different members.");
    const active = await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.status, "active"), inArray(members.id, [body.fromMemberId, body.toMemberId])));
    if (active.length !== 2) throw badRequest("invalid_members", "Choose active members only.");

    const id = randomUUID();
    try {
      await db.insert(settlements).values({
        id,
        fromMemberId: body.fromMemberId,
        toMemberId: body.toMemberId,
        amountCents: body.amountCents,
        method: body.method ?? "venmo",
        note: body.note ?? null,
        createdByMemberId: claims.mid,
        requestKey: body.requestKey
      });
    } catch (err) {
      if (isRequestKeyViolation(err)) {
        const existing = (await db.select({ id: settlements.id }).from(settlements).where(eq(settlements.requestKey, body.requestKey)).limit(1))[0];
        if (!existing) throw err;
        return { created: false, id: existing.id, duplicate: true };
      }
      throw err;
    }
    await writeAudit(db, {
      actorLabel: `member:${claims.mid}`,
      action: "settlement.create",
      entityType: "settlement",
      entityId: id,
      afterJson: { fromMemberId: body.fromMemberId, toMemberId: body.toMemberId, amountCents: body.amountCents, method: body.method ?? "venmo" }
    });
    return { created: true, id };
  });

  // POST /api/poker/settlements/:id/confirm — the trust model here matches
  // the rest of the app (any signed-in member, not just the two parties, can
  // settle a handshake bet too) — this is a private group ledger, not a
  // payments product with per-action authorization.
  router.post("/api/poker/settlements/:id/confirm", async (ctx: Ctx) => {
    const claims = requireViewer(ctx);
    const id = ctx.params.id!;
    const existing = (await db.select().from(settlements).where(eq(settlements.id, id)).limit(1))[0];
    if (!existing) throw notFound();
    if (existing.status !== "pending") throw badRequest("not_pending", "This payment isn't pending confirmation.");
    await db
      .update(settlements)
      .set({ status: "confirmed", confirmedAt: new Date(), confirmedByMemberId: claims.mid })
      .where(and(eq(settlements.id, id), eq(settlements.status, "pending")));
    await writeAudit(db, {
      actorLabel: `member:${claims.mid}`,
      action: "settlement.confirm",
      entityType: "settlement",
      entityId: id,
      beforeJson: { status: existing.status },
      afterJson: { status: "confirmed" }
    });
    return { ok: true };
  });

  // POST /api/poker/settlements/:id/void — idempotent void, same shape as
  // handshake-bet void: dropping status out of "confirmed" is all the
  // ledger query keys off, so the reversal takes effect immediately.
  router.post("/api/poker/settlements/:id/void", async (ctx: Ctx) => {
    const claims = requireViewer(ctx);
    const id = ctx.params.id!;
    const existing = (await db.select().from(settlements).where(eq(settlements.id, id)).limit(1))[0];
    if (!existing) throw notFound();
    if (existing.status === "voided") return { ok: true };
    await db.update(settlements).set({ status: "voided", voidedAt: new Date() }).where(and(eq(settlements.id, id), ne(settlements.status, "voided")));
    await writeAudit(db, {
      actorLabel: `member:${claims.mid}`,
      action: "settlement.void",
      entityType: "settlement",
      entityId: id,
      beforeJson: { status: existing.status },
      afterJson: { status: "voided" }
    });
    return { ok: true };
  });
}

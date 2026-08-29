import { and, asc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireGroup, requireViewer } from "../auth.js";
import { db } from "../db/client.js";
import { liveBuyIns, liveCashOuts, members, pokerSessions, sessionResults } from "../db/schema.js";
import { MAX_AMOUNT_CENTS } from "../domain/money.js";
import { badRequest, conflict, notFound } from "../errors.js";
import type { Handler, Router } from "../router.js";

const StartSchema = z.object({
  requestKey: z.string().min(8).max(64),
  title: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  players: z.array(z.object({ memberId: z.string().uuid(), amountCents: z.number().int().positive().max(MAX_AMOUNT_CENTS) })).min(2)
});
const BuyInSchema = z.object({ memberId: z.string().uuid(), amountCents: z.number().int().positive().max(MAX_AMOUNT_CENTS) });
const CashOutSchema = z.object({ memberId: z.string().uuid(), amountCents: z.number().int().nonnegative().max(MAX_AMOUNT_CENTS) });

function route(router: Router, method: "get" | "post" | "patch", path: string, handler: Handler): void {
  router[method](path, handler);
  router[method](`/api/poker${path}`, handler);
}

async function livePayload(id: string) {
  const session = (await db.select({ id: pokerSessions.id, playedAt: pokerSessions.playedAt, title: pokerSessions.title, notes: pokerSessions.notes, status: pokerSessions.status, version: pokerSessions.version, recordedByMemberId: pokerSessions.recordedByMemberId }).from(pokerSessions).where(eq(pokerSessions.id, id)).limit(1))[0];
  if (!session) throw notFound();
  const buyRows = await db.select({ id: liveBuyIns.id, memberId: liveBuyIns.memberId, name: members.displayName, amountCents: liveBuyIns.amountCents, createdAt: liveBuyIns.createdAt }).from(liveBuyIns).innerJoin(members, eq(members.id, liveBuyIns.memberId)).where(eq(liveBuyIns.sessionId, id)).orderBy(asc(liveBuyIns.createdAt));
  const cashRows = await db.select({ memberId: liveCashOuts.memberId, amountCents: liveCashOuts.amountCents, createdAt: liveCashOuts.createdAt }).from(liveCashOuts).where(eq(liveCashOuts.sessionId, id));
  const cashByMember = new Map(cashRows.map((r) => [r.memberId, r]));
  const byMember = new Map<string, { memberId: string; name: string; buyInCents: number; cashOutCents: number | null; buyIns: Array<{ id: string; amountCents: number; createdAt: string }> }>();
  for (const r of buyRows) {
    const current = byMember.get(r.memberId) ?? { memberId: r.memberId, name: r.name, buyInCents: 0, cashOutCents: null, buyIns: [] };
    current.buyInCents += Number(r.amountCents);
    current.buyIns.push({ id: r.id, amountCents: Number(r.amountCents), createdAt: r.createdAt.toISOString() });
    byMember.set(r.memberId, current);
  }
  for (const row of byMember.values()) {
    row.cashOutCents = cashByMember.get(row.memberId)?.amountCents ?? null;
  }
  return {
    session: { id: session.id, playedAt: session.playedAt.toISOString(), title: session.title, notes: session.notes, status: session.status, version: session.version, recordedByMemberId: session.recordedByMemberId },
    participants: [...byMember.values()],
    ended: session.status !== "live"
  };
}

export function registerLiveRoutes(router: Router): void {
  route(router, "get", "/live", async (ctx) => {
    requireGroup(ctx);
    const row = (await db.select({ id: pokerSessions.id }).from(pokerSessions).where(eq(pokerSessions.status, "live")).limit(1))[0];
    return row ? await livePayload(row.id) : { session: null, participants: [], ended: false };
  });

  route(router, "post", "/live", async (ctx) => {
    const claims = requireViewer(ctx);
    const body = StartSchema.parse(ctx.body);
    const memberIds = [...new Set(body.players.map((p) => p.memberId))];
    if (memberIds.length !== body.players.length) throw badRequest("duplicate_members", "Choose each player only once.");
    const active = await db.select({ id: members.id }).from(members).where(and(eq(members.status, "active"), inArray(members.id, memberIds)));
    if (active.length !== memberIds.length) throw badRequest("invalid_members", "Choose active members only.");
    const existing = (await db.select({ id: pokerSessions.id }).from(pokerSessions).where(eq(pokerSessions.status, "live")).limit(1))[0];
    if (existing) throw conflict("A live session is already in progress.");
    const id = randomUUID();
    await db.insert(pokerSessions).values({ id, playedAt: new Date(), title: body.title ?? null, notes: body.notes ?? null, recordedByMemberId: claims.mid, status: "live", version: 1, requestKey: body.requestKey });
    await db.insert(liveBuyIns).values(body.players.map((p) => ({ sessionId: id, memberId: p.memberId, amountCents: p.amountCents, recordedByMemberId: claims.mid })));
    return { ...(await livePayload(id)), created: true };
  });

  route(router, "post", "/live/:id/buyins", async (ctx) => {
    const claims = requireViewer(ctx);
    const body = BuyInSchema.parse(ctx.body);
    const session = (await db.select({ id: pokerSessions.id, status: pokerSessions.status }).from(pokerSessions).where(eq(pokerSessions.id, ctx.params.id!)).limit(1))[0];
    if (!session) throw notFound();
    if (session.status !== "live") throw conflict("This live session has ended.");
    await db.insert(liveBuyIns).values({ sessionId: session.id, memberId: body.memberId, amountCents: body.amountCents, recordedByMemberId: claims.mid });
    return livePayload(session.id);
  });

  route(router, "patch", "/live/:id/cashouts", async (ctx) => {
    const claims = requireViewer(ctx);
    const body = CashOutSchema.parse(ctx.body);
    const session = (await db.select({ id: pokerSessions.id, status: pokerSessions.status }).from(pokerSessions).where(eq(pokerSessions.id, ctx.params.id!)).limit(1))[0];
    if (!session) throw notFound();
    if (session.status !== "live") throw conflict("This live session has ended.");
    await db.insert(liveCashOuts).values({ sessionId: session.id, memberId: body.memberId, amountCents: body.amountCents, recordedByMemberId: claims.mid }).onConflictDoUpdate({ target: [liveCashOuts.sessionId, liveCashOuts.memberId], set: { amountCents: body.amountCents, recordedByMemberId: claims.mid, updatedAt: new Date() } });
    return livePayload(session.id);
  });

  route(router, "post", "/live/:id/end", async (ctx) => {
    const claims = requireViewer(ctx);
    const id = ctx.params.id!;
    const live = await livePayload(id);
    if (live.session.status !== "live") return live;
    if (live.participants.length < 2) throw badRequest("not_enough_players", "Add at least two players before ending the session.");
    const missing = live.participants.filter((p) => p.cashOutCents === null);
    if (missing.length) throw badRequest("cashouts_required", "Enter a cash-out amount for every player.");
    await db.transaction(async (tx) => {
      await tx.delete(sessionResults).where(eq(sessionResults.sessionId, id));
      await tx.insert(sessionResults).values(live.participants.map((p) => ({ sessionId: id, memberId: p.memberId, amountCents: (p.cashOutCents ?? 0) - p.buyInCents })));
      await tx.update(pokerSessions).set({ status: "active", version: live.session.version + 1, updatedAt: new Date() }).where(and(eq(pokerSessions.id, id), eq(pokerSessions.status, "live")));
    });
    return { ...(await livePayload(id)), ended: true, endedByMemberId: claims.mid };
  });
}

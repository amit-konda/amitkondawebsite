import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireGroup, requireViewer } from "../auth.js";
import { db } from "../db/client.js";
import { members, pokerSessions, sessionResults } from "../db/schema.js";
import { MAX_AMOUNT_CENTS } from "../domain/money.js";
import { badRequest, notFound } from "../errors.js";
import type { Router } from "../router.js";

const createSchema = z.object({
  requestKey: z.string().min(8).max(64),
  playedAt: z.string().datetime(),
  title: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  verifiedDealer: z.literal(true),
  players: z.array(z.object({ memberId: z.string().uuid(), amountCents: z.number().int().min(-MAX_AMOUNT_CENTS).max(MAX_AMOUNT_CENTS) })).min(1)
});

export function registerBlackjackRoutes(router: Router): void {
  router.get("/api/poker/blackjack/ledger", async (ctx) => {
    const claims = requireGroup(ctx);
    const rows = await db.select({ id: members.id, name: members.displayName, netCents: sql<string>`coalesce(sum(${sessionResults.amountCents}) filter (where ${pokerSessions.status} <> 'voided'), 0)::bigint`, sessionsPlayed: sql<string>`coalesce(count(distinct ${sessionResults.sessionId}) filter (where ${pokerSessions.status} <> 'voided'), 0)::bigint`, lastPlayedAt: sql<string | null>`to_char((max(${pokerSessions.playedAt}) filter (where ${pokerSessions.status} <> 'voided')) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` }).from(members).leftJoin(sessionResults, eq(sessionResults.memberId, members.id)).leftJoin(pokerSessions, and(eq(pokerSessions.id, sessionResults.sessionId), eq(pokerSessions.gameType, "blackjack"))).groupBy(members.id, members.displayName);
    const active = new Set((await db.select({ id: members.id }).from(members).where(eq(members.status, "active"))).map((m) => m.id));
    const out = rows.filter((r) => active.has(r.id)).map((r) => ({ memberId: r.id, name: r.name, netCents: Number(r.netCents), sessionsPlayed: Number(r.sessionsPlayed), lastPlayedAt: r.lastPlayedAt ?? null, isViewer: r.id === claims.mid })).sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name));
    return { totalCents: out.reduce((sum, r) => sum + r.netCents, 0), rows: out };
  });

  router.get("/api/poker/blackjack/sessions", async (ctx) => {
    requireGroup(ctx);
    const page = await db.select({ id: pokerSessions.id, playedAt: pokerSessions.playedAt, title: pokerSessions.title, status: pokerSessions.status, version: pokerSessions.version, recordedByMemberId: pokerSessions.recordedByMemberId }).from(pokerSessions).where(eq(pokerSessions.gameType, "blackjack")).orderBy(desc(pokerSessions.playedAt)).limit(30);
    const ids = page.map((s) => s.id);
    const players = ids.length ? await db.select({ sessionId: sessionResults.sessionId, memberId: sessionResults.memberId, name: members.displayName, amountCents: sessionResults.amountCents }).from(sessionResults).innerJoin(members, eq(members.id, sessionResults.memberId)).where(inArray(sessionResults.sessionId, ids)) : [];
    const bySession = new Map<string, typeof players>();
    for (const p of players) bySession.set(p.sessionId, [...(bySession.get(p.sessionId) ?? []), p]);
    return { sessions: page.map((s) => ({ id: s.id, playedAt: s.playedAt.toISOString(), title: s.title, status: s.status, version: s.version, recordedBy: s.recordedByMemberId, participants: (bySession.get(s.id) ?? []).map((p) => ({ memberId: p.memberId, name: p.name, amountCents: Number(p.amountCents) })) })) };
  });

  router.post("/api/poker/blackjack/sessions", async (ctx) => {
    const claims = requireViewer(ctx);
    const body = createSchema.parse(ctx.body);
    const ids = [...new Set(body.players.map((p) => p.memberId))];
    if (ids.length !== body.players.length || ids.includes(claims.mid!)) throw badRequest("invalid_players", "Choose unique players; the dealer is added automatically.");
    const active = await db.select({ id: members.id }).from(members).where(and(eq(members.status, "active"), inArray(members.id, ids)));
    if (active.length !== ids.length) throw badRequest("invalid_players", "Choose active members only.");
    const playerTotal = body.players.reduce((sum, p) => sum + p.amountCents, 0);
    if (playerTotal === 0) throw badRequest("invalid_results", "Enter at least one non-zero player result.");
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(pokerSessions).values({ id, gameType: "blackjack", playedAt: new Date(body.playedAt), title: body.title ?? null, notes: body.notes ?? null, recordedByMemberId: claims.mid, status: "active", version: 1, requestKey: body.requestKey });
      await tx.insert(sessionResults).values([{ sessionId: id, memberId: claims.mid!, amountCents: -playerTotal }, ...body.players.map((p) => ({ sessionId: id, memberId: p.memberId, amountCents: p.amountCents }))]);
    });
    return { created: true, sessionId: id };
  });

  router.get("/api/poker/blackjack/sessions/:id", async (ctx) => {
    requireGroup(ctx);
    const s = (await db.select().from(pokerSessions).where(and(eq(pokerSessions.id, ctx.params.id!), eq(pokerSessions.gameType, "blackjack"))).limit(1))[0];
    if (!s) throw notFound();
    const rows = await db.select({ memberId: sessionResults.memberId, name: members.displayName, amountCents: sessionResults.amountCents }).from(sessionResults).innerJoin(members, eq(members.id, sessionResults.memberId)).where(eq(sessionResults.sessionId, s.id));
    return { session: { id: s.id, playedAt: s.playedAt.toISOString(), title: s.title, notes: s.notes, status: s.status, dealerMemberId: s.recordedByMemberId, participants: rows.map((r) => ({ memberId: r.memberId, name: r.name, amountCents: Number(r.amountCents) })) } };
  });
}

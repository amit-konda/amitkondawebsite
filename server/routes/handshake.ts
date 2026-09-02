import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireGroup, requireViewer } from "../auth.js";
import { db } from "../db/client.js";
import { handshakeBetCategories, handshakeBets, members } from "../db/schema.js";
import { writeAudit } from "../domain/audit.js";
import { MAX_AMOUNT_CENTS } from "../domain/money.js";
import { badRequest, notFound } from "../errors.js";
import type { Router } from "../router.js";

const createSchema = z.object({ requestKey: z.string().min(8).max(64), description: z.string().min(1).max(200), amountCents: z.number().int().positive().max(MAX_AMOUNT_CENTS), firstMemberId: z.string().uuid(), secondMemberId: z.string().uuid(), categoryId: z.string().uuid().optional() });
const settleSchema = z.object({ winnerMemberId: z.string().uuid() });
const createCategorySchema = z.object({ name: z.string().trim().min(1).max(40) });

export function registerHandshakeRoutes(router: Router): void {
  router.get("/api/poker/handshake/ledger", async (ctx) => {
    const claims = requireGroup(ctx);
    const active = await db.select({ id: members.id, name: members.displayName }).from(members).where(eq(members.status, "active"));
    const settled = await db.select({ first: handshakeBets.firstMemberId, second: handshakeBets.secondMemberId, winner: handshakeBets.winnerMemberId, amount: handshakeBets.amountCents }).from(handshakeBets).where(eq(handshakeBets.status, "settled"));
    const totals = new Map(active.map((m) => [m.id, 0]));
    for (const b of settled) { const amount = Number(b.amount); if (!b.winner) continue; const loser = b.winner === b.first ? b.second : b.first; totals.set(b.winner, (totals.get(b.winner) ?? 0) + amount); totals.set(loser, (totals.get(loser) ?? 0) - amount); }
    const rows = active.map((m) => ({ memberId: m.id, name: m.name, netCents: totals.get(m.id) ?? 0, sessionsPlayed: 0, lastPlayedAt: null, isViewer: m.id === claims.mid }));
    rows.sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name));
    return { totalCents: rows.reduce((s, r) => s + r.netCents, 0), rows };
  });
  router.get("/api/poker/handshake/bets", async (ctx) => {
    requireGroup(ctx);
    const rows = await db.select({ id: handshakeBets.id, description: handshakeBets.description, amountCents: handshakeBets.amountCents, firstMemberId: handshakeBets.firstMemberId, secondMemberId: handshakeBets.secondMemberId, winnerMemberId: handshakeBets.winnerMemberId, categoryId: handshakeBets.categoryId, status: handshakeBets.status, createdAt: handshakeBets.createdAt }).from(handshakeBets).orderBy(asc(handshakeBets.status), sql`${handshakeBets.createdAt} desc`).limit(50);
    const ids = [...new Set(rows.flatMap((r) => [r.firstMemberId, r.secondMemberId, r.winnerMemberId].filter(Boolean) as string[]))];
    const names = new Map((ids.length ? await db.select({ id: members.id, name: members.displayName }).from(members).where(inArray(members.id, ids)) : []).map((m) => [m.id, m.name]));
    const categoryIds = [...new Set(rows.map((r) => r.categoryId).filter(Boolean) as string[])];
    const categoryNames = new Map((categoryIds.length ? await db.select({ id: handshakeBetCategories.id, name: handshakeBetCategories.name }).from(handshakeBetCategories).where(inArray(handshakeBetCategories.id, categoryIds)) : []).map((c) => [c.id, c.name]));
    return { bets: rows.map((r) => ({ ...r, amountCents: Number(r.amountCents), firstMember: { id: r.firstMemberId, name: names.get(r.firstMemberId) ?? "Unknown" }, secondMember: { id: r.secondMemberId, name: names.get(r.secondMemberId) ?? "Unknown" }, winnerMember: r.winnerMemberId ? { id: r.winnerMemberId, name: names.get(r.winnerMemberId) ?? "Unknown" } : null, category: r.categoryId ? { id: r.categoryId, name: categoryNames.get(r.categoryId) ?? "Unknown" } : null })) };
  });
  router.get("/api/poker/handshake/categories", async (ctx) => {
    requireGroup(ctx);
    const rows = await db.select({ id: handshakeBetCategories.id, name: handshakeBetCategories.name }).from(handshakeBetCategories).orderBy(asc(handshakeBetCategories.name));
    return { categories: rows };
  });
  router.post("/api/poker/handshake/categories", async (ctx) => {
    const claims = requireViewer(ctx); const body = createCategorySchema.parse(ctx.body);
    const existing = (await db.select({ id: handshakeBetCategories.id, name: handshakeBetCategories.name }).from(handshakeBetCategories).where(sql`lower(${handshakeBetCategories.name}) = lower(${body.name})`).limit(1))[0];
    if (existing) return { created: false, ...existing };
    const id = randomUUID();
    await db.insert(handshakeBetCategories).values({ id, name: body.name, createdByMemberId: claims.mid });
    return { created: true, id, name: body.name };
  });
  router.post("/api/poker/handshake/bets", async (ctx) => {
    const claims = requireViewer(ctx); const body = createSchema.parse(ctx.body);
    if (body.firstMemberId === body.secondMemberId) throw badRequest("same_member", "Choose two different members.");
    const active = await db.select({ id: members.id }).from(members).where(and(eq(members.status, "active"), inArray(members.id, [body.firstMemberId, body.secondMemberId])));
    if (active.length !== 2) throw badRequest("invalid_members", "Choose active members only.");
    if (body.categoryId) {
      const category = (await db.select({ id: handshakeBetCategories.id }).from(handshakeBetCategories).where(eq(handshakeBetCategories.id, body.categoryId)).limit(1))[0];
      if (!category) throw badRequest("invalid_category", "Choose a valid category.");
    }
    const id = randomUUID();
    await db.insert(handshakeBets).values({ id, description: body.description, amountCents: body.amountCents, firstMemberId: body.firstMemberId, secondMemberId: body.secondMemberId, categoryId: body.categoryId ?? null, createdByMemberId: claims.mid });
    return { created: true, id };
  });
  router.post("/api/poker/handshake/bets/:id/settle", async (ctx) => {
    requireViewer(ctx); const body = settleSchema.parse(ctx.body);
    const bet = (await db.select().from(handshakeBets).where(eq(handshakeBets.id, ctx.params.id!)).limit(1))[0];
    if (!bet) throw notFound(); if (bet.status !== "open") throw badRequest("already_settled", "This bet is already settled.");
    if (![bet.firstMemberId, bet.secondMemberId].includes(body.winnerMemberId)) throw badRequest("invalid_winner", "Winner must be one of the two bettors.");
    await db.update(handshakeBets).set({ winnerMemberId: body.winnerMemberId, status: "settled", settledAt: new Date() }).where(eq(handshakeBets.id, bet.id));
    return { ok: true };
  });
  // POST /api/poker/handshake/bets/:id/void — idempotent void. Voiding drops
  // the bet's status out of "settled", which is all the ledger/balances
  // query keys off — so the effect on settled balances reverses immediately
  // without any separate reversal bookkeeping.
  router.post("/api/poker/handshake/bets/:id/void", async (ctx) => {
    const claims = requireViewer(ctx);
    const betId = ctx.params.id!;
    const existing = (await db.select().from(handshakeBets).where(eq(handshakeBets.id, betId)).limit(1))[0];
    if (!existing) throw notFound();
    if (existing.status === "voided") return { ok: true };
    await db.update(handshakeBets).set({ status: "voided" }).where(and(eq(handshakeBets.id, betId), ne(handshakeBets.status, "voided")));
    await writeAudit(db, {
      actorLabel: `member:${claims.mid}`,
      action: "handshake_bet.void",
      entityType: "handshake_bet",
      entityId: betId,
      beforeJson: { status: existing.status },
      afterJson: { status: "voided" }
    });
    return { ok: true };
  });
}

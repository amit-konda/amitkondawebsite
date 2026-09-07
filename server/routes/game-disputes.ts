import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin, requireViewer } from "../auth.js";
import { db } from "../db/client.js";
import { gameDisputes, golfRounds, handshakeBets, members } from "../db/schema.js";
import { writeAudit } from "../domain/audit.js";
import { badRequest, conflict, notFound } from "../errors.js";
import type { Ctx, Router } from "../router.js";

const openSchema = z.object({
  entityType: z.enum(["handshake_bet", "golf_round"]),
  entityId: z.uuid(),
  reason: z.string().trim().min(1).max(1000)
});
const resolveSchema = z.object({
  outcome: z.enum(["resolved", "dismissed"]),
  note: z.string().max(1000).nullable().optional()
});

async function openGameDispute(ctx: Ctx): Promise<unknown> {
  const claims = requireViewer(ctx);
  const memberId = claims.mid;
  if (!memberId) throw new Error("viewer required");
  const body = openSchema.parse(ctx.body);
  const entity = body.entityType === "handshake_bet"
    ? (await db.select({ id: handshakeBets.id, status: handshakeBets.status }).from(handshakeBets).where(eq(handshakeBets.id, body.entityId)).limit(1))[0]
    : (await db.select({ id: golfRounds.id }).from(golfRounds).where(eq(golfRounds.id, body.entityId)).limit(1))[0];
  if (!entity) throw notFound("That record was not found.");
  if (body.entityType === "handshake_bet" && "status" in entity && entity.status === "voided") {
    throw conflict("Voided bets cannot be disputed.");
  }
  const existing = await db.select({ id: gameDisputes.id }).from(gameDisputes).where(and(
    eq(gameDisputes.entityType, body.entityType),
    eq(gameDisputes.entityId, body.entityId),
    eq(gameDisputes.memberId, memberId),
    eq(gameDisputes.status, "open")
  )).limit(1);
  if (existing.length) throw conflict("A dispute for this record is already open.");
  const [created] = await db.insert(gameDisputes).values({
    entityType: body.entityType,
    entityId: body.entityId,
    memberId,
    reason: body.reason
  }).returning({ id: gameDisputes.id, createdAt: gameDisputes.createdAt });
  if (!created) throw new Error("Dispute was not created.");
  await writeAudit(db, {
    actorLabel: `member:${memberId}`,
    action: "game_dispute.open",
    entityType: body.entityType,
    entityId: body.entityId,
    afterJson: { reason: body.reason, disputeId: created.id }
  });
  ctx.res.statusCode = 201;
  return { dispute: { id: created.id, entityType: body.entityType, entityId: body.entityId, status: "open", createdAt: created.createdAt } };
}

async function listGameDisputes(ctx: Ctx): Promise<unknown> {
  requireAdmin(ctx);
  const rows = await db.select({
    id: gameDisputes.id,
    entityType: gameDisputes.entityType,
    entityId: gameDisputes.entityId,
    memberId: gameDisputes.memberId,
    memberName: members.displayName,
    reason: gameDisputes.reason,
    status: gameDisputes.status,
    resolutionNote: gameDisputes.resolutionNote,
    createdAt: gameDisputes.createdAt,
    resolvedAt: gameDisputes.resolvedAt
  }).from(gameDisputes).innerJoin(members, eq(gameDisputes.memberId, members.id))
    .orderBy(desc(gameDisputes.createdAt)).limit(100);
  const handshakeIds = rows.filter((r) => r.entityType === "handshake_bet").map((r) => r.entityId);
  const golfIds = rows.filter((r) => r.entityType === "golf_round").map((r) => r.entityId);
  const bets = new Map((handshakeIds.length ? await db.select({ id: handshakeBets.id, description: handshakeBets.description, amountCents: handshakeBets.amountCents, createdAt: handshakeBets.createdAt, status: handshakeBets.status }).from(handshakeBets).where(inArray(handshakeBets.id, handshakeIds)) : []).map((r) => [r.id, r]));
  const rounds = new Map((golfIds.length ? await db.select({ id: golfRounds.id, memberId: golfRounds.memberId, course: golfRounds.course, strokes: golfRounds.strokes, par: golfRounds.par, playedAt: golfRounds.playedAt }).from(golfRounds).where(inArray(golfRounds.id, golfIds)) : []).map((r) => [r.id, r]));
  return { disputes: rows.map((r) => {
    const bet = r.entityType === "handshake_bet" ? bets.get(r.entityId) : null;
    const round = r.entityType === "golf_round" ? rounds.get(r.entityId) : null;
    const playedAt = bet?.createdAt ?? round?.playedAt ?? r.createdAt;
    return {
      kind: "game",
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      memberId: r.memberId,
      memberName: r.memberName,
      reason: r.reason,
      status: r.status,
      resolutionNote: r.resolutionNote,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
      session: { title: bet ? `Handshake bet: ${bet.description}` : `Golf round: ${round?.course ?? "Unknown course"}`, playedAt, status: r.status, version: 1 },
      details: bet ? { amountCents: Number(bet.amountCents), status: bet.status } : round ? { memberId: round.memberId, course: round.course, strokes: round.strokes, par: round.par } : null
    };
  }) };
}

async function resolveGameDispute(ctx: Ctx): Promise<unknown> {
  requireAdmin(ctx);
  const id = ctx.params.id!;
  const body = resolveSchema.parse(ctx.body);
  const existing = (await db.select().from(gameDisputes).where(eq(gameDisputes.id, id)).limit(1))[0];
  if (!existing) throw notFound("Dispute not found.");
  if (existing.status !== "open") throw conflict("This dispute is no longer open.");
  const [updated] = await db.update(gameDisputes).set({ status: body.outcome, resolutionNote: body.note ?? null, resolvedAt: new Date() }).where(and(eq(gameDisputes.id, id), eq(gameDisputes.status, "open"))).returning({ id: gameDisputes.id });
  if (!updated) throw conflict("This dispute is no longer open.");
  await writeAudit(db, { action: "game_dispute.resolve", entityType: existing.entityType, entityId: existing.entityId, actorLabel: "admin", beforeJson: { status: existing.status }, afterJson: { status: body.outcome, note: body.note ?? null } });
  return { dispute: { id, entityType: existing.entityType, entityId: existing.entityId, status: body.outcome, resolutionNote: body.note ?? null } };
}

export function registerGameDisputeRoutes(router: Router): void {
  router.post("/api/poker/game-disputes", openGameDispute);
  router.get("/api/poker/admin/game-disputes", listGameDisputes);
  router.post("/api/poker/admin/game-disputes/:id/resolve", resolveGameDispute);
}

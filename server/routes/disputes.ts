/**
 * Disputes: email-token verification, dispute opening, and admin resolution.
 *
 * Tokens are high-entropy secrets sent by email; only SHA-256 hashes are ever
 * stored or logged. All public failure modes collapse into one generic error
 * so the endpoint cannot be used as a token oracle.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin } from "../auth.js";
import { db } from "../db/client.js";
import {
  disputeTokens,
  disputes,
  members,
  pokerSessions,
  sessionResults
} from "../db/schema.js";
import { writeAudit } from "../domain/audit.js";
import { validateSessionResults } from "../domain/money.js";
import { generateToken, hashToken, TOKEN_TTL_DAYS } from "../domain/tokens.js";
import { enqueueEmail } from "../email/outbox.js";
import { notifyEntity } from "../email/notify.js";
import { ApiError, conflict, notFound, rateLimited } from "../errors.js";
import { checkRateLimit, clientKey, RATE, type RatePreset } from "../rate-limit.js";
import type { Ctx, Router } from "../router.js";

const TOKEN_INVALID_MSG = "This link is invalid or expired.";
const ALREADY_OPEN_MSG = "A dispute for this session is already open.";

const tokenInvalid404 = () => new ApiError(404, "token_invalid", TOKEN_INVALID_MSG);
const tokenInvalid409 = () => new ApiError(409, "token_invalid", TOKEN_INVALID_MSG);

const verifySchema = z.object({
  token: z.string().min(20).max(200)
});

const openSchema = z.object({
  token: z.string().min(20).max(200),
  reason: z.string().trim().min(1).max(1000)
});

const resolveSchema = z.object({
  outcome: z.enum(["resolved", "dismissed"]),
  note: z.string().max(1000).nullable().optional(),
  corrections: z
    .array(
      z.object({
        memberId: z.uuid(),
        amountCents: z.number().int().refine((v) => v !== 0, {
          message: "Amount must be non-zero."
        })
      })
    )
    .nullable()
    .optional()
});

async function enforceRateLimit(ctx: Ctx, preset: RatePreset): Promise<void> {
  const r = await checkRateLimit(db, preset, clientKey(ctx.req));
  if (!r.ok) throw rateLimited(r.retryAfterSec);
}

/** POST /disputes/verify-token — public; the token itself is the credential. */
async function verifyToken(ctx: Ctx): Promise<unknown> {
  await enforceRateLimit(ctx, RATE.TOKEN_PER_IP);
  const { token } = verifySchema.parse(ctx.body);

  const row = (
    await db
      .select({
        sessionId: disputeTokens.sessionId,
        memberId: disputeTokens.memberId,
        memberName: members.displayName,
        expiresAt: disputeTokens.expiresAt,
        usedAt: disputeTokens.usedAt,
        revokedAt: disputeTokens.revokedAt,
        session: {
          id: pokerSessions.id,
          playedAt: pokerSessions.playedAt,
          title: pokerSessions.title,
          status: pokerSessions.status,
          version: pokerSessions.version
        }
      })
      .from(disputeTokens)
      .innerJoin(pokerSessions, eq(disputeTokens.sessionId, pokerSessions.id))
      .innerJoin(members, eq(disputeTokens.memberId, members.id))
      .where(eq(disputeTokens.tokenHash, hashToken(token)))
      .limit(1)
  )[0];

  if (!row) throw tokenInvalid404();
  if (row.expiresAt.getTime() <= Date.now()) throw tokenInvalid404();
  if (row.usedAt !== null) throw tokenInvalid404();
  if (row.revokedAt !== null) throw tokenInvalid404();

  const participants = await db
    .select({
      memberId: sessionResults.memberId,
      name: members.displayName,
      amountCents: sessionResults.amountCents
    })
    .from(sessionResults)
    .innerJoin(members, eq(sessionResults.memberId, members.id))
    .where(eq(sessionResults.sessionId, row.sessionId));

  const totalCents = participants.reduce((sum, p) => sum + p.amountCents, 0);

  return {
    token: {
      sessionId: row.sessionId,
      memberId: row.memberId,
      memberName: row.memberName,
      expiresAt: row.expiresAt,
      session: { ...row.session, participants, totalCents }
    }
  };
}

/** POST /disputes — consume a receipt token and open a dispute. */
async function openDispute(ctx: Ctx): Promise<unknown> {
  await enforceRateLimit(ctx, RATE.DISPUTE_PER_IP);
  const { token, reason } = openSchema.parse(ctx.body);
  const hash = hashToken(token);

  // Atomic consumption — a token can open at most one dispute.
  const consumed = await db
    .update(disputeTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(disputeTokens.tokenHash, hash),
        isNull(disputeTokens.usedAt),
        isNull(disputeTokens.revokedAt),
        sql`${disputeTokens.expiresAt} > now()`
      )
    )
    .returning({ id: disputeTokens.id });
  if (consumed.length === 0) throw tokenInvalid409();

  const tok = (
    await db
      .select({
        sessionId: disputeTokens.sessionId,
        memberId: disputeTokens.memberId,
        memberName: members.displayName
      })
      .from(disputeTokens)
      .innerJoin(members, eq(disputeTokens.memberId, members.id))
      .where(eq(disputeTokens.tokenHash, hash))
      .limit(1)
  )[0];
  if (!tok) throw tokenInvalid409();

  const existing = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(
      and(
        eq(disputes.sessionId, tok.sessionId),
        eq(disputes.memberId, tok.memberId),
        eq(disputes.status, "open")
      )
    )
    .limit(1);
  if (existing.length > 0) throw conflict(ALREADY_OPEN_MSG);

  let inserted;
  try {
    inserted = await db
      .insert(disputes)
      .values({
        sessionId: tok.sessionId,
        memberId: tok.memberId,
        reason,
        status: "open"
      })
      .returning({ id: disputes.id, createdAt: disputes.createdAt });
  } catch (err) {
    // Partial unique index disputes_open_session_member_uidx backs up the check.
    if ((err as { code?: string } | null)?.code === "23505") {
      throw conflict(ALREADY_OPEN_MSG);
    }
    throw err;
  }
  const dispute = inserted[0]!;

  // Flag the session disputed (only if still active; no version bump — version
  // only changes on admin-led mutations). If a prior dispute already flagged
  // it, the update is a no-op.
  await db
    .update(pokerSessions)
    .set({ status: "disputed" })
    .where(
      and(eq(pokerSessions.id, tok.sessionId), eq(pokerSessions.status, "active"))
    );

  await writeAudit(db, {
    action: "dispute.open",
    entityType: "dispute",
    entityId: dispute.id,
    actorLabel: `member:${tok.memberName}`,
    afterJson: { sessionId: tok.sessionId, memberId: tok.memberId, reason }
  });

  ctx.res.statusCode = 201;
  return {
    dispute: {
      id: dispute.id,
      sessionId: tok.sessionId,
      memberId: tok.memberId,
      status: "open",
      createdAt: dispute.createdAt
    }
  };
}

/** GET /admin/disputes — open first, then resolved/dismissed; latest first. */
async function listDisputes(ctx: Ctx): Promise<unknown> {
  requireAdmin(ctx);

  const rows = await db
    .select({
      id: disputes.id,
      sessionId: disputes.sessionId,
      memberId: disputes.memberId,
      memberName: members.displayName,
      reason: disputes.reason,
      status: disputes.status,
      resolutionNote: disputes.resolutionNote,
      createdAt: disputes.createdAt,
      resolvedAt: disputes.resolvedAt,
      session: {
        id: pokerSessions.id,
        playedAt: pokerSessions.playedAt,
        title: pokerSessions.title,
        status: pokerSessions.status,
        version: pokerSessions.version
      }
    })
    .from(disputes)
    .innerJoin(members, eq(disputes.memberId, members.id))
    .innerJoin(pokerSessions, eq(disputes.sessionId, pokerSessions.id))
    .orderBy(
      sql`case when ${disputes.status} = 'open' then 0 else 1 end`,
      sql`case when ${disputes.status} = 'open' then ${disputes.createdAt} else ${disputes.resolvedAt} end desc`
    )
    .limit(100);

  return { disputes: rows };
}

/** POST /admin/disputes/:id/resolve — dismiss or resolve (with corrections). */
async function resolveDispute(ctx: Ctx): Promise<unknown> {
  requireAdmin(ctx);
  const { outcome, note, corrections } = resolveSchema.parse(ctx.body);

  const id = ctx.params.id ?? "";
  if (!z.uuid().safeParse(id).success) throw notFound("Dispute not found.");

  const dispute = (
    await db
      .select()
      .from(disputes)
      .where(eq(disputes.id, id))
      .limit(1)
  )[0];
  if (!dispute) throw notFound("Dispute not found.");
  if (dispute.status !== "open") {
    throw conflict("This dispute is no longer open.");
  }

  const session = (
    await db
      .select({
        id: pokerSessions.id,
        status: pokerSessions.status,
        version: pokerSessions.version
      })
      .from(pokerSessions)
      .where(eq(pokerSessions.id, dispute.sessionId))
      .limit(1)
  )[0];
  if (!session) throw notFound("Session not found.");

  const result = await db.transaction(async (tx) => {
    const updated = await tx
      .update(disputes)
      .set({
        status: outcome,
        resolvedAt: new Date(),
        resolutionNote: note ?? null
      })
      .where(and(eq(disputes.id, dispute.id), eq(disputes.status, "open")))
      .returning({ id: disputes.id });
    if (updated.length === 0) throw conflict("This dispute is no longer open.");

    if (outcome === "resolved" && corrections) {
      return await applyCorrections(tx, dispute, session, corrections, note);
    }

    // Dismissed (or resolved without corrections): results are untouched.
    await tx
      .update(pokerSessions)
      .set({ status: outcome === "resolved" ? "resolved" : "active" })
      .where(
        and(
          eq(pokerSessions.id, session.id),
          eq(pokerSessions.status, "disputed")
        )
      );
    // Revoke this member's still-live tokens; do not reissue.
    await tx
      .update(disputeTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(disputeTokens.sessionId, session.id),
          eq(disputeTokens.memberId, dispute.memberId),
          isNull(disputeTokens.usedAt),
          isNull(disputeTokens.revokedAt)
        )
      );
    await writeAudit(tx, {
      action: "dispute.resolve",
      entityType: "dispute",
      entityId: dispute.id,
      actorLabel: "admin",
      afterJson: { outcome, note }
    });
    return {
      sessionStatus: outcome === "resolved" ? "resolved" : "active",
      version: session.version,
      newVersion: null
    };
  });

  if (result.newVersion !== null) {
    // After commit: best-effort receipt pump; never blocks or throws.
    void notifyEntity("session", session.id, result.newVersion);
  }

  return {
    dispute: {
      id: dispute.id,
      sessionId: dispute.sessionId,
      memberId: dispute.memberId,
      reason: dispute.reason,
      status: outcome,
      resolutionNote: note ?? null,
      createdAt: dispute.createdAt,
      resolvedAt: new Date()
    },
    session: { id: session.id, status: result.sessionStatus, version: result.version }
  };
}

/**
 * Resolved-with-corrections path (runs inside the resolve transaction):
 * validate, bump version, replace results, rotate tokens, enqueue receipts.
 */
async function applyCorrections(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  dispute: { id: string; sessionId: string },
  session: { id: string; version: number },
  corrections: { memberId: string; amountCents: number }[],
  note: string | null | undefined
): Promise<{ sessionStatus: string; version: number; newVersion: number }> {
  const v = validateSessionResults(corrections);
  if (!v.ok) {
    throw new ApiError(400, "validation", "Corrections are invalid.", {
      corrections: v.errors
    });
  }

  const ids = [...new Set(corrections.map((c) => c.memberId))];
  const membersRows = await tx
    .select({
      id: members.id,
      displayName: members.displayName,
      emailNormalized: members.emailNormalized,
      status: members.status
    })
    .from(members)
    .where(inArray(members.id, ids));
  if (
    membersRows.length !== ids.length ||
    membersRows.some((m) => m.status !== "active")
  ) {
    throw new ApiError(
      400,
      "validation",
      "Corrections are invalid.",
      { corrections: ["Every participant must be an active member."] }
    );
  }
  const byId = new Map(membersRows.map((m) => [m.id, m]));

  const oldResults = await tx
    .select({
      memberId: sessionResults.memberId,
      amountCents: sessionResults.amountCents
    })
    .from(sessionResults)
    .where(eq(sessionResults.sessionId, session.id));

  const newVersion = session.version + 1;
  const updated = await tx
    .update(pokerSessions)
    .set({ status: "resolved", version: newVersion })
    .where(and(eq(pokerSessions.id, session.id), eq(pokerSessions.version, session.version)))
    .returning({ id: pokerSessions.id, status: pokerSessions.status, version: pokerSessions.version });
  if (updated.length === 0) {
    throw new ApiError(409, "stale", "The session was modified; please retry.");
  }

  await tx
    .delete(sessionResults)
    .where(eq(sessionResults.sessionId, session.id));
  await tx.insert(sessionResults).values(
    corrections.map((c) => ({
      sessionId: session.id,
      memberId: c.memberId,
      amountCents: c.amountCents
    }))
  );

  // Rotate dispute tokens: revoke every live token for the session…
  await tx
    .update(disputeTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(disputeTokens.sessionId, session.id), isNull(disputeTokens.revokedAt))
    );
  // …and issue fresh ones to the correction participants (30-day TTL).
  const now = Date.now();
  const fresh = corrections.map((c) => ({
    tokenHash: hashToken(generateToken()),
    sessionId: session.id,
    memberId: c.memberId,
    expiresAt: new Date(now + TOKEN_TTL_DAYS * 24 * 3600 * 1000)
  }));
  await tx.insert(disputeTokens).values(fresh);

  // Corrected receipts at the NEW version for each participant.
  for (const c of corrections) {
    const member = byId.get(c.memberId);
    if (!member) continue;
    await enqueueEmail(tx, {
      eventType: "session_receipt",
      entityType: "session",
      entityId: session.id,
      version: newVersion,
      recipientEmail: member.emailNormalized,
      recipientMemberId: member.id
    });
  }

  await writeAudit(tx, {
    action: "dispute.resolve",
    entityType: "dispute",
    entityId: dispute.id,
    actorLabel: "admin",
    afterJson: { outcome: "resolved", note }
  });
  await writeAudit(tx, {
    action: "session.correction",
    entityType: "session",
    entityId: session.id,
    actorLabel: "admin",
    beforeJson: { version: session.version, results: oldResults },
    afterJson: { version: newVersion, results: corrections }
  });

  return { sessionStatus: "resolved", version: newVersion, newVersion };
}

export function registerDisputesRoutes(router: Router): void {
  router.post("api/poker/disputes/verify-token", verifyToken);
  router.post("api/poker/disputes", openDispute);
  router.get("api/poker/admin/disputes", listDisputes);
  router.post("api/poker/admin/disputes/:id/resolve", resolveDispute);
}

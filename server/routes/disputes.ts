/**
 * Dispute workflow.
 *
 * SECURITY (§1 remediation): BOTH dispute endpoints require a valid GROUP
 * cookie before any token work. The email token is an additional
 * authorization layer (proof of receipt), never a substitute for group
 * membership — a forwarded receipt alone cannot touch the ledger, and token
 * validity is never observable without group authentication. Raw tokens
 * never appear in logs, audits, or error messages (hashes only).
 *
 * TRANSACTIONS (§3): opening a dispute is one database transaction — token
 * consumption, open-dispute guard, dispute insert, session flag, audit, and
 * notification outbox rows all commit or roll back together. A failed
 * transaction leaves the token usable; concurrent submissions cannot both
 * succeed.
 *
 * STATUS (§4): session status derives from ALL of its disputes via
 * deriveSessionStatus — voided stays voided; any open dispute → disputed;
 * otherwise resolved if any dispute was resolved, else active.
 */
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin, requireGroup } from "../auth.js";
import { db } from "../db/client.js";
import {
  disputeTokens,
  disputes,
  members,
  pokerSessions,
  sessionResults
} from "../db/schema.js";
import type { PokerSessionRow } from "../db/schema.js";
import { writeAudit } from "../domain/audit.js";
import { validateSessionResults } from "../domain/money.js";
import { generateToken, hashToken, TOKEN_TTL_DAYS } from "../domain/tokens.js";
import { enqueueEmail } from "../email/outbox.js";
import { notifyEntity } from "../email/notify.js";
import { env } from "../env.js";
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Roll back the open-dispute transaction and map to a stable 4xx response. */
class TxAbort extends Error {
  constructor(
    readonly kind: "token" | "open" | "conflict",
    message: string
  ) {
    super(message);
  }
}

async function enforceRateLimit(ctx: Ctx, preset: RatePreset): Promise<void> {
  const r = await checkRateLimit(db, preset, clientKey(ctx.req));
  if (!r.ok) throw rateLimited(r.retryAfterSec);
}

/**
 * Deterministic session status from ALL disputes (§4):
 * voided > any open dispute > any resolved dispute > active.
 */
async function deriveSessionStatus(
  tx: Tx,
  sessionId: string
): Promise<PokerSessionRow["status"]> {
  const [session] = await tx
    .select({ status: pokerSessions.status })
    .from(pokerSessions)
    .where(eq(pokerSessions.id, sessionId))
    .limit(1);
  if (!session || session.status === "voided") return "voided";
  const [open] = await tx
    .select({ n: count() })
    .from(disputes)
    .where(and(eq(disputes.sessionId, sessionId), eq(disputes.status, "open")));
  if ((open?.n ?? 0) > 0) return "disputed";
  const [resolved] = await tx
    .select({ n: count() })
    .from(disputes)
    .where(and(eq(disputes.sessionId, sessionId), eq(disputes.status, "resolved")));
  return (resolved?.n ?? 0) > 0 ? "resolved" : "active";
}

/** POST /disputes/verify-token — group password + the token as proof of receipt. */
async function verifyToken(ctx: Ctx): Promise<unknown> {
  await enforceRateLimit(ctx, RATE.TOKEN_PER_IP);
  requireGroup(ctx); // §1: never reveal token validity without group auth.
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

/** POST /disputes — consume a receipt token and open a dispute (§1 + §3). */
async function openDispute(ctx: Ctx): Promise<unknown> {
  await enforceRateLimit(ctx, RATE.DISPUTE_PER_IP);
  requireGroup(ctx); // §1: password gates the whole dispute flow.
  const { token, reason } = openSchema.parse(ctx.body);
  const hash = hashToken(token);

  let created: {
    disputeId: string;
    createdAt: Date;
    sessionId: string;
    memberId: string;
    memberName: string;
  };
  try {
    created = await db.transaction(async (tx) => {
      // 1. Atomically consume the token inside the transaction. The row lock
      //    serializes concurrent submissions: only one can flip used_at.
      const consumed = await tx
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
        .returning({
          id: disputeTokens.id,
          sessionId: disputeTokens.sessionId,
          memberId: disputeTokens.memberId
        });
      if (consumed.length === 0) throw new TxAbort("token", TOKEN_INVALID_MSG);
      const tok = consumed[0]!;

      const [memberRow] = await tx
        .select({ displayName: members.displayName, emailNormalized: members.emailNormalized })
        .from(members)
        .where(eq(members.id, tok.memberId))
        .limit(1);

      // 2. One open dispute per member/session.
      const existing = await tx
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
      if (existing.length > 0) throw new TxAbort("open", ALREADY_OPEN_MSG);

      // 3. Insert (the partial unique index backs up the check).
      let inserted;
      try {
        inserted = await tx
          .insert(disputes)
          .values({ sessionId: tok.sessionId, memberId: tok.memberId, reason, status: "open" })
          .returning({ id: disputes.id, createdAt: disputes.createdAt });
      } catch (err) {
        // drizzle wraps driver errors (PostgresError lives on .cause).
        const code =
          (err as { code?: unknown } | null)?.code ??
          ((err as { cause?: { code?: unknown } } | null)?.cause?.code ?? null);
        if (code === "23505") {
          throw new TxAbort("open", ALREADY_OPEN_MSG);
        }
        throw err;
      }

      // 4. Flag the session disputed (active → disputed only; version untouched —
      //    versions change exclusively on admin-led mutations).
      await tx
        .update(pokerSessions)
        .set({ status: "disputed" })
        .where(and(eq(pokerSessions.id, tok.sessionId), eq(pokerSessions.status, "active")));

      // 5. Audit inside the transaction.
      await writeAudit(tx, {
        action: "dispute.open",
        entityType: "dispute",
        entityId: inserted[0]!.id,
        actorLabel: `member:${memberRow?.displayName ?? "member"}`,
        afterJson: { sessionId: tok.sessionId, memberId: tok.memberId, reason }
      });

      // 6. Notification outbox rows (inside the tx; sending happens after commit).
      const adminEmail = env().POKER_ADMIN_NOTIFY_EMAIL;
      if (adminEmail) {
        await enqueueEmail(tx, {
          eventType: "dispute_opened",
          entityType: "dispute",
          entityId: inserted[0]!.id,
          version: 1,
          recipientEmail: adminEmail
        });
      }
      if (memberRow?.emailNormalized) {
        await enqueueEmail(tx, {
          eventType: "dispute_opened_ack",
          entityType: "dispute",
          entityId: inserted[0]!.id,
          version: 1,
          recipientEmail: memberRow.emailNormalized,
          recipientMemberId: tok.memberId
        });
      }

      return {
        disputeId: inserted[0]!.id,
        createdAt: inserted[0]!.createdAt,
        sessionId: tok.sessionId,
        memberId: tok.memberId,
        memberName: memberRow?.displayName ?? "member"
      };
    });
  } catch (err) {
    if (err instanceof TxAbort) {
      if (err.kind === "token") throw tokenInvalid409();
      if (err.kind === "open") throw conflict(ALREADY_OPEN_MSG);
      throw conflict(err.message);
    }
    throw err;
  }

  // After commit: best-effort email pump; queued rows persist for retries.
  void notifyEntity("dispute", created.disputeId, 1);

  ctx.res.statusCode = 201;
  return {
    dispute: {
      id: created.disputeId,
      sessionId: created.sessionId,
      memberId: created.memberId,
      status: "open",
      createdAt: created.createdAt
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

  // Load inside the transaction with a row lock so concurrent resolutions
  // serialize instead of racing on the same open dispute.
  const result = await db.transaction(async (tx) => {
    const [dispute] = await tx
      .select()
      .from(disputes)
      .where(eq(disputes.id, id))
      .for("update")
      .limit(1);
    if (!dispute) throw notFound("Dispute not found.");
    if (dispute.status !== "open") {
      throw conflict("This dispute is no longer open.");
    }

    const [session] = await tx
      .select({ id: pokerSessions.id, status: pokerSessions.status, version: pokerSessions.version })
      .from(pokerSessions)
      .where(eq(pokerSessions.id, dispute.sessionId))
      .for("update")
      .limit(1);
    if (!session) throw notFound("Session not found.");
    // Voided sessions may still have their disputes resolved/dismissed — the
    // derived status below guarantees a voided session never reverts.

    // Mark the dispute resolved/dismissed first, then the derived status
    // below reflects the NEW state of all disputes for the session (§4).
    const updated = await tx
      .update(disputes)
      .set({ status: outcome, resolvedAt: new Date(), resolutionNote: note ?? null })
      .where(and(eq(disputes.id, dispute.id), eq(disputes.status, "open")))
      .returning({ id: disputes.id });
    if (updated.length === 0) throw conflict("This dispute is no longer open.");

    let newVersion: number | null = null;
    if (outcome === "resolved" && corrections) {
      newVersion = await applyCorrections(tx, dispute, session, corrections, note);
    } else {
      // Dismissed (or resolved without corrections): results are untouched;
      // revoke this member's still-live tokens; do not reissue.
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
    }

    // Derive the session status from ALL disputes and persist it.
    const derived = await deriveSessionStatus(tx, session.id);
    await tx.update(pokerSessions).set({ status: derived }).where(eq(pokerSessions.id, session.id));

    await writeAudit(tx, {
      action: "dispute.resolve",
      entityType: "dispute",
      entityId: dispute.id,
      actorLabel: "admin",
      afterJson: { outcome, note }
    });

    // Notification outbox rows: ack to the disputing participant.
    const [memberRow] = await tx
      .select({ emailNormalized: members.emailNormalized })
      .from(members)
      .where(eq(members.id, dispute.memberId))
      .limit(1);
    if (memberRow?.emailNormalized) {
      await enqueueEmail(tx, {
        eventType: outcome === "resolved" ? "dispute_resolved" : "dispute_dismissed",
        entityType: "dispute",
        entityId: dispute.id,
        version: 1,
        recipientEmail: memberRow.emailNormalized,
        recipientMemberId: dispute.memberId
      });
    }

    return {
      sessionStatus: derived,
      version: newVersion ?? session.version,
      newVersion,
      sessionId: session.id
    };
  });

  // After commit: best-effort pumps (outbox rows persist for retries).
  void notifyEntity("dispute", id, 1);
  if (result.newVersion !== null) {
    void notifyEntity("session", result.sessionId, result.newVersion);
  }

  const [disputeAfter] = await db
    .select({ sessionId: disputes.sessionId, memberId: disputes.memberId, reason: disputes.reason, createdAt: disputes.createdAt })
    .from(disputes)
    .where(eq(disputes.id, id))
    .limit(1);

  return {
    dispute: {
      id,
      sessionId: disputeAfter?.sessionId,
      memberId: disputeAfter?.memberId,
      reason: disputeAfter?.reason,
      status: outcome,
      resolutionNote: note ?? null,
      createdAt: disputeAfter?.createdAt,
      resolvedAt: new Date()
    },
    session: { id: disputeAfter?.sessionId, status: result.sessionStatus, version: result.version }
  };
}

async function loadSessionId(disputeId: string): Promise<string | null> {
  const [row] = await db
    .select({ sessionId: disputes.sessionId })
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .limit(1);
  return row?.sessionId ?? null;
}

/**
 * Resolved-with-corrections path (runs inside the resolve transaction):
 * validate, bump version, replace results, rotate tokens, enqueue receipts.
 * Returns the new session version. Does NOT set the session status — the
 * caller derives it from all disputes (§4).
 */
async function applyCorrections(
  tx: Tx,
  dispute: { id: string; sessionId: string },
  session: { id: string; version: number },
  corrections: { memberId: string; amountCents: number }[],
  note: string | null | undefined
): Promise<number> {
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
  if (membersRows.length !== ids.length || membersRows.some((m) => m.status !== "active")) {
    throw new ApiError(400, "validation", "Corrections are invalid.", {
      corrections: ["Every participant must be an active member."]
    });
  }
  const byId = new Map(membersRows.map((m) => [m.id, m]));

  const oldResults = await tx
    .select({ memberId: sessionResults.memberId, amountCents: sessionResults.amountCents })
    .from(sessionResults)
    .where(eq(sessionResults.sessionId, session.id));

  const newVersion = session.version + 1;
  const updated = await tx
    .update(pokerSessions)
    .set({ version: newVersion })
    .where(and(eq(pokerSessions.id, session.id), eq(pokerSessions.version, session.version)))
    .returning({ id: pokerSessions.id, version: pokerSessions.version });
  if (updated.length === 0) {
    throw new ApiError(409, "conflict", "The session was modified; please retry.");
  }

  await tx.delete(sessionResults).where(eq(sessionResults.sessionId, session.id));
  await tx.insert(sessionResults).values(
    corrections.map((c) => ({ sessionId: session.id, memberId: c.memberId, amountCents: c.amountCents }))
  );

  // Rotate dispute tokens: revoke every live token for the session…
  await tx
    .update(disputeTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(disputeTokens.sessionId, session.id), isNull(disputeTokens.revokedAt)));
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
    action: "session.correction",
    entityType: "session",
    entityId: session.id,
    actorLabel: "admin",
    beforeJson: { version: session.version, results: oldResults },
    afterJson: { version: newVersion, results: corrections }
  });

  return newVersion;
}

export function registerDisputesRoutes(router: Router): void {
  router.post("api/poker/disputes/verify-token", verifyToken);
  router.post("api/poker/disputes", openDispute);
  router.get("api/poker/admin/disputes", listDisputes);
  router.post("api/poker/admin/disputes/:id/resolve", resolveDispute);
}

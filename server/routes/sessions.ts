/**
 * Sessions + ledger routes.
 *
 * Money is integer cents. Dispute tokens are stored hashed-only; raw tokens
 * are never returned by any response. Session creation is transactional and
 * idempotent via a unique request key; admin edits use optimistic concurrency
 * on `version` (stale edits → 409) and voiding is idempotent.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { requireAdmin, requireGroup, requireViewer } from "../auth.js";
import { db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { disputeTokens, members, pokerSessions, sessionResults } from "../db/schema.js";
import type { PokerSessionRow } from "../db/schema.js";
import { writeAudit } from "../domain/audit.js";
import { MAX_AMOUNT_CENTS, validateSessionResults } from "../domain/money.js";
import { generateToken, hashToken, TOKEN_TTL_DAYS } from "../domain/tokens.js";
import { enqueueEmail } from "../email/outbox.js";
import { notifyEntity } from "../email/notify.js";
import { ApiError, conflict, notFound } from "../errors.js";
import type { Ctx, Router } from "../router.js";

type Db = PostgresJsDatabase<typeof schema>;
type SessionStatus = PokerSessionRow["status"];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const resultSchema = z.object({
  memberId: z.string().uuid(),
  amountCents: z
    .number()
    .int()
    .min(-MAX_AMOUNT_CENTS)
    .max(MAX_AMOUNT_CENTS)
    .refine((v) => v !== 0, "Amount must be non-zero")
});

const resultsSchema = z.array(resultSchema).min(2);

const createBodySchema = z.object({
  requestKey: z.string().min(8).max(64),
  playedAt: z.string().datetime(),
  title: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  results: resultsSchema
});

const editBodySchema = z.object({
  version: z.number().int().min(1),
  playedAt: z.string().datetime().optional(),
  title: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  results: resultsSchema.optional()
});

type CreateBody = z.infer<typeof createBodySchema>;
type EditBody = z.infer<typeof editBodySchema>;
type ResultInput = z.infer<typeof resultSchema>;

// ---------------------------------------------------------------------------
// Shared payload shapes
// ---------------------------------------------------------------------------
interface ParticipantPayload {
  memberId: string;
  name: string;
  amountCents: number;
}

interface SessionPayload {
  id: string;
  playedAt: string;
  title: string | null;
  notes: string | null;
  status: SessionStatus;
  version: number;
  recordedBy: { id: string; name: string } | null;
  participants: ParticipantPayload[];
  totalCents: number;
}

/** Session row without timestamps we don't expose. */
interface SessionListRow {
  id: string;
  playedAt: Date;
  title: string | null;
  status: SessionStatus;
  version: number;
  recordedByMemberId: string | null;
}

function sessionPayload(
  s: SessionListRow,
  participants: ParticipantPayload[],
  recordedByName: string | undefined,
  extra: Pick<SessionPayload, "notes" | "totalCents">
): SessionPayload {
  return {
    id: s.id,
    playedAt: s.playedAt.toISOString(),
    title: s.title,
    status: s.status,
    version: s.version,
    recordedBy: s.recordedByMemberId
      ? { id: s.recordedByMemberId, name: recordedByName ?? "Unknown" }
      : null,
    participants,
    ...extra
  };
}

async function loadSessionRow(dbx: Db, id: string): Promise<PokerSessionRow | null> {
  const rows = await dbx
    .select()
    .from(pokerSessions)
    .where(eq(pokerSessions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Participants grouped by session id, sorted by member name ASC. */
async function loadParticipants(
  dbx: Db,
  sessionIds: string[]
): Promise<Map<string, ParticipantPayload[]>> {
  const map = new Map<string, ParticipantPayload[]>();
  if (sessionIds.length === 0) return map;
  const rows = await dbx
    .select({
      sessionId: sessionResults.sessionId,
      memberId: sessionResults.memberId,
      name: members.displayName,
      amountCents: sessionResults.amountCents
    })
    .from(sessionResults)
    .innerJoin(members, eq(members.id, sessionResults.memberId))
    .where(inArray(sessionResults.sessionId, sessionIds));
  for (const r of rows) {
    const arr = map.get(r.sessionId) ?? [];
    arr.push({ memberId: r.memberId, name: r.name, amountCents: r.amountCents });
    map.set(r.sessionId, arr);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return map;
}

async function loadMemberNames(dbx: Db, ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (uniq.length === 0) return new Map();
  const rows = await dbx
    .select({ id: members.id, name: members.displayName })
    .from(members)
    .where(inArray(members.id, uniq));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Full detail payload (includes notes + totalCents) or null when missing. */
async function loadSessionDetail(dbx: Db, id: string): Promise<SessionPayload | null> {
  const s = await loadSessionRow(dbx, id);
  if (!s) return null;
  const participants = (await loadParticipants(dbx, [id])).get(id) ?? [];
  const names = await loadMemberNames(dbx, s.recordedByMemberId ? [s.recordedByMemberId] : []);
  return sessionPayload(
    s,
    participants,
    s.recordedByMemberId ? names.get(s.recordedByMemberId) : undefined,
    {
      notes: s.notes,
      totalCents: participants.reduce((acc, p) => acc + p.amountCents, 0)
    }
  );
}

/** Plain result rows (memberId + amountCents) — used for audit before/after. */
async function loadResults(dbx: Db, sessionId: string): Promise<ResultInput[]> {
  const rows = await dbx
    .select({
      memberId: sessionResults.memberId,
      amountCents: sessionResults.amountCents
    })
    .from(sessionResults)
    .where(eq(sessionResults.sessionId, sessionId));
  return rows;
}

/** Validate a result set against the domain rules; throws 400 with fieldErrors. */
async function validateResultsInput(dbx: Db, input: ResultInput[]): Promise<ResultInput[]> {
  const validation = validateSessionResults(input);
  if (!validation.ok) {
    throw new ApiError(400, "validation", "Invalid session results.", {
      results: validation.errors
    });
  }
  const memberIds = [...new Set(validation.results.map((r) => r.memberId))];
  const found = await dbx
    .select({
      id: members.id,
      displayName: members.displayName,
      emailNormalized: members.emailNormalized
    })
    .from(members)
    .where(and(inArray(members.id, memberIds), eq(members.status, "active")));
  if (found.length !== memberIds.length) {
    throw new ApiError(400, "validation", "Invalid session results.", {
      results: ["Every participant must be an active member."]
    });
  }
  return validation.results;
}

function isRequestKeyViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; cause?: unknown; message?: unknown };
  const cause = (e.cause ?? null) as { code?: unknown; message?: unknown } | null;
  const code = e.code ?? cause?.code;
  const msg = `${String(e.message ?? "")} ${String(cause?.message ?? "")}`;
  return code === "23505" && msg.includes("request_key");
}

const DAY_MS = 86_400_000;

/** Issue a hashed dispute token for one participant (transactional). */
async function issueDisputeToken(
  dbx: Db,
  sessionId: string,
  memberId: string
): Promise<void> {
  const token = generateToken();
  await dbx.insert(disputeTokens).values({
    sessionId,
    memberId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + TOKEN_TTL_DAYS * DAY_MS)
  });
}

/** Enqueue a receipt for one participant (transactional, idempotent). */
async function enqueueReceipt(
  dbx: Db,
  sessionId: string,
  version: number,
  member: { id: string; emailNormalized: string }
): Promise<void> {
  await enqueueEmail(dbx, {
    eventType: "session_receipt",
    entityType: "session",
    entityId: sessionId,
    version,
    recipientEmail: member.emailNormalized,
    recipientMemberId: member.id
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function registerSessionsRoutes(router: Router): void {
  // GET /api/poker/ledger — all-time net per active member.
  router.get("/api/poker/ledger", async (ctx: Ctx) => {
    const claims = requireGroup(ctx);
    const rows = await db
      .select({
        id: members.id,
        name: members.displayName,
        // ::bigint because sum()/count() return int8/numeric which postgres.js
        // hands back as strings; Number() below normalizes. Avoids int4 overflow.
        netCents: sql<string>`coalesce(sum(${sessionResults.amountCents}) filter (where ${pokerSessions.status} <> 'voided'), 0)::bigint`,
        sessionsPlayed: sql<string>`coalesce(count(distinct ${sessionResults.sessionId}) filter (where ${pokerSessions.status} <> 'voided'), 0)::bigint`,
        // to_char → ISO-8601 UTC string; raw timestamp aggregates come back as
        // untyped strings through the driver, so format server-side.
        lastPlayedAt: sql<string | null>`to_char((max(${pokerSessions.playedAt}) filter (where ${pokerSessions.status} <> 'voided')) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
      })
      .from(members)
      .leftJoin(sessionResults, eq(sessionResults.memberId, members.id))
      .leftJoin(pokerSessions, eq(pokerSessions.id, sessionResults.sessionId))
      // ALL members (active + inactive): the visible total must always sum to
      // exactly $0.00, which only holds if departed members stay in the ledger.
      // Deactivation only removes a member from selection/participation.
      .groupBy(members.id, members.displayName);
    rows.sort(
      (a, b) =>
        Number(b.netCents) - Number(a.netCents) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );
    const out = rows.map((r) => ({
      memberId: r.id,
      name: r.name,
      netCents: Number(r.netCents),
      sessionsPlayed: Number(r.sessionsPlayed),
      lastPlayedAt: r.lastPlayedAt ?? null,
      isViewer: r.id === claims.mid
    }));
    const totalCents = out.reduce((acc, r) => acc + r.netCents, 0);
    return { totalCents, rows: out };
  });

  // GET /api/poker/sessions — newest-first keyset pagination.
  router.get("/api/poker/sessions", async (ctx: Ctx) => {
    requireGroup(ctx);
    const rawLimit = ctx.query.get("limit");
    const parsed = rawLimit ? Number.parseInt(rawLimit, 10) : 20;
    const limit = Number.isFinite(parsed) ? Math.min(50, Math.max(1, parsed)) : 20;

    let after: { playedAt: Date; id: string } | null = null;
    const cursorId = ctx.query.get("cursor");
    if (cursorId) {
      const cursorRow = await loadSessionRow(db, cursorId);
      if (!cursorRow) {
        // Unknown cursor — nothing further to page.
        return { sessions: [], nextCursor: null };
      }
      after = { playedAt: cursorRow.playedAt, id: cursorRow.id };
    }

    const page = await db
      .select({
        id: pokerSessions.id,
        playedAt: pokerSessions.playedAt,
        title: pokerSessions.title,
        status: pokerSessions.status,
        version: pokerSessions.version,
        recordedByMemberId: pokerSessions.recordedByMemberId
      })
      .from(pokerSessions)
      .where(
        // NOTE: pass the cursor timestamp as an ISO string + explicit cast —
        // raw Date params crash the postgres.js driver when drizzle's
        // transparent serializer is installed (drizzle-orm/postgres-js).
        after
          ? sql`(${pokerSessions.playedAt}, ${pokerSessions.id}) < (${after.playedAt.toISOString()}::timestamptz, ${after.id})`
          : sql`true`
      )
      .orderBy(desc(pokerSessions.playedAt), desc(pokerSessions.id))
      .limit(limit + 1);

    const hasMore = page.length > limit;
    const items = hasMore ? page.slice(0, limit) : page;
    const nextCursor = hasMore ? items[items.length - 1]!.id : null;

    const participantsMap = await loadParticipants(
      db,
      items.map((s) => s.id)
    );
    const names = await loadMemberNames(
      db,
      items.map((s) => s.recordedByMemberId ?? "")
    );
    // List items omit notes/totalCents — detail-only fields.
    const sessions = items.map((s) => ({
      id: s.id,
      playedAt: s.playedAt.toISOString(),
      title: s.title,
      status: s.status,
      version: s.version,
      recordedBy: s.recordedByMemberId
        ? { id: s.recordedByMemberId, name: names.get(s.recordedByMemberId) ?? "Unknown" }
        : null,
      participants: participantsMap.get(s.id) ?? []
    }));
    return { sessions, nextCursor };
  });

  // POST /api/poker/sessions — create a session (idempotent via requestKey).
  router.post("/api/poker/sessions", async (ctx: Ctx) => {
    const claims = requireViewer(ctx);
    const viewerId = claims.mid!;
    const body = createBodySchema.parse(ctx.body) as CreateBody;

    const results = await validateResultsInput(db, body.results);

    const viewerRow = await db
      .select({ displayName: members.displayName })
      .from(members)
      .where(eq(members.id, viewerId))
      .limit(1);
    const viewerDisplayName = viewerRow[0]?.displayName ?? viewerId;

    const memberRows = await db
      .select({
        id: members.id,
        displayName: members.displayName,
        emailNormalized: members.emailNormalized
      })
      .from(members)
      .where(inArray(members.id, [...new Set(results.map((r) => r.memberId))]));
    const memberById = new Map(memberRows.map((m) => [m.id, m]));

    const sessionId = randomUUID();
    const playedAtDate = new Date(body.playedAt);
    const version = 1;

    try {
      await db.transaction(async (tx) => {
        await tx.insert(pokerSessions).values({
          id: sessionId,
          playedAt: playedAtDate,
          title: body.title ?? null,
          notes: body.notes ?? null,
          recordedByMemberId: viewerId,
          status: "active",
          version,
          requestKey: body.requestKey
        });
        await tx.insert(sessionResults).values(
          results.map((r) => ({
            sessionId,
            memberId: r.memberId,
            amountCents: r.amountCents
          }))
        );
        for (const r of results) {
          await issueDisputeToken(tx, sessionId, r.memberId);
          const m = memberById.get(r.memberId)!;
          await enqueueReceipt(tx, sessionId, version, m);
        }
        await writeAudit(tx, {
          actorLabel: `member:${viewerDisplayName}`,
          memberHint: viewerDisplayName,
          action: "session.create",
          entityType: "session",
          entityId: sessionId,
          afterJson: {
            id: sessionId,
            playedAt: body.playedAt,
            results: results.map((r) => ({ memberId: r.memberId, amountCents: r.amountCents }))
          }
        });
      });
    } catch (err) {
      if (isRequestKeyViolation(err)) {
        // Duplicate submission — return the existing session unchanged.
        const existing = await db
          .select({ id: pokerSessions.id })
          .from(pokerSessions)
          .where(eq(pokerSessions.requestKey, body.requestKey))
          .limit(1);
        const existingRow = existing[0];
        if (!existingRow) throw err;
        const session = await loadSessionDetail(db, existingRow.id);
        if (!session) throw err;
        return { session, duplicate: true };
      }
      throw err;
    }

    const session = await loadSessionDetail(db, sessionId);
    if (!session) throw new ApiError(500, "internal", "Session was not created.");

    // Best-effort email pump — never fails the request.
    await notifyEntity("session", sessionId, version);

    ctx.res.statusCode = 201;
    return { session, receiptsQueued: results.length };
  });

  // GET /api/poker/sessions/:id — session detail (notes only here).
  router.get("/api/poker/sessions/:id", async (ctx: Ctx) => {
    requireGroup(ctx);
    const session = await loadSessionDetail(db, ctx.params.id!);
    if (!session) throw notFound();
    return { session };
  });

  // PATCH /api/poker/admin/sessions/:id — edit/correct a session.
  router.patch("/api/poker/admin/sessions/:id", async (ctx: Ctx) => {
    requireAdmin(ctx);
    const sessionId = ctx.params.id!;
    const body = editBodySchema.parse(ctx.body) as EditBody;

    const existing = await loadSessionRow(db, sessionId);
    if (!existing) throw notFound();
    if (existing.status === "voided") throw conflict("Session is voided.");
    if (existing.version !== body.version) {
      throw conflict("Session was modified. Reload and try again.");
    }

    // Results change path: re-validate against fresh member state.
    let newResults: ResultInput[] | null = null;
    let memberById = new Map<string, { id: string; emailNormalized: string }>();
    const oldResults = body.results ? await loadResults(db, sessionId) : null;
    if (body.results) {
      const validated = await validateResultsInput(db, body.results);
      newResults = validated;
      const memberRows = await db
        .select({ id: members.id, emailNormalized: members.emailNormalized })
        .from(members)
        .where(inArray(members.id, [...new Set(validated.map((r) => r.memberId))]));
      memberById = new Map(memberRows.map((m) => [m.id, m]));
    }

    const oldVersion = existing.version;
    const newVersion = oldVersion + 1;

    const set: Record<string, unknown> = {
      version: sql`${pokerSessions.version} + 1`
    };
    if (body.playedAt !== undefined) set.playedAt = new Date(body.playedAt);
    if (body.title !== undefined) set.title = body.title;
    if (body.notes !== undefined) set.notes = body.notes;

    await db.transaction(async (tx) => {
      const updated = await tx
        .update(pokerSessions)
        .set(set)
        .where(
          and(
            eq(pokerSessions.id, sessionId),
            eq(pokerSessions.version, body.version),
            ne(pokerSessions.status, "voided")
          )
        )
        .returning({ id: pokerSessions.id });
      if (updated.length === 0) {
        // Lost the optimistic-concurrency race: distinguish 404 vs 409.
        const cur = await loadSessionRow(tx, sessionId);
        if (!cur) throw notFound();
        if (cur.status === "voided") throw conflict("Session is voided.");
        throw conflict("Session was modified. Reload and try again.");
      }

      if (newResults) {
        await tx.delete(sessionResults).where(eq(sessionResults.sessionId, sessionId));
        await tx.insert(sessionResults).values(
          newResults.map((r) => ({
            sessionId,
            memberId: r.memberId,
            amountCents: r.amountCents
          }))
        );
        // Revoke every outstanding token, then issue fresh ones.
        await tx
          .update(disputeTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(disputeTokens.sessionId, sessionId), isNull(disputeTokens.revokedAt)));
        for (const r of newResults) {
          await issueDisputeToken(tx, sessionId, r.memberId);
          const m = memberById.get(r.memberId)!;
          await enqueueReceipt(tx, sessionId, newVersion, m);
        }
      }

      await writeAudit(tx, {
        actorLabel: "admin",
        action: "session.edit",
        entityType: "session",
        entityId: sessionId,
        beforeJson: {
          version: oldVersion,
          ...(oldResults ? { results: oldResults } : {})
        },
        afterJson: {
          version: newVersion,
          ...(newResults ? { results: newResults } : {})
        }
      });
    });

    await notifyEntity("session", sessionId, newVersion);

    const session = await loadSessionDetail(db, sessionId);
    if (!session) throw new ApiError(500, "internal", "Session edit failed.");
    return { session };
  });

  // POST /api/poker/admin/sessions/:id/void — idempotent void.
  router.post("/api/poker/admin/sessions/:id/void", async (ctx: Ctx) => {
    requireAdmin(ctx);
    const sessionId = ctx.params.id!;

    const existing = await loadSessionRow(db, sessionId);
    if (!existing) throw notFound();
    if (existing.status === "voided") return { ok: true };

    const oldVersion = existing.version;
    const newVersion = oldVersion + 1;

    await db.transaction(async (tx) => {
      const updated = await tx
        .update(pokerSessions)
        .set({
          status: "voided",
          voidedAt: new Date(),
          version: sql`${pokerSessions.version} + 1`
        })
        .where(and(eq(pokerSessions.id, sessionId), ne(pokerSessions.status, "voided")))
        .returning({ id: pokerSessions.id });
      if (updated.length === 0) {
        // Concurrent void won — idempotent success.
        const cur = await loadSessionRow(tx, sessionId);
        if (!cur) throw notFound();
        return;
      }
      await tx
        .update(disputeTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(disputeTokens.sessionId, sessionId), isNull(disputeTokens.revokedAt)));
      await writeAudit(tx, {
        actorLabel: "admin",
        action: "session.void",
        entityType: "session",
        entityId: sessionId,
        beforeJson: { status: existing.status, version: oldVersion },
        afterJson: { status: "voided", version: newVersion }
      });
    });

    return { ok: true };
  });
}

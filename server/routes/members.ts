/**
 * Members + join-request routes.
 *
 * Security notes:
 * - POST /join-requests is public and rate-limited per IP. It NEVER reveals
 *   whether an email already exists: duplicates (partial unique index) and
 *   requests for existing members' emails all return the same generic
 *   success, so the endpoint cannot be used for account enumeration.
 * - Only a SHA-256 fingerprint of the requester's IP is stored
 *   (first 16 bytes, hex) — raw IP addresses are never persisted.
 * - Admin mutations are transactional: state change + audit + email outbox
 *   row commit atomically; the email pump runs best-effort after commit.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { requireAdmin, requireGroup } from "../auth.js";
import { db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { joinRequests, members } from "../db/schema.js";
import type { JoinRequestRow, MemberRow } from "../db/schema.js";
import { writeAudit } from "../domain/audit.js";
import { enqueueEmail } from "../email/outbox.js";
import { notifyEntity } from "../email/notify.js";
import { conflict, notFound, rateLimited } from "../errors.js";
import { checkRateLimit, clientKey, RATE } from "../rate-limit.js";
import type { Handler, Router } from "../router.js";

type Db = PostgresJsDatabase<typeof schema>;

const JOIN_REQUEST_RECEIVED = { ok: true, message: "Request received." } as const;

// ---------------------------------------------------------------------------
// Validation (zod v4). Emails are validated AFTER trimming so surrounding
// whitespace never causes a false "invalid email"; the parsed output is
// already trimmed and is normalized (toLowerCase) before any comparison.
// ---------------------------------------------------------------------------
const displayNameSchema = z.string().trim().min(1).max(80);
const emailSchema = z.string().trim().pipe(z.email("Invalid email address."));
const noteSchema = z.string().trim().max(500);

const joinRequestBodySchema = z.object({
  displayName: displayNameSchema,
  email: emailSchema,
  note: noteSchema.optional()
});

const createMemberSchema = z.object({
  displayName: displayNameSchema,
  email: emailSchema.optional().or(z.literal("")),
  welcomeEmail: z.boolean().optional()
});

const patchMemberSchema = z.object({
  displayName: displayNameSchema.optional(),
  status: z.enum(["active", "inactive"]).optional()
});

const normalizeEmail = (s: string): string => s.trim().toLowerCase();

/**
 * drizzle 0.45 wraps failed queries in DrizzleQueryError — the postgres
 * error (with its SQLSTATE `code`) lives on `.cause`. Check both levels so
 * the check survives either shape.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; cause?: unknown };
  if (e.code === "23505") return true;
  const cause = e.cause as { code?: string } | undefined;
  return typeof cause === "object" && cause !== null && cause.code === "23505";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Best-effort requester IP: first x-forwarded-for entry, else socket addr. */
function requestIp(req: Parameters<typeof clientKey>[0]): string {
  const xff = req.headers["x-forwarded-for"];
  return (
    (Array.isArray(xff) ? xff[0] : xff?.split(",")[0]?.trim()) ??
    req.socket.remoteAddress ??
    "unknown"
  );
}

/** First 16 bytes of sha256(ip) as hex — a fingerprint, never the raw IP. */
function requestIpHash(req: Parameters<typeof clientKey>[0]): string {
  return createHash("sha256").update(requestIp(req)).digest("hex").slice(0, 32);
}

async function enforceJoinRateLimit(req: Parameters<typeof clientKey>[0]): Promise<void> {
  const r = await checkRateLimit(db, RATE.JOIN_PER_IP, clientKey(req));
  if (!r.ok) throw rateLimited(r.retryAfterSec);
}

async function loadJoinRequest(dbx: Db, id: string): Promise<JoinRequestRow | null> {
  const rows = await dbx.select().from(joinRequests).where(eq(joinRequests.id, id)).limit(1);
  return rows[0] ?? null;
}

async function findMemberByEmail(dbx: Db, emailNormalized: string): Promise<MemberRow | null> {
  const rows = await dbx
    .select()
    .from(members)
    .where(eq(members.emailNormalized, emailNormalized))
    .limit(1);
  return rows[0] ?? null;
}

async function findPendingRequest(dbx: Db, emailNormalized: string): Promise<JoinRequestRow | null> {
  const rows = await dbx
    .select()
    .from(joinRequests)
    .where(
      and(
        eq(joinRequests.emailNormalized, emailNormalized),
        eq(joinRequests.status, "pending")
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Rejects non-UUID ids with 404 so malformed ids never disclose anything. */
function requireUuid(id: string | undefined, message: string): string {
  if (!id || !z.uuid().safeParse(id).success) throw notFound(message);
  return id;
}

/**
 * The catch-all Vercel function and the local dev server forward the FULL
 * `/api/poker/*` path to the router, but route modules register paths without
 * that mount prefix. Register both forms so routing works whether or not the
 * prefix is stripped upstream.
 */
function route(
  router: Router,
  method: "get" | "post" | "patch" | "delete",
  path: string,
  handler: Handler
): void {
  router[method](path, handler);
  router[method](`/api/poker${path}`, handler);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function registerMembersRoutes(router: Router): void {
  // POST /join-requests — public, rate-limited, anti-enumeration.
  route(router, "post", "/join-requests", async (ctx) => {
    await enforceJoinRateLimit(ctx.req);
    const body = joinRequestBodySchema.parse(ctx.body);
    const emailNormalized = body.email ? normalizeEmail(body.email) : `noemail+${randomUUID()}@invalid.local`;

    // Anti-enumeration: existing ACTIVE members silently "receive" the
    // request — no row is created and no indication is given either way.
    const existing = await findMemberByEmail(db, emailNormalized);
    if (existing && existing.status === "active") {
      return JOIN_REQUEST_RECEIVED;
    }

    try {
      await db.insert(joinRequests).values({
        displayName: body.displayName,
        emailNormalized,
        note: body.note ?? null,
        requestIpHash: requestIpHash(ctx.req)
      });
    } catch (err) {
      // 23505 = partial unique index on pending email — a duplicate request
      // looks exactly like a first-time request.
      if (isUniqueViolation(err)) {
        return JOIN_REQUEST_RECEIVED;
      }
      throw err;
    }
    return JOIN_REQUEST_RECEIVED;
  });

  // GET /members — active members only, name asc. No emails, no counts.
  route(router, "get", "/members", async (ctx) => {
    requireGroup(ctx);
    const rows = await db
      .select({ id: members.id, name: members.displayName })
      .from(members)
      .where(eq(members.status, "active"))
      .orderBy(asc(members.displayName), asc(members.id));
    return { members: rows };
  });

  // GET /admin/join-requests — everything except rejected, newest first.
  route(router, "get", "/admin/join-requests", async (ctx) => {
    requireAdmin(ctx);
    const rows = await db
      .select({
        id: joinRequests.id,
        displayName: joinRequests.displayName,
        email: joinRequests.emailNormalized,
        note: joinRequests.note,
        status: joinRequests.status,
        requestedAt: joinRequests.requestedAt
      })
      .from(joinRequests)
      .where(ne(joinRequests.status, "rejected"))
      .orderBy(desc(joinRequests.requestedAt), desc(joinRequests.id))
      .limit(200);
    return {
      requests: rows.map((r) => ({ ...r, requestedAt: r.requestedAt.toISOString() }))
    };
  });

  // POST /admin/join-requests/:id/approve — turn a pending request into a
  // member. Request state, member, audit, and outbox row commit atomically.
  route(router, "post", "/admin/join-requests/:id/approve", async (ctx) => {
    requireAdmin(ctx);
    const id = requireUuid(ctx.params.id, "Join request not found.");
    const request = await loadJoinRequest(db, id);
    if (!request) throw notFound("Join request not found.");
    if (request.status !== "pending") {
      throw conflict("This request was already reviewed.");
    }
    const emailNormalized = request.emailNormalized;
    if (await findMemberByEmail(db, emailNormalized)) {
      throw conflict("A member with this email already exists.");
    }

    let member: { id: string; displayName: string };
    try {
      member = await db.transaction(async (tx) => {
        await tx
          .update(joinRequests)
          .set({ status: "approved", reviewedAt: new Date() })
          .where(eq(joinRequests.id, request.id));
        const inserted = await tx
          .insert(members)
          .values({ displayName: request.displayName, emailNormalized, status: "active" })
          .returning({ id: members.id, displayName: members.displayName });
        const m = inserted[0]!;
        await enqueueEmail(tx, {
          eventType: "member_approved",
          entityType: "member",
          entityId: m.id,
          version: 1,
          recipientEmail: emailNormalized,
          recipientMemberId: m.id
        });
        await writeAudit(tx, {
          actorLabel: "admin",
          action: "member.approve",
          entityType: "join_request",
          entityId: request.id,
          beforeJson: {
            id: request.id,
            displayName: request.displayName,
            emailNormalized,
            status: request.status
          },
          afterJson: { memberId: m.id }
        });
        return m;
      });
    } catch (err) {
      // Concurrent approval created the member first — surface as a conflict.
      if (isUniqueViolation(err)) {
        throw conflict("A member with this email already exists.");
      }
      throw err;
    }

    // Best-effort email pump after commit — never fails the request.
    await notifyEntity("member", member.id, 1);

    ctx.res.statusCode = 201;
    return { member: { id: member.id, name: member.displayName } };
  });

  // POST /admin/join-requests/:id/reject.
  route(router, "post", "/admin/join-requests/:id/reject", async (ctx) => {
    requireAdmin(ctx);
    const id = requireUuid(ctx.params.id, "Join request not found.");
    const request = await loadJoinRequest(db, id);
    if (!request) throw notFound("Join request not found.");
    if (request.status !== "pending") {
      throw conflict("This request was already reviewed.");
    }

    await db.transaction(async (tx) => {
      await tx
        .update(joinRequests)
        .set({ status: "rejected", reviewedAt: new Date() })
        .where(eq(joinRequests.id, request.id));
      await writeAudit(tx, {
        actorLabel: "admin",
        action: "member.reject",
        entityType: "join_request",
        entityId: request.id,
        beforeJson: {
          id: request.id,
          displayName: request.displayName,
          emailNormalized: request.emailNormalized,
          status: request.status
        },
        afterJson: { status: "rejected" }
      });
    });

    return { ok: true };
  });

  // POST /admin/members — Amit directly adds a friend. If a pending join
  // request already exists for that email, it is approved as part of this
  // add (the two paths merge into one member).
  route(router, "post", "/admin/members", async (ctx) => {
    requireAdmin(ctx);
    const body = createMemberSchema.parse(ctx.body);
    const emailNormalized = body.email ? normalizeEmail(body.email) : `noemail+${randomUUID()}@invalid.local`;

    if (body.email && await findMemberByEmail(db, emailNormalized)) {
      throw conflict("A member with this email already exists.");
    }
    const pending = body.email ? await findPendingRequest(db, emailNormalized) : null;

    const member = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(members)
        .values({ displayName: body.displayName, emailNormalized, status: "active" })
        .returning({ id: members.id, displayName: members.displayName });
      const m = inserted[0]!;

      if (pending) {
        // Merge path: the pending request is approved by this direct add.
        await tx
          .update(joinRequests)
          .set({ status: "approved", reviewedAt: new Date() })
          .where(eq(joinRequests.id, pending.id));
        await writeAudit(tx, {
          actorLabel: "admin",
          action: "member.approve",
          entityType: "join_request",
          entityId: pending.id,
          beforeJson: {
            id: pending.id,
            displayName: pending.displayName,
            emailNormalized,
            status: pending.status
          },
          afterJson: { memberId: m.id }
        });
      }

      await writeAudit(tx, {
        actorLabel: "admin",
        action: "member.create",
        entityType: "member",
        entityId: m.id,
        beforeJson: null,
        afterJson: { id: m.id, displayName: m.displayName, emailNormalized }
      });

      if (body.welcomeEmail && body.email) {
        await enqueueEmail(tx, {
          eventType: "member_welcome",
          entityType: "member",
          entityId: m.id,
          version: 1,
          recipientEmail: emailNormalized,
          recipientMemberId: m.id
        });
      }
      return m;
    });

    if (body.welcomeEmail && body.email) {
      // Best-effort email pump after commit — never fails the request.
      await notifyEntity("member", member.id, 1);
    }

    ctx.res.statusCode = 201;
    return { member: { id: member.id, name: member.displayName } };
  });

  // PATCH /admin/members/:id — edit display name and/or status (admin view
  // includes the email; the group-facing list never does).
  route(router, "patch", "/admin/members/:id", async (ctx) => {
    requireAdmin(ctx);
    const id = requireUuid(ctx.params.id, "Member not found.");
    const body = patchMemberSchema.parse(ctx.body);

    const rows = await db.select().from(members).where(eq(members.id, id)).limit(1);
    const current = rows[0] ?? null;
    if (!current) throw notFound("Member not found.");

    if (body.displayName === undefined && body.status === undefined) {
      // Nothing to change — idempotent no-op.
      return {
        member: {
          id: current.id,
          name: current.displayName,
          email: current.emailNormalized,
          status: current.status
        }
      };
    }

    const set: { displayName?: string; status?: "active" | "inactive" } = {};
    if (body.displayName !== undefined) set.displayName = body.displayName;
    if (body.status !== undefined) set.status = body.status;

    const updated = await db.transaction(async (tx) => {
      const result = await tx
        .update(members)
        .set(set)
        .where(eq(members.id, id))
        .returning({
          id: members.id,
          displayName: members.displayName,
          emailNormalized: members.emailNormalized,
          status: members.status
        });
      const row = result[0]!;
      await writeAudit(tx, {
        actorLabel: "admin",
        action: "member.update",
        entityType: "member",
        entityId: id,
        beforeJson: { displayName: current.displayName, status: current.status },
        afterJson: { displayName: row.displayName, status: row.status }
      });
      return row;
    });

    return {
      member: {
        id: updated.id,
        name: updated.displayName,
        email: updated.emailNormalized,
        status: updated.status
      }
    };
  });
}

/**
 * Integration tests for members + join-request routes.
 *
 * Runs against the REAL router + local Postgres (poker_test), reset per file.
 * Auth setup: shared group password login → poker_session cookie; admin
 * unlock (with the group cookie) → poker_admin cookie.
 *
 * NOTE: the email outbox pump is disabled for this file (RESEND_API_KEY is
 * deleted before any server module is imported) so enqueued email_deliveries
 * rows stay in "queued" status deterministically instead of racing a
 * provider call with the dummy test key.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditEvents,
  emailDeliveries,
  joinRequests,
  members
} from "../../server/db/schema.js";

// Must run BEFORE any server module: env() caches on first access, and
// dotenv/config (imported by server/env.js) would otherwise restore values
// from the repo .env at import time. Point it at a missing file and delete
// the dummy key so isEmailConfigured() is false and the outbox pump no-ops —
// email_deliveries rows then stay deterministically "queued" instead of
// racing a provider call (or flipping to "sent" via dev-mode).
process.env.DOTENV_CONFIG_PATH = "/nonexistent/env-file-for-tests";
delete process.env.RESEND_API_KEY;

const { openDb, resetDb } = await import("../helpers/db.js");
const { startTestServer } = await import("../helpers/server.js");

interface TestServer {
  url: string;
  close: () => Promise<void>;
}
interface TestDb {
  db: ReturnType<typeof openDb>["db"];
  end: () => Promise<void>;
}

let server: TestServer;
let conn: TestDb;
let base: string;

interface MemberLite {
  id: string;
  name: string;
}
interface MembersListBody {
  members: MemberLite[];
}
interface AdminJoinRequest {
  id: string;
  displayName: string;
  email: string;
  note: string | null;
  status: string;
  requestedAt: string;
}
interface RequestsListBody {
  requests: AdminJoinRequest[];
}
interface ErrorBody {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function cookieHeaders(cookies: Record<string, string>): Record<string, string> {
  const parts = Object.entries(cookies).map(
    ([name, value]) => `${name}=${encodeURIComponent(value)}`
  );
  return parts.length ? { Cookie: parts.join("; ") } : {};
}

function getJson(path: string, cookies: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/poker${path}`, { headers: cookieHeaders(cookies) });
}

function postJson(
  path: string,
  body: unknown,
  cookies: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${base}/api/poker${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookieHeaders(cookies) },
    body: JSON.stringify(body)
  });
}

function patchJson(
  path: string,
  body: unknown,
  cookies: Record<string, string>
): Promise<Response> {
  return fetch(`${base}/api/poker${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...cookieHeaders(cookies) },
    body: JSON.stringify(body)
  });
}

function cookieValue(res: Response, name: string): string | null {
  for (const line of res.headers.getSetCookie()) {
    const m = /^([^=]+)=([^;]*)/.exec(line);
    if (m && m[1] === name) return decodeURIComponent(m[2]!);
  }
  return null;
}

async function groupLogin(): Promise<string> {
  const res = await postJson("/auth/login", { password: "group-pass-test" });
  expect(res.status).toBe(200);
  const cookie = cookieValue(res, "poker_session");
  expect(cookie).toBeTruthy();
  return cookie!;
}

async function adminLogin(): Promise<{ poker_session: string; poker_admin: string }> {
  const poker_session = await groupLogin();
  const res = await postJson(
    "/admin/unlock",
    { password: "admin-pass-test" },
    { poker_session }
  );
  expect(res.status).toBe(200);
  const poker_admin = cookieValue(res, "poker_admin") as string;
  expect(poker_admin).toBeTruthy();
  return { poker_session, poker_admin };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("members + join requests API", () => {
  beforeAll(async () => {
    // Shared resetDb() drops only schema "public", but the drizzle migrator
    // keeps its applied-migration bookkeeping in its own "drizzle" schema,
    // which survives that drop — a stale "applied" mark would make the
    // migrator skip the migration and leave every table missing. Drop the
    // bookkeeping schema first so the migration always runs fresh.
    const databaseUrl =
      process.env.DATABASE_URL ?? "postgres://postgres:***@localhost:5432/poker_test";
    const cleanup = postgres(databaseUrl, { max: 1, prepare: false });
    await cleanup`drop schema if exists drizzle cascade`;
    await cleanup.end();

    await resetDb();
    conn = openDb();
    server = await startTestServer();
    base = server.url;
  });

  afterAll(async () => {
    await server?.close();
    await conn?.end();
  });

  it("rejects anonymous /members but accepts public join requests", async () => {
    const anon = await getJson("/members");
    expect(anon.status).toBe(401);
    const anonBody = (await anon.json()) as ErrorBody;
    expect(anonBody.error.code).toBe("unauthorized");

    const res = await postJson("/join-requests", {
      displayName: "Friend",
      email: "  Friend@Example.com ",
      note: "Hey, add me!"
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: "Request received." });
  });

  it("normalizes join requests, hashes the IP, dedupes, and never leaks member emails", async () => {
    // Row exists with normalized email + IP fingerprint (never the raw IP).
    const rows = await conn.db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.emailNormalized, "friend@example.com"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.displayName).toBe("Friend");
    expect(row.note).toBe("Hey, add me!");
    expect(row.status).toBe("pending");
    expect(row.requestIpHash).toMatch(/^[0-9a-f]{32}$/);
    expect(["127.0.0.1", "::1", "::ffff:127.0.0.1", "unknown"]).not.toContain(
      row.requestIpHash
    );

    // Duplicate email → same generic success, still exactly one pending row.
    const dup = await postJson("/join-requests", {
      displayName: "Friend Again",
      email: "Friend@Example.com"
    });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toEqual({ ok: true, message: "Request received." });
    const after = await conn.db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.emailNormalized, "friend@example.com"));
    expect(after).toHaveLength(1);

    // Email of an EXISTING member → generic success, no row inserted.
    await conn.db.insert(members).values({
      displayName: "Existing",
      emailNormalized: "existing@example.com",
      status: "active"
    });
    const ex = await postJson("/join-requests", {
      displayName: "Sneaky",
      email: "  EXISTING@Example.COM "
    });
    expect(ex.status).toBe(200);
    expect(await ex.json()).toEqual({ ok: true, message: "Request received." });
    const exRows = await conn.db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.emailNormalized, "existing@example.com"));
    expect(exRows).toHaveLength(0);
  });

  it("lists only ACTIVE members for the group (sorted, no emails); admin list needs admin", async () => {
    const group = await groupLogin();

    await conn.db.insert(members).values([
      { displayName: "Claire", emailNormalized: "claire@example.com", status: "active" },
      { displayName: "Aaron", emailNormalized: "aaron@example.com", status: "active" },
      { displayName: "Zach", emailNormalized: "zach@example.com", status: "inactive" }
    ]);

    const res = await getJson("/members", { poker_session: group });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MembersListBody;
    expect(body.members.map((m) => m.name)).toEqual(["Aaron", "Claire", "Existing"]);
    for (const m of body.members) {
      expect(Object.keys(m).sort()).toEqual(["id", "name"]);
    }

    const adminReq = await getJson("/admin/join-requests", { poker_session: group });
    expect(adminReq.status).toBe(403);
    const adminBody = (await adminReq.json()) as ErrorBody;
    expect(adminBody.error.code).toBe("admin_required");
  });

  it("admin: lists pending requests, approves (member + email + audit), rejects, hides rejected", async () => {
    const admin = await adminLogin();

    await conn.db.insert(joinRequests).values([
      {
        displayName: "Approve Me",
        emailNormalized: "approve@example.com",
        note: "please",
        status: "pending",
        requestIpHash: "f".repeat(32)
      },
      {
        displayName: "Reject Me",
        emailNormalized: "reject@example.com",
        status: "pending",
        requestIpHash: "e".repeat(32)
      }
    ]);

    // List shows pending requests with all fields, newest first, no rejected.
    const listRes = await getJson("/admin/join-requests", admin);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as RequestsListBody;
    expect(list.requests.length).toBeGreaterThanOrEqual(2);
    expect(list.requests.some((r) => r.status === "rejected")).toBe(false);
    const approveReq = list.requests.find((r) => r.email === "approve@example.com");
    expect(approveReq).toBeTruthy();
    expect(approveReq!.displayName).toBe("Approve Me");
    expect(approveReq!.note).toBe("please");
    expect(approveReq!.status).toBe("pending");
    expect(typeof approveReq!.requestedAt).toBe("string");
    const rejectReq = list.requests.find((r) => r.email === "reject@example.com");
    expect(rejectReq).toBeTruthy();

    // Approve → 201 with the new member.
    const ar = await postJson(`/admin/join-requests/${approveReq!.id}/approve`, {}, admin);
    expect(ar.status).toBe(201);
    const arBody = (await ar.json()) as { member: MemberLite };
    expect(arBody.member).toEqual({ id: expect.any(String), name: "Approve Me" });
    const approveMemberId = arBody.member.id;

    // Request row flipped to approved with a review timestamp.
    const reqRow = (
      await conn.db
        .select()
        .from(joinRequests)
        .where(eq(joinRequests.id, approveReq!.id))
    )[0]!;
    expect(reqRow.status).toBe("approved");
    expect(reqRow.reviewedAt).not.toBeNull();

    // Member exists, is active, and shows up for the group.
    const memberRow = (
      await conn.db.select().from(members).where(eq(members.id, approveMemberId))
    )[0]!;
    expect(memberRow.emailNormalized).toBe("approve@example.com");
    expect(memberRow.status).toBe("active");
    const groupList = (await (
      await getJson("/members", { poker_session: admin.poker_session })
    ).json()) as MembersListBody;
    expect(groupList.members.some((m) => m.id === approveMemberId)).toBe(true);

    // Outbox row enqueued (pump disabled in tests → stays "queued").
    const deliveries = await conn.db
      .select()
      .from(emailDeliveries)
      .where(
        and(
          eq(emailDeliveries.eventType, "member_approved"),
          eq(emailDeliveries.recipientEmail, "approve@example.com")
        )
      );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe("queued");
    expect(deliveries[0]!.entityType).toBe("member");
    expect(deliveries[0]!.entityId).toBe(approveMemberId);
    expect(deliveries[0]!.version).toBe(1);
    expect(deliveries[0]!.recipientMemberId).toBe(approveMemberId);

    // Audit row for the approval.
    const audits = await conn.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "member.approve"), eq(auditEvents.entityId, approveReq!.id))
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorLabel).toBe("admin");
    expect(audits[0]!.entityType).toBe("join_request");
    expect(audits[0]!.beforeJson).toEqual({
      id: approveReq!.id,
      displayName: "Approve Me",
      emailNormalized: "approve@example.com",
      status: "pending"
    });
    expect(audits[0]!.afterJson).toEqual({ memberId: approveMemberId });

    // Approving again → 409; unknown id → 404.
    const again = await postJson(`/admin/join-requests/${approveReq!.id}/approve`, {}, admin);
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrorBody).error.message).toBe(
      "This request was already reviewed."
    );
    const missing = await postJson(`/admin/join-requests/${randomUUID()}/approve`, {}, admin);
    expect(missing.status).toBe(404);

    // Reject → ok, row rejected, audit written.
    const rr = await postJson(`/admin/join-requests/${rejectReq!.id}/reject`, {}, admin);
    expect(rr.status).toBe(200);
    expect(await rr.json()).toEqual({ ok: true });
    const rejRow = (
      await conn.db
        .select()
        .from(joinRequests)
        .where(eq(joinRequests.id, rejectReq!.id))
    )[0]!;
    expect(rejRow.status).toBe("rejected");
    expect(rejRow.reviewedAt).not.toBeNull();
    const rejAudits = await conn.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "member.reject"), eq(auditEvents.entityId, rejectReq!.id))
      );
    expect(rejAudits).toHaveLength(1);
    const rejAgain = await postJson(`/admin/join-requests/${rejectReq!.id}/reject`, {}, admin);
    expect(rejAgain.status).toBe(409);

    // Rejected requests are excluded; approved ones still appear.
    const list2 = (await (
      await getJson("/admin/join-requests", admin)
    ).json()) as RequestsListBody;
    expect(list2.requests.some((r) => r.email === "reject@example.com")).toBe(false);
    expect(list2.requests.some((r) => r.email === "approve@example.com")).toBe(true);
  });

  it("admin: directly adds a member (201), enqueues welcome email, rejects duplicates", async () => {
    const admin = await adminLogin();

    const res = await postJson(
      "/admin/members",
      { displayName: "Direct", email: "  Direct@Example.COM ", welcomeEmail: true },
      admin
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { member: MemberLite };
    expect(body.member.name).toBe("Direct");
    const directId = body.member.id;

    const m = (
      await conn.db
        .select()
        .from(members)
        .where(eq(members.emailNormalized, "direct@example.com"))
    )[0]!;
    expect(m.displayName).toBe("Direct");
    expect(m.status).toBe("active");

    // member_welcome outbox row.
    const welcomes = await conn.db
      .select()
      .from(emailDeliveries)
      .where(
        and(
          eq(emailDeliveries.eventType, "member_welcome"),
          eq(emailDeliveries.recipientEmail, "direct@example.com")
        )
      );
    expect(welcomes).toHaveLength(1);
    expect(welcomes[0]!.status).toBe("queued");
    expect(welcomes[0]!.entityType).toBe("member");
    expect(welcomes[0]!.entityId).toBe(directId);
    expect(welcomes[0]!.recipientMemberId).toBe(directId);

    // Audit row for member.create.
    const createAudits = await conn.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "member.create"), eq(auditEvents.entityId, directId)));
    expect(createAudits).toHaveLength(1);
    expect(createAudits[0]!.beforeJson).toBeNull();
    expect(createAudits[0]!.afterJson).toEqual({
      id: directId,
      displayName: "Direct",
      emailNormalized: "direct@example.com"
    });

    // Duplicate email → 409, nothing created.
    const dup = await postJson(
      "/admin/members",
      { displayName: "Direct 2", email: "direct@example.com" },
      admin
    );
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as ErrorBody).error).toEqual({
      code: "conflict",
      message: "A member with this email already exists."
    });
  });

  it("admin: direct add merges a pending join request for the same email", async () => {
    const admin = await adminLogin();

    await conn.db.insert(joinRequests).values({
      displayName: "Merge Me",
      emailNormalized: "merge@example.com",
      status: "pending",
      requestIpHash: "d".repeat(32)
    });

    const res = await postJson(
      "/admin/members",
      { displayName: "Merge Member", email: "  MERGE@Example.COM " },
      admin
    );
    expect(res.status).toBe(201);

    // The pending request is approved as part of the add…
    const req = (
      await conn.db
        .select()
        .from(joinRequests)
        .where(eq(joinRequests.emailNormalized, "merge@example.com"))
    )[0]!;
    expect(req.status).toBe("approved");
    expect(req.reviewedAt).not.toBeNull();

    // …and the member is created with the admin-provided name.
    const m = (
      await conn.db
        .select()
        .from(members)
        .where(eq(members.emailNormalized, "merge@example.com"))
    )[0]!;
    expect(m.displayName).toBe("Merge Member");
    expect(m.status).toBe("active");

    const approveAudits = await conn.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "member.approve"), eq(auditEvents.entityId, req.id)));
    expect(approveAudits).toHaveLength(1);
    const createAudits = await conn.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "member.create"), eq(auditEvents.entityId, m.id)));
    expect(createAudits).toHaveLength(1);
  });

  it("admin: PATCH deactivates a member (hidden from group) and 404s unknown ids", async () => {
    const admin = await adminLogin();
    const direct = (
      await conn.db
        .select()
        .from(members)
        .where(eq(members.emailNormalized, "direct@example.com"))
    )[0]!;

    const res = await patchJson(`/admin/members/${direct.id}`, { status: "inactive" }, admin);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      member: { id: string; name: string; email: string; status: string };
    };
    expect(body.member).toEqual({
      id: direct.id,
      name: "Direct",
      email: "direct@example.com",
      status: "inactive"
    });

    // Inactive members disappear from the group-facing list.
    const list = (await (
      await getJson("/members", { poker_session: admin.poker_session })
    ).json()) as MembersListBody;
    expect(list.members.some((m) => m.id === direct.id)).toBe(false);

    // Audit row for member.update with before/after state.
    const audits = await conn.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "member.update"), eq(auditEvents.entityId, direct.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.beforeJson).toEqual({ displayName: "Direct", status: "active" });
    expect(audits[0]!.afterJson).toEqual({ displayName: "Direct", status: "inactive" });

    // Unknown member id → 404.
    const nf = await patchJson(`/admin/members/${randomUUID()}`, { status: "inactive" }, admin);
    expect(nf.status).toBe(404);
    expect(((await nf.json()) as ErrorBody).error.code).toBe("not_found");
  });
});

/**
 * API integration tests for sessions + ledger routes.
 *
 * Auth cookies are crafted directly with the signing helpers from server/auth
 * (the HTTP auth routes live in a separately-implemented module); every
 * request here exercises the real cookie validation path used in production.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { makeAdminToken, makeGroupToken } from "../../server/auth.js";
import { env } from "../../server/env.js";
import {
  auditEvents,
  disputeTokens,
  emailDeliveries,
  members,
  pokerSessions,
  sessionResults
} from "../../server/db/schema.js";
import type { MemberRow } from "../../server/db/schema.js";
import { openDb, resetDb } from "../helpers/db.js";
import type { TestDb } from "../helpers/db.js";
import { startTestServer } from "../helpers/server.js";
import type { TestServer } from "../helpers/server.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ParticipantApi {
  memberId: string;
  name: string;
  amountCents: number;
}

interface SessionApi {
  id: string;
  playedAt: string;
  title: string | null;
  status: string;
  version: number;
  recordedBy: { id: string; name: string } | null;
  participants: ParticipantApi[];
  notes?: string | null;
  totalCents?: number;
}

interface LedgerRowApi {
  memberId: string;
  name: string;
  netCents: number;
  sessionsPlayed: number;
  lastPlayedAt: string | null;
  isViewer: boolean;
}

interface ApiResponse {
  status: number;
  json: Record<string, unknown> & {
    error?: { code?: string; message?: string; fieldErrors?: Record<string, string[]> };
    session?: SessionApi;
    sessions?: SessionApi[];
    nextCursor?: string | null;
    duplicate?: boolean;
    receiptsQueued?: number;
    ok?: boolean;
    totalCents?: number;
    rows?: LedgerRowApi[];
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
let server: TestServer;
let tdb: TestDb;

const groupCookie = (memberId: string | null): string => makeGroupToken(memberId);
const adminCookie = (): string => makeAdminToken();

interface ReqOpts {
  method?: string;
  body?: unknown;
  group?: string | null;
  admin?: boolean;
}

async function req(path: string, opts: ReqOpts = {}): Promise<ApiResponse> {
  const cookies: string[] = [];
  if (opts.group !== undefined) cookies.push(`poker_session=${opts.group}`);
  if (opts.admin) cookies.push(`poker_admin=${adminCookie()}`);
  const headers: Record<string, string> = {};
  if (cookies.length > 0) headers.cookie = cookies.join("; ");
  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(server.url + path, init);
  const text = await res.text();
  const json = text ? (JSON.parse(text) as ApiResponse["json"]) : {};
  return { status: res.status, json };
}

const postJson = (
  path: string,
  body: unknown,
  opts: { group: string | null; admin?: boolean }
): Promise<ApiResponse> => req(path, { method: "POST", body, ...opts });

const getLedger = (group: string | null): Promise<ApiResponse> =>
  req("/api/poker/ledger", { group });

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
let alice: MemberRow;
let bob: MemberRow;
let carol: MemberRow;
let dave: MemberRow;
let eve: MemberRow;
let zoe: MemberRow;
let frank: MemberRow;

beforeAll(async () => {
  // Drizzle's migration journal lives in its own `drizzle` schema, which
  // resetDb()'s `drop schema public cascade` does not remove; a stale journal
  // makes migrate() skip every migration (leaving an empty public schema).
  // Drop it first so resetDb() always re-applies fresh.
  const cleanup = postgres(env().DATABASE_URL, { max: 1, prepare: false });
  await cleanup`drop schema if exists drizzle cascade`;
  await cleanup.end();
  await resetDb();
  server = await startTestServer();
  tdb = openDb();
});

afterAll(async () => {
  await server?.close();
  await tdb?.end();
});

// ---------------------------------------------------------------------------
// Auth matrix (runs before any members are seeded)
// ---------------------------------------------------------------------------
describe("auth matrix", () => {
  it("rejects anonymous reads of private routes", async () => {
    for (const path of [
      "/api/poker/ledger",
      "/api/poker/sessions",
      "/api/poker/sessions/00000000-0000-4000-8000-000000000000"
    ]) {
      const res = await req(path);
      expect(res.status, path).toBe(401);
      expect(res.json.error?.code, path).toBe("unauthorized");
    }
  });

  it("returns an empty ledger for a valid group cookie", async () => {
    const res = await getLedger(groupCookie(null));
    expect(res.status).toBe(200);
    expect(res.json.totalCents).toBe(0);
    expect(res.json.rows).toEqual([]);
  });

  it("requires a selected viewer before creating sessions", async () => {
    const res = await postJson(
      "/api/poker/sessions",
      { requestKey: "auth-matrix-key-0001", playedAt: "2026-08-01T12:00:00.000Z", results: [] },
      { group: groupCookie(null) }
    );
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe("viewer_required");
  });

  it("rejects anonymous session creation", async () => {
    const res = await postJson("/api/poker/sessions", {}, { group: null });
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe("unauthorized");
  });

  it("blocks admin routes without an admin cookie", async () => {
    const group = groupCookie(alice?.id ?? null);
    const patch = await req("/api/poker/admin/sessions/00000000-0000-4000-8000-000000000000", {
      method: "PATCH",
      body: { version: 1 },
      group
    });
    expect(patch.status).toBe(403);
    expect(patch.json.error?.code).toBe("admin_required");

    const voidRes = await postJson(
      "/api/poker/admin/sessions/00000000-0000-4000-8000-000000000000/void",
      {},
      { group }
    );
    expect(voidRes.status).toBe(403);
    expect(voidRes.json.error?.code).toBe("admin_required");
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------
describe("session lifecycle", () => {
  beforeAll(async () => {
    const rows = await tdb.db
      .insert(members)
      .values([
        { displayName: "Alice", emailNormalized: "alice@example.com", status: "active" },
        { displayName: "Bob", emailNormalized: "bob@example.com", status: "active" },
        { displayName: "Carol", emailNormalized: "carol@example.com", status: "active" },
        { displayName: "Dave", emailNormalized: "dave@example.com", status: "active" },
        { displayName: "Eve", emailNormalized: "eve@example.com", status: "active" },
        { displayName: "Zoe", emailNormalized: "zoe@example.com", status: "active" },
        { displayName: "Frank", emailNormalized: "frank@example.com", status: "inactive" }
      ])
      .returning();
    const byName = new Map(rows.map((r) => [r.displayName, r]));
    alice = byName.get("Alice")!;
    bob = byName.get("Bob")!;
    carol = byName.get("Carol")!;
    dave = byName.get("Dave")!;
    eve = byName.get("Eve")!;
    zoe = byName.get("Zoe")!;
    frank = byName.get("Frank")!;
  });

  const count = async <T extends object>(table: T): Promise<number> =>
    (await tdb.db.select().from(table as never)).length;

  const s1Body = (requestKey = "create-key-00000001") => ({
    requestKey,
    playedAt: "2026-08-01T12:00:00.000Z",
    title: "August Home Game",
    notes: "Bring snacks.",
    results: [
      { memberId: alice.id, amountCents: 10000 },
      { memberId: bob.id, amountCents: -6000 },
      { memberId: carol.id, amountCents: -4000 }
    ]
  });

  it("creates a session and persists tokens, receipts, and audit", async () => {
    const group = groupCookie(alice.id);
    const res = await postJson("/api/poker/sessions", s1Body(), { group });
    expect(res.status).toBe(201);
    expect(res.json.receiptsQueued).toBe(3);
    expect(res.json.duplicate).toBeUndefined();

    const s = res.json.session!;
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.playedAt).toBe("2026-08-01T12:00:00.000Z");
    expect(s.title).toBe("August Home Game");
    expect(s.notes).toBe("Bring snacks.");
    expect(s.status).toBe("active");
    expect(s.version).toBe(1);
    expect(s.recordedBy).toEqual({ id: alice.id, name: "Alice" });
    expect(s.totalCents).toBe(0);
    expect(s.participants.map((p) => p.name)).toEqual(["Alice", "Bob", "Carol"]);
    const byMember = new Map(s.participants.map((p) => [p.memberId, p.amountCents]));
    expect(byMember.get(alice.id)).toBe(10000);
    expect(byMember.get(bob.id)).toBe(-6000);
    expect(byMember.get(carol.id)).toBe(-4000);

    // Dispute tokens: hashed, one per participant, none for non-participants.
    const tokens = await tdb.db
      .select()
      .from(disputeTokens)
      .where(eq(disputeTokens.sessionId, s.id));
    expect(tokens).toHaveLength(3);
    const tokenMembers = new Set(tokens.map((t) => t.memberId));
    expect(tokenMembers).toEqual(new Set([alice.id, bob.id, carol.id]));
    for (const t of tokens) {
      expect(t.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(t.revokedAt).toBeNull();
      expect(t.expiresAt.getTime()).toBeGreaterThan(Date.now());
    }

    // Outbox: one receipt per participant at version 1.
    const deliveries = await tdb.db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.entityId, s.id));
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every((d) => d.eventType === "session_receipt")).toBe(true);
    expect(deliveries.every((d) => d.entityType === "session")).toBe(true);
    expect(deliveries.every((d) => d.version === 1)).toBe(true);
    // Dev-mode delivery runs inline after commit — rows may already be "sent".
    expect(deliveries.every((d) => d.status === "queued" || d.status === "sent")).toBe(true);
    expect(new Set(deliveries.map((d) => d.recipientEmail))).toEqual(
      new Set(["alice@example.com", "bob@example.com", "carol@example.com"])
    );

    // Audit trail.
    const audits = await tdb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, s.id));
    const create = audits.find((a) => a.action === "session.create");
    expect(create).toBeTruthy();
    expect(create!.actorLabel).toBe("member:Alice");
    expect(create!.memberHint).toBe("Alice");
    const after = create!.afterJson as { id: string; playedAt: string; results: unknown[] };
    expect(after.id).toBe(s.id);
    expect(after.playedAt).toBe("2026-08-01T12:00:00.000Z");
    expect(after.results).toHaveLength(3);

    // List: item shape (no notes/totalCents) + nextCursor null.
    const list = await req("/api/poker/sessions", { group });
    expect(list.status).toBe(200);
    expect(list.json.sessions).toHaveLength(1);
    expect(list.json.nextCursor).toBeNull();
    const item = list.json.sessions![0]!;
    expect(item.id).toBe(s.id);
    expect(item.notes).toBeUndefined();
    expect(item.totalCents).toBeUndefined();
    expect(item.recordedBy).toEqual({ id: alice.id, name: "Alice" });
    expect(item.participants).toHaveLength(3);

    // Detail: notes + totalCents present.
    const detail = await req(`/api/poker/sessions/${s.id}`, { group });
    expect(detail.status).toBe(200);
    expect(detail.json.session!.notes).toBe("Bring snacks.");
    expect(detail.json.session!.totalCents).toBe(0);
    expect(detail.json.session!.participants).toHaveLength(3);

    // Missing session → 404.
    const missing = await req("/api/poker/sessions/00000000-0000-4000-8000-000000000000", {
      group
    });
    expect(missing.status).toBe(404);
  });

  it("rejects a non-zero-sum result set without creating anything", async () => {
    const group = groupCookie(alice.id);
    const before = await count(pokerSessions);
    const res = await postJson(
      "/api/poker/sessions",
      {
        requestKey: "create-key-badsum-001",
        playedAt: "2026-08-02T12:00:00.000Z",
        results: [
          { memberId: alice.id, amountCents: 10000 },
          { memberId: bob.id, amountCents: -6000 },
          { memberId: carol.id, amountCents: -4001 }
        ]
      },
      { group }
    );
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("validation");
    expect(res.json.error?.fieldErrors?.results?.join()).toContain("sum");
    expect(await count(pokerSessions)).toBe(before);

    // Zod-level rejection: zero amount.
    const zero = await postJson(
      "/api/poker/sessions",
      {
        requestKey: "create-key-zeroamt-001",
        playedAt: "2026-08-02T12:00:00.000Z",
        results: [
          { memberId: alice.id, amountCents: 100 },
          { memberId: bob.id, amountCents: 0 }
        ]
      },
      { group }
    );
    expect(zero.status).toBe(400);
    expect(JSON.stringify(zero.json.error?.fieldErrors)).toContain("non-zero");
    expect(await count(pokerSessions)).toBe(before);
  });

  it("dedupes by requestKey: second submit returns the existing session", async () => {
    const group = groupCookie(alice.id);
    const res = await postJson("/api/poker/sessions", s1Body(), { group });
    expect(res.status).toBe(200);
    expect(res.json.duplicate).toBe(true);
    expect(res.json.session!.id).toBeDefined();

    // Exactly one session, one token set, one delivery set, one audit row.
    const sessions = await tdb.db.select().from(pokerSessions);
    expect(sessions).toHaveLength(1);
    expect(
      await tdb.db.select().from(disputeTokens).where(eq(disputeTokens.sessionId, res.json.session!.id))
    ).toHaveLength(3);
    expect(
      await tdb.db
        .select()
        .from(emailDeliveries)
        .where(eq(emailDeliveries.entityId, res.json.session!.id))
    ).toHaveLength(3);
    const createAudits = await tdb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "session.create"));
    expect(createAudits).toHaveLength(1);
  });

  it("rejects inactive members as participants", async () => {
    const group = groupCookie(alice.id);
    const before = await count(pokerSessions);
    const res = await postJson(
      "/api/poker/sessions",
      {
        requestKey: "create-key-inactive-01",
        playedAt: "2026-08-03T12:00:00.000Z",
        results: [
          { memberId: frank.id, amountCents: 1000 },
          { memberId: eve.id, amountCents: -1000 }
        ]
      },
      { group }
    );
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("validation");
    expect(await count(pokerSessions)).toBe(before);
  });

  it("computes the ledger across two sessions", async () => {
    const group = groupCookie(alice.id);
    const s2 = await postJson(
      "/api/poker/sessions",
      {
        requestKey: "create-key-00000002",
        playedAt: "2026-08-15T12:00:00.000Z",
        title: "All In",
        results: [
          { memberId: alice.id, amountCents: 5000 },
          { memberId: bob.id, amountCents: 1000 },
          { memberId: carol.id, amountCents: -2000 },
          { memberId: dave.id, amountCents: -4000 }
        ]
      },
      { group }
    );
    expect(s2.status).toBe(201);

    const ledger = await getLedger(group);
    expect(ledger.status).toBe(200);
    expect(ledger.json.totalCents).toBe(0);
    // Alice 15000, Eve/Frank/Zoe 0 (name ASC tie), Dave -4000, Bob -5000, Carol -6000.
    // Inactive Frank still appears (total must always sum to $0.00).
    expect(ledger.json.rows!.map((r) => r.name)).toEqual([
      "Alice",
      "Eve",
      "Frank",
      "Zoe",
      "Dave",
      "Bob",
      "Carol"
    ]);
    const row = (name: string): LedgerRowApi => ledger.json.rows!.find((r) => r.name === name)!;
    expect(row("Alice")).toMatchObject({
      memberId: alice.id,
      netCents: 15000,
      sessionsPlayed: 2,
      lastPlayedAt: "2026-08-15T12:00:00.000Z",
      isViewer: true
    });
    expect(row("Alice").isViewer).toBe(true);
    expect(row("Bob")).toMatchObject({ netCents: -5000, sessionsPlayed: 2 });
    expect(row("Carol")).toMatchObject({ netCents: -6000, sessionsPlayed: 2 });
    expect(row("Dave")).toMatchObject({ netCents: -4000, sessionsPlayed: 1 });
    expect(row("Dave").isViewer).toBe(false);
    // Zero-session members: 0 / 0 / null.
    expect(row("Eve")).toMatchObject({ netCents: 0, sessionsPlayed: 0, lastPlayedAt: null });
    expect(row("Zoe")).toMatchObject({ netCents: 0, sessionsPlayed: 0, lastPlayedAt: null });
    // Inactive members appear with their balances (zero-sum invariant).
    expect(row("Frank")).toMatchObject({ netCents: 0, sessionsPlayed: 0, lastPlayedAt: null });
  });

  it("paginates sessions newest-first with a keyset cursor", async () => {
    const group = groupCookie(alice.id);
    const s3 = await postJson(
      "/api/poker/sessions",
      {
        requestKey: "create-key-00000003",
        playedAt: "2026-08-20T12:00:00.000Z",
        title: "Third Game",
        results: [
          { memberId: alice.id, amountCents: -2500 },
          { memberId: bob.id, amountCents: 2500 }
        ]
      },
      { group }
    );
    const s4 = await postJson(
      "/api/poker/sessions",
      {
        requestKey: "create-key-00000004",
        playedAt: "2026-08-25T12:00:00.000Z",
        title: "Fourth Game",
        results: [
          { memberId: carol.id, amountCents: 3000 },
          { memberId: dave.id, amountCents: -3000 }
        ]
      },
      { group }
    );
    const s5 = await postJson(
      "/api/poker/sessions",
      {
        requestKey: "create-key-00000005",
        playedAt: "2026-08-30T12:00:00.000Z",
        title: "Fifth Game",
        results: [
          { memberId: bob.id, amountCents: 1000 },
          { memberId: carol.id, amountCents: -1000 }
        ]
      },
      { group }
    );
    expect(s3.status).toBe(201);
    expect(s4.status).toBe(201);
    expect(s5.status).toBe(201);

    const p1 = await req("/api/poker/sessions?limit=2", { group });
    expect(p1.status).toBe(200);
    expect(p1.json.sessions!.map((s) => s.title)).toEqual(["Fifth Game", "Fourth Game"]);
    expect(p1.json.sessions![0]!.notes).toBeUndefined(); // notes only in detail
    expect(p1.json.nextCursor).toBe(p1.json.sessions![1]!.id);

    const p2 = await req(`/api/poker/sessions?limit=2&cursor=${p1.json.nextCursor}`, { group });
    expect(p2.json.sessions!.map((s) => s.title)).toEqual(["Third Game", "All In"]);
    expect(p2.json.nextCursor).toBe(p2.json.sessions![1]!.id);

    const p3 = await req(`/api/poker/sessions?limit=2&cursor=${p2.json.nextCursor}`, { group });
    expect(p3.json.sessions!.map((s) => s.title)).toEqual(["August Home Game"]);
    expect(p3.json.nextCursor).toBeNull();

    const seen = new Set(
      [...p1.json.sessions!, ...p2.json.sessions!, ...p3.json.sessions!].map((s) => s.id)
    );
    expect(seen.size).toBe(5);

    // limit clamping: 0 → 1, huge → all 5, default → all 5.
    const clamped = await req("/api/poker/sessions?limit=0", { group });
    expect(clamped.json.sessions).toHaveLength(1);
    expect(clamped.json.nextCursor).toBeTruthy();
    const huge = await req("/api/poker/sessions?limit=999", { group });
    expect(huge.json.sessions).toHaveLength(5);
    expect(huge.json.nextCursor).toBeNull();
    const dflt = await req("/api/poker/sessions", { group });
    expect(dflt.json.sessions).toHaveLength(5);
  });

  it("voids a session: excluded from ledger, tokens revoked, idempotent", async () => {
    const group = groupCookie(alice.id);
    const s2Row = await tdb.db
      .select()
      .from(pokerSessions)
      .where(eq(pokerSessions.requestKey, "create-key-00000002"));
    const s2 = s2Row[0]!;

    const voidRes = await postJson(`/api/poker/admin/sessions/${s2.id}/void`, {}, { group, admin: true });
    expect(voidRes.status).toBe(200);
    expect(voidRes.json.ok).toBe(true);

    // Ledger after void: Alice 7500 (s1+s3), Bob -2500, Carol -2000, Dave -3000, Eve/Frank/Zoe 0.
    const ledger = await getLedger(group);
    expect(ledger.json.totalCents).toBe(0);
    expect(ledger.json.rows!.map((r) => r.name)).toEqual([
      "Alice",
      "Eve",
      "Frank",
      "Zoe",
      "Carol",
      "Bob",
      "Dave"
    ]);
    const row = (name: string): LedgerRowApi => ledger.json.rows!.find((r) => r.name === name)!;
    expect(row("Alice")).toMatchObject({ netCents: 7500, sessionsPlayed: 2 });
    expect(row("Alice").lastPlayedAt).toBe("2026-08-20T12:00:00.000Z");
    expect(row("Bob")).toMatchObject({ netCents: -2500, sessionsPlayed: 3 });
    expect(row("Carol")).toMatchObject({ netCents: -2000, sessionsPlayed: 3 });
    expect(row("Dave")).toMatchObject({ netCents: -3000, sessionsPlayed: 1 });
    expect(row("Dave").lastPlayedAt).toBe("2026-08-25T12:00:00.000Z");

    // Detail reflects voided status + version bump.
    const detail = await req(`/api/poker/sessions/${s2.id}`, { group });
    expect(detail.json.session!.status).toBe("voided");
    expect(detail.json.session!.version).toBe(2);

    // Tokens revoked.
    const tokens = await tdb.db
      .select()
      .from(disputeTokens)
      .where(eq(disputeTokens.sessionId, s2.id));
    expect(tokens).toHaveLength(4);
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

    // Idempotent re-void: no error, no extra version bump.
    const again = await postJson(`/api/poker/admin/sessions/${s2.id}/void`, {}, { group, admin: true });
    expect(again.status).toBe(200);
    expect(again.json.ok).toBe(true);
    const after = await tdb.db
      .select({ version: pokerSessions.version })
      .from(pokerSessions)
      .where(eq(pokerSessions.id, s2.id));
    expect(after[0]!.version).toBe(2);
  });

  it("still counts disputed sessions in the ledger", async () => {
    const s1Row = await tdb.db
      .select()
      .from(pokerSessions)
      .where(eq(pokerSessions.requestKey, "create-key-00000001"));
    const s1 = s1Row[0]!;
    await tdb.db.update(pokerSessions).set({ status: "disputed" }).where(eq(pokerSessions.id, s1.id));

    const ledger = await getLedger(groupCookie(alice.id));
    const aliceRow = ledger.json.rows!.find((r) => r.name === "Alice")!;
    expect(aliceRow.netCents).toBe(7500);
    expect(ledger.json.totalCents).toBe(0);
  });

  it("rejects editing a voided session", async () => {
    const group = groupCookie(alice.id);
    const s2Row = await tdb.db
      .select()
      .from(pokerSessions)
      .where(eq(pokerSessions.requestKey, "create-key-00000002"));
    const s2 = s2Row[0]!;
    const res = await req(`/api/poker/admin/sessions/${s2.id}`, {
      method: "PATCH",
      body: {
        version: 2,
        results: [
          { memberId: alice.id, amountCents: 1000 },
          { memberId: bob.id, amountCents: -1000 }
        ]
      },
      group,
      admin: true
    });
    expect(res.status).toBe(409);
    expect(res.json.error?.message).toBe("Session is voided.");
  });

  it("rejects stale edits and applies resolved edits with new receipts", async () => {
    const group = groupCookie(alice.id);
    const s1Row = await tdb.db
      .select()
      .from(pokerSessions)
      .where(eq(pokerSessions.requestKey, "create-key-00000001"));
    const s1 = s1Row[0]!;

    // Stale version → 409.
    const stale = await req(`/api/poker/admin/sessions/${s1.id}`, {
      method: "PATCH",
      body: {
        version: 99,
        results: [
          { memberId: alice.id, amountCents: 10000 },
          { memberId: bob.id, amountCents: -6000 },
          { memberId: carol.id, amountCents: -4000 }
        ]
      },
      group,
      admin: true
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error?.message).toBe("Session was modified. Reload and try again.");

    // Correct version + new results → applied.
    const edited = await req(`/api/poker/admin/sessions/${s1.id}`, {
      method: "PATCH",
      body: {
        version: 1,
        results: [
          { memberId: alice.id, amountCents: 12000 },
          { memberId: dave.id, amountCents: -12000 }
        ]
      },
      group,
      admin: true
    });
    expect(edited.status).toBe(200);
    const s = edited.json.session!;
    expect(s.version).toBe(2);
    expect(s.status).toBe("disputed"); // preserved
    expect(s.participants.map((p) => p.name)).toEqual(["Alice", "Dave"]);
    expect(s.totalCents).toBe(0);
    expect(s.notes).toBe("Bring snacks."); // metadata untouched

    const results = await tdb.db
      .select()
      .from(sessionResults)
      .where(eq(sessionResults.sessionId, s1.id));
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([-12000, 12000]);

    // Old tokens revoked, new tokens issued (hashed).
    const tokens = await tdb.db
      .select()
      .from(disputeTokens)
      .where(eq(disputeTokens.sessionId, s1.id));
    expect(tokens).toHaveLength(5);
    const oldTokens = tokens.filter(
      (t) => [alice.id, bob.id, carol.id].includes(t.memberId) && t.revokedAt !== null
    );
    expect(oldTokens).toHaveLength(3);
    expect(oldTokens.every((t) => t.revokedAt !== null)).toBe(true);
    const newTokens = tokens.filter((t) => t.revokedAt === null);
    expect(newTokens.map((t) => t.memberId).sort()).toEqual([alice.id, dave.id].sort());
    expect(newTokens.every((t) => /^[0-9a-f]{64}$/.test(t.tokenHash))).toBe(true);

    // Receipts re-enqueued at the new version (v1 ×3 + v2 ×2).
    const deliveries = await tdb.db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.entityId, s1.id));
    expect(deliveries).toHaveLength(5);
    const v2 = deliveries.filter((d) => d.version === 2);
    expect(v2).toHaveLength(2);
    expect(new Set(v2.map((d) => d.recipientEmail))).toEqual(
      new Set(["alice@example.com", "dave@example.com"])
    );

    // Audit before/after.
    const audits = await tdb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, s1.id));
    const edit = audits.find((a) => a.action === "session.edit");
    expect(edit).toBeTruthy();
    const before = edit!.beforeJson as { version: number; results: unknown[] };
    const afterEdit = edit!.afterJson as { version: number; results: unknown[] };
    expect(before.version).toBe(1);
    expect(before.results).toHaveLength(3);
    expect(afterEdit.version).toBe(2);
    expect(afterEdit.results).toHaveLength(2);
  });

  it("metadata-only edits bump the version without resending receipts", async () => {
    const group = groupCookie(alice.id);
    const s1Row = await tdb.db
      .select()
      .from(pokerSessions)
      .where(eq(pokerSessions.requestKey, "create-key-00000001"));
    const s1 = s1Row[0]!;

    const res = await req(`/api/poker/admin/sessions/${s1.id}`, {
      method: "PATCH",
      body: { version: 2, title: "Renamed Game" },
      group,
      admin: true
    });
    expect(res.status).toBe(200);
    expect(res.json.session!.version).toBe(3);
    expect(res.json.session!.title).toBe("Renamed Game");

    const deliveries = await tdb.db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.entityId, s1.id));
    expect(deliveries).toHaveLength(5);
    const tokens = await tdb.db
      .select()
      .from(disputeTokens)
      .where(eq(disputeTokens.sessionId, s1.id));
    expect(tokens).toHaveLength(5);
  });

  it("resolves recordedBy and participants regardless of member status", async () => {
    // Deactivate Alice — she recorded sessions and is a participant.
    await tdb.db.update(members).set({ status: "inactive" }).where(eq(members.id, alice.id));

    const s1Row = await tdb.db
      .select()
      .from(pokerSessions)
      .where(eq(pokerSessions.requestKey, "create-key-00000001"));
    const s1 = s1Row[0]!;
    const group = groupCookie(bob.id);
    const detail = await req(`/api/poker/sessions/${s1.id}`, { group });
    expect(detail.json.session!.recordedBy).toEqual({ id: alice.id, name: "Alice" });
    expect(detail.json.session!.participants.map((p) => p.name)).toContain("Alice");

    // Ledger keeps ALL members (deactivation only hides from selection) —
    // the visible total must always sum to exactly $0.00.
    const ledger = await getLedger(group);
    expect(ledger.json.rows!.some((r) => r.name === "Alice")).toBe(true);
    expect(ledger.json.totalCents).toBe(0);
  });
});

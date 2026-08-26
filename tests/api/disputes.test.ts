import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  ADMIN_COOKIE,
  GROUP_COOKIE,
  makeAdminToken,
  makeGroupToken
} from "../../server/auth.js";
import { hashToken } from "../../server/domain/tokens.js";
import {
  auditEvents,
  disputeTokens,
  disputes,
  emailDeliveries,
  members,
  pokerSessions,
  sessionResults
} from "../../server/db/schema.js";
import { openDb, resetDb, type TestDb } from "../helpers/db.js";
import { startTestServer, type TestServer } from "../helpers/server.js";

/**
 * generateToken is mocked so tests know the raw value of tokens issued by the
 * admin resolution flow (real tokens are never persisted or returned).
 */
vi.mock("../../server/domain/tokens.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../server/domain/tokens.js")
  >();
  let n = 0;
  const generateToken = vi.fn(() => {
    n += 1;
    return `correction-token-${n}-abcdefghijklmnopqrstuvwxyz`;
  });
  return { ...actual, generateToken };
});

/**
 * Rate limiting is not under test here (and its in-memory buckets are shared
 * by IP across every limited route), so it is neutralized for determinism.
 */
vi.mock("../../server/rate-limit.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../server/rate-limit.js")
  >();
  return {
    ...actual,
    checkRateLimit: () => ({ ok: true as const }),
    clientKey: () => "test-client-key"
  };
});

/**
 * The email pump (send.ts) rotates a live token's hash when it sends, which
 * would race with these tests. The route's contract is the outbox rows, so
 * the pump itself (another module's territory) is stubbed out.
 */
vi.mock("../../server/email/notify.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../server/email/notify.js")
  >();
  return { ...actual, notifyEntity: vi.fn(async () => {}) };
});

const { generateToken } = await import("../../server/domain/tokens.js");
/** Mock view of generateToken (vi.mock swaps it at runtime). */
const generateTokenMock = generateToken as unknown as Mock<() => string>;

// Receipt tokens seeded by tests (only hashes are stored).
const TOKEN_A = "known-token-under-test"; // 24 chars — valid
const TOKEN_B = "second-token-under-test-0001";
const TOKEN_C = "third-token-under-test-0002";
const EXPIRED_TOKEN = "expired-token-under-test-0003";
const USED_TOKEN = "used-token-under-test-0004";
const REVOKED_TOKEN = "revoked-token-under-test-005";
const GARBAGE_TOKEN = "this-token-does-not-exist";

const INVALID_BODY = {
  error: { code: "token_invalid", message: "This link is invalid or expired." }
};

let t: TestDb;
let server: TestServer;
let fixture: { sessionId: string; members: Record<string, string> };
let disputeId = "";
let seq = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function wipe(): Promise<void> {
  await t.db.delete(disputes);
  await t.db.delete(emailDeliveries);
  await t.db.delete(sessionResults);
  await t.db.delete(disputeTokens);
  await t.db.delete(pokerSessions);
  await t.db.delete(auditEvents);
  await t.db.delete(members);
}

/** 3 active members + one active (version 1) session with zero-sum results. */
async function seedFixture(): Promise<{
  sessionId: string;
  members: Record<string, string>;
}> {
  const defs = [
    { key: "alice", displayName: "Alice", emailNormalized: "alice@example.com" },
    { key: "bob", displayName: "Bob", emailNormalized: "bob@example.com" },
    { key: "cara", displayName: "Cara", emailNormalized: "cara@example.com" }
  ] as const;
  const inserted = await t.db
    .insert(members)
    .values(defs.map((d) => ({ displayName: d.displayName, emailNormalized: d.emailNormalized })))
    .returning({ id: members.id });
  const membersById: Record<string, string> = {};
  defs.forEach((d, i) => {
    membersById[d.key] = inserted[i]!.id;
  });

  seq += 1;
  const session = (
    await t.db
      .insert(pokerSessions)
      .values({
        playedAt: new Date("2026-08-01T18:00:00Z"),
        title: "Friday Night Game",
        requestKey: `test-fixture-${seq}-key`
      })
      .returning({ id: pokerSessions.id })
  )[0]!;

  await t.db.insert(sessionResults).values([
    { sessionId: session.id, memberId: membersById.alice!, amountCents: 5000 },
    { sessionId: session.id, memberId: membersById.bob!, amountCents: -3000 },
    { sessionId: session.id, memberId: membersById.cara!, amountCents: -2000 }
  ]);

  return { sessionId: session.id, members: membersById };
}

async function addToken(
  memberId: string,
  sessionId: string,
  raw: string,
  opts: { expired?: boolean; used?: boolean; revoked?: boolean } = {}
): Promise<void> {
  await t.db.insert(disputeTokens).values({
    sessionId,
    memberId,
    tokenHash: hashToken(raw),
    expiresAt: opts.expired
      ? new Date(Date.now() - 60_000)
      : new Date(Date.now() + 30 * 24 * 3600 * 1000),
    usedAt: opts.used ? new Date() : null,
    revokedAt: opts.revoked ? new Date() : null
  });
}

/** Wipe + fresh fixture + one valid token for Alice. */
async function seedDefault(): Promise<void> {
  await wipe();
  fixture = await seedFixture();
  await addToken(fixture.members.alice!, fixture.sessionId, TOKEN_A);
}

/** Insert an open dispute + flag the session disputed, without using the API. */
async function seedOpenDispute(reason = "Everything is wrong"): Promise<string> {
  const inserted = await t.db
    .insert(disputes)
    .values({
      sessionId: fixture.sessionId,
      memberId: fixture.members.alice!,
      reason,
      status: "open"
    })
    .returning({ id: disputes.id });
  await t.db
    .update(pokerSessions)
    .set({ status: "disputed" })
    .where(eq(pokerSessions.id, fixture.sessionId));
  return inserted[0]!.id;
}

async function openDisputeViaApi(reason = "Everything is wrong"): Promise<string> {
  const res = await api("POST", "/api/poker/disputes", { token: TOKEN_A, reason });
  expect(res.status).toBe(201);
  return res.body.dispute.id as string;
}

interface ApiResult {
  status: number;
  body: any;
}

async function api(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  cookies?: Record<string, string>
): Promise<ApiResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) {
    headers.Cookie = Object.entries(cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("; ");
  }
  const res = await fetch(server!.url + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

const groupCookies = (): Record<string, string> => ({
  [GROUP_COOKIE]: makeGroupToken(fixture?.members.alice ?? null)
});

const adminCookies = (): Record<string, string> => ({
  [GROUP_COOKIE]: makeGroupToken(fixture?.members.alice ?? null),
  [ADMIN_COOKIE]: makeAdminToken()
});

async function balanceTotals(): Promise<Record<string, number>> {
  const rows = await t.db.select().from(sessionResults);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.memberId] = (out[r.memberId] ?? 0) + r.amountCents;
  return out;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

beforeAll(async () => {
  t = openDb();
  // resetDb() only drops `public`; the drizzle migrator's meta schema can carry
  // an "already applied" record across runs, which would skip table creation.
  await t.sql`drop schema if exists drizzle cascade`;
  await resetDb();
  server = await startTestServer();
});

afterAll(async () => {
  await server!.close();
  await t!.end();
});

describe("POST /api/poker/disputes/verify-token (public)", () => {
  beforeEach(async () => {
    await seedDefault();
    await addToken(fixture.members.alice!, fixture.sessionId, EXPIRED_TOKEN, {
      expired: true
    });
    await addToken(fixture.members.alice!, fixture.sessionId, USED_TOKEN, {
      used: true
    });
    await addToken(fixture.members.alice!, fixture.sessionId, REVOKED_TOKEN, {
      revoked: true
    });
  });

  it("returns session data for a valid token without any cookie", async () => {
    const res = await api("POST", "/api/poker/disputes/verify-token", {
      token: TOKEN_A
    });
    expect(res.status).toBe(200);
    expect(res.body.token.sessionId).toBe(fixture.sessionId);
    expect(res.body.token.memberId).toBe(fixture.members.alice);
    expect(res.body.token.memberName).toBe("Alice");
    expect(typeof res.body.token.expiresAt).toBe("string");
    expect(res.body.token.session).toMatchObject({
      id: fixture.sessionId,
      title: "Friday Night Game",
      status: "active",
      version: 1
    });
    expect(typeof res.body.token.session.playedAt).toBe("string");
    expect(res.body.token.session.participants).toHaveLength(3);
    expect(res.body.token.session.totalCents).toBe(0);
    const byName: Record<string, number> = Object.fromEntries(
      res.body.token.session.participants.map((p: any) => [p.name, p.amountCents])
    );
    expect(byName).toEqual({ Alice: 5000, Bob: -3000, Cara: -2000 });
    for (const p of res.body.token.session.participants) {
      expect(typeof p.memberId).toBe("string");
      expect(typeof p.amountCents).toBe("number");
    }
  });

  it("rejects unknown, expired, used, and revoked tokens with identical error bodies", async () => {
    const bodies: any[] = [];
    for (const raw of [GARBAGE_TOKEN, EXPIRED_TOKEN, USED_TOKEN, REVOKED_TOKEN]) {
      const res = await api("POST", "/api/poker/disputes/verify-token", {
        token: raw
      });
      expect(res.status).toBe(404);
      bodies.push(res.body);
    }
    for (const b of bodies) expect(b).toEqual(INVALID_BODY);
  });
});

describe("POST /api/poker/disputes", () => {
  beforeEach(seedDefault);

  it("consumes a valid token once, opens the dispute, and flags the session", async () => {
    const res = await api("POST", "/api/poker/disputes", {
      token: TOKEN_A,
      reason: "  Numbers look wrong  "
    });
    expect(res.status).toBe(201);
    expect(res.body.dispute).toMatchObject({
      sessionId: fixture.sessionId,
      memberId: fixture.members.alice,
      status: "open"
    });
    expect(res.body.dispute.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof res.body.dispute.createdAt).toBe("string");

    const d = (
      await t.db.select().from(disputes).where(eq(disputes.id, res.body.dispute.id))
    )[0]!;
    expect(d.status).toBe("open");
    expect(d.reason).toBe("Numbers look wrong"); // trimmed

    const s = (
      await t.db
        .select()
        .from(pokerSessions)
        .where(eq(pokerSessions.id, fixture.sessionId))
    )[0]!;
    expect(s.status).toBe("disputed");
    expect(s.version).toBe(1); // no version bump on dispute

    const tok = (
      await t.db
        .select()
        .from(disputeTokens)
        .where(eq(disputeTokens.tokenHash, hashToken(TOKEN_A)))
    )[0]!;
    expect(tok.usedAt).not.toBeNull();
  });

  it("rejects a second use of the same token (consumed)", async () => {
    await openDisputeViaApi();
    const res = await api("POST", "/api/poker/disputes", {
      token: TOKEN_A,
      reason: "Second attempt"
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(INVALID_BODY);
  });

  it("conflicts when the same member already has an open dispute for the session", async () => {
    await addToken(fixture.members.alice!, fixture.sessionId, TOKEN_B);
    await openDisputeViaApi();
    const res = await api("POST", "/api/poker/disputes", {
      token: TOKEN_B,
      reason: "One more try"
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
    expect(res.body.error.message).toBe(
      "A dispute for this session is already open."
    );
  });

  it("lets another participant verify and open their own dispute", async () => {
    await addToken(fixture.members.bob!, fixture.sessionId, TOKEN_C);
    await openDisputeViaApi();

    const verify = await api("POST", "/api/poker/disputes/verify-token", {
      token: TOKEN_C
    });
    expect(verify.status).toBe(200);
    expect(verify.body.token.memberName).toBe("Bob");

    const res = await api("POST", "/api/poker/disputes", {
      token: TOKEN_C,
      reason: "Bob disagrees too"
    });
    expect(res.status).toBe(201);
    expect(res.body.dispute.memberId).toBe(fixture.members.bob);

    const s = (
      await t.db
        .select()
        .from(pokerSessions)
        .where(eq(pokerSessions.id, fixture.sessionId))
    )[0]!;
    expect(s.status).toBe("disputed");
  });
});

describe("GET /api/poker/admin/disputes", () => {
  beforeEach(async () => {
    await seedDefault();
    disputeId = await seedOpenDispute();
  });

  it("is admin-only", async () => {
    const anon = await api("GET", "/api/poker/admin/disputes");
    expect(anon.status).toBe(401);

    const groupOnly = await api(
      "GET",
      "/api/poker/admin/disputes",
      undefined,
      groupCookies()
    );
    expect(groupOnly.status).toBe(403);
    expect(groupOnly.body.error.code).toBe("admin_required");
  });

  it("lists the open dispute with member and session detail", async () => {
    const res = await api(
      "GET",
      "/api/poker/admin/disputes",
      undefined,
      adminCookies()
    );
    expect(res.status).toBe(200);
    expect(res.body.disputes).toHaveLength(1);
    const d = res.body.disputes[0];
    expect(d).toMatchObject({
      id: disputeId,
      sessionId: fixture.sessionId,
      memberId: fixture.members.alice,
      memberName: "Alice",
      reason: "Everything is wrong",
      status: "open",
      resolutionNote: null,
      resolvedAt: null,
      session: {
        id: fixture.sessionId,
        status: "disputed",
        version: 1,
        title: "Friday Night Game"
      }
    });
    expect(typeof d.createdAt).toBe("string");
    expect(typeof d.session.playedAt).toBe("string");
  });
});

describe("POST /api/poker/admin/disputes/:id/resolve — dismissed", () => {
  beforeEach(async () => {
    await seedDefault();
    await addToken(fixture.members.alice!, fixture.sessionId, TOKEN_B);
    disputeId = await openDisputeViaApi();
  });

  it("dismisses, reactivates the session, keeps balances unchanged", async () => {
    const before = await balanceTotals();

    const res = await api(
      "POST",
      `/api/poker/admin/disputes/${disputeId}/resolve`,
      { outcome: "dismissed", note: "Checked — all correct" },
      adminCookies()
    );
    expect(res.status).toBe(200);
    expect(res.body.dispute).toMatchObject({
      id: disputeId,
      status: "dismissed",
      resolutionNote: "Checked — all correct"
    });
    expect(res.body.session).toEqual({
      id: fixture.sessionId,
      status: "active",
      version: 1
    });

    const d = (
      await t.db.select().from(disputes).where(eq(disputes.id, disputeId))
    )[0]!;
    expect(d.status).toBe("dismissed");
    expect(d.resolutionNote).toBe("Checked — all correct");
    expect(d.resolvedAt).not.toBeNull();

    const s = (
      await t.db
        .select()
        .from(pokerSessions)
        .where(eq(pokerSessions.id, fixture.sessionId))
    )[0]!;
    expect(s.status).toBe("active");
    expect(s.version).toBe(1);

    // Results untouched — the ledger balances cannot have moved.
    const rows = await t.db
      .select()
      .from(sessionResults)
      .where(eq(sessionResults.sessionId, fixture.sessionId));
    expect(rows).toHaveLength(3);
    expect(await balanceTotals()).toEqual(before);

    // The member's still-live tokens are revoked; nothing is reissued.
    const live = await t.db
      .select()
      .from(disputeTokens)
      .where(
        and(
          eq(disputeTokens.sessionId, fixture.sessionId),
          eq(disputeTokens.memberId, fixture.members.alice!),
          isNull(disputeTokens.usedAt),
          isNull(disputeTokens.revokedAt)
        )
      );
    expect(live).toHaveLength(0);
    const tokenB = (
      await t.db
        .select()
        .from(disputeTokens)
        .where(eq(disputeTokens.tokenHash, hashToken(TOKEN_B)))
    )[0]!;
    expect(tokenB.revokedAt).not.toBeNull();

    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.entityType, "dispute"), eq(auditEvents.entityId, disputeId))
      );
    expect(audits.some((a) => a.action === "dispute.resolve")).toBe(true);
    expect(audits.some((a) => a.action === "session.correction")).toBe(false);

    // verify-token on the revoked token now fails with the generic error
    const verify = await api("POST", "/api/poker/disputes/verify-token", {
      token: TOKEN_B
    });
    expect(verify.status).toBe(404);
    expect(verify.body).toEqual(INVALID_BODY);
  });
});

describe("POST /api/poker/admin/disputes/:id/resolve — resolved with corrections", () => {
  beforeEach(async () => {
    await seedDefault();
    await addToken(fixture.members.bob!, fixture.sessionId, TOKEN_C);
    disputeId = await seedOpenDispute();
  });

  it("rejects non-zero-sum corrections without touching anything", async () => {
    generateTokenMock.mockClear();
    const res = await api(
      "POST",
      `/api/poker/admin/disputes/${disputeId}/resolve`,
      {
        outcome: "resolved",
        note: "bad fix",
        corrections: [
          { memberId: fixture.members.alice, amountCents: 10000 },
          { memberId: fixture.members.bob, amountCents: -6000 }
        ]
      },
      adminCookies()
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation");
    expect(
      (res.body.error.fieldErrors.corrections as string[]).join()
    ).toContain("sum");
    expect(generateToken).not.toHaveBeenCalled();

    const d = (
      await t.db.select().from(disputes).where(eq(disputes.id, disputeId))
    )[0]!;
    expect(d.status).toBe("open");
    expect(d.resolvedAt).toBeNull();

    const s = (
      await t.db
        .select()
        .from(pokerSessions)
        .where(eq(pokerSessions.id, fixture.sessionId))
    )[0]!;
    expect(s.status).toBe("disputed");
    expect(s.version).toBe(1);

    const results = await t.db
      .select()
      .from(sessionResults)
      .where(eq(sessionResults.sessionId, fixture.sessionId));
    expect(results).toHaveLength(3);

    const live = await t.db
      .select()
      .from(disputeTokens)
      .where(
        and(
          eq(disputeTokens.sessionId, fixture.sessionId),
          isNull(disputeTokens.revokedAt)
        )
      );
    expect(live).toHaveLength(2);
  });

  it("applies corrections: version bump, results replaced, tokens rotated, receipts queued, audits written", async () => {
    generateTokenMock.mockClear();
    const res = await api(
      "POST",
      `/api/poker/admin/disputes/${disputeId}/resolve`,
      {
        outcome: "resolved",
        note: "Re-ran the math",
        corrections: [
          { memberId: fixture.members.alice, amountCents: 4000 },
          { memberId: fixture.members.bob, amountCents: -4000 }
        ]
      },
      adminCookies()
    );
    expect(res.status).toBe(200);
    expect(res.body.dispute.status).toBe("resolved");
    expect(res.body.dispute.resolutionNote).toBe("Re-ran the math");
    expect(res.body.session).toEqual({
      id: fixture.sessionId,
      status: "resolved",
      version: 2
    });
    expect(generateToken).toHaveBeenCalledTimes(2);
    const issuedRaw = generateTokenMock.mock.results.map((r) => r.value as string);

    const s = (
      await t.db
        .select()
        .from(pokerSessions)
        .where(eq(pokerSessions.id, fixture.sessionId))
    )[0]!;
    expect(s.status).toBe("resolved");
    expect(s.version).toBe(2);

    const results = await t.db
      .select()
      .from(sessionResults)
      .where(eq(sessionResults.sessionId, fixture.sessionId));
    expect(results).toHaveLength(2);
    const byMember = Object.fromEntries(
      results.map((r) => [r.memberId, r.amountCents])
    );
    expect(byMember).toEqual({
      [fixture.members.alice!]: 4000,
      [fixture.members.bob!]: -4000
    });

    // ALL old tokens revoked; exactly two fresh tokens for the participants.
    const tokens = await t.db
      .select()
      .from(disputeTokens)
      .where(eq(disputeTokens.sessionId, fixture.sessionId));
    expect(tokens).toHaveLength(4);
    const revoked = tokens.filter((x) => x.revokedAt !== null);
    expect(revoked).toHaveLength(2);
    const issued = tokens.filter((x) => x.revokedAt === null);
    expect(issued).toHaveLength(2);
    expect(new Set(issued.map((x) => x.tokenHash))).toEqual(
      new Set(issuedRaw.map((raw) => hashToken(raw)))
    );
    expect(new Set(issued.map((x) => x.memberId))).toEqual(
      new Set([fixture.members.alice, fixture.members.bob])
    );

    // Corrected receipts queued at the new version for each participant.
    const emails = await t.db
      .select()
      .from(emailDeliveries)
      .where(
        and(
          eq(emailDeliveries.entityId, fixture.sessionId),
          eq(emailDeliveries.version, 2)
        )
      );
    expect(emails).toHaveLength(2);
    expect(new Set(emails.map((e) => e.recipientEmail))).toEqual(
      new Set(["alice@example.com", "bob@example.com"])
    );
    expect(new Set(emails.map((e) => e.recipientMemberId))).toEqual(
      new Set([fixture.members.alice, fixture.members.bob])
    );

    // Audit trail: dispute.resolve + session.correction.
    const resolveAudit = (
      await t.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "dispute.resolve"),
            eq(auditEvents.entityId, disputeId)
          )
        )
    )[0]!;
    expect(resolveAudit.afterJson).toEqual({
      outcome: "resolved",
      note: "Re-ran the math"
    });
    const corrAudit = (
      await t.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "session.correction"),
            eq(auditEvents.entityId, fixture.sessionId)
          )
        )
    )[0]!;
    expect(corrAudit.beforeJson).toMatchObject({ version: 1 });
    expect(corrAudit.afterJson).toMatchObject({
      version: 2,
      results: [
        { memberId: fixture.members.alice, amountCents: 4000 },
        { memberId: fixture.members.bob, amountCents: -4000 }
      ]
    });

    // A freshly issued token verifies against the corrected session.
    const verify = await api("POST", "/api/poker/disputes/verify-token", {
      token: issuedRaw[0]!
    });
    expect(verify.status).toBe(200);
    expect(verify.body.token.memberName).toBe("Alice");
    expect(verify.body.token.session).toMatchObject({
      status: "resolved",
      version: 2
    });
    expect(verify.body.token.session.totalCents).toBe(0);
  });

  it("rejects resolving an already-resolved dispute", async () => {
    await api(
      "POST",
      `/api/poker/admin/disputes/${disputeId}/resolve`,
      {
        outcome: "resolved",
        corrections: [
          { memberId: fixture.members.alice, amountCents: 4000 },
          { memberId: fixture.members.bob, amountCents: -4000 }
        ]
      },
      adminCookies()
    );
    const res = await api(
      "POST",
      `/api/poker/admin/disputes/${disputeId}/resolve`,
      { outcome: "dismissed" },
      adminCookies()
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
  });

  it("is admin-only", async () => {
    const res = await api(
      "POST",
      `/api/poker/admin/disputes/${disputeId}/resolve`,
      { outcome: "dismissed" },
      groupCookies()
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("admin_required");
  });
});

/**
 * Notification coverage — outbox rows for session updates, results
 * corrections, and voids, plus a smoke pass over the new email templates.
 *
 * The send layer (send.ts) is another module's territory, so its pump
 * (notify.ts) is stubbed to a no-op: the contract under test is the OUTBOX
 * rows themselves. Group + admin logins go through the real auth routes
 * using the passwords from tests/setup-env.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  disputeTokens,
  emailDeliveries,
  members,
  pokerSessions
} from "../../server/db/schema.js";
import type { EmailDeliveryRow, MemberRow } from "../../server/db/schema.js";
import {
  renderDisputeAckEmail,
  renderDisputeDismissedEmail,
  renderDisputeOpenedEmail,
  renderDisputeResolvedEmail,
  renderResultsCorrectedEmail,
  renderSessionUpdatedEmail,
  renderSessionVoidedEmail
} from "../../server/email/templates.js";
import { openDb, resetDb } from "../helpers/db.js";
import type { TestDb } from "../helpers/db.js";
import { startTestServer } from "../helpers/server.js";
import type { TestServer } from "../helpers/server.js";

/**
 * The email pump would hand new event types to send.ts's buildContent switch
 * (another module's territory) — stub it so outbox rows stay observable.
 */
vi.mock("../../server/email/notify.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../server/email/notify.js")
  >();
  return { ...actual, notifyEntity: vi.fn(async () => {}) };
});

/**
 * These tests log in through the real auth routes; neutralize rate limiting
 * so login/unlock request counts can never flake across runs.
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

const GROUP_PASSWORD = "group-pass-test";
const ADMIN_PASSWORD = "admin-pass-test";

let server: TestServer;
let tdb: TestDb;
let alice: MemberRow;
let bob: MemberRow;
let carol: MemberRow;
let dave: MemberRow;
/** Cookie jar ("poker_session=…; poker_admin=…") shared by all requests. */
let cookie = "";

// ---------------------------------------------------------------------------
// HTTP helpers — real auth routes, real cookies
// ---------------------------------------------------------------------------

function collectCookies(res: Response, jar: Map<string, string>): void {
  for (const c of res.headers.getSetCookie()) {
    const idx = c.indexOf("=");
    if (idx < 0) continue;
    const end = c.indexOf(";");
    const name = c.slice(0, idx).trim();
    const value = c.slice(idx + 1, end < 0 ? undefined : end).trim();
    jar.set(name, value);
  }
}

function jarToCookie(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function api(
  path: string,
  opts: { method?: string; body?: unknown; withCookies?: boolean } = {}
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.withCookies) headers.cookie = cookie;
  return fetch(server.url + path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
}

/** Group login → viewer selection → admin unlock, via the real routes. */
async function loginAsAdminViewer(): Promise<string> {
  const jar = new Map<string, string>();

  const login = await api("/api/poker/auth/login", {
    method: "POST",
    body: { password: GROUP_PASSWORD }
  });
  expect(login.status).toBe(200);
  collectCookies(login, jar);
  cookie = jarToCookie(jar);

  const viewer = await api("/api/poker/viewer", {
    method: "POST",
    body: { memberId: alice.id },
    withCookies: true
  });
  expect(viewer.status).toBe(200);
  collectCookies(viewer, jar);
  cookie = jarToCookie(jar);

  const unlock = await api("/api/poker/admin/unlock", {
    method: "POST",
    body: { password: ADMIN_PASSWORD },
    withCookies: true
  });
  expect(unlock.status).toBe(200);
  collectCookies(unlock, jar);
  return jarToCookie(jar);
}

interface SessionRef {
  id: string;
  version: number;
}

async function createSession(
  key: string,
  results: Array<{ memberId: string; amountCents: number }>,
  title = "Notification Test Game"
): Promise<SessionRef> {
  const res = await api("/api/poker/sessions", {
    method: "POST",
    body: {
      requestKey: key,
      playedAt: "2026-08-01T19:30:00.000Z",
      title,
      results
    },
    withCookies: true
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { session: SessionRef };
  return json.session;
}

async function deliveries(sessionId: string): Promise<EmailDeliveryRow[]> {
  return tdb.db
    .select()
    .from(emailDeliveries)
    .where(eq(emailDeliveries.entityId, sessionId));
}

const ofType = (rows: EmailDeliveryRow[], eventType: string): EmailDeliveryRow[] =>
  rows.filter((r) => r.eventType === eventType);

const ABC = () => [
  { memberId: alice.id, amountCents: 10000 },
  { memberId: bob.id, amountCents: -6000 },
  { memberId: carol.id, amountCents: -4000 }
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await resetDb();
  server = await startTestServer();
  tdb = openDb();

  const rows = await tdb.db
    .insert(members)
    .values([
      { displayName: "Alice", emailNormalized: "alice@example.com", status: "active" },
      { displayName: "Bob", emailNormalized: "bob@example.com", status: "active" },
      { displayName: "Carol", emailNormalized: "carol@example.com", status: "active" },
      { displayName: "Dave", emailNormalized: "dave@example.com", status: "active" }
    ])
    .returning();
  const byName = new Map(rows.map((r) => [r.displayName, r]));
  alice = byName.get("Alice")!;
  bob = byName.get("Bob")!;
  carol = byName.get("Carol")!;
  dave = byName.get("Dave")!;

  cookie = await loginAsAdminViewer();
});

afterAll(async () => {
  await server?.close();
  await tdb?.end();
});

// ---------------------------------------------------------------------------
// Outbox coverage
// ---------------------------------------------------------------------------

describe("notification outbox", () => {
  it("create enqueues one session_receipt per participant at version 1", async () => {
    const s = await createSession("notify-key-00000001", ABC());

    const rows = await deliveries(s.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.eventType === "session_receipt")).toBe(true);
    expect(rows.every((r) => r.entityType === "session")).toBe(true);
    expect(rows.every((r) => r.version === 1)).toBe(true);
    expect(rows.every((r) => r.status === "queued")).toBe(true);
    expect(new Set(rows.map((r) => r.recipientEmail))).toEqual(
      new Set(["alice@example.com", "bob@example.com", "carol@example.com"])
    );
  });

  it("metadata-only edit enqueues session_updated for every participant, no new receipts", async () => {
    const s = await createSession("notify-key-00000002", ABC());

    const res = await api(`/api/poker/admin/sessions/${s.id}`, {
      method: "PATCH",
      body: { version: 1, title: "Renamed Game" },
      withCookies: true
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { session: { version: number; title: string } };
    expect(json.session.version).toBe(2);
    expect(json.session.title).toBe("Renamed Game");

    const rows = await deliveries(s.id);
    expect(rows).toHaveLength(6); // 3 receipts v1 + 3 update notices v2
    const v2 = rows.filter((r) => r.version === 2);
    expect(v2).toHaveLength(3);
    expect(v2.every((r) => r.eventType === "session_updated")).toBe(true);
    expect(v2.every((r) => r.entityType === "session")).toBe(true);
    expect(v2.every((r) => r.recipientMemberId !== null)).toBe(true);
    expect(new Set(v2.map((r) => r.recipientEmail))).toEqual(
      new Set(["alice@example.com", "bob@example.com", "carol@example.com"])
    );
    // The original receipts stay untouched — no fresh receipt rows.
    expect(ofType(rows, "session_receipt")).toHaveLength(3);

    // Metadata edits must not rotate dispute tokens.
    const tokens = await tdb.db
      .select()
      .from(disputeTokens)
      .where(eq(disputeTokens.sessionId, s.id));
    expect(tokens).toHaveLength(3);
    expect(tokens.every((t) => t.revokedAt === null)).toBe(true);

    // Audit before/after versions.
    const audits = await tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, s.id), eq(auditEvents.action, "session.edit")));
    expect(audits).toHaveLength(1);
    expect((audits[0]!.beforeJson as { version: number }).version).toBe(1);
    expect((audits[0]!.afterJson as { version: number }).version).toBe(2);
  });

  it("results edit enqueues receipts AND results_corrected at the new version", async () => {
    const s = await createSession("notify-key-00000003", ABC());

    const res = await api(`/api/poker/admin/sessions/${s.id}`, {
      method: "PATCH",
      body: {
        version: 1,
        results: [
          { memberId: alice.id, amountCents: 12000 },
          { memberId: dave.id, amountCents: -12000 }
        ]
      },
      withCookies: true
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { session: { version: number } };
    expect(json.session.version).toBe(2);

    const rows = await deliveries(s.id);
    const v2 = rows.filter((r) => r.version === 2);
    expect(v2).toHaveLength(4); // 2 fresh receipts + 2 correction notices
    const receipts = ofType(v2, "session_receipt");
    const corrected = ofType(v2, "results_corrected");
    expect(receipts).toHaveLength(2);
    expect(corrected).toHaveLength(2);
    expect(new Set(receipts.map((r) => r.recipientEmail))).toEqual(
      new Set(["alice@example.com", "dave@example.com"])
    );
    expect(new Set(corrected.map((r) => r.recipientEmail))).toEqual(
      new Set(["alice@example.com", "dave@example.com"])
    );
    expect(corrected.every((r) => r.entityType === "session")).toBe(true);

    // Old tokens revoked; fresh live tokens only for the new participants.
    const tokens = await tdb.db
      .select()
      .from(disputeTokens)
      .where(eq(disputeTokens.sessionId, s.id));
    expect(tokens).toHaveLength(5);
    expect(
      tokens.filter((t) => t.revokedAt !== null).map((t) => t.memberId).sort()
    ).toEqual([alice.id, bob.id, carol.id].sort());
    expect(
      tokens.filter((t) => t.revokedAt === null).map((t) => t.memberId).sort()
    ).toEqual([alice.id, dave.id].sort());
  });

  it("void enqueues session_voided for every participant and revokes tokens", async () => {
    const s = await createSession("notify-key-00000004", ABC());

    const res = await api(`/api/poker/admin/sessions/${s.id}/void`, {
      method: "POST",
      body: {},
      withCookies: true
    });
    expect(res.status).toBe(200);

    const [sess] = await tdb.db
      .select({ status: pokerSessions.status, version: pokerSessions.version })
      .from(pokerSessions)
      .where(eq(pokerSessions.id, s.id));
    expect(sess!.status).toBe("voided");
    expect(sess!.version).toBe(2);

    const rows = await deliveries(s.id);
    const voided = ofType(rows, "session_voided");
    expect(voided).toHaveLength(3);
    expect(voided.every((r) => r.version === 2)).toBe(true);
    expect(voided.every((r) => r.entityType === "session")).toBe(true);
    expect(voided.every((r) => r.recipientMemberId !== null)).toBe(true);
    expect(new Set(voided.map((r) => r.recipientEmail))).toEqual(
      new Set(["alice@example.com", "bob@example.com", "carol@example.com"])
    );

    const tokens = await tdb.db
      .select()
      .from(disputeTokens)
      .where(eq(disputeTokens.sessionId, s.id));
    expect(tokens).toHaveLength(3);
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

    const voids = await tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, s.id), eq(auditEvents.action, "session.void")));
    expect(voids).toHaveLength(1);
    expect((voids[0]!.beforeJson as { version: number }).version).toBe(1);
    expect((voids[0]!.afterJson as { version: number }).version).toBe(2);
  });

  it("re-voiding is idempotent — no duplicate session_voided rows", async () => {
    const s = await createSession("notify-key-00000005", [
      { memberId: alice.id, amountCents: 5000 },
      { memberId: bob.id, amountCents: -5000 }
    ]);

    const first = await api(`/api/poker/admin/sessions/${s.id}/void`, {
      method: "POST",
      body: {},
      withCookies: true
    });
    expect(first.status).toBe(200);
    const again = await api(`/api/poker/admin/sessions/${s.id}/void`, {
      method: "POST",
      body: {},
      withCookies: true
    });
    expect(again.status).toBe(200);

    const rows = await deliveries(s.id);
    const voided = ofType(rows, "session_voided");
    expect(voided).toHaveLength(2); // one per recipient — never duplicated
    expect(voided.map((r) => r.recipientEmail).sort()).toEqual(
      ["alice@example.com", "bob@example.com"].sort()
    );

    const [sess] = await tdb.db
      .select({ version: pokerSessions.version })
      .from(pokerSessions)
      .where(eq(pokerSessions.id, s.id));
    expect(sess!.version).toBe(2); // second call bumped nothing
  });
});

// ---------------------------------------------------------------------------
// Template smoke
// ---------------------------------------------------------------------------

describe("notification templates", () => {
  const SESSION_ID = "00000000-0000-4000-8000-000000000000";

  it("session updated + voided notices carry no token link and escape user text", () => {
    const base = {
      origin: "https://amitkonda.example",
      memberName: "<i>Eve</i>",
      session: {
        id: SESSION_ID,
        playedAt: new Date("2026-08-01T19:30:00Z"),
        title: "<script>bad()</script>",
        version: 2,
        status: "active"
      },
      recordedBy: { name: "Bob <b>the</b> Recorder" },
      results: [
        { name: "<b>Alice</b>", amountCents: 5000, isRecipient: true },
        { name: "Bob", amountCents: -5000, isRecipient: false }
      ],
      totalCents: 0
    };

    const updated = renderSessionUpdatedEmail(base);
    expect(updated.subject).toContain("Poker session updated —");
    expect(updated.html).not.toContain("<script");
    expect(updated.html).toContain("&lt;script&gt;");
    expect(updated.html).toContain("Recorded by Bob &lt;b&gt;the&lt;/b&gt; Recorder");
    expect(updated.html).not.toContain("/poker?token=");
    expect(updated.text).not.toContain("/poker?token=");
    expect(updated.text).toContain("Status: Active · Version 2");
    expect(updated.text).toContain("$0.00");

    const voided = renderSessionVoidedEmail({
      ...base,
      session: { ...base.session, status: "voided" }
    });
    expect(voided.subject).toBe("Poker session voided");
    expect(voided.html).not.toContain("<script");
    expect(voided.html).not.toContain("/poker?token=");
    expect(voided.text).toContain("Status: Voided · Version 2");
    expect(voided.text).toContain("no longer counts toward the ledger");
  });

  it("results corrected shows this member's before/after/change with signs", () => {
    const corrected = renderResultsCorrectedEmail({
      origin: "https://amitkonda.example",
      memberName: "Eve",
      session: {
        id: SESSION_ID,
        playedAt: new Date("2026-08-01T19:30:00Z"),
        title: "Friday Game",
        version: 2,
        status: "active"
      },
      beforeAmountCents: -5000,
      afterAmountCents: 2500,
      changeCents: 7500,
      totalCents: 0
    });
    expect(corrected.subject).toBe("Poker results corrected");
    expect(corrected.html).toContain("-$50.00");
    expect(corrected.html).toContain("+$25.00");
    expect(corrected.html).toContain("+$75.00");
    expect(corrected.text).toContain("Change: +$75.00");
    expect(corrected.text).toContain("Version 2");
    expect(corrected.html).toContain("https://amitkonda.example/poker");
    expect(corrected.html).not.toContain("/poker?token=");
  });

  it("dispute notices link to the ledger, never embed tokens or passwords", () => {
    const data = {
      origin: "https://amitkonda.example",
      memberName: "<i>Eve</i>",
      reason: "I counted <b>differently</b>",
      sessionTitle: "Friday <Game>",
      playedAt: new Date("2026-08-01T19:30:00Z"),
      sessionId: SESSION_ID
    };

    const opened = renderDisputeOpenedEmail(data);
    expect(opened.subject).toContain("Dispute opened");
    expect(opened.html).toContain("https://amitkonda.example/poker");
    expect(opened.html).toContain("&lt;i&gt;Eve&lt;/i&gt;");
    expect(opened.html).toContain("&lt;b&gt;differently");
    expect(opened.html).not.toContain("<b>differently");
    expect(opened.html).not.toContain("/poker?token=");
    expect(opened.text).toContain(
      "group password — shared separately, never emailed"
    );

    const ack = renderDisputeAckEmail(data);
    expect(ack.subject).toBe("Dispute received");
    expect(ack.text).toContain("The ledger is unchanged until the dispute is resolved");

    const resolved = renderDisputeResolvedEmail(data);
    expect(resolved.subject).toContain("Dispute resolved");
    expect(resolved.subject).toContain("Friday");
    expect(resolved.text).not.toContain("your favor");
    expect(resolved.text).toContain("Check the ledger");

    const dismissed = renderDisputeDismissedEmail(data);
    expect(dismissed.subject).toContain("Dispute dismissed");
    expect(dismissed.text).toContain("stands as recorded");
  });
});

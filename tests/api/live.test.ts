/**
 * API integration tests for the live-session routes (server/routes/live.ts):
 * start, rebuys / adding a player mid-session, cash-outs, single-level undo,
 * and the buyouts-must-balance-to-zero guard on ending.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { makeGroupToken } from "../../server/auth.js";
import { env } from "../../server/env.js";
import { liveSessionEvents, members, pokerSessions, sessionResults } from "../../server/db/schema.js";
import { eq } from "drizzle-orm";
import type { MemberRow } from "../../server/db/schema.js";
import { openDb, resetDb } from "../helpers/db.js";
import type { TestDb } from "../helpers/db.js";
import { startTestServer } from "../helpers/server.js";
import type { TestServer } from "../helpers/server.js";

interface ParticipantApi {
  memberId: string;
  name: string;
  buyInCents: number;
  cashOutCents: number | null;
}
interface LiveApi {
  session: { id: string; status: string; version: number } | null;
  participants: ParticipantApi[];
  ended?: boolean;
  created?: boolean;
  undone?: boolean;
}
interface ApiResponse {
  status: number;
  json: { error?: { code?: string; message?: string } } & Partial<LiveApi>;
}

let server: TestServer;
let tdb: TestDb;

const groupCookie = (memberId: string | null): string => makeGroupToken(memberId);

async function req(path: string, opts: { method?: string; body?: unknown; group?: string | null } = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (opts.group !== undefined) headers.cookie = `poker_session=${opts.group}`;
  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(server.url + path, init);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

const postJson = (path: string, body: unknown, group: string | null) => req(path, { method: "POST", body, group });
const patchJson = (path: string, body: unknown, group: string | null) => req(path, { method: "PATCH", body, group });

let alice: MemberRow;
let bob: MemberRow;
let carol: MemberRow;

beforeAll(async () => {
  const cleanup = postgres(env().DATABASE_URL, { max: 1, prepare: false });
  await cleanup`drop schema if exists drizzle cascade`;
  await cleanup.end();
  await resetDb();
  server = await startTestServer();
  tdb = openDb();
  const rows = await tdb.db
    .insert(members)
    .values([
      { displayName: "Alice", emailNormalized: "alice-live@example.com", status: "active" },
      { displayName: "Bob", emailNormalized: "bob-live@example.com", status: "active" },
      { displayName: "Carol", emailNormalized: "carol-live@example.com", status: "active" }
    ])
    .returning();
  const byName = new Map(rows.map((r) => [r.displayName, r]));
  alice = byName.get("Alice")!;
  bob = byName.get("Bob")!;
  carol = byName.get("Carol")!;
});

afterAll(async () => {
  await server?.close();
  await tdb?.end();
});

// Every test starts and (usually) ends its own live session — clear any
// leftover live session/events between tests so they don't collide on the
// "only one live session at a time" rule.
beforeEach(async () => {
  await tdb.db.delete(sessionResults);
  await tdb.db.delete(liveSessionEvents);
  await tdb.db.delete(pokerSessions);
});

describe("live session lifecycle", () => {
  it("starts a session, rebuys, adds a late player, and cashes everyone out to a balanced end", async () => {
    const start = await postJson(
      "/api/poker/live",
      { requestKey: "live-start-1".padEnd(10, "x"), players: [{ memberId: alice.id, amountCents: 5000 }, { memberId: bob.id, amountCents: 5000 }] },
      groupCookie(alice.id)
    );
    expect(start.status).toBe(200);
    expect(start.json.session?.status).toBe("live");
    expect(start.json.participants).toHaveLength(2);
    const id = start.json.session!.id;

    // Rebuy for Alice.
    const rebuy = await postJson(`/api/poker/live/${id}/buyins`, { memberId: alice.id, amountCents: 2000 }, groupCookie(alice.id));
    expect(rebuy.status).toBe(200);
    const aliceAfterRebuy = rebuy.json.participants!.find((p) => p.memberId === alice.id)!;
    expect(aliceAfterRebuy.buyInCents).toBe(7000);

    // Carol arrives late.
    const addPlayer = await postJson(`/api/poker/live/${id}/buyins`, { memberId: carol.id, amountCents: 3000 }, groupCookie(alice.id));
    expect(addPlayer.status).toBe(200);
    expect(addPlayer.json.participants).toHaveLength(3);
    expect(addPlayer.json.participants!.find((p) => p.memberId === carol.id)!.buyInCents).toBe(3000);

    // Total in: 7000 + 5000 + 3000 = 15000. Cash everyone out to net zero.
    await patchJson(`/api/poker/live/${id}/cashouts`, { memberId: alice.id, amountCents: 6000 }, groupCookie(alice.id));
    await patchJson(`/api/poker/live/${id}/cashouts`, { memberId: bob.id, amountCents: 4000 }, groupCookie(alice.id));
    const lastCashOut = await patchJson(`/api/poker/live/${id}/cashouts`, { memberId: carol.id, amountCents: 5000 }, groupCookie(alice.id));
    expect(lastCashOut.status).toBe(200);

    const end = await postJson(`/api/poker/live/${id}/end`, {}, groupCookie(alice.id));
    expect(end.status).toBe(200);
    expect(end.json.ended).toBe(true);
    expect(end.json.session?.status).toBe("active");

    const results = await tdb.db.select().from(sessionResults).where(eq(sessionResults.sessionId, id));
    expect(results).toHaveLength(3);
    expect(results.reduce((s, r) => s + Number(r.amountCents), 0)).toBe(0);

    // The undo log is cleared once a session ends.
    const eventsAfterEnd = await tdb.db.select().from(liveSessionEvents).where(eq(liveSessionEvents.sessionId, id));
    expect(eventsAfterEnd).toHaveLength(0);
  });

  it("blocks ending until cash-outs balance to zero, and reports the current difference", async () => {
    const start = await postJson(
      "/api/poker/live",
      { requestKey: "live-start-2".padEnd(10, "x"), players: [{ memberId: alice.id, amountCents: 5000 }, { memberId: bob.id, amountCents: 5000 }] },
      groupCookie(alice.id)
    );
    const id = start.json.session!.id;

    // Both cash out for less than they put in — table is short $20 total.
    await patchJson(`/api/poker/live/${id}/cashouts`, { memberId: alice.id, amountCents: 4000 }, groupCookie(alice.id));
    await patchJson(`/api/poker/live/${id}/cashouts`, { memberId: bob.id, amountCents: 4000 }, groupCookie(alice.id));

    const end = await postJson(`/api/poker/live/${id}/end`, {}, groupCookie(alice.id));
    expect(end.status).toBe(400);
    expect(end.json.error?.code).toBe("unbalanced");
    expect(end.json.error?.message).toContain("20.00");

    // Still live — no session_results were written.
    const [session] = await tdb.db.select().from(pokerSessions).where(eq(pokerSessions.id, id));
    expect(session!.status).toBe("live");
    const results = await tdb.db.select().from(sessionResults).where(eq(sessionResults.sessionId, id));
    expect(results).toHaveLength(0);
  });

  it("requires a cash-out for every player before ending, independent of the balance check", async () => {
    const start = await postJson(
      "/api/poker/live",
      { requestKey: "live-start-3".padEnd(10, "x"), players: [{ memberId: alice.id, amountCents: 5000 }, { memberId: bob.id, amountCents: 5000 }] },
      groupCookie(alice.id)
    );
    const id = start.json.session!.id;
    await patchJson(`/api/poker/live/${id}/cashouts`, { memberId: alice.id, amountCents: 5000 }, groupCookie(alice.id));
    // Bob never cashes out.
    const end = await postJson(`/api/poker/live/${id}/end`, {}, groupCookie(alice.id));
    expect(end.status).toBe(400);
    expect(end.json.error?.code).toBe("cashouts_required");
  });

  it("undoes the most recent change, one step at a time (cash-out, then the add-player buy-in)", async () => {
    const start = await postJson(
      "/api/poker/live",
      { requestKey: "live-start-4".padEnd(10, "x"), players: [{ memberId: alice.id, amountCents: 5000 }, { memberId: bob.id, amountCents: 5000 }] },
      groupCookie(alice.id)
    );
    const id = start.json.session!.id;

    // Nothing to undo yet — only the session-start buy-ins exist, and those
    // aren't logged as undoable events.
    const nothingYet = await postJson(`/api/poker/live/${id}/undo`, {}, groupCookie(alice.id));
    expect(nothingYet.status).toBe(400);
    expect(nothingYet.json.error?.code).toBe("nothing_to_undo");

    // Carol joins late.
    await postJson(`/api/poker/live/${id}/buyins`, { memberId: carol.id, amountCents: 3000 }, groupCookie(alice.id));
    // Bob's cash-out gets set, then corrected.
    await patchJson(`/api/poker/live/${id}/cashouts`, { memberId: bob.id, amountCents: 1000 }, groupCookie(alice.id));
    const corrected = await patchJson(`/api/poker/live/${id}/cashouts`, { memberId: bob.id, amountCents: 2000 }, groupCookie(alice.id));
    expect(corrected.json.participants!.find((p) => p.memberId === bob.id)!.cashOutCents).toBe(2000);

    // Undo #1: reverts Bob's cash-out back to 1000 (its previous value).
    const undo1 = await postJson(`/api/poker/live/${id}/undo`, {}, groupCookie(alice.id));
    expect(undo1.status).toBe(200);
    expect(undo1.json.participants!.find((p) => p.memberId === bob.id)!.cashOutCents).toBe(1000);

    // Undo #2: reverts Bob's cash-out again, back to "not entered" (null) —
    // there was no cash-out for him before that first PATCH.
    const undo2 = await postJson(`/api/poker/live/${id}/undo`, {}, groupCookie(alice.id));
    expect(undo2.status).toBe(200);
    expect(undo2.json.participants!.find((p) => p.memberId === bob.id)!.cashOutCents).toBeNull();

    // Undo #3: reverts the add-player buy-in — Carol's only buy-in row is
    // deleted, so she drops out of the participant list entirely.
    const undo3 = await postJson(`/api/poker/live/${id}/undo`, {}, groupCookie(alice.id));
    expect(undo3.status).toBe(200);
    expect(undo3.json.participants!.map((p) => p.memberId)).not.toContain(carol.id);
    expect(undo3.json.participants).toHaveLength(2);

    // Undo #4: back to nothing to undo (session-start buy-ins aren't logged).
    const undo4 = await postJson(`/api/poker/live/${id}/undo`, {}, groupCookie(alice.id));
    expect(undo4.status).toBe(400);
    expect(undo4.json.error?.code).toBe("nothing_to_undo");
  });

  it("rejects buy-ins, cash-outs, and undo once the session has ended", async () => {
    const start = await postJson(
      "/api/poker/live",
      { requestKey: "live-start-5".padEnd(10, "x"), players: [{ memberId: alice.id, amountCents: 5000 }, { memberId: bob.id, amountCents: 5000 }] },
      groupCookie(alice.id)
    );
    const id = start.json.session!.id;
    await patchJson(`/api/poker/live/${id}/cashouts`, { memberId: alice.id, amountCents: 5000 }, groupCookie(alice.id));
    await patchJson(`/api/poker/live/${id}/cashouts`, { memberId: bob.id, amountCents: 5000 }, groupCookie(alice.id));
    await postJson(`/api/poker/live/${id}/end`, {}, groupCookie(alice.id));

    const buyin = await postJson(`/api/poker/live/${id}/buyins`, { memberId: carol.id, amountCents: 1000 }, groupCookie(alice.id));
    expect(buyin.status).toBe(409);
    const cashout = await patchJson(`/api/poker/live/${id}/cashouts`, { memberId: alice.id, amountCents: 1000 }, groupCookie(alice.id));
    expect(cashout.status).toBe(409);
    const undo = await postJson(`/api/poker/live/${id}/undo`, {}, groupCookie(alice.id));
    expect(undo.status).toBe(409);
  });

  it("requires a viewer cookie for the mutating live-session routes", async () => {
    const start = await postJson(
      "/api/poker/live",
      { requestKey: "live-start-6".padEnd(10, "x"), players: [{ memberId: alice.id, amountCents: 5000 }, { memberId: bob.id, amountCents: 5000 }] },
      groupCookie(alice.id)
    );
    const id = start.json.session!.id;
    // A group cookie with no viewer selected (null member id).
    const noViewer = groupCookie(null);
    expect((await postJson(`/api/poker/live/${id}/buyins`, { memberId: bob.id, amountCents: 1000 }, noViewer)).status).toBe(401);
    expect((await patchJson(`/api/poker/live/${id}/cashouts`, { memberId: bob.id, amountCents: 1000 }, noViewer)).status).toBe(401);
    expect((await postJson(`/api/poker/live/${id}/undo`, {}, noViewer)).status).toBe(401);
    expect((await postJson(`/api/poker/live/${id}/end`, {}, noViewer)).status).toBe(401);
  });
});

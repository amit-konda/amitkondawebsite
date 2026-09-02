/**
 * API integration tests for the golf routes (server/routes/golf.ts):
 * logging rounds, the weighted leaderboard, the suggested stroke line, and
 * who can delete a mis-entered round.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { makeAdminToken, makeGroupToken } from "../../server/auth.js";
import { env } from "../../server/env.js";
import { members } from "../../server/db/schema.js";
import type { MemberRow } from "../../server/db/schema.js";
import { openDb, resetDb } from "../helpers/db.js";
import type { TestDb } from "../helpers/db.js";
import { startTestServer } from "../helpers/server.js";
import type { TestServer } from "../helpers/server.js";

interface RoundApi {
  id: string;
  memberId: string;
  name: string;
  course: string;
  strokes: number;
  par: number;
  toPar: number;
}
interface ApiResponse {
  status: number;
  json: { error?: { code?: string; message?: string } } & Record<string, unknown>;
}

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
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

const postJson = (path: string, body: unknown, group: string | null) => req(path, { method: "POST", body, group });

let amit: MemberRow;
let kyle: MemberRow;

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
      { displayName: "Amit", emailNormalized: "amit-golf@example.com", status: "active" },
      { displayName: "Kyle", emailNormalized: "kyle-golf@example.com", status: "active" }
    ])
    .returning();
  const byName = new Map(rows.map((r) => [r.displayName, r]));
  amit = byName.get("Amit")!;
  kyle = byName.get("Kyle")!;
});

afterAll(async () => {
  await server?.close();
  await tdb?.end();
});

// Fixed course pars (mirrors server/domain/golf.ts's COURSE_PAR) — the
// server now derives par from the course itself, a round no longer carries
// its own par.
const COURSE_PAR: Record<"butler" | "hancock", number> = { butler: 27, hancock: 35 };

function logRound(memberId: string, course: string, strokes: number, playedAt: string, group: string) {
  return postJson("/api/poker/golf/rounds", { memberId, course, strokes, playedAt }, group);
}

describe("golf rounds", () => {
  it("requires group access to list rounds, and a viewer to log one", async () => {
    const list = await req("/api/poker/golf/rounds");
    expect(list.status).toBe(401);
    const create = await logRound(amit.id, "butler", 50, "2026-08-01T12:00:00Z", groupCookie(null));
    expect(create.status).toBe(401);
  });

  it("logs a round for another member and lists it with toPar computed from the course's fixed par", async () => {
    const res = await logRound(kyle.id, "butler", COURSE_PAR.butler + 7, "2026-08-01T12:00:00Z", groupCookie(amit.id));
    expect(res.status).toBe(200);
    expect(res.json.created).toBe(true);

    const list = await req("/api/poker/golf/rounds?course=butler", { group: groupCookie(null) });
    const round = (list.json.rounds as RoundApi[]).find((r) => r.id === res.json.id);
    expect(round?.name).toBe("Kyle");
    expect(round?.par).toBe(COURSE_PAR.butler);
    expect(round?.toPar).toBe(7);
  });

  it("rejects an inactive/unknown member id", async () => {
    const res = await logRound("00000000-0000-0000-0000-000000000000", "butler", 50, "2026-08-01T12:00:00Z", groupCookie(amit.id));
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("invalid_member");
  });

  it("rejects an unknown course", async () => {
    const res = await postJson(
      "/api/poker/golf/rounds",
      { memberId: amit.id, course: "pebble_beach", strokes: 80, playedAt: "2026-08-01T12:00:00Z" },
      groupCookie(amit.id)
    );
    expect(res.status).toBe(400);
  });

  it("lets the recording member delete their own round, but not another viewer", async () => {
    const created = await logRound(amit.id, "hancock", 45, "2026-08-02T12:00:00Z", groupCookie(kyle.id));
    expect(created.status).toBe(200);

    const deniedDelete = await req(`/api/poker/golf/rounds/${created.json.id}`, { method: "DELETE", group: groupCookie(amit.id) });
    expect(deniedDelete.status).toBe(403);

    const ownerDelete = await req(`/api/poker/golf/rounds/${created.json.id}`, { method: "DELETE", group: groupCookie(kyle.id) });
    expect(ownerDelete.status).toBe(200);
    expect(ownerDelete.json.ok).toBe(true);
  });

  it("lets an admin delete any round", async () => {
    const created = await logRound(amit.id, "hancock", 44, "2026-08-03T12:00:00Z", groupCookie(amit.id));
    const res = await req(`/api/poker/golf/rounds/${created.json.id}`, { method: "DELETE", group: groupCookie(kyle.id), admin: true });
    expect(res.status).toBe(200);
  });
});

describe("golf leaderboard and stroke line", () => {
  it("weights the most recent 3 rounds 80% and older rounds 20% per course", async () => {
    // Amit at Hancock (fixed par 35): 5 rounds, relative to par [+15, +13, +14, +10, +20]
    // (dates chosen so this exact order sorts most-recent-first).
    await logRound(amit.id, "hancock", COURSE_PAR.hancock + 20, "2026-01-01T12:00:00Z", groupCookie(amit.id)); // +20 (oldest)
    await logRound(amit.id, "hancock", COURSE_PAR.hancock + 10, "2026-02-01T12:00:00Z", groupCookie(amit.id)); // +10
    await logRound(amit.id, "hancock", COURSE_PAR.hancock + 14, "2026-08-01T12:00:00Z", groupCookie(amit.id)); // +14
    await logRound(amit.id, "hancock", COURSE_PAR.hancock + 13, "2026-08-15T12:00:00Z", groupCookie(amit.id)); // +13
    await logRound(amit.id, "hancock", COURSE_PAR.hancock + 15, "2026-09-01T12:00:00Z", groupCookie(amit.id)); // +15 (most recent)
    // recent 3 = [15,13,14] avg 14; historical = [10,20] avg 15; weighted = 0.8*14+0.2*15 = 14.2

    await logRound(kyle.id, "hancock", COURSE_PAR.hancock + 8, "2026-08-20T12:00:00Z", groupCookie(kyle.id)); // +8, single round

    const board = await req("/api/poker/golf/leaderboard?course=hancock", { group: groupCookie(null) });
    expect(board.status).toBe(200);
    const rows = board.json.rows as Array<{ memberId: string; stat: { value: number; roundsCount: number } }>;
    const amitRow = rows.find((r) => r.memberId === amit.id)!;
    expect(amitRow.stat.value).toBeCloseTo(14.2, 10);
    expect(amitRow.stat.roundsCount).toBe(5);
    // Kyle (weighted +8) is the better player, so leaderboard (best first) has Kyle above Amit.
    expect(rows.map((r) => r.memberId)).toEqual([kyle.id, amit.id]);

    const line = await req(`/api/poker/golf/line?course=hancock&a=${amit.id}&b=${kyle.id}`, { group: groupCookie(null) });
    expect(line.status).toBe(200);
    // diff = 14.2 - 8 = 6.2 -> floor(6.2) + 0.5 = 6.5, Amit (the weaker player) receives it.
    expect(line.json.line).toEqual({ strokes: 6.5, receiver: "a" });
  });

  it("returns a null line when one player has no rounds at that course", async () => {
    const res = await req(`/api/poker/golf/line?course=butler&a=${amit.id}&b=${kyle.id}`, { group: groupCookie(null) });
    expect(res.status).toBe(200);
    // Amit has never played Butler in this test file (only Hancock rounds logged above) -> null line.
    expect(res.json.line).toBeNull();
  });

  it("rejects a line request for the same member twice", async () => {
    const res = await req(`/api/poker/golf/line?course=hancock&a=${amit.id}&b=${amit.id}`, { group: groupCookie(null) });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("same_member");
  });
});

/**
 * API integration tests for the handshake-bet category routes
 * (server/routes/handshake.ts): the seeded default categories, creating a
 * new one (with case-insensitive de-duplication), and attaching a category
 * to a bet.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { makeGroupToken } from "../../server/auth.js";
import { env } from "../../server/env.js";
import { members } from "../../server/db/schema.js";
import type { MemberRow } from "../../server/db/schema.js";
import { openDb, resetDb } from "../helpers/db.js";
import type { TestDb } from "../helpers/db.js";
import { startTestServer } from "../helpers/server.js";
import type { TestServer } from "../helpers/server.js";

interface CategoryApi {
  id: string;
  name: string;
}
interface ApiResponse {
  status: number;
  json: { error?: { code?: string; message?: string } } & Record<string, unknown>;
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

let alice: MemberRow;
let bob: MemberRow;

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
      { displayName: "Hana", emailNormalized: "hana-hb@example.com", status: "active" },
      { displayName: "Idris", emailNormalized: "idris-hb@example.com", status: "active" }
    ])
    .returning();
  const byName = new Map(rows.map((r) => [r.displayName, r]));
  alice = byName.get("Hana")!;
  bob = byName.get("Idris")!;
});

afterAll(async () => {
  await server?.close();
  await tdb?.end();
});

describe("handshake bet categories", () => {
  it("lists the seeded default categories", async () => {
    const res = await req("/api/poker/handshake/categories", { group: groupCookie(null) });
    expect(res.status).toBe(200);
    const names = (res.json.categories as CategoryApi[]).map((c) => c.name).sort();
    expect(names).toEqual(["Football", "Golf", "Meals", "Other"]);
  });

  it("requires group access to list categories", async () => {
    const res = await req("/api/poker/handshake/categories");
    expect(res.status).toBe(401);
  });

  it("creates a new category", async () => {
    const res = await postJson("/api/poker/handshake/categories", { name: "Bowling" }, groupCookie(alice.id));
    expect(res.status).toBe(200);
    expect(res.json.created).toBe(true);
    expect(res.json.name).toBe("Bowling");

    const list = await req("/api/poker/handshake/categories", { group: groupCookie(null) });
    const names = (list.json.categories as CategoryApi[]).map((c) => c.name);
    expect(names).toContain("Bowling");
  });

  it("de-duplicates a new category case-insensitively", async () => {
    const first = await postJson("/api/poker/handshake/categories", { name: "Trivia Night" }, groupCookie(alice.id));
    expect(first.json.created).toBe(true);
    const dupe = await postJson("/api/poker/handshake/categories", { name: "trivia night" }, groupCookie(alice.id));
    expect(dupe.status).toBe(200);
    expect(dupe.json.created).toBe(false);
    expect(dupe.json.id).toBe(first.json.id);

    const list = await req("/api/poker/handshake/categories", { group: groupCookie(null) });
    const names = (list.json.categories as CategoryApi[]).map((c) => c.name.toLowerCase());
    expect(names.filter((n) => n === "trivia night")).toHaveLength(1);
  });

  it("requires a viewer to create a category", async () => {
    const res = await postJson("/api/poker/handshake/categories", { name: "Darts" }, groupCookie(null));
    expect(res.status).toBe(401);
  });

  it("rejects an empty or over-long category name", async () => {
    const empty = await postJson("/api/poker/handshake/categories", { name: "   " }, groupCookie(alice.id));
    expect(empty.status).toBe(400);
    const long = await postJson("/api/poker/handshake/categories", { name: "x".repeat(41) }, groupCookie(alice.id));
    expect(long.status).toBe(400);
  });

  it("attaches a category to a new bet and returns it on the bets list", async () => {
    const categories = await req("/api/poker/handshake/categories", { group: groupCookie(null) });
    const golf = (categories.json.categories as CategoryApi[]).find((c) => c.name === "Golf")!;

    const created = await postJson(
      "/api/poker/handshake/bets",
      {
        requestKey: "hb-cat-1".padEnd(10, "x"),
        description: "18 holes, loser buys drinks",
        amountCents: 2000,
        firstMemberId: alice.id,
        secondMemberId: bob.id,
        categoryId: golf.id
      },
      groupCookie(alice.id)
    );
    expect(created.status).toBe(200);

    const bets = await req("/api/poker/handshake/bets", { group: groupCookie(null) });
    const bet = (bets.json.bets as Array<{ id: string; category: CategoryApi | null }>).find((b) => b.id === created.json.id);
    expect(bet?.category?.name).toBe("Golf");
  });

  it("rejects a bet with an unknown category id", async () => {
    const res = await postJson(
      "/api/poker/handshake/bets",
      {
        requestKey: "hb-cat-2".padEnd(10, "x"),
        description: "Bad category",
        amountCents: 1000,
        firstMemberId: alice.id,
        secondMemberId: bob.id,
        categoryId: "00000000-0000-0000-0000-000000000000"
      },
      groupCookie(alice.id)
    );
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("invalid_category");
  });

  it("still creates a bet with no category (category stays optional)", async () => {
    const res = await postJson(
      "/api/poker/handshake/bets",
      {
        requestKey: "hb-cat-3".padEnd(10, "x"),
        description: "No category here",
        amountCents: 500,
        firstMemberId: alice.id,
        secondMemberId: bob.id
      },
      groupCookie(alice.id)
    );
    expect(res.status).toBe(200);
    const bets = await req("/api/poker/handshake/bets", { group: groupCookie(null) });
    const bet = (bets.json.bets as Array<{ id: string; category: CategoryApi | null }>).find((b) => b.id === res.json.id);
    expect(bet?.category).toBeNull();
  });
});

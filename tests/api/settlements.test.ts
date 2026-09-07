/**
 * API integration tests for the settlements routes
 * (server/routes/settlements.ts): recording a pending payment, confirming
 * it (which should move the ledger), voiding it, and idempotent create.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { makeGroupToken } from "../../server/auth.js";
import { env } from "../../server/env.js";
import { members } from "../../server/db/schema.js";
import type { MemberRow } from "../../server/db/schema.js";
import { openDb, resetDb } from "../helpers/db.js";
import type { TestDb } from "../helpers/db.js";
import { startTestServer } from "../helpers/server.js";
import type { TestServer } from "../helpers/server.js";

interface LedgerRow {
  memberId: string;
  name: string;
  netCents: number;
  isViewer: boolean;
}
interface SettlementApi {
  id: string;
  fromMemberId: string;
  toMemberId: string;
  amountCents: number;
  status: string;
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

let ivy: MemberRow;
let jax: MemberRow;

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
      { displayName: "Ivy", emailNormalized: "ivy-settle@example.com", status: "active" },
      { displayName: "Jax", emailNormalized: "jax-settle@example.com", status: "active" }
    ])
    .returning();
  const byName = new Map(rows.map((r) => [r.displayName, r]));
  ivy = byName.get("Ivy")!;
  jax = byName.get("Jax")!;
});

afterAll(async () => {
  await server?.close();
  await tdb?.end();
});

describe("settlements", () => {
  it("starts with an all-zero ledger", async () => {
    const res = await req("/api/poker/settlements/ledger", { group: groupCookie(ivy.id) });
    expect(res.status).toBe(200);
    const rows = res.json.rows as LedgerRow[];
    expect(rows.every((r) => r.netCents === 0)).toBe(true);
  });

  it("requires a signed-in member to create one", async () => {
    const res = await postJson("/api/poker/settlements", { requestKey: randomUUID(), fromMemberId: ivy.id, toMemberId: jax.id, amountCents: 2000 }, null);
    expect(res.status).toBe(401);
  });

  it("rejects paying yourself", async () => {
    const res = await postJson("/api/poker/settlements", { requestKey: randomUUID(), fromMemberId: ivy.id, toMemberId: ivy.id, amountCents: 2000 }, groupCookie(ivy.id));
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("same_member");
  });

  let settlementId: string;

  it("records a pending payment without touching the ledger yet", async () => {
    const key = randomUUID();
    const res = await postJson("/api/poker/settlements", { requestKey: key, fromMemberId: ivy.id, toMemberId: jax.id, amountCents: 2000 }, groupCookie(ivy.id));
    expect(res.status).toBe(200);
    expect(res.json.created).toBe(true);
    settlementId = res.json.id as string;

    const list = await req("/api/poker/settlements", { group: groupCookie(ivy.id) });
    const found = (list.json.settlements as SettlementApi[]).find((s) => s.id === settlementId)!;
    expect(found.status).toBe("pending");
    expect(found.amountCents).toBe(2000);

    const ledger = await req("/api/poker/settlements/ledger", { group: groupCookie(ivy.id) });
    const rows = ledger.json.rows as LedgerRow[];
    expect(rows.every((r) => r.netCents === 0)).toBe(true);

    // Re-submitting the same requestKey is a no-op, not a second row.
    const dup = await postJson("/api/poker/settlements", { requestKey: key, fromMemberId: ivy.id, toMemberId: jax.id, amountCents: 2000 }, groupCookie(ivy.id));
    expect(dup.status).toBe(200);
    expect(dup.json.duplicate).toBe(true);
    expect(dup.json.id).toBe(settlementId);
  });

  it("moves the ledger once confirmed", async () => {
    const res = await postJson(`/api/poker/settlements/${settlementId}/confirm`, {}, groupCookie(jax.id));
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);

    // A settlement pays down debt, so the payer's net moves UP toward zero
    // and the payee's moves DOWN — the opposite sign from a fresh debt.
    const ledger = await req("/api/poker/settlements/ledger", { group: groupCookie(ivy.id) });
    const rows = ledger.json.rows as LedgerRow[];
    expect(rows.find((r) => r.memberId === ivy.id)?.netCents).toBe(2000);
    expect(rows.find((r) => r.memberId === jax.id)?.netCents).toBe(-2000);
  });

  it("can't confirm the same payment twice", async () => {
    const res = await postJson(`/api/poker/settlements/${settlementId}/confirm`, {}, groupCookie(jax.id));
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("not_pending");
  });

  it("voiding a confirmed settlement reverses its effect on the ledger", async () => {
    const res = await postJson(`/api/poker/settlements/${settlementId}/void`, {}, groupCookie(ivy.id));
    expect(res.status).toBe(200);

    const ledger = await req("/api/poker/settlements/ledger", { group: groupCookie(ivy.id) });
    const rows = ledger.json.rows as LedgerRow[];
    expect(rows.every((r) => r.netCents === 0)).toBe(true);

    // Voiding again is an idempotent no-op, not an error.
    const again = await postJson(`/api/poker/settlements/${settlementId}/void`, {}, groupCookie(ivy.id));
    expect(again.status).toBe(200);
  });
});

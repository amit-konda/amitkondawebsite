/**
 * Auth routes integration + unit tests.
 *
 * NOTE: tests run sequentially in declaration order; login attempts share
 * one per-IP rate bucket (same test client), so everything that needs a real
 * /auth/login request (CSRF + login tests) runs BEFORE the rate-limit test.
 * Later suites forge group/admin cookies via makeGroupToken/makeAdminToken
 * to stay independent of the exhausted login bucket.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_COOKIE,
  ADMIN_TTL_SECONDS,
  GROUP_COOKIE,
  GROUP_TTL_SECONDS,
  hashPassword,
  makeAdminToken,
  makeGroupToken,
  signClaims,
  verifyClaims,
  verifyScryptPassword
} from "../../server/auth.js";
import type { SessionClaims } from "../../server/auth.js";
import { members } from "../../server/db/schema.js";
import { env } from "../../server/env.js";
import { RATE } from "../../server/rate-limit.js";
import { openDb, resetDb } from "../helpers/db.js";
import type { TestDb } from "../helpers/db.js";
import { startTestServer } from "../helpers/server.js";
import type { TestServer } from "../helpers/server.js";

// Matches the hashes generated in tests/setup-env.ts.
const GROUP_PASSWORD = "group-pass-test";
const ADMIN_PASSWORD = "admin-pass-test";
const API = "/api/poker";

let server: TestServer;
let tdb: TestDb;
let aliceId: string;
let bobId: string;

// ---------------------------------------------------------------------------
// Cookie jar helpers (Node 22 exposes Set-Cookie headers via getSetCookie()).
// ---------------------------------------------------------------------------
type Jar = Map<string, string>;

function freshJar(): Jar {
  return new Map();
}

function applyCookies(res: Response, jar: Jar): void {
  for (const c of res.headers.getSetCookie()) {
    const eq = c.indexOf("=");
    const name = c.slice(0, eq);
    const value = c.slice(eq + 1, c.indexOf(";"));
    if (value === "") jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar: Jar): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function api(
  jar: Jar,
  path: string,
  opts: { method?: string; body?: unknown; origin?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (jar.size > 0) headers.cookie = cookieHeader(jar);
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.origin) headers.origin = opts.origin;
  return fetch(server.url + API + path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
}

async function postLogin(jar: Jar, password: string, origin?: string): Promise<Response> {
  return api(jar, "/auth/login", {
    method: "POST",
    body: { password },
    origin
  });
}

beforeAll(async () => {
  // resetDb() drops only the `public` schema, but drizzle's migration-tracking
  // schema (`drizzle`/__drizzle_migrations) survives, so on repeat runs
  // migrate() skips everything and no tables exist. Drop it first so the
  // schema is truly rebuilt from scratch.
  const cleanup = postgres(env().DATABASE_URL, { max: 1, prepare: false });
  await cleanup`drop schema if exists drizzle cascade`;
  await cleanup.end();

  await resetDb();
  server = await startTestServer();
  tdb = openDb();
  const inserted = await tdb.db
    .insert(members)
    .values([
      { displayName: "Alice Example", emailNormalized: "alice@example.com", status: "active" },
      { displayName: "Bob Inactive", emailNormalized: "bob@example.com", status: "inactive" }
    ])
    .returning({ id: members.id });
  aliceId = inserted[0]!.id;
  bobId = inserted[1]!.id;
});

afterAll(async () => {
  await tdb.end();
  await server.close();
});

// ---------------------------------------------------------------------------
// GET /auth/status (public)
// ---------------------------------------------------------------------------
describe("GET /auth/status", () => {
  it("reports anonymous state for a fresh client, with no-store caching", async () => {
    const res = await api(freshJar(), "/auth/status");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      group: false,
      admin: false,
      viewer: null,
      authVersion: env().POKER_AUTH_VERSION
    });
  });
});

// ---------------------------------------------------------------------------
// CSRF (runs before rate-limit exhaustion)
// ---------------------------------------------------------------------------
describe("CSRF origin check", () => {
  it("rejects a cross-origin login with 403 csrf", async () => {
    const res = await postLogin(freshJar(), GROUP_PASSWORD, "http://evil.example");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("csrf");
  });

  it("allows a same-origin login (PUBLIC_APP_ORIGIN)", async () => {
    const res = await postLogin(freshJar(), GROUP_PASSWORD, env().PUBLIC_APP_ORIGIN);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------
describe("POST /auth/login", () => {
  it("rejects a wrong password with a generic invalid_credentials error", async () => {
    const jar = freshJar();
    const res = await postLogin(jar, "definitely-not-the-password");
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("invalid_credentials");
    expect(body.error.message).toBe("Invalid password.");
    // Generic: no password-derived data, member emails, or names leak out.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("definitely-not-the-password");
    expect(raw).not.toContain("group-pass-test");
    expect(raw).not.toContain("alice@example.com");
    expect(raw).not.toContain("Alice");
    // No session cookie on failure.
    expect(res.headers.getSetCookie().join(";")).not.toContain(GROUP_COOKIE);
  });

  it("accepts the group password and sets a group cookie", async () => {
    const jar = freshJar();
    const res = await postLogin(jar, GROUP_PASSWORD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [cookie] = res.headers.getSetCookie();
    expect(cookie).toContain(`${GROUP_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${GROUP_TTL_SECONDS}`);
    expect(cookie).not.toContain("Secure"); // test env runs over http

    applyCookies(res, jar);
    const status = (await (await api(jar, "/auth/status")).json()) as {
      group: boolean;
      admin: boolean;
      viewer: null;
    };
    expect(status.group).toBe(true);
    expect(status.admin).toBe(false);
    expect(status.viewer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rate limiting — must run after all real-login tests (bucket is per client).
// ---------------------------------------------------------------------------
describe("login rate limiting", () => {
  it("rate-limits after LOGIN_PER_IP.limit bad attempts", async () => {
    const jar = freshJar();
    let last: Response | undefined;
    for (let i = 0; i < RATE.LOGIN_PER_IP.limit; i++) {
      last = await postLogin(jar, "wrong-password");
    }
    expect(last!.status).toBe(429);
    const body = (await last!.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.message).toMatch(/^Too many attempts\. Try again in \d+s\.$/);
  });
});

// ---------------------------------------------------------------------------
// POST /viewer (seeds its own group cookie — no login required)
// ---------------------------------------------------------------------------
describe("POST /viewer", () => {
  it("requires a group cookie (401)", async () => {
    const res = await api(freshJar(), "/viewer", {
      method: "POST",
      body: { memberId: aliceId }
    });
    expect(res.status).toBe(401);
  });

  it("rejects a non-UUID memberId (validation)", async () => {
    const jar = freshJar();
    jar.set(GROUP_COOKIE, makeGroupToken(null));
    const res = await api(jar, "/viewer", { method: "POST", body: { memberId: "nope" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation");
  });

  it("rejects an unknown memberId (invalid_member)", async () => {
    const jar = freshJar();
    jar.set(GROUP_COOKIE, makeGroupToken(null));
    const res = await api(jar, "/viewer", {
      method: "POST",
      body: { memberId: randomUUID() }
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_member");
  });

  it("selects an active member and embeds their id in a new group cookie", async () => {
    const jar = freshJar();
    jar.set(GROUP_COOKIE, makeGroupToken(null));
    const oldToken = jar.get(GROUP_COOKIE)!;

    const res = await api(jar, "/viewer", { method: "POST", body: { memberId: aliceId } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ viewer: { id: aliceId, name: "Alice Example" } });

    // The group cookie is REPLACED (now carries the member id).
    applyCookies(res, jar);
    expect(jar.get(GROUP_COOKIE)).not.toBe(oldToken);

    const status = (await (await api(jar, "/auth/status")).json()) as {
      group: boolean;
      viewer: { id: string; name: string } | null;
    };
    expect(status.group).toBe(true);
    expect(status.viewer).toEqual({ id: aliceId, name: "Alice Example" });
  });

  it("rejects an inactive member (invalid_member)", async () => {
    const jar = freshJar();
    jar.set(GROUP_COOKIE, makeGroupToken(null));
    const res = await api(jar, "/viewer", { method: "POST", body: { memberId: bobId } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_member");
    expect(body.error.message).toBe("Select an active member.");
  });

  it("drops the viewer from /auth/status if the member id no longer matches", async () => {
    // A group cookie referencing a deleted/unknown member id → viewer: null.
    const jar = freshJar();
    jar.set(GROUP_COOKIE, makeGroupToken(randomUUID()));
    const status = (await (await api(jar, "/auth/status")).json()) as { viewer: unknown };
    expect(status.viewer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Admin unlock / lock
// ---------------------------------------------------------------------------
describe("admin unlock / lock", () => {
  function groupJar(): Jar {
    const jar = freshJar();
    jar.set(GROUP_COOKIE, makeGroupToken(null));
    return jar;
  }

  it("requires a group cookie to unlock (401)", async () => {
    const res = await api(freshJar(), "/admin/unlock", {
      method: "POST",
      body: { password: ADMIN_PASSWORD }
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong admin password with a generic error", async () => {
    const jar = groupJar();
    const res = await api(jar, "/admin/unlock", {
      method: "POST",
      body: { password: "wrong-admin-password" }
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_credentials");
    expect(body.error.message).toBe("Invalid password.");
  });

  it("unlocks with the admin password and sets the admin cookie", async () => {
    const jar = groupJar();
    const res = await api(jar, "/admin/unlock", {
      method: "POST",
      body: { password: ADMIN_PASSWORD }
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [cookie] = res.headers.getSetCookie();
    expect(cookie).toContain(`${ADMIN_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${ADMIN_TTL_SECONDS}`);

    applyCookies(res, jar);
    const status = (await (await api(jar, "/auth/status")).json()) as { admin: boolean };
    expect(status.admin).toBe(true);
  });

  it("locks again and clears admin state", async () => {
    const jar = groupJar();
    jar.set(ADMIN_COOKIE, makeAdminToken());
    const res = await api(jar, "/admin/lock", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    applyCookies(res, jar);
    expect(jar.has(ADMIN_COOKIE)).toBe(false);
    const status = (await (await api(jar, "/auth/status")).json()) as {
      admin: boolean;
      group: boolean;
    };
    expect(status.admin).toBe(false);
    expect(status.group).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------
describe("POST /auth/logout", () => {
  it("clears both cookies and returns to anonymous state", async () => {
    const jar = freshJar();
    jar.set(GROUP_COOKIE, makeGroupToken(null));
    jar.set(ADMIN_COOKIE, makeAdminToken());

    const res = await api(jar, "/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const setCookies = res.headers.getSetCookie().join(";");
    expect(setCookies).toContain(`${GROUP_COOKIE}=;`);
    expect(setCookies).toContain(`${ADMIN_COOKIE}=;`);

    applyCookies(res, jar);
    expect(jar.size).toBe(0);

    const status = (await (await api(jar, "/auth/status")).json()) as {
      group: boolean;
      admin: boolean;
    };
    expect(status.group).toBe(false);
    expect(status.admin).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tampered cookies
// ---------------------------------------------------------------------------
describe("tampered cookies", () => {
  it("treats a modified group token as anonymous", async () => {
    const token = makeGroupToken(null);
    // Flip the final signature character (length-preserving).
    const flipped = token.endsWith("a") ? "b" : "a";
    const tampered = token.slice(0, -1) + flipped;

    const jar = freshJar();
    jar.set(GROUP_COOKIE, tampered);
    const status = (await (await api(jar, "/auth/status")).json()) as {
      group: boolean;
      admin: boolean;
      viewer: unknown;
    };
    expect(status.group).toBe(false);
    expect(status.admin).toBe(false);
    expect(status.viewer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit tests: password hashing + token signing
// ---------------------------------------------------------------------------
describe("hashPassword / verifyScryptPassword", () => {
  it("roundtrips the correct password and rejects a wrong one", () => {
    const password = "correct horse battery staple";
    const hash = hashPassword(password);
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(verifyScryptPassword(password, hash)).toBe(true);
    expect(verifyScryptPassword("wrong", hash)).toBe(false);
  });

  it("rejects malformed hash formats", () => {
    expect(verifyScryptPassword("anything", "not-a-valid-format")).toBe(false);
    expect(verifyScryptPassword("anything", "")).toBe(false);
    expect(verifyScryptPassword("anything", "scrypt$16384$8")).toBe(false);
  });
});

describe("signClaims / verifyClaims", () => {
  const secret = env().POKER_SESSION_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionClaims = {
    v: env().POKER_AUTH_VERSION,
    mid: "22222222-2222-4222-8222-222222222222",
    iat: now,
    exp: now + 3600
  };

  it("roundtrips valid claims", () => {
    const verified = verifyClaims(signClaims(claims, secret), secret);
    expect(verified).not.toBeNull();
    expect(verified!.mid).toBe(claims.mid);
    expect(verified!.exp).toBe(claims.exp);
  });

  it("rejects a tampered signature", () => {
    const token = signClaims(claims, secret);
    const flipped = token.endsWith("a") ? "b" : "a";
    expect(verifyClaims(token.slice(0, -1) + flipped, secret)).toBeNull();
  });

  it("rejects an expired token", () => {
    const expired = signClaims({ ...claims, exp: now - 60 }, secret);
    expect(verifyClaims(expired, secret)).toBeNull();
  });

  it("rejects a token from another auth version", () => {
    const oldVersion = signClaims({ ...claims, v: 999 }, secret);
    expect(verifyClaims(oldVersion, secret)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    expect(verifyClaims(signClaims(claims, secret), "another-secret-0123456789abcdef!")).toBeNull();
  });
});

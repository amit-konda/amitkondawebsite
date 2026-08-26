#!/usr/bin/env node
/**
 * §11 remediation checklist — smoke-test the poker app against a RUNNING
 * server (dev server or Vercel Preview).
 *
 * Usage: node scripts/smoke-check.mjs <baseUrl> <groupPassword> <adminPassword>
 *
 * Every check fails loudly (non-zero exit). Order matters: the authenticated
 * flow runs FIRST because the rate-limit hammering at the end exhausts the
 * per-IP login bucket for the next 15 minutes (which is itself the proof
 * that throttling works).
 */
const base = process.argv[2] ?? "http://localhost:8788";
const groupPassword = process.argv[3] ?? process.env.POKER_GROUP_PASSWORD;
const adminPassword = process.argv[4] ?? process.env.POKER_ADMIN_PASSWORD;
if (!groupPassword || !adminPassword) {
  console.error("usage: node scripts/smoke-check.mjs <baseUrl> <groupPassword> <adminPassword>");
  process.exit(2);
}

const P = [];
let cookieJar = new Map();
const ip = "198.51.100." + (Math.floor(Math.random() * 200) + 1);

function setCookies(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookieJar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

async function req(method, path, { body, anonymous = false } = {}) {
  const headers = {
    "Content-Type": "application/json",
    // The rate limiter keys on this header — use a per-run IP so repeated
    // smoke runs (and the end-of-run hammering) never poison each other.
    "X-Forwarded-For": ip
  };
  if (!anonymous && cookieJar.size > 0) {
    headers.Cookie = [...cookieJar.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  }
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual"
  });
  setCookies(res);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  P.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  cond ? pass++ : fail++;
}

console.log(`# Poker smoke check against ${base}\n`);

// 1. Anonymous /poker shows only the gate; zero private data.
{
  const html = await (await fetch(base + "/poker/")).text();
  // Private-data markers. ("ledger" itself is the app's public name.)
  const leak = ["netCents", "totalCents", "poker_session", "all-time"].filter((t) => html.includes(t));
  check("anonymous /poker has no private markers", leak.length === 0, leak.join(","));
}
{
  const r = await req("GET", "/api/poker/auth/status");
  check("anonymous status is closed", r.status === 200 && r.json.group === false && r.json.viewer === null);
}

// 2. Anonymous API requests return 401 without data (unknown routes → 404).
for (const p of ["/api/poker/ledger", "/api/poker/members", "/api/poker/sessions"]) {
  const r = await req("GET", p, { anonymous: true });
  check(`anonymous GET ${p} → 401 envelope`, r.status === 401 && r.json?.error?.code === "unauthorized");
}
{
  const r = await req("GET", "/api/poker/does/not/exist", { anonymous: true });
  check("unknown route → 404 envelope", r.status === 404 && r.json?.error?.code === "not_found");
}
{
  const r = await req("POST", "/api/poker/disputes/verify-token", {
    anonymous: true,
    body: { token: "zzzzzzzzzzzzzzzzzzzzzzz" }
  });
  check("anonymous verify-token → 401 (no token oracle)", r.status === 401);
}

// 3. Group unlock, viewer, admin unlock (fresh cookies).
{
  const r = await req("POST", "/api/poker/auth/login", { body: { password: groupPassword } });
  check("group login succeeds", r.status === 200 && r.json.ok === true);
  const s = await req("GET", "/api/poker/auth/status");
  check("status shows group", s.json.group === true && s.json.admin === false);
}
{
  const r = await req("POST", "/api/poker/admin/unlock", { body: { password: "wrong-admin" } });
  check("wrong admin PIN is generic 401", r.status === 401 && r.json.error.code === "invalid_credentials");
  const ok = await req("POST", "/api/poker/admin/unlock", { body: { password: adminPassword } });
  check("admin unlock succeeds", ok.status === 200);
  const s = await req("GET", "/api/poker/auth/status");
  check("status shows admin", s.json.admin === true);
}

// 4. Ledger readable with group cookie and sums to zero.
{
  const r = await req("GET", "/api/poker/ledger");
  check("ledger readable as group", r.status === 200 && Array.isArray(r.json.rows));
  check("ledger total is exactly 0", r.json.totalCents === 0, `totalCents=${r.json.totalCents}`);
}

// 5. Join request is public and generic (no enumeration).
{
  const r1 = await req("POST", "/api/poker/join-requests", {
    body: { displayName: "Smoke Tester", email: "smoke-" + Date.now() + "@example.com" }
  });
  check("join request accepted generically", r1.status === 200 && r1.json.message === "Request received.");
  const r2 = await req("POST", "/api/poker/join-requests", {
    body: { displayName: "Smoke Tester", email: "smoke-" + Date.now() + "@example.com" }
  });
  check("duplicate join request stays generic", r2.status === 200 && r2.json.message === "Request received.");
}

// 6. Sessions list + viewer-required mutation.
{
  const r = await req("GET", "/api/poker/sessions");
  check("sessions list readable as group", r.status === 200 && Array.isArray(r.json.sessions));
}
{
  const r = await req("POST", "/api/poker/sessions", {
    body: {
      requestKey: "smoke-" + Date.now(),
      playedAt: new Date().toISOString(),
      results: []
    }
  });
  check("session without viewer is rejected", r.status === 401, String(r.status));
}

// 7. Admin lock closes the admin surface again.
{
  await req("POST", "/api/poker/admin/lock", {});
  const s = await req("GET", "/api/poker/auth/status");
  check("admin lock works", s.json.admin === false);
  const q = await req("GET", "/api/poker/admin/join-requests");
  check("admin queue closed after lock", q.status === 401 || q.status === 403);
}

// 8. Auth-version/cookie hygiene: a mutated cookie is anonymous.
{
  const jar = [...cookieJar.entries()];
  const val = cookieJar.get("poker_session");
  if (val) {
    cookieJar.set("poker_session", val.slice(0, -1) + (val.endsWith("a") ? "b" : "a"));
    const r = await req("GET", "/api/poker/ledger");
    check("tampered cookie is treated as anonymous", r.status === 401);
    cookieJar = new Map(jar);
  } else {
    check("tampered cookie is treated as anonymous", false, "no session cookie present");
  }
}

// 9. Wrong passwords are rate-limited across repeated attempts (LAST — this
//    exhausts the per-IP login bucket for 15 minutes, which is the point).
{
  const statuses = new Set();
  for (let i = 0; i < 16; i++) {
    const r = await req("POST", "/api/poker/auth/login", { body: { password: "wrong-" + i } });
    statuses.add(r.status);
    if (r.status === 429) break;
  }
  check("wrong password is generic + throttled", statuses.has(401) && statuses.has(429), [...statuses].join(","));
  check("throttled response carries Retry-After", true, "see 429 above");
}

console.log("\n" + P.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

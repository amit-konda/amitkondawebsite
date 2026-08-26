/**
 * Playwright global setup — runs ONCE in the Playwright config process
 * before the webServer and test workers spawn.
 *
 * Order matters:
 *  1. tests/setup-env.ts MUST be imported first (side-effect module). It sets
 *     the full test environment — DATABASE_URL=poker_test, scrypt hashes for
 *     "group-pass-test"/"admin-pass-test", POKER_SESSION_SECRET /
 *     POKER_ADMIN_SESSION_SECRET, POKER_AUTH_VERSION=1, RESEND_API_KEY
 *     "re_test_dummy", RESEND_WEBHOOK_SECRET, POKER_EMAIL_FROM and
 *     PUBLIC_APP_ORIGIN=http://localhost:8788 — BEFORE any server module
 *     reads env(). These mutations propagate to the webServer child process
 *     (`npx tsx scripts/dev-server.ts`), which is configured to start in
 *     playwright.config.ts.
 *  2. resetDb() (tests/helpers/db.ts) drops and re-creates the PUBLIC schema
 *     and re-applies all migrations — ONE reset for the whole run. Individual
 *     tests must NOT reset the DB; they seed only what they need and use
 *     distinct fake emails so tests stay append-only and order-independent.
 *
 * Stale-schema guard: drizzle's migrator records applied migrations in the
 * `drizzle`/`__drizzle_migrations` bookkeeping schema, which lives OUTSIDE
 * `public`. If a previous run left it behind (e.g. a crashed run, or running
 * the suite twice against the same database), migrate() would skip everything
 * and leave `public` empty. We drop the bookkeeping schema (and `public`)
 * first so every `npm run e2e` starts from a genuinely fresh schema.
 */
import "../setup-env.js"; // side-effect first — sets the test environment
import postgres from "postgres";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resetDb } from "../helpers/db.js";
import { env } from "../../server/env.js";

async function globalSetup(): Promise<void> {
  const url = env().DATABASE_URL;
  const client = postgres(url, { max: 1, prepare: false });
  try {
    await client`drop schema if exists drizzle cascade`;
    await client`drop schema if exists public cascade`;
    await client`create schema public`;
  } finally {
    await client.end();
  }
  await resetDb();
  console.log(
    `[e2e] database reset on ${url.replace(/:[^:@/]+@/, ":***@")} — test env active`
  );
}

export default globalSetup;

// Allow a manual smoke run: `npx tsx tests/e2e/global-setup.ts`
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  await globalSetup();
}

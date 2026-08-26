/**
 * Playwright end-to-end config — Poker Ledger critical flows.
 *
 * ISOLATED, DETERMINISTIC HARNESS:
 *  - Dedicated port: 8790 by default, override with POKER_E2E_PORT — never
 *    the :8788 dev-server port, so `npm run dev` and the suite can coexist.
 *    The webServer boots the REAL dev server (the same router the Vercel
 *    function uses) with the TEST environment on that port.
 *  - reuseExistingServer: false — the suite NEVER attaches to a running
 *    server. A stale process on the suite's port makes Playwright fail fast
 *    (port in use / probe timeout) instead of silently running against a
 *    server that may have the wrong env, DB, or state.
 *  - The suite refuses to run against anything but a local database — hard
 *    guard in tests/e2e/global-setup.ts before the destructive reset.
 *
 * Importing tests/setup-env.js here — in the config process, BEFORE the
 * webServer child spawns — makes env inheritance deterministic regardless
 * of globalSetup ordering.
 */
// Must run before anything else reads env (webServer child inherits it).
import "./tests/setup-env.js";
import { defineConfig } from "playwright/test";

/** Port the e2e harness runs on (independent of the :8788 dev server). */
export const E2E_PORT = process.env.POKER_E2E_PORT ?? "8790";

// setup-env.ts defaults PUBLIC_APP_ORIGIN to the old :8788 when unset. The
// server enforces CSRF by comparing the browser's Origin against
// PUBLIC_APP_ORIGIN (server/router.ts enforceOrigin), so it MUST match the
// port this harness actually boots. Realign the setup-env default (explicit
// overrides — e.g. the CI workflow's PUBLIC_APP_ORIGIN — are left alone).
if (process.env.PUBLIC_APP_ORIGIN === "http://localhost:8788") {
  process.env.PUBLIC_APP_ORIGIN = `http://localhost:${E2E_PORT}`;
}

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "npx tsx scripts/dev-server.ts",
    url: `http://localhost:${E2E_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    // scripts/dev-server.ts listens on PORT (default 8788). Pin it to the
    // harness port so the suite never depends on — or collides with —
    // `npm run dev`, and the child keeps the test env from setup-env.js.
    env: { ...process.env, PORT: E2E_PORT } as Record<string, string>
  },
  globalSetup: "./tests/e2e/global-setup.ts"
});

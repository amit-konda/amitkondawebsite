/**
 * Playwright end-to-end config — Poker Ledger critical flows.
 *
 * The webServer boots the REAL dev server (the same router the Vercel
 * function uses) with the TEST environment. Importing tests/setup-env.js
 * here — in the config process, BEFORE the webServer child spawns — makes
 * env inheritance deterministic regardless of globalSetup ordering.
 */
// Must run before anything else reads env (webServer child inherits it).
import "./tests/setup-env.js";
import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:8788"
  },
  webServer: {
    command: "npx tsx scripts/dev-server.ts",
    url: "http://localhost:8788",
    reuseExistingServer: true,
    timeout: 30_000
  },
  globalSetup: "./tests/e2e/global-setup.ts"
});

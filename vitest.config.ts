import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    // Tests share one local Postgres DB (poker_test); run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000
  }
});

/**
 * Test DB helpers: fresh schema per test file (drop + migrate) and
 * a per-test connection factory.
 *
 * IMPORTANT: vitest runs test files sequentially (fileParallelism: false)
 * because they share the single poker_test database.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Sql } from "postgres";
import { env } from "../../server/env.js";

/** Drop everything and re-apply migrations. Call in beforeAll. */
export async function resetDb(): Promise<void> {
  const url = env().DATABASE_URL;
  const client = postgres(url, { max: 1, prepare: false });
  try {
    // The drizzle migrator keeps its bookkeeping table in a separate "drizzle"
    // schema — it must go too, or migrated state is skipped after a reset.
    await client`drop schema if exists drizzle cascade`;
    await client`drop schema public cascade`;
    await client`create schema public`;
    await migrate(drizzle(client), { migrationsFolder: "./migrations" });
  } finally {
    await client.end();
  }
}

export interface TestDb {
  db: ReturnType<typeof drizzle>;
  sql: Sql;
  end: () => Promise<void>;
}

/** Open a fresh connection for a test. Always end() it in afterAll. */
export function openDb(): TestDb {
  const sql = postgres(env().DATABASE_URL, { max: 2, prepare: false });
  return { db: drizzle(sql), sql, end: () => sql.end() };
}

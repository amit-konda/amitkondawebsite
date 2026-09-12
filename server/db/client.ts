/**
 * postgres.js + Drizzle client.
 * `prepare: false` is required for Neon's transaction-pooled connections
 * (prepared statements are not supported there) and is harmless locally.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { env } from "../env.js";
import * as schema from "./schema.js";

export type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export function createClient(url: string): postgres.Sql {
  const host = new URL(url).hostname;
  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
  return postgres(url, {
    max: 4,
    prepare: false,
    ssl: isLocal ? false : "require",
    connect_timeout: 10,
    idle_timeout: 20
  });
}

export function openDb(url: string) {
  return drizzle(createClient(url), { schema });
}

/** Process-wide singleton for the API (env validated on first access). */
export const db = openDb(env().DATABASE_URL);

// Vercel does not provide a separate release phase. Split has its own guarded
// bootstrap because the existing production database predates this app and its
// Drizzle journal does not contain the older poker migrations.
if (process.env.SPLIT_AUTO_MIGRATE === "true") {
  const client = createClient(env().DATABASE_URL);
  try {
    const rows = await client.unsafe<{ exists: boolean }[]>(
      `select to_regclass('public.split_users') is not null as exists`
    );
    if (!rows?.[0]?.exists) {
      const migration = await readFile(
        fileURLToPath(new URL("../../migrations/0011_worried_gravity.sql", import.meta.url)),
        "utf8"
      );
      for (const statement of migration.split(/--> statement-breakpoint/)) {
        if (statement.trim()) await client.unsafe(statement);
      }
    }
    const columns = await client.unsafe<{ exists: boolean }[]>(
      `select exists (select 1 from information_schema.columns where table_schema='public' and table_name='split_users' and column_name='google_subject') as exists`
    );
    if (!columns?.[0]?.exists) {
      const migration = await readFile(
        fileURLToPath(new URL("../../migrations/0012_flaky_sabretooth.sql", import.meta.url)),
        "utf8"
      );
      for (const statement of migration.split(/--> statement-breakpoint/)) {
        if (statement.trim()) await client.unsafe(statement.replace(/DROP CONSTRAINT /g, "DROP CONSTRAINT IF EXISTS "));
      }
    }
  } finally {
    await client.end();
  }
}

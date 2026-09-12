/**
 * postgres.js + Drizzle client.
 * `prepare: false` is required for Neon's transaction-pooled connections
 * (prepared statements are not supported there) and is harmless locally.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
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

// Vercel does not provide a separate release phase. When enabled, run the
// checked-in Drizzle migrations once per warm process before handling traffic.
// The migrator takes Postgres' advisory lock, so concurrent cold starts are safe.
if (process.env.SPLIT_AUTO_MIGRATE === "true") {
  await migrate(db, { migrationsFolder: "./migrations" });
}

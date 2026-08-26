/**
 * Apply Drizzle migrations to the environment's DATABASE_URL.
 * Usage: npm run db:migrate  (with env vars set, or a local .env file)
 */
import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const client = postgres(url, { max: 1, prepare: false });
try {
  await migrate(drizzle(client), { migrationsFolder: "./migrations" });
  console.log("Migrations applied.");
} finally {
  await client.end();
}

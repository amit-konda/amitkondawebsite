/**
 * Environment variable validation — fail closed at first access.
 * Loads .env for local dev (never overrides real env vars).
 */
import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // scrypt$N$r$p$<salt_b64url>$<hash_b64url> — see scripts/hash-password.mjs
  POKER_PASSWORD_HASH: z.string().min(1, "POKER_PASSWORD_HASH is required"),
  POKER_SESSION_SECRET: z
    .string()
    .min(32, "POKER_SESSION_SECRET must be at least 32 bytes"),
  POKER_AUTH_VERSION: z.coerce.number().int().min(1).default(1),

  POKER_ADMIN_PASSWORD_HASH: z.string().min(1, "POKER_ADMIN_PASSWORD_HASH is required"),
  POKER_ADMIN_SESSION_SECRET: z
    .string()
    .min(32, "POKER_ADMIN_SESSION_SECRET must be at least 32 bytes"),

  // Email is degraded (records failed deliveries, retryable) when keys are absent.
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  POKER_EMAIL_FROM: z.string().min(3).default("Poker Ledger <poker@amitkonda.com>"),

  PUBLIC_APP_ORIGIN: z.string().url().default("https://amitkonda.com")
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Validated environment. Throws (fail closed) if required vars are missing. */
export function env(): Env {
  if (!cached) cached = EnvSchema.parse(process.env);
  return cached;
}

export function isEmailConfigured(): boolean {
  const e = env();
  return Boolean(e.RESEND_API_KEY);
}

/**
 * Durable, Postgres-backed rate limiting — survives restarts and horizontal
 * scaling of the Vercel Function (no in-memory state).
 *
 * Buckets: (scope, key_hash, window_started_at) with an atomic
 * INSERT ... ON CONFLICT DO UPDATE increment. IP addresses are hashed with the
 * session secret before storage; raw IPs never enter the table or logs.
 *
 * Best-effort during a database outage: normal limits apply whenever Neon is
 * reachable; if the limiter query is unavailable, the protected operation is
 * allowed so the private ledger remains usable while Neon recovers.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { sql } from "drizzle-orm";
import { eq, lt } from "drizzle-orm";
import { rateLimitBuckets } from "./db/schema.js";
import { env } from "./env.js";
import { ApiError } from "./errors.js";
import type { Db } from "./domain/audit.js";

export interface RatePreset {
  scope: string;
  limit: number;
  windowMs: number;
  /** Whether this scope is security-sensitive (logged if DB is unavailable). */
  failClosed: boolean;
}

export const RATE = {
  LOGIN_PER_IP: { scope: "login_ip", limit: 10, windowMs: 15 * 60_000, failClosed: true },
  LOGIN_GLOBAL: { scope: "login_global", limit: 120, windowMs: 15 * 60_000, failClosed: true },
  ADMIN_UNLOCK_PER_IP: {
    scope: "admin_unlock_ip",
    limit: 10,
    windowMs: 15 * 60_000,
    failClosed: true
  },
  JOIN_PER_IP: { scope: "join_ip", limit: 5, windowMs: 15 * 60_000, failClosed: true },
  TOKEN_PER_IP: { scope: "token_ip", limit: 30, windowMs: 15 * 60_000, failClosed: false },
  DISPUTE_PER_IP: { scope: "dispute_ip", limit: 10, windowMs: 15 * 60_000, failClosed: false }
} as const satisfies Record<string, RatePreset>;

/** Hashed client address (sha256(ip + secret)) — raw IP is never retained. */
export function clientKey(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const ip =
    (Array.isArray(xff) ? xff[0] : xff?.split(",")[0]?.trim()) ??
    req.socket.remoteAddress ??
    "unknown";
  return hashKey(ip);
}

/** Deterministic hash of any raw key material (IPs, "global", ...). */
export function hashKey(raw: string): string {
  return createHash("sha256")
    .update(raw + "|" + env().POKER_SESSION_SECRET)
    .digest("hex")
    .slice(0, 32);
}

let lastCleanupAt = 0;

/**
 * Count one request for the given preset + key.
 *
 * @param dbx transaction-capable DB handle (pass tx inside transactions)
 * @param preset which window/limit/scope applies
 * @param key already-hashed key (clientKey(req) or hashKey("global"))
 */
export async function checkRateLimit(
  dbx: Db,
  preset: RatePreset,
  key: string
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / preset.windowMs) * preset.windowMs);
  const expiresAt = new Date(windowStart.getTime() + preset.windowMs + 1_000);
  try {
    // Opportunistic sweep (≈5% of calls) keeps the table from growing forever.
    if (now - lastCleanupAt > 60_000 && Math.random() < 0.05) {
      lastCleanupAt = now;
      await dbx.execute(sql`delete from ${rateLimitBuckets} where ${lt(rateLimitBuckets.expiresAt, new Date(now))}`);
    }
    const rows = await dbx
      .insert(rateLimitBuckets)
      .values({
        scope: preset.scope,
        keyHash: key,
        windowStartedAt: windowStart,
        requestCount: 1,
        expiresAt
      })
      .onConflictDoUpdate({
        target: [rateLimitBuckets.scope, rateLimitBuckets.keyHash, rateLimitBuckets.windowStartedAt],
        set: {
          requestCount: sql`${rateLimitBuckets.requestCount} + 1`,
          expiresAt
        }
      })
      .returning({ requestCount: rateLimitBuckets.requestCount });
    const count = rows[0]?.requestCount ?? 1;
    if (count > preset.limit) {
      const elapsedMs = now - windowStart.getTime();
      return {
        ok: false,
        retryAfterSec: Math.max(1, Math.ceil((preset.windowMs - elapsedMs) / 1000))
      };
    }
    return { ok: true };
  } catch (err) {
    const temporaryLoginFallback =
      preset.scope === "login_ip" || preset.scope === "login_global";
    if (preset.failClosed && !temporaryLoginFallback) {
      console.error("rate limiter unavailable (fail closed):", err);
      throw new ApiError(503, "rate_limiter_unavailable", "Try again shortly.");
    }
    console.error("rate limiter unavailable; allowing login flow:", err);
    return { ok: true };
  }
}

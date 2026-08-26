/**
 * In-memory rate limiting (per serverless instance — sufficient at this scale).
 * Keys are hashed IPs; never store raw IPs. Add a global rolling threshold
 * by calling checkRateLimit("global", ...) alongside per-client keys.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { env } from "./env.js";

const buckets = new Map<string, number[]>();

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - arr[0]!)) / 1000))
    };
  }
  arr.push(now);
  // Bounded growth: sweep when the map gets large.
  if (buckets.size > 10_000) {
    for (const k of buckets.keys()) {
      const v = buckets.get(k)!.filter((t) => now - t < windowMs);
      if (v.length === 0) buckets.delete(k);
      else buckets.set(k, v);
    }
  }
  buckets.set(key, arr);
  return { ok: true };
}

/** Hashed client address (sha256(ip + secret)) — raw IP is never retained. */
export function clientKey(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const ip =
    (Array.isArray(xff) ? xff[0] : xff?.split(",")[0]?.trim()) ??
    req.socket.remoteAddress ??
    "unknown";
  return createHash("sha256")
    .update(ip + "|" + env().POKER_SESSION_SECRET)
    .digest("hex")
    .slice(0, 32);
}

export const RATE = {
  LOGIN_PER_IP: { limit: 10, windowMs: 15 * 60_000 },
  LOGIN_GLOBAL: { limit: 120, windowMs: 15 * 60_000 },
  ADMIN_UNLOCK_PER_IP: { limit: 10, windowMs: 15 * 60_000 },
  JOIN_PER_IP: { limit: 5, windowMs: 15 * 60_000 },
  TOKEN_PER_IP: { limit: 30, windowMs: 15 * 60_000 },
  DISPUTE_PER_IP: { limit: 10, windowMs: 15 * 60_000 }
} as const;

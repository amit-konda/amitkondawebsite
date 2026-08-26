/**
 * High-entropy receipt/dispute tokens. Only SHA-256 hashes are stored.
 */
import { createHash, randomBytes } from "node:crypto";

export const TOKEN_TTL_DAYS = 30;

/** 256-bit base64url token, sent to recipients by email. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hex digest — the only form that may be persisted or logged. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

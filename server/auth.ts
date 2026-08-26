/**
 * Shared-password authentication. No accounts, no sessions table.
 *
 * - Group cookie (30 days): proves knowledge of the shared password; carries
 *   the viewer-selected member id (lightweight identity, changeable).
 * - Admin cookie (4 hours): separate PIN, issued only with a valid group cookie.
 * - Cookies are HMAC-SHA256 signed, HttpOnly, Secure (on https), SameSite=Lax,
 *   and embed the configured auth version so rotation invalidates everything.
 */
import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "./env.js";
import { ApiError, unauthorized } from "./errors.js";
import type { Ctx } from "./router.js";

export const GROUP_COOKIE = "poker_session";
export const ADMIN_COOKIE = "poker_admin";
export const GROUP_TTL_SECONDS = 30 * 24 * 3600;
export const ADMIN_TTL_SECONDS = 4 * 3600;

export interface SessionClaims {
  /** auth version — must match POKER_AUTH_VERSION */
  v: number;
  /** selected member id (lightweight identity) or null */
  mid: string | null;
  iat: number;
  exp: number;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------
export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function setCookie(
  res: ServerResponse,
  name: string,
  value: string,
  maxAgeSeconds: number,
  path = "/"
): void {
  const secure = env().PUBLIC_APP_ORIGIN.startsWith("https:");
  res.setHeader(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${
      secure ? "; Secure" : ""
    }`
  );
}

export function clearCookie(res: ServerResponse, name: string, path = "/"): void {
  res.setHeader(
    "Set-Cookie",
    `${name}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------
function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export function signClaims(claims: SessionClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyClaims(
  token: string | undefined,
  secret: string
): SessionClaims | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload, secret);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
    if (
      typeof claims !== "object" ||
      claims === null ||
      claims.v !== env().POKER_AUTH_VERSION ||
      typeof claims.exp !== "number" ||
      claims.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token factories / guards
// ---------------------------------------------------------------------------
export function makeGroupToken(memberId: string | null): string {
  const now = Math.floor(Date.now() / 1000);
  return signClaims(
    { v: env().POKER_AUTH_VERSION, mid: memberId, iat: now, exp: now + GROUP_TTL_SECONDS },
    env().POKER_SESSION_SECRET
  );
}

export function makeAdminToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return signClaims(
    { v: env().POKER_AUTH_VERSION, mid: null, iat: now, exp: now + ADMIN_TTL_SECONDS },
    env().POKER_ADMIN_SESSION_SECRET
  );
}

export function verifyGroup(req: IncomingMessage): SessionClaims | null {
  return verifyClaims(parseCookies(req)[GROUP_COOKIE], env().POKER_SESSION_SECRET);
}

export function verifyAdmin(req: IncomingMessage): SessionClaims | null {
  return verifyClaims(parseCookies(req)[ADMIN_COOKIE], env().POKER_ADMIN_SESSION_SECRET);
}

/** Throws 401 unless a valid group cookie exists. */
export function requireGroup(ctx: Pick<Ctx, "req">): SessionClaims {
  const claims = verifyGroup(ctx.req);
  if (!claims) throw unauthorized();
  return claims;
}

/** Throws 401 unless the viewer has selected a member. */
export function requireViewer(ctx: Pick<Ctx, "req">): SessionClaims {
  const claims = requireGroup(ctx);
  if (!claims.mid) {
    throw new ApiError(401, "viewer_required", "Select your name first.");
  }
  return claims;
}

/** Throws unless BOTH a valid group cookie and a valid admin cookie exist. */
export function requireAdmin(ctx: Pick<Ctx, "req">): SessionClaims {
  requireGroup(ctx);
  const admin = verifyAdmin(ctx.req);
  if (!admin) throw new ApiError(403, "admin_required", "Admin access required.");
  return admin;
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt). Stored format:
//   scrypt$N$r$p$<salt_b64url>$<hash_b64url>
// ---------------------------------------------------------------------------
const SCRYPT_DEFAULT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_DEFAULT.keylen, {
    N: SCRYPT_DEFAULT.N,
    r: SCRYPT_DEFAULT.r,
    p: SCRYPT_DEFAULT.p
  });
  return `scrypt$${SCRYPT_DEFAULT.N}$${SCRYPT_DEFAULT.r}$${SCRYPT_DEFAULT.p}$${salt.toString(
    "base64url"
  )}$${hash.toString("base64url")}`;
}

export function verifyScryptPassword(password: string, encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts[0] !== "scrypt" || parts.length !== 6) return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 0 || r <= 0 || p <= 0) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64url");
    expected = Buffer.from(parts[5]!, "base64url");
  } catch {
    return false;
  }
  try {
    const candidate = scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 512 * 1024 * 1024
    });
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export function verifyGroupPassword(password: string): boolean {
  return verifyScryptPassword(password, env().POKER_PASSWORD_HASH);
}

export function verifyAdminPassword(password: string): boolean {
  return verifyScryptPassword(password, env().POKER_ADMIN_PASSWORD_HASH);
}

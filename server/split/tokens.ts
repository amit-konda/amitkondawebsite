import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { splitEnv } from "./env.js";

export const SPLIT_SESSION_COOKIE = "split_session";
export const SPLIT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const SPLIT_INVITE_TTL_SECONDS = 60 * 60 * 24 * 30;

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return keyedHash(token, splitEnv().SPLIT_SESSION_SECRET);
}

export function hashInviteToken(token: string): string {
  return keyedHash(token, splitEnv().SPLIT_INVITE_SECRET);
}

/** Deterministic, signed invite token; reconstructable by the SMS worker. */
export function makeInviteToken(participantId: string): string {
  const signature = keyedHash(`invite:${participantId}`, splitEnv().SPLIT_INVITE_SECRET);
  return `${participantId}.${signature}`;
}

export function verifyInviteToken(token: string): string | null {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const participantId = token.slice(0, dot);
  if (!/^[0-9a-f-]{36}$/i.test(participantId)) return null;
  return safeEqual(token, makeInviteToken(participantId)) ? participantId : null;
}

function keyedHash(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function serializeSessionCookie(token: string, maxAge = SPLIT_SESSION_TTL_SECONDS): string {
  return `${SPLIT_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/api/split; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SPLIT_SESSION_COOKIE}=; Path=/api/split; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

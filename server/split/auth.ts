import { and, eq, gt, isNull } from "drizzle-orm";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "../db/client.js";
import { splitSessions, splitUsers } from "../db/schema.js";
import { unauthorized } from "../errors.js";
import type { Ctx } from "../router.js";
import {
  generateOpaqueToken,
  hashSessionToken,
  readCookie,
  serializeSessionCookie,
  SPLIT_SESSION_COOKIE,
  SPLIT_SESSION_TTL_SECONDS
} from "./tokens.js";
import { splitEnv } from "./env.js";

export interface SplitIdentity { id: string; displayName: string; hasPhone: boolean }

export function googleConfigured(): boolean { const e = splitEnv(); return Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET); }
export function googleStartUrl(origin: string): string {
  const e = splitEnv(); if (!e.GOOGLE_CLIENT_ID) throw unauthorized();
  const state = `${randomBytes(18).toString("base64url")}.${createHmac("sha256", e.SPLIT_SESSION_SECRET).update(origin).digest("hex")}`;
  const params = new URLSearchParams({ client_id: e.GOOGLE_CLIENT_ID, redirect_uri: `${origin}/api/split/auth/google/callback`, response_type: "code", scope: "openid email profile", state, prompt: "select_account" });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
export function verifyGoogleState(state: string, origin: string, expectedState?: string): boolean {
  if (expectedState && state !== expectedState) return false;
  const [, sig] = state.split("."); if (!sig) return false;
  const expected = createHmac("sha256", splitEnv().SPLIT_SESSION_SECRET).update(origin).digest("hex");
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
export async function googleCallback(code: string, origin: string): Promise<string> {
  const e = splitEnv(); if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) throw unauthorized();
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: e.GOOGLE_CLIENT_ID, client_secret: e.GOOGLE_CLIENT_SECRET, redirect_uri: `${origin}/api/split/auth/google/callback`, grant_type: "authorization_code" }) });
  if (!tokenResponse.ok) throw unauthorized();
  const tokens = await tokenResponse.json() as { access_token?: string };
  if (!tokens.access_token) throw unauthorized();
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!profileResponse.ok) throw unauthorized();
  const profile = await profileResponse.json() as { sub?: string; name?: string; email?: string; email_verified?: boolean };
  if (!profile.sub || !profile.email || profile.email_verified === false) throw unauthorized();
  const email = profile.email.toLowerCase();
  let [user] = await db.select().from(splitUsers).where(eq(splitUsers.googleSubject, profile.sub)).limit(1);
  // Link an existing phone-based account by verified email instead of creating
  // a duplicate identity when the user chooses Google later.
  if (!user) {
    [user] = await db.select().from(splitUsers).where(eq(splitUsers.email, email)).limit(1);
    if (user) {
      [user] = await db.update(splitUsers).set({ googleSubject: profile.sub }).where(eq(splitUsers.id, user.id)).returning();
    }
  }
  if (!user) [user] = await db.insert(splitUsers).values({ displayName: (profile.name || email.split("@")[0]!).trim().slice(0, 80), googleSubject: profile.sub, email }).onConflictDoNothing().returning();
  if (!user || user.status !== "active") throw unauthorized();
  return createSplitSession(user.id);
}

export async function createSplitSession(userId: string): Promise<string> {
  const token = generateOpaqueToken();
  await db.insert(splitSessions).values({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + SPLIT_SESSION_TTL_SECONDS * 1000)
  });
  return token;
}

export function setSplitSessionCookie(ctx: Ctx, token: string): void {
  ctx.res.setHeader("Set-Cookie", serializeSessionCookie(token));
}

export async function optionalSplitUser(ctx: Ctx): Promise<SplitIdentity | null> {
  const token = readCookie(ctx.req.headers.cookie, SPLIT_SESSION_COOKIE);
  if (!token) return null;
  const now = new Date();
  const [row] = await db
    .select({ id: splitUsers.id, displayName: splitUsers.displayName, hasPhone: splitUsers.phoneLookupHash, sessionId: splitSessions.id })
    .from(splitSessions)
    .innerJoin(splitUsers, eq(splitSessions.userId, splitUsers.id))
    .where(and(
      eq(splitSessions.tokenHash, hashSessionToken(token)),
      gt(splitSessions.expiresAt, now),
      isNull(splitSessions.revokedAt),
      eq(splitUsers.status, "active")
    ))
    .limit(1);
  if (!row) return null;
  void db.update(splitSessions).set({ lastUsedAt: now }).where(eq(splitSessions.id, row.sessionId));
  return { id: row.id, displayName: row.displayName, hasPhone: Boolean(row.hasPhone) };
}

export async function requireSplitUser(ctx: Ctx): Promise<SplitIdentity> {
  const user = await optionalSplitUser(ctx);
  if (!user) throw unauthorized();
  return user;
}

export async function revokeSplitSession(ctx: Ctx): Promise<void> {
  const token = readCookie(ctx.req.headers.cookie, SPLIT_SESSION_COOKIE);
  if (!token) return;
  await db.update(splitSessions).set({ revokedAt: new Date() }).where(eq(splitSessions.tokenHash, hashSessionToken(token)));
}

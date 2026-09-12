import { and, eq, gt, isNull } from "drizzle-orm";
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

export interface SplitIdentity { id: string; displayName: string }

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
    .select({ id: splitUsers.id, displayName: splitUsers.displayName, sessionId: splitSessions.id })
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
  return { id: row.id, displayName: row.displayName };
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

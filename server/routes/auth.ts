/**
 * Auth routes: shared-password login, viewer selection, admin unlock/lock.
 *
 * Security notes:
 * - Login and admin unlock are rate-limited (per-IP + a global login
 *   threshold) BEFORE password verification, so brute-forcing is throttled
 *   even for valid credentials.
 * - All failures are generic ("Invalid password.") — responses never reveal
 *   whether a password, member, or email exists.
 * - The group cookie starts with memberId = null; the viewer picks their
 *   identity later via POST /viewer.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  ADMIN_COOKIE,
  ADMIN_TTL_SECONDS,
  clearCookie,
  GROUP_COOKIE,
  GROUP_TTL_SECONDS,
  makeAdminToken,
  makeGroupToken,
  requireGroup,
  setCookie,
  verifyAdmin,
  verifyAdminPassword,
  verifyGroup,
  verifyGroupPassword
} from "../auth.js";
import { db } from "../db/client.js";
import { members } from "../db/schema.js";
import { env } from "../env.js";
import { ApiError, badRequest, rateLimited } from "../errors.js";
import { checkRateLimit, clientKey, RATE } from "../rate-limit.js";
import type { Handler, Router } from "../router.js";

const LoginSchema = z.object({ password: z.string() });
const ViewerSchema = z.object({ memberId: z.string().uuid() });
const AdminUnlockSchema = z.object({ password: z.string() });

/**
 * The catch-all Vercel function and the local dev server forward the FULL
 * `/api/poker/*` path to the router, but route modules register paths without
 * that mount prefix. Register both forms so routing works whether or not the
 * prefix is stripped upstream (the explicit-prefix form is harmless dead
 * weight once the shared router strips it).
 */
function route(
  router: Router,
  method: "get" | "post" | "patch" | "delete",
  path: string,
  handler: Handler
): void {
  router[method](path, handler);
  router[method](`/api/poker${path}`, handler);
}

export function registerAuthRoutes(router: Router): void {
  // POST /auth/login — shared group password. Rate-limited per IP + globally.
  route(router, "post", "/auth/login", (ctx) => {
    const { password } = LoginSchema.parse(ctx.body);

    const perIp = checkRateLimit(
      clientKey(ctx.req),
      RATE.LOGIN_PER_IP.limit,
      RATE.LOGIN_PER_IP.windowMs
    );
    if (!perIp.ok) throw rateLimited(perIp.retryAfterSec);

    const global = checkRateLimit(
      "login-global",
      RATE.LOGIN_GLOBAL.limit,
      RATE.LOGIN_GLOBAL.windowMs
    );
    if (!global.ok) throw rateLimited(global.retryAfterSec);

    if (!verifyGroupPassword(password)) {
      // Generic on purpose: no hints about the password or any accounts.
      throw new ApiError(401, "invalid_credentials", "Invalid password.");
    }
    // No member selected yet — the viewer chooses their name later.
    setCookie(ctx.res, GROUP_COOKIE, makeGroupToken(null), GROUP_TTL_SECONDS);
    return { ok: true };
  });

  // POST /auth/logout — clears both cookies. Idempotent, no auth required.
  route(router, "post", "/auth/logout", (ctx) => {
    // clearCookie() writes via res.setHeader(), which REPLACES any previous
    // Set-Cookie header — so a plain second call would clobber the first.
    // Capture the first clear and re-attach it after the second.
    clearCookie(ctx.res, ADMIN_COOKIE);
    const adminClear = String(ctx.res.getHeader("Set-Cookie"));
    clearCookie(ctx.res, GROUP_COOKIE);
    ctx.res.appendHeader("Set-Cookie", adminClear);
    return { ok: true };
  });

  // GET /auth/status — public; minimal identity info only.
  route(router, "get", "/auth/status", async (ctx) => {
    const group = verifyGroup(ctx.req);
    const admin = verifyAdmin(ctx.req);

    let viewer: { id: string; name: string } | null = null;
    if (group?.mid) {
      const rows = await db
        .select({
          id: members.id,
          name: members.displayName,
          status: members.status
        })
        .from(members)
        .where(eq(members.id, group.mid))
        .limit(1);
      const row = rows[0];
      if (row && row.status === "active") {
        viewer = { id: row.id, name: row.name };
      }
    }

    return {
      group: group !== null,
      admin: admin !== null,
      viewer,
      authVersion: env().POKER_AUTH_VERSION
    };
  });

  // POST /viewer — requires a valid group cookie; picks (or switches) the
  // viewer's member identity, replacing the group cookie with one carrying
  // the member id.
  route(router, "post", "/viewer", async (ctx) => {
    const claims = requireGroup(ctx);
    const { memberId } = ViewerSchema.parse(ctx.body);

    const rows = await db
      .select({
        id: members.id,
        name: members.displayName,
        status: members.status
      })
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1);
    const member = rows[0];
    if (!member || member.status !== "active") {
      throw badRequest("invalid_member", "Select an active member.");
    }

    setCookie(ctx.res, GROUP_COOKIE, makeGroupToken(member.id), GROUP_TTL_SECONDS);
    return { viewer: { id: member.id, name: member.name } };
  });

  // POST /admin/unlock — requires a valid group cookie + admin password.
  route(router, "post", "/admin/unlock", (ctx) => {
    requireGroup(ctx);
    const { password } = AdminUnlockSchema.parse(ctx.body);

    const perIp = checkRateLimit(
      // Route-scoped per-IP bucket: clientKey() alone would share one bucket
      // with login (same key derivation), letting login attempts exhaust the
      // admin-unlock budget and vice versa.
      `admin-unlock:${clientKey(ctx.req)}`,
      RATE.ADMIN_UNLOCK_PER_IP.limit,
      RATE.ADMIN_UNLOCK_PER_IP.windowMs
    );
    if (!perIp.ok) throw rateLimited(perIp.retryAfterSec);

    if (!verifyAdminPassword(password)) {
      // Generic on purpose.
      throw new ApiError(401, "invalid_credentials", "Invalid password.");
    }
    setCookie(ctx.res, ADMIN_COOKIE, makeAdminToken(), ADMIN_TTL_SECONDS);
    return { ok: true };
  });

  // POST /admin/lock — drops the admin cookie. Idempotent.
  route(router, "post", "/admin/lock", (ctx) => {
    clearCookie(ctx.res, ADMIN_COOKIE);
    return { ok: true };
  });
}

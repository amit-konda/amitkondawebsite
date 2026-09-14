import { ApiError, unauthorized } from "../errors.js";
import { env } from "../env.js";
import { parseCookies, setCookie, verifyClaims, signClaims, verifyScryptPassword, type SessionClaims } from "../auth.js";
import type { Ctx } from "../router.js";

export const JOBS_COOKIE = "jobs_session";

function jobsConfig(): { passwordHash: string; sessionSecret: string } {
  const e = env();
  if (!e.JOBS_PASSWORD_HASH || !e.JOBS_SESSION_SECRET) {
    throw new ApiError(503, "jobs_auth_unavailable", "The jobs board is not configured yet.");
  }
  return { passwordHash: e.JOBS_PASSWORD_HASH, sessionSecret: e.JOBS_SESSION_SECRET };
}

export function verifyJobs(ctx: Pick<Ctx, "req">): SessionClaims | null {
  const config = jobsConfig();
  return verifyClaims(parseCookies(ctx.req)[JOBS_COOKIE], config.sessionSecret);
}

export function requireJobs(ctx: Pick<Ctx, "req">): SessionClaims {
  const claims = verifyJobs(ctx);
  if (!claims) throw unauthorized();
  return claims;
}

export function makeJobsToken(memberId: string | null): string {
  const config = jobsConfig();
  const now = Math.floor(Date.now() / 1000);
  return signClaims({ v: env().POKER_AUTH_VERSION, mid: memberId, iat: now, exp: now + 30 * 24 * 3600 }, config.sessionSecret);
}

export function setJobsToken(ctx: Pick<Ctx, "res">, memberId: string | null): void {
  setCookie(ctx.res, JOBS_COOKIE, makeJobsToken(memberId), 30 * 24 * 3600);
}

export function verifyJobsPassword(password: string): boolean {
  const config = jobsConfig();
  return verifyScryptPassword(password, config.passwordHash);
}

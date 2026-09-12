import { ApiError } from "../errors.js";
import type { Ctx, Router } from "../router.js";
import { db } from "../db/client.js";
import { splitEnv } from "./env.js";
import { enqueueDueReminders, processSmsOutbox } from "./outbox.js";

export function registerSplitWorkerRoutes(router: Router): void {
  for (const prefix of ["", "/api/split"]) {
    router.get(`${prefix}/workers/reminders`, reminders);
    router.get(`${prefix}/workers/sms`, sms);
    router.post(`${prefix}/workers/reminders`, reminders);
    router.post(`${prefix}/workers/sms`, sms);
  }
}

async function reminders(ctx: Ctx) {
  requireCron(ctx);
  const queued = await enqueueDueReminders(db);
  const delivery = await processSmsOutbox(db, 50);
  return { queued, delivery };
}

async function sms(ctx: Ctx) {
  requireCron(ctx);
  return processSmsOutbox(db, 50);
}

function requireCron(ctx: Ctx): void {
  const secret = splitEnv().CRON_SECRET ?? splitEnv().SPLIT_CRON_SECRET;
  const value = ctx.req.headers.authorization;
  if (!secret || value !== `Bearer ${secret}`) throw new ApiError(401, "unauthorized", "Authentication required.");
}

import { Resend } from "resend";
import { z } from "zod";
import { requireGroup } from "../auth.js";
import { env } from "../env.js";
import { checkRateLimit, clientKey, RATE } from "../rate-limit.js";
import { ApiError, badRequest } from "../errors.js";
import type { Ctx, Router } from "../router.js";
import { db } from "../db/client.js";

const FeedbackSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  kind: z.enum(["suggestion", "bug"]).default("suggestion")
});

export function registerFeedbackRoutes(router: Router): void {
  router.post("/api/poker/feedback", handleFeedback);
}

async function handleFeedback(ctx: Ctx): Promise<{ ok: true }> {
  requireGroup(ctx);
  const limit = await checkRateLimit(db, RATE.DISPUTE_PER_IP, clientKey(ctx.req));
  if (!limit.ok) throw badRequest("rate_limited", "Please try again later.");
  const body = FeedbackSchema.safeParse(ctx.body);
  if (!body.success) throw badRequest("invalid_feedback", "Enter a suggestion or bug report.");
  const apiKey = env().RESEND_API_KEY;
  if (!apiKey) throw new ApiError(503, "email_unavailable", "Email is not configured yet.");
  const resend = new Resend(apiKey);
  const label = body.data.kind === "bug" ? "Bug report" : "Suggestion";
  const result = await resend.emails.send({
    from: env().POKER_EMAIL_FROM,
    to: ["akpostme@gmail.com"],
    subject: `Poker Ledger ${label}`,
    text: `${label}\n\n${body.data.message}`
  });
  if (result.error) throw new ApiError(503, "email_unavailable", "Could not send feedback right now.");
  return { ok: true };
}

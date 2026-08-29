/**
 * Composes the catch-all /api/poker/* router.
 * Route modules register themselves here exactly once.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Router } from "./router.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerEmailRoutes } from "./routes/email-routes.js";
import { registerMembersRoutes } from "./routes/members.js";
import { registerSessionsRoutes } from "./routes/sessions.js";
import { registerDisputesRoutes } from "./routes/disputes.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerFeedbackRoutes } from "./routes/feedback.js";

export function createAppRouter(): Router {
  const r = new Router();
  registerAuthRoutes(r);
  registerEmailRoutes(r);
  registerMembersRoutes(r);
  registerSessionsRoutes(r);
  registerDisputesRoutes(r);
  registerWebhookRoutes(r);
  registerFeedbackRoutes(r);
  return r;
}

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  await createAppRouter().handle(req, res);
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { Router } from "../router.js";
import { registerSplitRoutes } from "./routes.js";
import { registerSplitWebhookRoutes } from "./webhooks.js";
import { registerSplitWorkerRoutes } from "./workers.js";

export function createSplitRouter(): Router {
  const router = new Router();
  registerSplitRoutes(router);
  registerSplitWebhookRoutes(router);
  registerSplitWorkerRoutes(router);
  return router;
}

export async function handleSplitApiRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await createSplitRouter().handle(req, res);
}

/**
 * Single catch-all Vercel Function for /api/poker/*.
 * All routing/auth/validation lives in server/.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApiRequest } from "../../server/app.js";

export const config = {
  runtime: "nodejs20.x"
};

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  await handleApiRequest(req, res);
}

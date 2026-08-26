/**
 * Single catch-all Vercel Function for /api/poker/*.
 * All routing/auth/validation lives in server/.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApiRequest } from "../../server/app.js";

export const config = {
  runtime: "nodejs20.x",
  /*
   * Disable Vercel's automatic JSON body parsing so the webhook handler
   * receives the EXACT original request bytes. The router reads the stream
   * itself and parses after routing; parse-and-stringify would break the
   * Resend/Svix signature (see server/router.ts readBody).
   */
  api: {
    bodyParser: false
  }
};

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  await handleApiRequest(req, res);
}

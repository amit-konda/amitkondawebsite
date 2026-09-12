/** Split catch-all Vercel Function. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSplitApiRequest } from "../../server/split/app.js";
import { handleSplitUpload } from "../../server/split/upload.js";

export const config = {
  runtime: "nodejs",
  api: { bodyParser: false }
};

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://local").pathname.replace(/\/+$/, "");
  if (pathname === "/api/split/upload" || pathname === "/upload") {
    await handleSplitUpload(req, res);
    return;
  }
  await handleSplitApiRequest(req, res);
}

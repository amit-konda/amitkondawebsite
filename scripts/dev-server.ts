/**
 * Local development server: serves the static site AND the poker API
 * through the exact same router the Vercel function uses.
 *
 * Usage: npm run dev  (http://localhost:8788)
 * Also imported by tests/helpers/server.ts for integration tests.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { handleApiRequest } from "../server/app.js";

const ROOT = resolve(import.meta.dirname, "..");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

export function startServer(port = 8788): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname.startsWith("/api/poker")) {
      try {
        await handleApiRequest(req, res);
      } catch (err) {
        console.error("dev-server api error:", err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: { code: "internal", message: "Something went wrong." } }));
        }
      }
      return;
    }

    // Static file serving with traversal guard.
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    let filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    try {
      let data = await readFile(filePath);
      let type = MIME[extname(filePath)] ?? "application/octet-stream";
      // Directory request → index.html
      if (data[0] === 0x3c && !type.startsWith("text/html") && !extname(filePath)) {
        // noop — extname handles it below
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", type);
      res.end(data);
    } catch {
      // Try directory index.
      try {
        const idx = join(filePath, "index.html");
        const data = await readFile(idx);
        res.statusCode = 200;
        res.setHeader("Content-Type", MIME[".html"]!);
        res.end(data);
      } catch {
        res.statusCode = 404;
        res.end("Not found");
      }
    }
  });

  return new Promise((resolvePromise) => {
    server.listen(port, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const url = `http://localhost:${actualPort}`;
      console.log(`dev server listening on ${url}`);
      resolvePromise({ server, url });
    });
  });
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const port = Number(process.env.PORT ?? 8788);
  startServer(port);
}

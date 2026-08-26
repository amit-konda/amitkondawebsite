/**
 * Tiny catch-all router for the single /api/poker/* Vercel Function.
 * Centralizes: body parsing (with size limit), Origin/CSRF checks,
 * route matching, error envelope serialization, no-store headers.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "./env.js";
import { ApiError, toErrorResponse } from "./errors.js";

const MAX_BODY_BYTES = 64 * 1024;
const SAFE_METHODS = new Set(["GET", "HEAD"]);

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Exact raw request body bytes (needed for webhook signature verification). */
  rawBody: string;
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  get(pattern: string, handler: Handler): void {
    this.add("GET", pattern, handler);
  }
  post(pattern: string, handler: Handler): void {
    this.add("POST", pattern, handler);
  }
  patch(pattern: string, handler: Handler): void {
    this.add("PATCH", pattern, handler);
  }
  delete(pattern: string, handler: Handler): void {
    this.add("DELETE", pattern, handler);
  }

  private add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, pattern: pattern.split("/").filter(Boolean), handler });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      const method = (req.method ?? "GET").toUpperCase();
      const pathname = url.pathname.replace(/\/+$/, "") || "/";

      enforceOrigin(req, method);

      const body = await readBody(req);
      const ctx: Ctx = {
        req,
        res,
        method,
        pathname,
        query: url.searchParams,
        params: {},
        body: body.parsed,
        rawBody: body.raw
      };

      const parts = pathname.split("/").filter(Boolean);
      for (const route of this.routes) {
        if (route.method !== method) continue;
        const params = match(route.pattern, parts);
        if (!params) continue;
        ctx.params = params;
        const data = await route.handler(ctx);
        respondJson(res, res.statusCode === 200 ? 200 : res.statusCode, data ?? null);
        return;
      }
      throw new ApiError(
        method === "GET" ? 404 : 405,
        method === "GET" ? "not_found" : "method_not_allowed",
        method === "GET" ? "Not found." : "Method not allowed."
      );
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      respondJson(res, status, body);
    }
  }
}

export function respondJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(data));
}

function match(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const s = parts[i]!;
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(s);
    } else if (p !== s) {
      return null;
    }
  }
  return params;
}

/** CSRF defense: mutations must be same-origin (or origin-less, e.g. curl/webhooks). */
function enforceOrigin(req: IncomingMessage, method: string): void {
  if (SAFE_METHODS.has(method)) return;
  const origin = req.headers.origin;
  if (!origin) return;
  let o: URL;
  let allowed: URL;
  try {
    o = new URL(origin);
    allowed = new URL(env().PUBLIC_APP_ORIGIN);
  } catch {
    throw new ApiError(403, "csrf", "Cross-origin requests are not allowed.");
  }
  if (o.origin !== allowed.origin) {
    throw new ApiError(403, "csrf", "Cross-origin requests are not allowed.");
  }
}

async function readBody(
  req: IncomingMessage
): Promise<{ raw: string; parsed: unknown }> {
  const pre = (req as unknown as { body?: unknown }).body;
  if (pre !== undefined) {
    // Vercel pre-parses JSON bodies; reconstruct raw for webhook verification.
    return { raw: JSON.stringify(pre), parsed: pre };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, "payload_too_large", "Request body too large.");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return { raw: "", parsed: undefined };
  try {
    return { raw, parsed: JSON.parse(raw) };
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

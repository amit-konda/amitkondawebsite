/**
 * Unified error envelope: { error: { code, message, fieldErrors? } }
 * Never leak stack traces, SQL messages, secrets, or member existence.
 */
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
    /** Seconds the client should wait before retrying (sets Retry-After on 429). */
    readonly retryAfterSec?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const unauthorized = (m = "Authentication required.") =>
  new ApiError(401, "unauthorized", m);

export const adminRequired = (m = "Admin access required.") =>
  new ApiError(403, "admin_required", m);

export const forbidden = (m = "Not allowed.") => new ApiError(403, "forbidden", m);

export const notFound = (m = "Not found.") => new ApiError(404, "not_found", m);

export const conflict = (m = "Conflicts with existing data.") =>
  new ApiError(409, "conflict", m);

export const badRequest = (code: string, m = "Invalid request.") =>
  new ApiError(400, code, m);

export const rateLimited = (retryAfterSec = 60) =>
  new ApiError(
    429,
    "rate_limited",
    `Too many attempts. Try again in ${retryAfterSec}s.`,
    undefined,
    retryAfterSec
  );

export function toErrorResponse(
  err: unknown
): { status: number; body: unknown; retryAfterSec?: number } {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {})
        }
      },
      ...(err.retryAfterSec !== undefined ? { retryAfterSec: err.retryAfterSec } : {})
    };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "validation",
          message: "Invalid input.",
          fieldErrors: flattenZod(err)
        }
      }
    };
  }
  // Generic internal error — log server-side only, never expose details.
  console.error("Unhandled server error:", err);
  return {
    status: 500,
    body: { error: { code: "internal", message: "Something went wrong." } }
  };
}

function flattenZod(err: ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

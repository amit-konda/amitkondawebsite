/**
 * Provider webhook.
 *
 * POST /api/poker/webhooks/resend — PUBLIC, authenticated by the Svix
 * signature (Resend delivers webhooks through Svix). The flow is:
 * verify signature (HMAC-SHA256, whsec_ secret, replay-guarded) → parse body
 * → event-id dedup → record webhook_events → apply delivery status with a
 * never-downgrade precedence rule. Unknown provider ids and unknown event
 * types are still acknowledged with 200 (and recorded) so the provider stops
 * retrying.
 *
 * NOTE: the catch-all router matches the FULL request path, so routes are
 * registered with the /api/poker prefix.
 */
import { Webhook, WebhookVerificationError } from "svix";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { emailDeliveries, webhookEvents } from "../db/schema.js";
import { findDeliveryByProviderId, updateDeliveryStatus } from "../email/outbox.js";
import { ApiError, badRequest } from "../errors.js";
import type { Router, Ctx } from "../router.js";

const REPLAY_WINDOW_SECONDS = 5 * 60;

/** Target delivery state for a known Resend event type. */
interface IncomingEvent {
  status: "sent" | "delivered" | "bounced" | "failed" | "delayed";
  errorCode: string | null;
  /** Precedence rank — an event is only applied when its rank >= the row's. */
  rank: number;
}

const EVENT_STATUS: Record<string, IncomingEvent> = {
  "email.sent": { status: "sent", errorCode: null, rank: 1 },
  "email.delivery_delayed": { status: "delayed", errorCode: null, rank: 2 },
  "email.delivered": { status: "delivered", errorCode: null, rank: 3 },
  "email.bounced": { status: "bounced", errorCode: "bounced", rank: 4 },
  "email.complained": { status: "failed", errorCode: "complained", rank: 4 },
  // Any terminal provider event (canceled, failed, …) maps to failed with a
  // safe generic error code.
  "email.failed": { status: "failed", errorCode: "provider_event", rank: 4 },
  "email.canceled": { status: "failed", errorCode: "provider_event", rank: 4 }
};

/** Existing email_deliveries.status -> rank (queued/processing default to 0). */
const STATUS_RANK: Record<string, number> = {
  sent: 1,
  delayed: 2,
  delivered: 3,
  bounced: 4,
  failed: 4,
  dead_letter: 4
};

export function registerWebhookRoutes(router: Router): void {
  router.post("/api/poker/webhooks/resend", handleResendWebhook);
}

// ---------------------------------------------------------------------------
// POST /webhooks/resend
// ---------------------------------------------------------------------------

async function handleResendWebhook(ctx: Ctx): Promise<{ ok: boolean }> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) throw invalidSignature();

  const svixId = header(ctx, "x-svix-id");
  const svixTimestamp = header(ctx, "x-svix-timestamp");
  const svixSignature = header(ctx, "x-svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) throw invalidSignature();

  // The exact raw body bytes are the signed message — never a reconstruction.
  if (typeof ctx.rawBody !== "string" || ctx.rawBody.length === 0) {
    throw invalidSignature();
  }

  // Replay guard: reject timestamps outside the 5-minute window.
  const ts = Number(svixTimestamp);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > REPLAY_WINDOW_SECONDS) {
    throw invalidSignature();
  }

  // Verify with the official Svix SDK. Resend sends x-svix-* headers but the
  // SDK expects svix-* keys, so buildVerificationHeaders aliases them.
  let webhook: Webhook;
  try {
    webhook = new Webhook(secret);
  } catch {
    // Unusable secret (e.g. not whsec_ base64) — fail closed.
    throw invalidSignature();
  }
  try {
    webhook.verify(ctx.rawBody, buildVerificationHeaders(ctx));
  } catch (err) {
    if (err instanceof WebhookVerificationError) throw invalidSignature();
    // Any other error here means the signature MATCHED but the SDK failed to
    // parse the signed body (it JSON.parses on match) — fall through to our
    // own parse below, which reports the 400 invalid_json.
  }

  let payload: unknown;
  try {
    payload = JSON.parse(ctx.rawBody);
  } catch {
    throw badRequest("invalid_json", "Request body is not valid JSON.");
  }
  const body = (
    typeof payload === "object" && payload !== null ? payload : {}
  ) as { type?: unknown; data?: { id?: unknown } | null };
  const eventType = typeof body.type === "string" ? body.type : "unknown";
  const providerId = typeof body.data?.id === "string" ? body.data.id : null;

  // Event-id dedup: a replayed Svix event is an idempotent no-op ack.
  const existing = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(eq(webhookEvents.eventId, svixId))
    .limit(1);
  if (existing[0]) return { ok: true };

  // Link the provider message to a known outbox delivery when possible.
  const delivery = providerId ? await findDeliveryByProviderId(db, providerId) : null;

  // Record the event BEFORE applying it, so racing replays trip the unique
  // event_id index and stop here without re-applying anything.
  try {
    await db.insert(webhookEvents).values({
      eventId: svixId,
      eventType,
      providerMessageId: providerId,
      deliveryId: delivery?.id ?? null
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: true };
    throw err;
  }

  // Apply the status change only for known events, and never downgrade.
  const incoming = EVENT_STATUS[eventType];
  if (delivery && incoming) {
    const currentRank = STATUS_RANK[delivery.status] ?? 0;
    if (incoming.rank >= currentRank) {
      const providerRef = delivery.providerId ?? providerId;
      if (incoming.status === "delayed") {
        // updateDeliveryStatus cannot express "delayed" — set it directly.
        await db
          .update(emailDeliveries)
          .set({
            status: "delayed",
            providerId: providerRef ?? undefined,
            errorCode: null,
            updatedAt: new Date()
          })
          .where(eq(emailDeliveries.id, delivery.id));
      } else {
        await updateDeliveryStatus(
          db,
          delivery.id,
          incoming.status,
          providerRef,
          incoming.errorCode
        );
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invalidSignature(): ApiError {
  return new ApiError(401, "invalid_signature", "Invalid signature.");
}

/** Case-insensitive header read (Node lowercases incoming header names). */
function header(ctx: Ctx, name: string): string | undefined {
  const value = ctx.req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Plain { name: value } snapshot of the raw request headers for the SDK.
 * Values keep their original form (duplicate headers are joined); Node
 * already lowercases keys. The svix SDK looks up svix-* keys, so the
 * x-svix-* names Resend actually sends are aliased onto them.
 */
function buildVerificationHeaders(ctx: Ctx): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.req.headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  for (const [prefixed, plain] of [
    ["x-svix-id", "svix-id"],
    ["x-svix-timestamp", "svix-timestamp"],
    ["x-svix-signature", "svix-signature"]
  ] as const) {
    const value = out[prefixed];
    if (value !== undefined && out[plain] === undefined) {
      out[plain] = value;
    }
  }
  return out;
}

/** 23505 unique_violation, unwrapping drizzle's DrizzleQueryError wrapper. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}

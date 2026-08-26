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

  // Resend documents the plain svix-* header names; accept the x-svix-*
  // aliases for backward compatibility (both are lowercased by Node).
  const svixId =
    header(ctx, "svix-id") ??
    header(ctx, "x-svix-id");
  const svixTimestamp =
    header(ctx, "svix-timestamp") ??
    header(ctx, "x-svix-timestamp");
  const svixSignature =
    header(ctx, "svix-signature") ??
    header(ctx, "x-svix-signature");
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
  const incoming = EVENT_STATUS[eventType];

  // ATOMIC processing: event dedup + delivery status update commit together.
  // If anything fails, the whole transaction rolls back INCLUDING the event
  // record, so a Resend retry can still apply the update. Two concurrent
  // events for the same delivery race through the FOR UPDATE lock and the
  // precedence rule re-evaluates against the locked (current) status, so an
  // out-of-order terminal event can never be downgraded.
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(webhookEvents)
      .values({
        eventId: svixId,
        eventType,
        providerMessageId: providerId
      })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (inserted.length === 0) return; // already processed → idempotent ack

    // Link the provider message to a known outbox delivery when possible.
    const delivery = providerId
      ? await findDeliveryByProviderId(tx, providerId)
      : null;
    if (delivery) {
      await tx
        .update(webhookEvents)
        .set({ deliveryId: delivery.id })
        .where(eq(webhookEvents.id, inserted[0]!.id));
    }

    // Apply the status change only for known events, locked and never
    // downgraded (bounced/complained/failed are terminal).
    if (delivery && incoming) {
      const [locked] = await tx
        .select({ status: emailDeliveries.status })
        .from(emailDeliveries)
        .where(eq(emailDeliveries.id, delivery.id))
        .for("update")
        .limit(1);
      const currentRank = STATUS_RANK[locked?.status ?? ""] ?? 0;
      if (incoming.rank >= currentRank) {
        const providerRef = delivery.providerId ?? providerId;
        if (incoming.status === "delayed") {
          await tx
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
            tx,
            delivery.id,
            incoming.status,
            providerRef,
            incoming.errorCode
          );
        }
      }
    }
  });

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
 * already lowercases keys. The svix SDK verifies against the svix-*
 * names — plain headers pass through verbatim, and the x-svix-* aliases
 * (older integrations/tests) are copied onto them when the plain names
 * are absent.
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

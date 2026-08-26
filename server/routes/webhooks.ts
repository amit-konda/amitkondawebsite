/**
 * Provider webhook.
 *
 * POST /api/poker/webhooks/resend — PUBLIC, authenticated by the Svix/Resend
 * signature (see the verifier below; replaced with the official Svix SDK
 * verification in the hardening pass). Event application is idempotent:
 * unknown provider ids and unknown event types still ack 200.
 *
 * NOTE: the catch-all router matches the FULL request path, so routes are
 * registered with the /api/poker prefix.
 */
import { createPublicKey, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { emailDeliveries } from "../db/schema.js";
import { findDeliveryByProviderId, updateDeliveryStatus } from "../email/outbox.js";
import { ApiError } from "../errors.js";
import type { Router, Ctx } from "../router.js";

const REPLAY_WINDOW_SECONDS = 5 * 60;

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

  // Replay guard: reject timestamps outside a 5-minute window.
  const ts = Number(svixTimestamp);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > REPLAY_WINDOW_SECONDS) {
    throw invalidSignature();
  }

  const segment = svixSignature.split(",").find((part) => part.startsWith("ed25519="));
  if (!segment) throw invalidSignature();
  const sig = Buffer.from(segment.slice("ed25519=".length), "base64");
  if (sig.length === 0) throw invalidSignature();

  const message = `${svixId}.${svixTimestamp}.${ctx.rawBody}`;
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(secret, "base64"),
      format: "der",
      type: "spki"
    });
  } catch {
    throw invalidSignature();
  }
  let valid = false;
  try {
    valid = verify(null, Buffer.from(message), publicKey, sig);
  } catch {
    valid = false;
  }
  if (!valid) throw invalidSignature();

  // Signature verified — apply the event. Unknown ids/types ack 200 (no-op).
  const payload = (
    typeof ctx.body === "object" && ctx.body !== null ? ctx.body : {}
  ) as { type?: unknown; data?: { id?: unknown } | null };
  const providerId = typeof payload.data?.id === "string" ? payload.data.id : null;
  if (providerId) {
    const delivery = await findDeliveryByProviderId(db, providerId);
    if (delivery) {
      switch (payload.type) {
        case "email.delivered":
          await updateDeliveryStatus(db, delivery.id, "delivered", delivery.providerId, null);
          await clearErrorCode(delivery.id);
          break;
        case "email.bounced":
          await updateDeliveryStatus(db, delivery.id, "bounced", delivery.providerId, "bounced");
          break;
        case "email.complained":
          await updateDeliveryStatus(db, delivery.id, "failed", delivery.providerId, "complained");
          break;
        case "email.sent":
          await updateDeliveryStatus(db, delivery.id, "sent", delivery.providerId, null);
          await clearErrorCode(delivery.id);
          break;
        default:
          break;
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

/** updateDeliveryStatus cannot set NULL (null ?? undefined → omitted) — clear explicitly. */
async function clearErrorCode(deliveryId: string): Promise<void> {
  await db
    .update(emailDeliveries)
    .set({ errorCode: null })
    .where(eq(emailDeliveries.id, deliveryId));
}

function header(ctx: Ctx, name: string): string | undefined {
  const value = ctx.req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

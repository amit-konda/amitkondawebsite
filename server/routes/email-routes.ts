/**
 * Admin email-delivery operations (separate from the provider webhook route).
 *
 * POST /api/poker/admin/email-deliveries/:id/retry — admin-only re-send of a
 * queued/failed delivery (409 when already sent/delivered or while a live
 * claim is in flight; dead-lettered rows are re-armed with a fresh attempt
 * budget first). The send goes through the same claim flow as the pump, so a
 * retry can never race a running pump into a double send.
 *
 * NOTE: the catch-all router matches the FULL request path, so routes are
 * registered with the /api/poker prefix.
 */
import { eq } from "drizzle-orm";
import { requireAdmin } from "../auth.js";
import { db } from "../db/client.js";
import { emailDeliveries } from "../db/schema.js";
import { CLAIM_LEASE_MS, sendOneDelivery } from "../email/send.js";
import { conflict, notFound } from "../errors.js";
import type { Router, Ctx } from "../router.js";

export function registerEmailRoutes(router: Router): void {
  router.post("/api/poker/admin/email-deliveries/:id/retry", handleRetryDelivery);
}

async function handleRetryDelivery(
  ctx: Ctx
): Promise<{ delivery: { id: string; status: string; attempts: number; errorCode: string | null; updatedAt: Date } }> {
  requireAdmin(ctx);
  const id = ctx.params.id!;
  const before = (
    await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.id, id))
      .limit(1)
  )[0] ?? null;
  if (!before) throw notFound();
  if (before.status === "sent" || before.status === "delivered") {
    throw conflict("Email already delivered.");
  }
  // A fresh (non-expired) claim means another worker/retry is sending right
  // now — racing it would risk a double send.
  if (
    before.status === "processing" &&
    before.claimedAt &&
    before.claimedAt.getTime() > Date.now() - CLAIM_LEASE_MS
  ) {
    throw conflict("Email send already in progress.");
  }
  if (before.status === "dead_letter") {
    // Explicit admin re-arm: fresh attempt budget, back claimable.
    await db
      .update(emailDeliveries)
      .set({
        status: "failed",
        attempts: 0,
        nextAttemptAt: null,
        claimId: null,
        claimedAt: null
      })
      .where(eq(emailDeliveries.id, id));
  }

  // Claim + send via the same flow as the pump (ignoring backoff). Returns
  // null when the claim was lost to a concurrent worker.
  const claimed = await sendOneDelivery(id); // never throws

  const after = (
    await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.id, id))
      .limit(1)
  )[0] ?? null;
  if (!claimed && after) {
    if (after.status === "sent" || after.status === "delivered") {
      throw conflict("Email already delivered.");
    }
    if (after.status === "processing") {
      throw conflict("Email send already in progress.");
    }
  }
  return {
    delivery: {
      id: after?.id ?? id,
      status: after?.status ?? before.status,
      attempts: after?.attempts ?? before.attempts,
      // Must NOT fall through to the pre-send row: a successful send clears errorCode.
      errorCode: after ? after.errorCode : (before.errorCode ?? null),
      updatedAt: after?.updatedAt ?? before.updatedAt
    }
  };
}

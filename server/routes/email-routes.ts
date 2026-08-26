/**
 * Admin email-delivery operations (separate from the provider webhook route).
 *
 * POST /api/poker/admin/email-deliveries/:id/retry — admin-only re-send of a
 * queued/failed delivery (409 when already sent/delivered).
 *
 * NOTE: the catch-all router matches the FULL request path, so routes are
 * registered with the /api/poker prefix.
 */
import { eq } from "drizzle-orm";
import { requireAdmin } from "../auth.js";
import { db } from "../db/client.js";
import { emailDeliveries } from "../db/schema.js";
import { sendOneDelivery } from "../email/send.js";
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

  await sendOneDelivery(id); // never throws

  const after = (
    await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.id, id))
      .limit(1)
  )[0] ?? null;
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

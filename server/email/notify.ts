/**
 * Best-effort pump: after an entity (session/member/dispute) is committed and
 * its receipt rows are enqueued, fire-and-forget delivery.
 *
 * Deliberately a dynamic import + try/catch seam: if the email module is not
 * configured yet (or fails), the outbox rows simply stay queued/failed and
 * the admin "retry" route covers them. Never throws into the caller.
 */
import { isEmailConfigured } from "../env.js";

export async function notifyEntity(
  entityType: "session" | "member" | "dispute",
  entityId: string,
  version?: number
): Promise<void> {
  if (!isEmailConfigured()) return;
  try {
    const mod = await import("./send.js");
    await mod.processOutboxFor(entityType, entityId, version);
  } catch (err) {
    // Outbox rows persist; admin retry handles delivery later.
    console.error(`email notify failed for ${entityType}/${entityId}:`, err);
  }
}

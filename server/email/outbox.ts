/**
 * Email outbox — durable delivery queue (email_deliveries table).
 * Sessions/entities are committed FIRST, then receipts are enqueued here,
 * then delivery is attempted best-effort. Failures never roll back data.
 *
 * Uniqueness (eventType, entityId, version, recipientEmail) makes
 * enqueue idempotent: retries never duplicate intended emails.
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { emailDeliveries } from "../db/schema.js";
import * as schema from "../db/schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

export interface EnqueueInput {
  eventType:
    | "session_receipt"
    | "member_approved"
    | "member_welcome"
    | "dispute_resolution"
    | "dispute_opened"
    | "dispute_opened_ack"
    | "dispute_resolved"
    | "dispute_dismissed"
    | "session_updated"
    | "session_voided"
    | "results_corrected";
  entityType: "session" | "member" | "dispute";
  entityId: string;
  version: number;
  recipientEmail: string;
  recipientMemberId?: string | null;
}

/** Idempotent insert — duplicate (already enqueued) rows are silently kept. */
export async function enqueueEmail(db: Db, input: EnqueueInput): Promise<void> {
  try {
    await db.insert(emailDeliveries).values({
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      version: input.version,
      recipientEmail: input.recipientEmail,
      recipientMemberId: input.recipientMemberId ?? null,
      status: "queued"
    });
  } catch (err) {
    // 23505 = unique_violation on (eventType, entityId, version, recipientEmail)
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      return;
    }
    throw err;
  }
}

export async function updateDeliveryStatus(
  db: Db,
  deliveryId: string,
  status: "sent" | "delivered" | "bounced" | "failed",
  providerId?: string | null,
  errorCode?: string | null
): Promise<void> {
  await db
    .update(emailDeliveries)
    .set({
      status,
      providerId: providerId ?? undefined,
      errorCode: errorCode ?? undefined,
      updatedAt: new Date()
    })
    .where(eq(emailDeliveries.id, deliveryId));
}

export async function findDeliveryByProviderId(
  db: Db,
  providerId: string
): Promise<typeof emailDeliveries.$inferSelect | null> {
  const rows = await db
    .select()
    .from(emailDeliveries)
    .where(and(eq(emailDeliveries.providerId, providerId)))
    .limit(1);
  return rows[0] ?? null;
}

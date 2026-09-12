import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema.js";
import {
  splitBills,
  splitParticipants,
  splitSmsDeliveries,
  splitUsers
} from "../db/schema.js";
import { decryptPhone } from "./phone.js";
import { sendSms } from "./sms.js";
import { makeInviteToken } from "./tokens.js";
import { splitEnv } from "./env.js";

export type SplitDb = PostgresJsDatabase<typeof schema>;
type SmsEventType = "invitation" | "final_amount" | "payment_reminder" | "payment_clarification";

export async function enqueueSms(db: SplitDb, input: {
  eventType: SmsEventType;
  billId: string;
  participantId: string;
  phoneEncrypted: string;
  phoneHash: string;
  billVersion: number;
  idempotencyKey: string;
  reminderNumber?: number;
}): Promise<void> {
  await db.insert(splitSmsDeliveries).values({
    eventType: input.eventType,
    billId: input.billId,
    participantId: input.participantId,
    recipientPhoneEncrypted: input.phoneEncrypted,
    recipientPhoneLookupHash: input.phoneHash,
    billVersion: input.billVersion,
    idempotencyKey: input.idempotencyKey,
    reminderNumber: input.reminderNumber,
    status: "queued",
    nextAttemptAt: new Date()
  }).onConflictDoNothing();
}

/** Queue every due unpaid reminder and advance the participant's 24h schedule. */
export async function enqueueDueReminders(db: SplitDb, now = new Date()): Promise<number> {
  const due = await db.select().from(splitParticipants).where(and(
    inArray(splitParticipants.paymentStatus, ["unpaid", "rejected"]),
    lte(splitParticipants.nextReminderAt, now),
    or(isNull(splitParticipants.remindersSnoozedUntil), lte(splitParticipants.remindersSnoozedUntil, now))
  )).limit(250);
  let count = 0;
  for (const participant of due) {
    const [bill] = await db.select({ version: splitBills.version, status: splitBills.status })
      .from(splitBills).where(eq(splitBills.id, participant.billId)).limit(1);
    if (!bill || !["locked", "settled"].includes(bill.status)) continue;
    const reminderNumber = participant.reminderCount + 1;
    await db.transaction(async (tx) => {
      await enqueueSms(tx, {
        eventType: "payment_reminder",
        billId: participant.billId,
        participantId: participant.id,
        phoneEncrypted: participant.invitedPhoneEncrypted,
        phoneHash: participant.invitedPhoneLookupHash,
        billVersion: bill.version,
        reminderNumber,
        idempotencyKey: `reminder:${participant.id}:${reminderNumber}`
      });
      await tx.update(splitParticipants).set({
        reminderCount: reminderNumber,
        lastReminderAt: now,
        nextReminderAt: new Date(now.getTime() + 24 * 60 * 60 * 1000)
      }).where(and(
        eq(splitParticipants.id, participant.id),
        eq(splitParticipants.reminderCount, participant.reminderCount)
      ));
    });
    count++;
  }
  return count;
}

/** Best-effort durable outbox drain. Safe for overlapping workers. */
export async function processSmsOutbox(db: SplitDb, limit = 25): Promise<{ processed: number; sent: number; failed: number }> {
  const candidates = await db.select({ id: splitSmsDeliveries.id })
    .from(splitSmsDeliveries)
    .where(and(
      inArray(splitSmsDeliveries.status, ["queued", "failed"]),
      or(isNull(splitSmsDeliveries.nextAttemptAt), lte(splitSmsDeliveries.nextAttemptAt, new Date()))
    ))
    .limit(Math.max(1, Math.min(limit, 100)));
  let sent = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const claimId = randomUUID();
    const [claimed] = await db.update(splitSmsDeliveries).set({
      status: "processing", claimId, claimedAt: new Date(), lastAttemptAt: new Date()
    }).where(and(
      eq(splitSmsDeliveries.id, candidate.id),
      inArray(splitSmsDeliveries.status, ["queued", "failed"])
    )).returning();
    if (!claimed) continue;
    try {
      const optedOut = await db.select({ id: splitUsers.id }).from(splitUsers).where(and(
        eq(splitUsers.phoneLookupHash, claimed.recipientPhoneLookupHash),
        // null means the recipient has not opted out
        // (the negative predicate is represented by querying the row below)
      )).limit(1);
      if (optedOut[0]) {
        const [user] = await db.select({ optedOutAt: splitUsers.smsOptedOutAt }).from(splitUsers).where(eq(splitUsers.id, optedOut[0].id)).limit(1);
        if (user?.optedOutAt) {
          await db.update(splitSmsDeliveries).set({ status: "suppressed", errorCode: "opted_out", claimId: null, claimedAt: null }).where(eq(splitSmsDeliveries.id, claimed.id));
          continue;
        }
      }
      const message = await renderSms(db, claimed);
      const callback = `${splitEnv().PUBLIC_APP_ORIGIN}/api/split/webhooks/twilio/status`;
      const result = await sendSms(decryptPhone(claimed.recipientPhoneEncrypted), message, callback);
      await db.update(splitSmsDeliveries).set({
        status: "sent", providerMessageId: result.providerId, attempts: claimed.attempts + 1,
        sentAt: new Date(), errorCode: null, claimId: null, claimedAt: null
      }).where(eq(splitSmsDeliveries.id, claimed.id));
      if (claimed.eventType === "invitation" && claimed.participantId) {
        await db.update(splitParticipants).set({ invitationStatus: "sent", inviteSentAt: new Date() }).where(eq(splitParticipants.id, claimed.participantId));
      }
      sent++;
    } catch (error) {
      console.error("Split SMS delivery failed", claimed.id, error instanceof Error ? error.message : "unknown");
      const attempts = claimed.attempts + 1;
      await db.update(splitSmsDeliveries).set({
        status: attempts >= 5 ? "dead_letter" : "failed",
        attempts,
        errorCode: "provider_failure",
        nextAttemptAt: attempts >= 5 ? null : new Date(Date.now() + Math.min(3600, 30 * 2 ** attempts) * 1000),
        claimId: null,
        claimedAt: null
      }).where(eq(splitSmsDeliveries.id, claimed.id));
      // Keep the participant-facing state honest once an invitation has
      // exhausted all retries. While it is retryable, leave the invitation
      // queued so the organizer can still see that delivery is in progress.
      if (attempts >= 5 && claimed.eventType === "invitation" && claimed.participantId) {
        await db.update(splitParticipants).set({ invitationStatus: "failed" }).where(eq(splitParticipants.id, claimed.participantId));
      }
      failed++;
    }
  }
  return { processed: sent + failed, sent, failed };
}

async function renderSms(db: SplitDb, delivery: typeof splitSmsDeliveries.$inferSelect): Promise<string> {
  if (!delivery.participantId) return "You have an update in Split.";
  const [row] = await db.select({
    participantId: splitParticipants.id,
    amountCents: splitParticipants.finalAmountCents,
    merchant: splitBills.merchantName,
    payerUserId: splitBills.payerUserId
  }).from(splitParticipants)
    .innerJoin(splitBills, eq(splitParticipants.billId, splitBills.id))
    .where(eq(splitParticipants.id, delivery.participantId)).limit(1);
  if (!row) throw new Error("participant_not_found");
  const [payer] = await db.select({ displayName: splitUsers.displayName, provider: splitUsers.paymentProvider, handle: splitUsers.paymentHandle })
    .from(splitUsers).where(eq(splitUsers.id, row.payerUserId)).limit(1);
  const payerName = payer?.displayName ?? "the payer";
  const merchant = row.merchant ?? "dinner";
  const app = splitEnv().PUBLIC_APP_ORIGIN;
  if (delivery.eventType === "invitation") {
    // Keep the invite as a query parameter because the static Split client
    // preserves it through Google/phone sign-in before routing to the invite
    // view. A hash-only route would be stripped from SMS deep links.
    const inviteUrl = `${app}/split?invite=${encodeURIComponent(makeInviteToken(row.participantId))}`;
    return `${payerName} invited you to split ${merchant}. Claim your items: ${inviteUrl} Reply STOP to unsubscribe.`;
  }
  const amount = `$${(row.amountCents / 100).toFixed(2)}`;
  const payment = payer?.provider && payer.handle ? ` Pay via ${payer.provider}: ${payer.handle}.` : "";
  if (delivery.eventType === "payment_reminder") {
    return `Split reminder: You still owe ${payerName} ${amount} for ${merchant}.${payment} ${app}/split Reply PAID after sending payment.`;
  }
  if (delivery.eventType === "payment_clarification") {
    return `You have multiple unpaid dinners. Choose the one you paid: ${app}/split`;
  }
  return `Your share for ${merchant} is ${amount}.${payment} ${app}/split Reply PAID after sending payment.`;
}

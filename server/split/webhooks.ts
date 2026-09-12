import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { splitBills, splitParticipants, splitPayments, splitSmsDeliveries, splitUsers, splitWebhookEvents } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { Ctx, Router } from "../router.js";
import { enqueueSms, processSmsOutbox } from "./outbox.js";
import { parseTwilioForm, verifyTwilioSignature } from "./sms.js";

export function registerSplitWebhookRoutes(router: Router): void {
  router.post("/webhooks/twilio/status", statusWebhook);
  router.post("/api/split/webhooks/twilio/status", statusWebhook);
  router.post("/webhooks/twilio/inbound", inboundWebhook);
  router.post("/api/split/webhooks/twilio/inbound", inboundWebhook);
}

async function statusWebhook(ctx: Ctx) {
  const form = verify(ctx);
  const sid = form.MessageSid ?? form.SmsSid;
  if (!sid) throw invalidSignature();
  const status = mapStatus(form.MessageStatus ?? form.SmsStatus);
  const eventId = `${sid}:${form.MessageStatus ?? form.SmsStatus ?? "unknown"}`;
  await db.transaction(async (tx) => {
    const inserted = await tx.insert(splitWebhookEvents).values({
      provider: "twilio", eventId, eventType: `message.${form.MessageStatus ?? "unknown"}`,
      providerMessageId: sid, payloadSha256: createHash("sha256").update(ctx.rawBody).digest("hex")
    }).onConflictDoNothing().returning({ id: splitWebhookEvents.id });
    if (!inserted.length) return;
    const [delivery] = await tx.select().from(splitSmsDeliveries).where(eq(splitSmsDeliveries.providerMessageId, sid)).limit(1);
    if (!delivery) return;
    await tx.update(splitWebhookEvents).set({ deliveryId: delivery.id }).where(eq(splitWebhookEvents.id, inserted[0]!.id));
    if (status && statusRank(status) >= statusRank(delivery.status)) {
      await tx.update(splitSmsDeliveries).set({
        status,
        deliveredAt: status === "delivered" ? new Date() : undefined,
        errorCode: status === "failed" || status === "undelivered" ? (form.ErrorCode ?? "provider_failure") : null
      }).where(eq(splitSmsDeliveries.id, delivery.id));
      if (["failed", "undelivered"].includes(status) && delivery.eventType === "invitation" && delivery.participantId) {
        await tx.update(splitParticipants).set({ invitationStatus: "failed" }).where(eq(splitParticipants.id, delivery.participantId));
      }
    }
  });
  return { ok: true };
}

async function inboundWebhook(ctx: Ctx) {
  const form = verify(ctx);
  const sid = form.MessageSid ?? form.SmsSid;
  const from = form.From;
  if (!sid || !from) throw invalidSignature();
  const { normalizePhone, phoneHash } = await import("./phone.js");
  const hash = phoneHash(normalizePhone(from));
  const body = (form.Body ?? "").trim().toUpperCase();
  const inserted = await db.insert(splitWebhookEvents).values({
    provider: "twilio", eventId: sid, eventType: "message.inbound", providerMessageId: sid,
    payloadSha256: createHash("sha256").update(ctx.rawBody).digest("hex")
  }).onConflictDoNothing().returning({ id: splitWebhookEvents.id });
  if (!inserted.length) return twiml(ctx);

  const optOutType = (form.OptOutType ?? "").toUpperCase();
  if (optOutType === "STOP" || ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(body)) {
    const indefinitely = new Date("9999-12-31T23:59:59.000Z");
    await db.transaction(async (tx) => {
      await tx.update(splitUsers).set({ smsOptedOutAt: new Date() }).where(eq(splitUsers.phoneLookupHash, hash));
      await tx.update(splitParticipants).set({ nextReminderAt: null, remindersSnoozedUntil: indefinitely }).where(eq(splitParticipants.invitedPhoneLookupHash, hash));
      await tx.update(splitSmsDeliveries).set({ status: "suppressed", errorCode: "opted_out" }).where(and(
        eq(splitSmsDeliveries.recipientPhoneLookupHash, hash),
        inArray(splitSmsDeliveries.status, ["queued", "failed"])
      ));
    });
    return twiml(ctx);
  }
  if (optOutType === "START" || body === "START" || body === "UNSTOP") {
    const nextReminderAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.transaction(async (tx) => {
      await tx.update(splitUsers).set({ smsOptedOutAt: null, smsConsentAt: new Date() }).where(eq(splitUsers.phoneLookupHash, hash));
      await tx.update(splitParticipants).set({ remindersSnoozedUntil: null, nextReminderAt }).where(and(
        eq(splitParticipants.invitedPhoneLookupHash, hash),
        inArray(splitParticipants.paymentStatus, ["unpaid", "rejected"])
      ));
    });
    return twiml(ctx);
  }
  if (body === "HELP") {
    return twiml(ctx, "Split helps your dinner group claim receipt items and settle up. Open your Split link for details. Reply STOP to unsubscribe.");
  }
  if (!/^PAID(?:\s+[A-Z0-9-]{2,12})?$/.test(body)) return twiml(ctx);
  const outstanding = await db.select({ participant: splitParticipants, billStatus: splitBills.status })
    .from(splitParticipants)
    .innerJoin(splitBills, eq(splitBills.id, splitParticipants.billId))
    .where(and(
      eq(splitParticipants.invitedPhoneLookupHash, hash),
      inArray(splitParticipants.paymentStatus, ["unpaid", "rejected"]),
      inArray(splitBills.status, ["locked", "settled"])
    )).limit(10);
  if (outstanding.length === 1) {
    const participant = outstanding[0]!.participant;
    await db.transaction(async (tx) => {
      const [bill] = await tx.select({ payerUserId: splitBills.payerUserId }).from(splitBills).where(eq(splitBills.id, participant.billId)).limit(1);
      if (bill?.payerUserId) await tx.insert(splitPayments).values({
        billId: participant.billId, participantId: participant.id, payerUserId: bill.payerUserId,
        amountCents: participant.finalAmountCents, status: "reported_paid", reportSource: "sms", requestKey: `twilio:${sid}`,
        reportedAt: new Date()
      }).onConflictDoNothing();
      await tx.update(splitParticipants).set({ paymentStatus: "reported_paid", nextReminderAt: null }).where(eq(splitParticipants.id, participant.id));
    });
  } else if (outstanding.length > 1) {
    const participant = outstanding[0]!.participant;
    await enqueueSms(db, {
      eventType: "payment_clarification", billId: participant.billId, participantId: participant.id,
      phoneEncrypted: participant.invitedPhoneEncrypted, phoneHash: participant.invitedPhoneLookupHash,
      billVersion: 1, idempotencyKey: `clarification:${sid}`
    });
    await processSmsOutbox(db, 10);
  }
  return twiml(ctx);
}

function twiml(ctx: Ctx, message?: string): null {
  ctx.res.statusCode = 200;
  ctx.res.setHeader("Content-Type", "application/xml; charset=utf-8");
  ctx.res.setHeader("Cache-Control", "no-store");
  const body = message ? `<Message>${escapeXml(message)}</Message>` : "";
  ctx.res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
  return null;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '\"': "&quot;" })[character] ?? character);
}

function verify(ctx: Ctx): Record<string, string> {
  const form = parseTwilioForm(ctx.rawBody);
  const signature = first(ctx.req.headers["x-twilio-signature"]);
  const forwardedProto = first(ctx.req.headers["x-forwarded-proto"]) ?? "https";
  const forwardedHost = first(ctx.req.headers["x-forwarded-host"]) ?? first(ctx.req.headers.host);
  const url = forwardedHost ? `${forwardedProto}://${forwardedHost}${ctx.req.url ?? ctx.pathname}` : ctx.pathname;
  if (!verifyTwilioSignature(url, form, signature)) throw invalidSignature();
  return form;
}

function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function invalidSignature() { return new ApiError(401, "invalid_signature", "Invalid signature."); }
function mapStatus(status: string | undefined): "sent" | "delivered" | "failed" | "undelivered" | null {
  if (status === "delivered") return "delivered";
  if (status === "undelivered") return "undelivered";
  if (status === "failed") return "failed";
  if (["queued", "accepted", "sending", "sent", "read"].includes(status ?? "")) return "sent";
  return null;
}

function statusRank(status: string): number {
  if (["failed", "undelivered", "dead_letter"].includes(status)) return 4;
  if (status === "delivered") return 3;
  if (status === "sent") return 2;
  return 1;
}

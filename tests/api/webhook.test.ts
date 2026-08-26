/**
 * Resend webhook (Svix-signed) — integration tests over the real dev-server
 * router and the shared poker_test database.
 *
 * The route reads RESEND_WEBHOOK_SECRET directly from process.env, so the
 * tests inject a freshly generated `whsec_<base64>` key in beforeAll and
 * delete it in afterAll. Signatures use the Svix v1 scheme
 * (HMAC-SHA256 over `<msgId>.<timestampSec>.<body>`) and MUST cover the
 * EXACT body bytes that are sent — never a re-stringified object.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  emailDeliveries,
  members,
  pokerSessions,
  webhookEvents
} from "../../server/db/schema.js";
import type { EmailDeliveryRow, WebhookEventRow } from "../../server/db/schema.js";
import { openDb, resetDb } from "../helpers/db.js";
import type { TestDb } from "../helpers/db.js";
import { startTestServer } from "../helpers/server.js";

let server: Awaited<ReturnType<typeof startTestServer>> | null = null;
let testDb: TestDb | null = null;
let secret = "";

/** Svix v1 signature: v1,<base64 hmac-sha256(whsec key, msgId.ts.body)>. */
function sign(
  secretKey: string,
  msgId: string,
  timestampSec: string,
  payload: string
): string {
  const keyBytes = Buffer.from(secretKey.replace(/^whsec_/, ""), "base64");
  const msg = `${msgId}.${timestampSec}.${payload}`;
  return `v1,${createHmac("sha256", keyBytes).update(msg).digest("base64")}`;
}

async function postWebhook(
  body: string,
  opts: {
    svixId?: string;
    timestamp?: string;
    signature?: string;
    secretKey?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  const svixId = opts.svixId ?? `evt_${randomUUID()}`;
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    opts.signature ?? sign(opts.secretKey ?? secret, svixId, timestamp, body);
  return fetch(`${server!.url}/api/poker/webhooks/resend`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-svix-id": svixId,
      "x-svix-timestamp": timestamp,
      "x-svix-signature": signature,
      ...opts.headers
    },
    body
  });
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function deliveryByProviderId(providerId: string): Promise<EmailDeliveryRow | null> {
  const rows = await testDb!.db
    .select()
    .from(emailDeliveries)
    .where(eq(emailDeliveries.providerId, providerId))
    .limit(1);
  return rows[0] ?? null;
}

async function eventsByEventId(eventId: string): Promise<WebhookEventRow[]> {
  return testDb!.db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.eventId, eventId));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resend webhook (svix verification + dedup + precedence)", () => {
  let deliveryId1 = "";
  let deliveryId3 = "";

  beforeAll(async () => {
    const key = randomBytes(32);
    secret = `whsec_${key.toString("base64")}`;
    process.env.RESEND_WEBHOOK_SECRET = secret;

    await resetDb();
    server = await startTestServer();

    testDb = openDb();
    const [member] = await testDb.db
      .insert(members)
      .values({
        displayName: "Webhook Alice",
        emailNormalized: `wh-${randomUUID()}@example.com`
      })
      .returning();
    const [session] = await testDb.db
      .insert(pokerSessions)
      .values({
        playedAt: new Date("2026-08-01T19:30:00Z"),
        title: "Webhook Game",
        requestKey: `req-${randomUUID()}`,
        recordedByMemberId: member!.id
      })
      .returning();
    const seeded = await testDb.db
      .insert(emailDeliveries)
      .values([
        {
          eventType: "session_receipt",
          entityType: "session",
          entityId: session!.id,
          version: 1,
          recipientEmail: `wh-${randomUUID()}@example.com`,
          recipientMemberId: member!.id,
          providerId: "msg_1",
          status: "sent"
        },
        {
          eventType: "session_receipt",
          entityType: "session",
          entityId: session!.id,
          version: 1,
          recipientEmail: `wh-${randomUUID()}@example.com`,
          recipientMemberId: member!.id,
          providerId: "msg_2",
          status: "sent"
        },
        {
          eventType: "session_receipt",
          entityType: "session",
          entityId: session!.id,
          version: 1,
          recipientEmail: `wh-${randomUUID()}@example.com`,
          recipientMemberId: member!.id,
          providerId: "msg_3",
          status: "sent"
        }
      ])
      .returning();
    deliveryId1 = seeded[0]!.id;
    deliveryId3 = seeded[2]!.id;
  });

  afterAll(async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    await testDb?.end();
    await server?.close();
  });

  it("(a) valid signature → 200 ok, sent→delivered, webhook_events row recorded", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { id: "msg_1" } });
    const eventId = `evt_${randomUUID()}`;

    const res = await postWebhook(body, { svixId: eventId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const delivery = await deliveryByProviderId("msg_1");
    expect(delivery!.id).toBe(deliveryId1);
    expect(delivery!.status).toBe("delivered");
    expect(delivery!.errorCode).toBeNull();

    const events = await eventsByEventId(eventId);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("email.delivered");
    expect(events[0]!.providerMessageId).toBe("msg_1");
    expect(events[0]!.deliveryId).toBe(deliveryId1);
  });

  it("(b) re-formatted JSON (same data, different bytes) → 401, delivery unchanged", async () => {
    const compact = JSON.stringify({ type: "email.delivered", data: { id: "msg_2" } });
    const spaced = '{ "type": "email.delivered", "data": { "id": "msg_2" } }';
    const eventId = `evt_${randomUUID()}`;
    // Signature covers the COMPACT bytes; the request body is the spaced ones.
    const sig = sign(secret, eventId, String(Math.floor(Date.now() / 1000)), compact);

    const res = await postWebhook(spaced, { svixId: eventId, signature: sig });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "invalid_signature", message: "Invalid signature." }
    });

    const delivery = await deliveryByProviderId("msg_2");
    expect(delivery!.status).toBe("sent");
    expect(delivery!.errorCode).toBeNull();
    expect(await eventsByEventId(eventId)).toHaveLength(0);
  });

  it("(c) missing headers → 401; empty body with valid signature → 401", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { id: "msg_1" } });
    const timestamp = String(Math.floor(Date.now() / 1000));

    const missing = await fetch(`${server!.url}/api/poker/webhooks/resend`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-svix-id": `evt_${randomUUID()}`,
        "x-svix-timestamp": timestamp
      },
      body
    });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      error: { code: "invalid_signature", message: "Invalid signature." }
    });

    // A signature covering the empty body is still rejected outright.
    const empty = await postWebhook("", { svixId: `evt_${randomUUID()}` });
    expect(empty.status).toBe(401);
  });

  it("(d) signature with the wrong secret → 401", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { id: "msg_1" } });
    const otherSecret = `whsec_${randomBytes(32).toString("base64")}`;

    const res = await postWebhook(body, {
      svixId: `evt_${randomUUID()}`,
      secretKey: otherSecret
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "invalid_signature", message: "Invalid signature." }
    });
  });

  it("(e) duplicate event_id → both 200, applied exactly once", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { id: "msg_3" } });
    const eventId = `evt_${randomUUID()}`;

    const first = await postWebhook(body, { svixId: eventId });
    expect(first.status).toBe(200);

    const second = await postWebhook(body, { svixId: eventId });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });

    expect(await eventsByEventId(eventId)).toHaveLength(1);
    const delivery = await deliveryByProviderId("msg_3");
    expect(delivery!.id).toBe(deliveryId3);
    expect(delivery!.status).toBe("delivered");
    expect(delivery!.errorCode).toBeNull();
  });

  it("(f) unknown event type → 200, recorded, delivery unchanged", async () => {
    const body = JSON.stringify({ type: "email.unknown_thing", data: { id: "msg_1" } });
    const eventId = `evt_${randomUUID()}`;

    const res = await postWebhook(body, { svixId: eventId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const events = await eventsByEventId(eventId);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("email.unknown_thing");
    expect(events[0]!.providerMessageId).toBe("msg_1");
    expect(events[0]!.deliveryId).toBe(deliveryId1);

    const delivery = await deliveryByProviderId("msg_1");
    expect(delivery!.status).toBe("delivered"); // unchanged by the unknown type
  });

  it("(g) bounced event → status bounced with errorCode bounced", async () => {
    const body = JSON.stringify({ type: "email.bounced", data: { id: "msg_1" } });

    const res = await postWebhook(body, { svixId: `evt_${randomUUID()}` });
    expect(res.status).toBe(200);

    const delivery = await deliveryByProviderId("msg_1");
    expect(delivery!.status).toBe("bounced");
    expect(delivery!.errorCode).toBe("bounced");
  });

  it("(h) unknown provider id → 200, event recorded, no error", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { id: "msg_zzz" } });
    const eventId = `evt_${randomUUID()}`;

    const res = await postWebhook(body, { svixId: eventId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const events = await eventsByEventId(eventId);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("email.delivered");
    expect(events[0]!.providerMessageId).toBe("msg_zzz");
    expect(events[0]!.deliveryId).toBeNull();
  });

  it("(i) malformed JSON: valid signature → 400 invalid_json; bad signature → 401", async () => {
    const malformed = '{"type": "email.delivered", "data": {"id": "msg_1"}'; // unclosed

    const validSig = await postWebhook(malformed, { svixId: `evt_${randomUUID()}` });
    expect(validSig.status).toBe(400);
    expect(await validSig.json()).toEqual({
      error: { code: "invalid_json", message: "Request body is not valid JSON." }
    });

    const badSig = await postWebhook(malformed, {
      svixId: `evt_${randomUUID()}`,
      secretKey: `whsec_${randomBytes(32).toString("base64")}`
    });
    expect(badSig.status).toBe(401);
    expect(await badSig.json()).toEqual({
      error: { code: "invalid_signature", message: "Invalid signature." }
    });
  });

  it("(j) stale timestamp (now - 400s) → 401", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { id: "msg_1" } });

    const res = await postWebhook(body, {
      svixId: `evt_${randomUUID()}`,
      timestamp: String(Math.floor(Date.now() / 1000) - 400)
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "invalid_signature", message: "Invalid signature." }
    });
  });

  it("(k) precedence: delivered arriving after bounced does not downgrade", async () => {
    // msg_1 is bounced from (g).
    const body = JSON.stringify({ type: "email.delivered", data: { id: "msg_1" } });

    const res = await postWebhook(body, { svixId: `evt_${randomUUID()}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const delivery = await deliveryByProviderId("msg_1");
    expect(delivery!.status).toBe("bounced");
    expect(delivery!.errorCode).toBe("bounced");
  });
});

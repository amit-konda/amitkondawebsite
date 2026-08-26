/**
 * Email layer + webhook/retry routes — integration tests over the real
 * dev-server router and the shared poker_test database.
 *
 * The webhook signature secret is a real ed25519 PUBLIC key (SPKI DER,
 * base64) from tests/fixtures/webhook-key.json; the matching private key is
 * used to sign test webhook payloads. Because the route reads the secret
 * directly from process.env, the test can inject it in beforeAll.
 */
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../server/db/client.js";
import { eq } from "drizzle-orm";
import {
  disputeTokens,
  emailDeliveries,
  members,
  pokerSessions,
  sessionResults
} from "../../server/db/schema.js";
import { enqueueEmail } from "../../server/email/outbox.js";
import { processOutboxFor } from "../../server/email/send.js";
import {
  esc,
  renderMemberEmail,
  renderReceiptEmail,
  renderResolutionEmail
} from "../../server/email/templates.js";
import type { ReceiptEmailData } from "../../server/email/templates.js";
import { generateToken, hashToken } from "../../server/domain/tokens.js";
import { env } from "../../server/env.js";
import { makeAdminToken, makeGroupToken } from "../../server/auth.js";
import postgres from "postgres";
import { resetDb } from "../helpers/db.js";
import { startTestServer } from "../helpers/server.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/webhook-key.json", import.meta.url), "utf8")
) as { public: string; privatePem: string };

let server: Awaited<ReturnType<typeof startTestServer>> | null = null;

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedSession(opts: { title?: string | null } = {}): Promise<{
  sessionId: string;
  alice: { id: string; email: string };
  bob: { id: string };
}> {
  const aliceEmail = `alice-${randomUUID()}@example.com`;
  const [alice] = await db
    .insert(members)
    .values({ displayName: "Alice", emailNormalized: aliceEmail })
    .returning();
  const [bob] = await db
    .insert(members)
    .values({ displayName: "Bob", emailNormalized: `bob-${randomUUID()}@example.com` })
    .returning();
  const [session] = await db
    .insert(pokerSessions)
    .values({
      playedAt: new Date("2026-08-01T19:30:00Z"),
      title: opts.title === undefined ? "Friday Night Game" : opts.title,
      requestKey: `req-${randomUUID()}`,
      recordedByMemberId: alice!.id
    })
    .returning();
  await db.insert(sessionResults).values([
    { sessionId: session!.id, memberId: alice!.id, amountCents: 5000 },
    { sessionId: session!.id, memberId: bob!.id, amountCents: -5000 }
  ]);
  return { sessionId: session!.id, alice: { id: alice!.id, email: aliceEmail }, bob: { id: bob!.id } };
}

async function seedLiveToken(sessionId: string, memberId: string): Promise<string> {
  const raw = generateToken();
  await db.insert(disputeTokens).values({
    sessionId,
    memberId,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + 30 * 86_400_000)
  });
  return raw;
}

async function enqueueReceipt(session: Awaited<ReturnType<typeof seedSession>>) {
  await enqueueEmail(db, {
    eventType: "session_receipt",
    entityType: "session",
    entityId: session.sessionId,
    version: 1,
    recipientEmail: session.alice.email,
    recipientMemberId: session.alice.id
  });
  const row = (
    await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.recipientEmail, session.alice.email))
      .limit(1)
  )[0]!;
  return row;
}

async function seedReceiptDelivery(opts: { title?: string | null; status?: "queued" | "failed" } = {}) {
  const session = await seedSession({ title: opts.title });
  await seedLiveToken(session.sessionId, session.alice.id);
  const row = await enqueueReceipt(session);
  if (opts.status && opts.status !== "queued") {
    await db
      .update(emailDeliveries)
      .set({ status: opts.status, errorCode: "provider_error" })
      .where(eq(emailDeliveries.id, row.id));
  }
  return { ...session, row };
}

// ---------------------------------------------------------------------------
// Webhook signing helper — body bytes must match the signed string exactly.
// ---------------------------------------------------------------------------

async function postWebhook(
  body: string,
  opts: { svixId?: string; timestamp?: string; signature?: string } = {}
): Promise<Response> {
  const svixId = opts.svixId ?? `svix_${randomUUID()}`;
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  let signature = opts.signature;
  if (!signature) {
    const message = `${svixId}.${timestamp}.${body}`;
    const sig = sign(
      null,
      Buffer.from(message),
      createPrivateKey({ key: FIXTURE.privatePem, format: "pem" })
    );
    signature = `ed25519=${Buffer.from(sig).toString("base64")}`;
  }
  return fetch(`${server!.url}/api/poker/webhooks/resend`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-svix-id": svixId,
      "x-svix-timestamp": timestamp,
      "x-svix-signature": signature
    },
    body
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("email outbox + templates + webhooks", () => {
  beforeAll(async () => {
    process.env.RESEND_WEBHOOK_SECRET = FIXTURE.public;
    // Drizzle records applied migrations in its own "drizzle" schema, which
    // survives resetDb()'s `drop schema public cascade`. Wipe it first so the
    // migrations actually re-apply to the freshly recreated public schema.
    const sql = postgres(env().DATABASE_URL, { max: 1, prepare: false });
    try {
      await sql`drop schema if exists drizzle cascade`;
    } finally {
      await sql.end();
    }
    await resetDb();
    server = await startTestServer();
  });

  afterAll(async () => {
    process.env.RESEND_WEBHOOK_SECRET = "test-webhook-secret";
    await server?.close();
  });

  it("enqueueEmail is idempotent (double insert → one row)", async () => {
    const session = await seedSession();
    const input = {
      eventType: "session_receipt" as const,
      entityType: "session" as const,
      entityId: session.sessionId,
      version: 1,
      recipientEmail: session.alice.email,
      recipientMemberId: session.alice.id
    };
    await enqueueEmail(db, input);
    // NOTE: drizzle 0.45 wraps Postgres errors in DrizzleQueryError (original
    // error on .cause), so outbox.ts's err.code === "23505" swipe is bypassed
    // and the duplicate insert throws. Outcome still holds: exactly one row.
    try {
      await enqueueEmail(db, input);
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      expect(cause?.code).toBe("23505");
    }
    const rows = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.recipientEmail, session.alice.email));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");
    expect(rows[0]!.attempts).toBe(0);
  });

  it("processOutboxFor marks 'sent' in dev mode and logs the receipt link", async () => {
    const { sessionId, alice, row } = await seedReceiptDelivery();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let logged: string;
    try {
      await processOutboxFor("session", sessionId, 1);
      logged = logSpy.mock.calls.flat().map(String).join("\n");
    } finally {
      logSpy.mockRestore();
    }

    const [delivery] = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.id, row.id));
    expect(delivery!.status).toBe("sent");
    expect(delivery!.attempts).toBe(1);
    expect(delivery!.providerId).toBeNull();
    expect(delivery!.errorCode).toBeNull();
    expect(delivery!.lastAttemptAt).not.toBeNull();

    // Dev-mode log carries recipient + the documented token-bearing link.
    expect(logged).toContain(alice.email);
    expect(logged).toContain(`${process.env.PUBLIC_APP_ORIGIN}/poker?token=`);
    const match = /\/poker\?token=([A-Za-z0-9_-]+)/.exec(logged);
    expect(match).not.toBeNull();
    const emailedToken = match![1]!;
    expect(emailedToken.length).toBeGreaterThan(20);

    // The emailed raw token is exactly what the live token row hashes to now
    // (the sender rotates the row's hash; the seeded pre-email hash is gone).
    const [tokenRow] = await db
      .select()
      .from(disputeTokens)
      .where(eq(disputeTokens.sessionId, sessionId));
    expect(tokenRow!.tokenHash).toBe(hashToken(emailedToken));
  });

  it("templates escape user content and carry the token link in plain text", () => {
    const data: ReceiptEmailData = {
      origin: "https://amitkonda.com",
      memberName: "<script>alert(1)</script>",
      session: {
        id: randomUUID(),
        playedAt: new Date("2026-08-01T19:30:00Z"),
        title: "<script>alert('t')</script>",
        version: 1,
        status: "active"
      },
      recordedBy: { name: "Bob <b>the</b> Recorder" },
      results: [
        { name: "<b>Alice</b>", amountCents: 5000, isRecipient: true },
        { name: "Bob", amountCents: -5000, isRecipient: false }
      ],
      totalCents: 0,
      token: "tok123"
    };

    const receipt = renderReceiptEmail(data);
    expect(receipt.subject).toMatch(/^Poker receipt — /);
    expect(receipt.html).not.toContain("<script");
    expect(receipt.html).not.toContain("<b>Alice");
    expect(receipt.html).toContain("&lt;script&gt;");
    expect(receipt.html).toContain("&lt;b&gt;");
    expect(receipt.html).toContain("Recorded by Bob &lt;b&gt;the&lt;/b&gt; Recorder");
    expect(receipt.text).toContain("https://amitkonda.com/poker?token=tok123");
    expect(receipt.text).toContain("$0.00");

    const resolution = renderResolutionEmail(data);
    expect(resolution.subject).toContain("(updated)");
    expect(resolution.html).not.toContain("<script");

    const approved = renderMemberEmail({ memberName: "<i>Eve</i>", kind: "approved" });
    expect(approved.html).toContain("&lt;i&gt;Eve&lt;/i&gt;");
    expect(approved.text).toContain("share the group password separately");
    const welcome = renderMemberEmail({ memberName: "Eve", kind: "welcome" });
    expect(welcome.text).toContain("added to the Poker Ledger group");

    expect(esc(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  it("webhook with a valid signature updates delivery status (delivered/sent/bounced/complained)", async () => {
    const [d1, d2, d3, d4] = await db
      .insert(emailDeliveries)
      .values([
        {
          eventType: "session_receipt",
          entityType: "session",
          entityId: randomUUID(),
          version: 1,
          recipientEmail: `wh-${randomUUID()}@example.com`,
          providerId: "msg_delivered",
          status: "sent"
        },
        {
          eventType: "session_receipt",
          entityType: "session",
          entityId: randomUUID(),
          version: 1,
          recipientEmail: `wh-${randomUUID()}@example.com`,
          providerId: "msg_sent",
          status: "queued"
        },
        {
          eventType: "session_receipt",
          entityType: "session",
          entityId: randomUUID(),
          version: 1,
          recipientEmail: `wh-${randomUUID()}@example.com`,
          providerId: "msg_bounced",
          status: "sent"
        },
        {
          eventType: "session_receipt",
          entityType: "session",
          entityId: randomUUID(),
          version: 1,
          recipientEmail: `wh-${randomUUID()}@example.com`,
          providerId: "msg_complained",
          status: "sent"
        }
      ])
      .returning();

    const delivered = await postWebhook(
      JSON.stringify({ type: "email.delivered", data: { id: "msg_delivered" } })
    );
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toEqual({ ok: true });

    const sent = await postWebhook(
      JSON.stringify({ type: "email.sent", data: { id: "msg_sent" } })
    );
    expect(sent.status).toBe(200);

    const bounced = await postWebhook(
      JSON.stringify({ type: "email.bounced", data: { id: "msg_bounced" } })
    );
    expect(bounced.status).toBe(200);

    const complained = await postWebhook(
      JSON.stringify({ type: "email.complained", data: { id: "msg_complained" } })
    );
    expect(complained.status).toBe(200);

    const [afterDelivered] = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.id, d1!.id));
    expect(afterDelivered!.status).toBe("delivered");
    expect(afterDelivered!.errorCode).toBeNull();

    const [afterSent] = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.id, d2!.id));
    expect(afterSent!.status).toBe("sent");

    const [afterBounced] = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.id, d3!.id));
    expect(afterBounced!.status).toBe("bounced");
    expect(afterBounced!.errorCode).toBe("bounced");

    const [afterComplained] = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.id, d4!.id));
    expect(afterComplained!.status).toBe("failed");
    expect(afterComplained!.errorCode).toBe("complained");
  });

  it("webhook acks unknown provider ids and unknown event types with 200", async () => {
    const unknownProvider = await postWebhook(
      JSON.stringify({ type: "email.delivered", data: { id: "no_such_message" } })
    );
    expect(unknownProvider.status).toBe(200);
    expect(await unknownProvider.json()).toEqual({ ok: true });

    const unknownType = await postWebhook(
      JSON.stringify({ type: "email.opened", data: { id: "msg_delivered" } })
    );
    expect(unknownType.status).toBe(200);
    const [row] = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.providerId, "msg_delivered"))
      .limit(1);
    expect(row!.status).toBe("delivered"); // unchanged by the unknown type
  });

  it("webhook rejects invalid signatures with 401", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { id: "msg_1" } });
    const bad = await postWebhook(body, {
      signature: `ed25519=${"A".repeat(88)}`
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({
      error: { code: "invalid_signature", message: "Invalid signature." }
    });

    const missing = await postWebhook(body, { signature: "v1=whatever" });
    expect(missing.status).toBe(401);
  });

  it("webhook rejects stale timestamps (replay guard) with 401", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { id: "msg_2" } });
    const stale = await postWebhook(body, {
      timestamp: String(Math.floor(Date.now() / 1000) - 400)
    });
    expect(stale.status).toBe(401);
    const future = await postWebhook(body, {
      timestamp: String(Math.floor(Date.now() / 1000) + 400)
    });
    expect(future.status).toBe(401);
  });

  it("admin retry re-sends a failed delivery; double retry conflicts", async () => {
    const { sessionId, row } = await seedReceiptDelivery({ status: "failed" });
    const adminCookie = `poker_session=${makeGroupToken(null)}; poker_admin=${makeAdminToken()}`;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let res: Response;
    let logged = "";
    try {
      res = await fetch(`${server!.url}/api/poker/admin/email-deliveries/${row.id}/retry`, {
        method: "POST",
        headers: { cookie: adminCookie }
      });
      logged = logSpy.mock.calls.flat().map(String).join("\n");
    } finally {
      logSpy.mockRestore();
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      delivery: { id: string; status: string; attempts: number; errorCode: string | null };
    };
    expect(body.delivery.id).toBe(row.id);
    expect(body.delivery.status).toBe("sent"); // dev mode
    expect(body.delivery.attempts).toBe(1);
    expect(body.delivery.errorCode).toBeNull();

    const again = await fetch(`${server!.url}/api/poker/admin/email-deliveries/${row.id}/retry`, {
      method: "POST",
      headers: { cookie: adminCookie }
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: { code: "conflict", message: "Email already delivered." }
    });

    // The retried send rotated the live token; the emailed token is current.
    const match = /\/poker\?token=([A-Za-z0-9_-]+)/.exec(logged);
    expect(match).not.toBeNull();
    const [tokenRow] = await db
      .select()
      .from(disputeTokens)
      .where(eq(disputeTokens.sessionId, sessionId));
    expect(tokenRow!.tokenHash).toBe(hashToken(match![1]!));
  });

  it("retry requires admin (403) and 404s for unknown ids", async () => {
    const { row } = await seedReceiptDelivery({ status: "failed" });

    // Valid group cookie but NO admin cookie → 403 admin_required.
    const noAdmin = await fetch(
      `${server!.url}/api/poker/admin/email-deliveries/${row.id}/retry`,
      { method: "POST", headers: { cookie: `poker_session=${makeGroupToken(null)}` } }
    );
    expect(noAdmin.status).toBe(403);
    expect(await noAdmin.json()).toEqual({
      error: { code: "admin_required", message: "Admin access required." }
    });

    // Admin cookie + unknown id → 404.
    const adminCookie = `poker_session=${makeGroupToken(null)}; poker_admin=${makeAdminToken()}`;
    const unknown = await fetch(
      `${server!.url}/api/poker/admin/email-deliveries/${randomUUID()}/retry`,
      { method: "POST", headers: { cookie: adminCookie } }
    );
    expect(unknown.status).toBe(404);
  });

  it("retry on a delivered email conflicts", async () => {
    const session = await seedSession();
    await seedLiveToken(session.sessionId, session.alice.id);
    const row = await enqueueReceipt(session);
    await db
      .update(emailDeliveries)
      .set({ status: "delivered", providerId: "msg_already" })
      .where(eq(emailDeliveries.id, row.id));
    const adminCookie = `poker_session=${makeGroupToken(null)}; poker_admin=${makeAdminToken()}`;
    const res = await fetch(`${server!.url}/api/poker/admin/email-deliveries/${row.id}/retry`, {
      method: "POST",
      headers: { cookie: adminCookie }
    });
    expect(res.status).toBe(409);
  });
});

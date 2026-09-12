import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitBills, splitItemAllocations, splitPayments, splitParticipants, splitSmsDeliveries, splitUsers } from "../../server/db/schema.js";
import { createSplitSession } from "../../server/split/auth.js";
import { SPLIT_SESSION_COOKIE } from "../../server/split/tokens.js";
import { enqueueDueReminders } from "../../server/split/outbox.js";
import { openDb, resetDb } from "../helpers/db.js";
import type { TestDb } from "../helpers/db.js";
import { startTestServer } from "../helpers/server.js";
import type { TestServer } from "../helpers/server.js";

type Jar = Map<string, string>;

function freshJar(): Jar {
  return new Map();
}

function applyCookies(response: Response, jar: Jar): void {
  for (const cookie of response.headers.getSetCookie()) {
    const equals = cookie.indexOf("=");
    const name = cookie.slice(0, equals);
    const value = cookie.slice(equals + 1, cookie.indexOf(";"));
    if (value === "") jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar: Jar): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function api(
  server: TestServer,
  jar: Jar,
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (jar.size) headers.cookie = cookieHeader(jar);
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${server.url}/api/split${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

describe("Split organizer and settlement flow", () => {
  let server: TestServer;
  let tdb: TestDb;

  beforeAll(async () => {
    await resetDb();
    server = await startTestServer();
    tdb = openDb();
  });

  afterAll(async () => {
    await tdb?.end();
    await server?.close();
  });

  it("creates accounts, edits/publishes a bill, claims an invite, settles, and idempotently reminds", async () => {
    const organizerJar = freshJar();
    const attendeeJar = freshJar();
    const organizerPhone = "+15550000001";
    const attendeePhone = "+15550000002";

    expect((await api(server, organizerJar, "/auth/start", {
      method: "POST", body: { phone: organizerPhone }
    })).status).toBe(200);
    const organizerVerify = await api(server, organizerJar, "/auth/verify", {
      method: "POST", body: { phone: organizerPhone, code: "000000", displayName: "Organizer" }
    });
    expect(organizerVerify.status).toBe(200);
    applyCookies(organizerVerify, organizerJar);

    const create = await api(server, organizerJar, "/bills", {
      method: "POST",
      body: {
        requestKey: `bill-${randomUUID()}`,
        merchantName: "Demo Bistro",
        purchasedAt: "2026-09-12",
        subtotalCents: 3000,
        taxCents: 240,
        tipCents: 600,
        feeCents: 0,
        discountCents: 0,
        totalCents: 3840
      }
    });
    expect(create.status).toBe(200);
    const created = await json<{ bill: { id: string; version: number; status: string } }>(create);
    const billId = created.bill.id;
    expect(created.bill.status).toBe("review");

    const patch = await api(server, organizerJar, `/bills/${billId}`, {
      method: "PATCH", body: { version: 1, merchantName: "Demo Bistro (edited)" }
    });
    expect(patch.status).toBe(200);
    expect((await json<{ bill: { merchantName: string; version: number } }>(patch)).bill).toMatchObject({
      merchantName: "Demo Bistro (edited)", version: 2
    });

    const item1Response = await api(server, organizerJar, `/bills/${billId}/items`, {
      method: "POST",
      body: { description: "Entree", quantity: 1, unitPriceCents: 1800, lineTotalCents: 1800, displayOrder: 0 }
    });
    expect(item1Response.status).toBe(200);
    const item1 = (await json<{ item: { id: string } }>(item1Response)).item;
    const item2Response = await api(server, organizerJar, `/bills/${billId}/items`, {
      method: "POST",
      body: { description: "Drinks", quantity: 2, unitPriceCents: 600, lineTotalCents: 1200, displayOrder: 1 }
    });
    expect(item2Response.status).toBe(200);
    const item2 = (await json<{ item: { id: string } }>(item2Response)).item;
    const disposableItemResponse = await api(server, organizerJar, `/bills/${billId}/items`, {
      method: "POST",
      body: { description: "Remove me", quantity: 1, unitPriceCents: 0, lineTotalCents: 0, displayOrder: 2 }
    });
    const disposableItem = (await json<{ item: { id: string } }>(disposableItemResponse)).item;
    expect((await api(server, organizerJar, `/items/${disposableItem.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(server, organizerJar, `/items/${item1.id}`, {
      method: "PATCH", body: { description: "Entree (corrected)" }
    })).status).toBe(200);

    const addParticipant = await api(server, organizerJar, `/bills/${billId}/participants`, {
      method: "POST", body: { displayName: "Attendee", phone: attendeePhone }
    });
    expect(addParticipant.status).toBe(200);
    const invitation = await json<{ participant: { id: string }; inviteToken: string }>(addParticipant);
    expect(invitation.inviteToken).toContain(invitation.participant.id);

    const contactSearch = await api(server, organizerJar, "/contacts?q=att");
    expect(contactSearch.status).toBe(200);
    expect(await json<{ contacts: Array<{ name: string; phone: string }> }>(contactSearch)).toMatchObject({
      contacts: [{ name: "Attendee", phone: attendeePhone }]
    });

    // Re-adding a contact should produce a useful conflict instead of a raw
    // database uniqueness error (common when contacts contain duplicates).
    const duplicate = await api(server, organizerJar, `/bills/${billId}/participants`, {
      method: "POST", body: { displayName: "Attendee again", phone: "(555) 000-0002" }
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json() as { error: { message: string } }).error.message).toContain("already on this split");

    const publish = await api(server, organizerJar, `/bills/${billId}/publish`, { method: "POST" });
    expect(publish.status).toBe(200);
    const publishedRows = await tdb.db.select().from(splitSmsDeliveries);
    expect(publishedRows.filter((row) => row.eventType === "invitation")).toHaveLength(1);
    const duplicatePublish = await api(server, organizerJar, `/bills/${billId}/publish`, { method: "POST" });
    expect(duplicatePublish.status).toBe(409);

    // The invite preview is public, but its encrypted number and token hash
    // must never be returned before the invitee verifies their phone.
    const inviteView = await api(server, freshJar(), `/invites/${invitation.inviteToken}`);
    expect(inviteView.status).toBe(200);
    const inviteBody = JSON.stringify(await inviteView.json());
    expect(inviteBody).not.toContain("invitedPhoneEncrypted");
    expect(inviteBody).not.toContain("inviteTokenHash");

    expect((await api(server, attendeeJar, "/auth/start", {
      method: "POST", body: { phone: attendeePhone }
    })).status).toBe(200);
    const attendeeVerify = await api(server, attendeeJar, "/auth/verify", {
      method: "POST", body: { phone: attendeePhone, code: "000000", displayName: "Attendee" }
    });
    expect(attendeeVerify.status).toBe(200);
    applyCookies(attendeeVerify, attendeeJar);
    const accepted = await api(server, attendeeJar, `/invites/${invitation.inviteToken}/accept`, { method: "POST" });
    expect(accepted.status).toBe(200);

    expect((await api(server, attendeeJar, `/participants/${invitation.participant.id}/allocations`, {
      method: "POST",
      body: { allocations: [
        { itemId: item1.id, kind: "manual", amountCents: 1800 },
        { itemId: item2.id, kind: "manual", amountCents: 1200 }
      ] }
    })).status).toBe(200);
    expect((await api(server, attendeeJar, `/participants/${invitation.participant.id}/selection/complete`, { method: "POST" })).status).toBe(200);

    // The payer is automatically included as a participant. In this fixture
    // the attendee claimed the whole receipt, so the payer completes with no
    // items and correctly ends with a zero, already-confirmed share.
    const billView = await api(server, organizerJar, `/bills/${billId}`);
    const billBody = await json<{ participants: Array<{ id: string; displayName: string }> }>(billView);
    const organizerParticipant = billBody.participants.find((participant) => participant.displayName === "Organizer");
    expect(organizerParticipant).toBeDefined();
    expect((await api(server, organizerJar, `/participants/${organizerParticipant!.id}/allocations`, {
      method: "POST", body: { allocations: [] }
    })).status).toBe(200);
    expect((await api(server, organizerJar, `/participants/${organizerParticipant!.id}/selection/complete`, { method: "POST" })).status).toBe(200);

    const allocationRows = await tdb.db.select().from(splitItemAllocations);
    const currentBills = await tdb.db.select().from(splitBills);
    expect(allocationRows.reduce((sum, row) => sum + row.amountCents, 0)).toBe(3000);
    expect(currentBills[0]!.subtotalCents).toBe(3000);

    const lock = await api(server, organizerJar, `/bills/${billId}/lock`, { method: "POST" });
    expect(lock.status, JSON.stringify(await lock.clone().json())).toBe(200);
    const locked = await json<{ allocations: Array<{ totalCents: number }> }>(lock);
    expect(locked.allocations.reduce((sum, row) => sum + row.totalCents, 0)).toBe(3840);

    // Locking schedules the first reminder 24 hours later. Running the worker
    // twice with the same due time must only enqueue one reminder.
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000 + 1000);
    expect(await enqueueDueReminders(tdb.db, dueAt)).toBe(1);
    expect(await enqueueDueReminders(tdb.db, dueAt)).toBe(0);
    const reminders = await tdb.db.select().from(splitSmsDeliveries);
    expect(reminders.filter((row) => row.eventType === "payment_reminder")).toHaveLength(1);

    const report = await api(server, attendeeJar, `/participants/${invitation.participant.id}/report-paid`, {
      method: "POST", body: { requestKey: `paid-${randomUUID()}` }
    });
    expect(report.status).toBe(200);
    expect((await api(server, organizerJar, `/participants/${invitation.participant.id}/payment-status`, {
      method: "POST", body: { status: "confirmed" }
    })).status).toBe(200);

    const paymentRows = await tdb.db.select().from(splitPayments);
    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0]!.status).toBe("confirmed");
    const participantRows = await tdb.db.select().from(splitParticipants);
    const paidParticipant = participantRows.find((row) => row.id === invitation.participant.id);
    expect(paidParticipant!.paymentStatus).toBe("confirmed");
    expect(paidParticipant!.nextReminderAt).toBeNull();
  });

  it("rejects a phone-less Google account before creating an orphaned bill", async () => {
    const [user] = await tdb.db.insert(splitUsers).values({
      displayName: "Google Preview", googleSubject: `google-${randomUUID()}`, email: `preview-${randomUUID()}@example.com`
    }).returning({ id: splitUsers.id });
    const token = await createSplitSession(user!.id);
    const jar = new Map([[SPLIT_SESSION_COOKIE, token]]);
    const before = await tdb.db.select().from(splitBills);
    const response = await api(server, jar, "/bills", {
      method: "POST", body: { requestKey: `phone-required-${randomUUID()}`, subtotalCents: 0, taxCents: 0, tipCents: 0, feeCents: 0, discountCents: 0, totalCents: 0 }
    });
    expect(response.status).toBe(400);
    const errorBody = await response.json() as { error: { code: string } };
    expect(errorBody.error.code).toBe("phone_required");
    expect((await tdb.db.select().from(splitBills))).toHaveLength(before.length);
  });
});

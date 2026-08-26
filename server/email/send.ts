/**
 * Outbox sender — turns queued/failed email_deliveries rows into emails.
 *
 * Design notes:
 * - Only token HASHES are ever persisted (dispute_tokens.token_hash), so the
 *   raw receipt token cannot be recovered at send time. For each live token
 *   row we mint a fresh raw token, rotate that row's stored hash to the new
 *   value (keeping the row's identity/dates), and email the raw token. The
 *   emailed token is therefore always the single live token for that
 *   (session, member); older un-emailed hashes die with the rotation.
 * - DEV MODE: when RESEND_API_KEY is unset or starts with "re_dev", we log
 *   the recipient and the receipt link (the ONE documented token-bearing
 *   log line) and mark the delivery "sent" without calling the provider.
 * - Failures are recorded as safe error codes only ("no_token",
 *   "unsupported_event", "render_error", "provider_error") — never provider
 *   message text, and never email bodies, in logs.
 * - These functions NEVER throw into their callers (notify.ts and the admin
 *   retry route rely on that); failures stay in the outbox for retry.
 */
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { Resend } from "resend";
import { db } from "../db/client.js";
import {
  disputeTokens,
  emailDeliveries,
  members,
  pokerSessions,
  sessionResults
} from "../db/schema.js";
import type { EmailDeliveryRow } from "../db/schema.js";
import { generateToken, hashToken, TOKEN_TTL_DAYS } from "../domain/tokens.js";
import { env } from "../env.js";
import { updateDeliveryStatus } from "./outbox.js";
import {
  renderMemberEmail,
  renderReceiptEmail,
  renderResolutionEmail
} from "./templates.js";
import type { ReceiptEmailData } from "./templates.js";

const DEV_KEY_PREFIX = "re_dev";
// Resend test/dummy keys use the "re_test_" prefix (as in tests/setup-env.ts).
const TEST_KEY_PREFIX = "re_test_";
const DAY_MS = 86_400_000;

interface EmailContent {
  subject: string;
  html: string;
  text: string;
  /** Receipt link (token-bearing) — used only by the dev-mode log line. */
  link: string | null;
}

type BuiltContent = { ok: true; content: EmailContent } | { ok: false; errorCode: string };

/**
 * Deliver every queued/failed row for one entity (and optional version),
 * oldest first. Never throws.
 */
export async function processOutboxFor(
  entityType: string,
  entityId: string,
  version?: number
): Promise<void> {
  try {
    const conditions = [
      eq(emailDeliveries.entityType, entityType),
      eq(emailDeliveries.entityId, entityId),
      inArray(emailDeliveries.status, ["queued", "failed"])
    ];
    if (version !== undefined) {
      conditions.push(eq(emailDeliveries.version, version));
    }
    const rows = await db
      .select()
      .from(emailDeliveries)
      .where(and(...conditions))
      .orderBy(asc(emailDeliveries.createdAt), asc(emailDeliveries.id));
    for (const row of rows) {
      await attemptDelivery(row);
    }
  } catch (err) {
    console.error(
      `email outbox query failed for ${entityType}/${entityId} (${errName(err)})`
    );
  }
}

/** Send one delivery by id (admin retry). Never throws. */
export async function sendOneDelivery(deliveryId: string): Promise<void> {
  try {
    const row =
      (
        await db
          .select()
          .from(emailDeliveries)
          .where(eq(emailDeliveries.id, deliveryId))
          .limit(1)
      )[0] ?? null;
    if (!row) return;
    await attemptDelivery(row);
  } catch (err) {
    console.error(`email delivery send failed for ${deliveryId} (${errName(err)})`);
  }
}

async function attemptDelivery(row: EmailDeliveryRow): Promise<void> {
  // Count the attempt first so retries are observable even if sending fails.
  try {
    await db
      .update(emailDeliveries)
      .set({
        attempts: row.attempts + 1,
        lastAttemptAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(emailDeliveries.id, row.id));
  } catch (err) {
    console.error(`email attempt bump failed for ${row.id} (${errName(err)})`);
    return;
  }

  const built = await buildContent(row); // never throws
  if (!built.ok) {
    await markFailed(row.id, built.errorCode);
    return;
  }

  const apiKey = env().RESEND_API_KEY;
  if (!apiKey || apiKey.startsWith(DEV_KEY_PREFIX) || apiKey.startsWith(TEST_KEY_PREFIX)) {
    // Dev mode — no provider call. The link is the documented exception to
    // the no-token-in-logs rule; it exists so developers can click through.
    const suffix = built.content.link ? ` link=${built.content.link}` : "";
    console.log(`[poker-email-dev] to=${row.recipientEmail}${suffix}`);
    await markSent(row.id, null);
    return;
  }

  try {
    const resend = new Resend(apiKey);
    const response = await resend.emails.send({
      from: env().POKER_EMAIL_FROM,
      to: row.recipientEmail,
      subject: built.content.subject,
      html: built.content.html,
      text: built.content.text
    });
    if (response.error || !response.data) {
      await markFailed(row.id, "provider_error");
      return;
    }
    await markSent(row.id, response.data.id ?? null);
  } catch (err) {
    console.error(`email provider call failed for ${row.id} (${errName(err)})`);
    await markFailed(row.id, "provider_error");
  }
}

async function buildContent(row: EmailDeliveryRow): Promise<BuiltContent> {
  switch (row.eventType) {
    case "session_receipt":
    case "dispute_resolution":
      return buildReceiptContent(row);
    case "member_approved":
    case "member_welcome":
      return buildMemberContent(row);
    default:
      return { ok: false, errorCode: "unsupported_event" };
  }
}

async function buildReceiptContent(row: EmailDeliveryRow): Promise<BuiltContent> {
  if (!row.recipientMemberId) {
    return { ok: false, errorCode: "no_token" };
  }
  try {
    // The CURRENT token: the newest unrevoked, unused row for this pair.
    // Corrections revoke old rows, so the unrevoked one is authoritative.
    const tokenRow =
      (
        await db
          .select()
          .from(disputeTokens)
          .where(
            and(
              eq(disputeTokens.sessionId, row.entityId),
              eq(disputeTokens.memberId, row.recipientMemberId),
              isNull(disputeTokens.revokedAt),
              isNull(disputeTokens.usedAt)
            )
          )
          .orderBy(desc(disputeTokens.createdAt))
          .limit(1)
      )[0] ?? null;
    if (!tokenRow) {
      return { ok: false, errorCode: "no_token" };
    }

    // Rotate the live row's hash to a freshly minted raw token (the only one
    // that will be emailed), and give it a full TTL from send time.
    const token = generateToken();
    await db
      .update(disputeTokens)
      .set({
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + TOKEN_TTL_DAYS * DAY_MS)
      })
      .where(eq(disputeTokens.id, tokenRow.id));

    const session =
      (
        await db
          .select()
          .from(pokerSessions)
          .where(eq(pokerSessions.id, row.entityId))
          .limit(1)
      )[0] ?? null;
    if (!session) return { ok: false, errorCode: "render_error" };

    const resultRows = await db
      .select({
        memberId: sessionResults.memberId,
        name: members.displayName,
        amountCents: sessionResults.amountCents
      })
      .from(sessionResults)
      .innerJoin(members, eq(members.id, sessionResults.memberId))
      .where(eq(sessionResults.sessionId, row.entityId))
      .orderBy(desc(sessionResults.amountCents));

    const [recipientName] = await db
      .select({ name: members.displayName })
      .from(members)
      .where(eq(members.id, row.recipientMemberId))
      .limit(1);
    const [recorderName] = session.recordedByMemberId
      ? await db
          .select({ name: members.displayName })
          .from(members)
          .where(eq(members.id, session.recordedByMemberId))
          .limit(1)
      : [null];

    const origin = env().PUBLIC_APP_ORIGIN;
    const data: ReceiptEmailData = {
      origin,
      memberName: recipientName?.name ?? row.recipientEmail,
      session: {
        id: session.id,
        playedAt: session.playedAt,
        title: session.title,
        version: session.version,
        status: session.status
      },
      recordedBy: recorderName ? { name: recorderName.name } : null,
      results: resultRows.map((r) => ({
        name: r.name,
        amountCents: r.amountCents,
        isRecipient: r.memberId === row.recipientMemberId
      })),
      totalCents: resultRows.reduce((sum, r) => sum + r.amountCents, 0),
      token
    };
    const rendered =
      row.eventType === "dispute_resolution"
        ? renderResolutionEmail(data)
        : renderReceiptEmail(data);
    return {
      ok: true,
      content: { ...rendered, link: `${origin}/poker?token=${encodeURIComponent(token)}` }
    };
  } catch (err) {
    console.error(`email content build failed for ${row.id} (${errName(err)})`);
    return { ok: false, errorCode: "render_error" };
  }
}

async function buildMemberContent(row: EmailDeliveryRow): Promise<BuiltContent> {
  try {
    const member =
      (
        await db
          .select()
          .from(members)
          .where(eq(members.id, row.entityId))
          .limit(1)
      )[0] ?? null;
    if (!member) return { ok: false, errorCode: "render_error" };
    const rendered = renderMemberEmail({
      memberName: member.displayName,
      kind: row.eventType === "member_approved" ? "approved" : "welcome"
    });
    return { ok: true, content: { ...rendered, link: null } };
  } catch (err) {
    console.error(`email content build failed for ${row.id} (${errName(err)})`);
    return { ok: false, errorCode: "render_error" };
  }
}

async function markSent(deliveryId: string, providerId: string | null): Promise<void> {
  try {
    await updateDeliveryStatus(db, deliveryId, "sent", providerId, null);
    // updateDeliveryStatus can't express "set NULL": `null ?? undefined`
    // collapses to undefined, which drizzle omits from the UPDATE. Clear any
    // stale errorCode explicitly.
    await db
      .update(emailDeliveries)
      .set({ errorCode: null })
      .where(eq(emailDeliveries.id, deliveryId));
  } catch (err) {
    console.error(`email status update failed for ${deliveryId} (${errName(err)})`);
  }
}

async function markFailed(deliveryId: string, errorCode: string): Promise<void> {
  try {
    await updateDeliveryStatus(db, deliveryId, "failed", null, errorCode);
  } catch (err) {
    console.error(`email status update failed for ${deliveryId} (${errName(err)})`);
  }
}

/** Error class name only — never messages (provider text may be sensitive). */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown error";
}

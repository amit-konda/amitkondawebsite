/**
 * Email templates — warm, minimal HTML with plain-text fallbacks.
 *
 * Rules:
 * - Every user-controlled field (member names, session titles, result names)
 *   is HTML-escaped via esc() before it enters HTML markup.
 * - The shared group password is NEVER included in any email; Amit shares it
 *   separately. Only its generic mention ("ask Amit") appears.
 * - Plain-text versions always carry the same links as the HTML.
 */
import { formatCents } from "../domain/money.js";

/** HTML-escape a user-controlled string (ampersand, <, >, double/single quotes). */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ReceiptEmailData {
  /** App origin used to build the verify/dispute link (PUBLIC_APP_ORIGIN). */
  origin: string;
  memberName: string;
  session: {
    id: string;
    playedAt: Date | string;
    title: string | null;
    version: number;
    status: string;
  };
  recordedBy: { name: string } | null;
  results: Array<{ name: string; amountCents: number; isRecipient: boolean }>;
  totalCents: number;
  /** Raw dispute token — never persisted or logged outside the email/dev link log. */
  token: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Receipt payload without the raw token — the shape for notice renderers
 * (session updates, voids) that must NEVER embed a dispute link: their
 * outbox rows are not paired with a freshly minted token, so any previously
 * emailed token may be stale.
 */
export type WithoutTokenReceiptData = Omit<ReceiptEmailData, "token">;

function formatPlayedAt(playedAt: Date | string): string {
  const d = typeof playedAt === "string" ? new Date(playedAt) : playedAt;
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" });
}

/** Session label for subjects/bodies: title when present, else the date. */
function sessionLabel(session: {
  title: string | null;
  playedAt: Date | string;
}): string {
  return session.title ?? formatPlayedAt(session.playedAt);
}

/** "voided" → "Voided" — human-readable session status line. */
function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function receiptLink(data: ReceiptEmailData): string {
  return `${data.origin}/poker?token=${encodeURIComponent(data.token)}`;
}

const FONT_SANS = "Arial, Helvetica, sans-serif";
const FONT_SERIF = "Georgia, 'Times New Roman', serif";

function emailShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#F7F5F0;">
    <div style="max-width:560px;margin:0 auto;padding:28px 16px;font-family:${FONT_SERIF};color:#17211B;">
      ${bodyHtml}
    </div>
  </body>
</html>`;
}

interface NoticeOptions {
  /** Render the token dispute button/link (receipt renderers only). */
  includeLink?: boolean;
  /** Status/version line under the table, e.g. "Status: Voided · Version 2". */
  statusLine?: string;
  /** Extra note paragraph under the table. */
  note?: string;
}

function receiptHtml(
  data: WithoutTokenReceiptData,
  headline: string,
  intro: string,
  opts: NoticeOptions = {}
): string {
  // The token-bearing dispute link is reserved for receipt renderers; notice
  // emails (updates/voids) carry no fresh token, so they pass no link.
  const link = opts.includeLink ? receiptLink(data as ReceiptEmailData) : null;
  const rows = data.results
    .map((r) => {
      const highlight = r.isRecipient;
      const cellStyle = `padding:9px 14px;border-top:1px solid #F0ECE2;${
        highlight ? "font-weight:600;" : ""
      }`;
      const you = highlight
        ? ' <span style="color:#1F6B4F;font-weight:700;">(you)</span>'
        : "";
      return `<tr style="${highlight ? "background:#E9F2EC;" : ""}">
        <td style="${cellStyle}">${esc(r.name)}${you}</td>
        <td style="${cellStyle}text-align:right;">${esc(formatCents(r.amountCents))}</td>
      </tr>`;
    })
    .join("");
  return emailShell(
    `Poker receipt — ${sessionLabel(data.session)}`,
    `<h1 style="font-size:22px;margin:0 0 4px;">${esc(headline)}</h1>
    <p style="margin:0 0 22px;color:#5A655E;font-family:${FONT_SANS};font-size:13px;">${esc(sessionLabel(data.session))}</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 6px;">Hi ${esc(data.memberName)},</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 20px;">${intro}</p>
    <table role="table" style="width:100%;border-collapse:collapse;background:#FFFFFF;border:1px solid #DDD8CE;border-radius:10px;overflow:hidden;font-family:${FONT_SANS};font-size:15px;">
      <thead>
        <tr>
          <th scope="col" style="text-align:left;padding:10px 14px;background:#F1EDE4;">Player</th>
          <th scope="col" style="text-align:right;padding:10px 14px;background:#F1EDE4;">Result</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
        <tr style="background:#FBF9F4;">
          <td style="padding:9px 14px;border-top:1px solid #DDD8CE;font-weight:700;">Total</td>
          <td style="padding:9px 14px;border-top:1px solid #DDD8CE;text-align:right;font-weight:700;">${esc(formatCents(data.totalCents))}</td>
        </tr>
      </tbody>
    </table>
    ${
      data.recordedBy
        ? `<p style="font-family:${FONT_SANS};font-size:13px;color:#5A655E;margin:12px 0 0;">Recorded by ${esc(data.recordedBy.name)}.</p>`
        : ""
    }
    ${
      opts.statusLine
        ? `<p style="font-family:${FONT_SANS};font-size:13px;color:#5A655E;margin:12px 0 0;">${esc(opts.statusLine)}</p>`
        : ""
    }
    ${
      opts.note
        ? `<p style="font-family:${FONT_SANS};font-size:13px;color:#5A655E;margin:8px 0 0;line-height:1.6;">${esc(opts.note)}</p>`
        : ""
    }
    ${
      link
        ? `<p style="margin:24px 0 0;">
      <a href="${esc(link)}" style="display:inline-block;background:#1F6B4F;color:#FFFFFF;padding:12px 22px;border-radius:8px;text-decoration:none;font-family:${FONT_SANS};font-size:15px;font-weight:600;">View or dispute</a>
    </p>
    <p style="margin:18px 0 0;font-family:${FONT_SANS};font-size:13px;color:#5A655E;">
      <a href="${esc(link)}" style="color:#1F6B4F;">${esc(link)}</a>
    </p>
    <p style="margin:22px 0 0;font-family:${FONT_SANS};font-size:12px;color:#8A918B;line-height:1.6;">Poker Ledger is a friendly home game ledger. If something looks off, open the link above to dispute it before the group settles up.</p>`
        : ""
    }`
  );
}

function receiptText(
  data: WithoutTokenReceiptData,
  intro: string,
  opts: NoticeOptions = {}
): string {
  const lines = [
    `Hi ${data.memberName},`,
    "",
    intro,
    "",
    `Session: ${sessionLabel(data.session)}`,
    "",
    "Results:",
    ...data.results.map(
      (r) => `${r.name}  ${formatCents(r.amountCents)}${r.isRecipient ? "  (you)" : ""}`
    ),
    `Total: ${formatCents(data.totalCents)}`,
    ""
  ];
  if (data.recordedBy) {
    lines.push(`Recorded by ${data.recordedBy.name}.`, "");
  }
  if (opts.statusLine) lines.push(opts.statusLine, "");
  if (opts.note) lines.push(opts.note, "");
  if (opts.includeLink) {
    lines.push("View or dispute: " + receiptLink(data as ReceiptEmailData));
  }
  return lines.join("\n");
}

/** Session receipt — sent to every participant when a session is recorded. */
export function renderReceiptEmail(data: ReceiptEmailData): RenderedEmail {
  const intro = `Here is your receipt for the session${
    data.session.title ? ` “${esc(data.session.title)}”` : ""
  }.`;
  return {
    subject: `Poker receipt — ${sessionLabel(data.session)}`,
    html: receiptHtml(data, "Your poker receipt", intro, { includeLink: true }),
    text: receiptText(data, intro, { includeLink: true })
  };
}

/** Correction/resolution receipt — sent after an admin updates a session. */
export function renderResolutionEmail(data: ReceiptEmailData): RenderedEmail {
  const intro = `The session was updated${
    data.session.title ? ` (“${esc(data.session.title)}”)` : ""
  } — here is the current receipt.`;
  const label = sessionLabel(data.session);
  return {
    subject: `Poker receipt — ${label} (updated)`,
    html: receiptHtml(data, "Updated poker receipt", intro, { includeLink: true }),
    text: receiptText(data, intro, { includeLink: true })
  };
}

export interface MemberEmailInput {
  memberName: string;
  kind: "approved" | "welcome";
}

/** Approval/welcome note — never contains the shared group password. */
export function renderMemberEmail(input: MemberEmailInput): RenderedEmail {
  const name = input.memberName;
  if (input.kind === "approved") {
    const body = `Hi ${name},

Your request to join the Poker Ledger was approved. Amit will share the group password separately — just ask him for it and you will be in.

See you at the tables,
Poker Ledger`;
    return {
      subject: "Poker Ledger — you're approved",
      html: emailShell(
        "Poker Ledger — you're approved",
        `<h1 style="font-size:22px;margin:0 0 4px;">You're in!</h1>
        <p style="margin:0 0 22px;color:#5A655E;font-family:${FONT_SANS};font-size:13px;">Poker Ledger</p>
        <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 6px;">Hi ${esc(name)},</p>
        <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 20px;">Your request to join the Poker Ledger was approved. Amit will share the group password separately — just ask him for it and you will be in.</p>
        <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0;">See you at the tables,<br>Poker Ledger</p>`
      ),
      text: body
    };
  }
  return {
    subject: "Welcome to Poker Ledger",
    html: emailShell(
      "Welcome to Poker Ledger",
      `<h1 style="font-size:22px;margin:0 0 4px;">Welcome!</h1>
      <p style="margin:0 0 22px;color:#5A655E;font-family:${FONT_SANS};font-size:13px;">Poker Ledger</p>
      <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 6px;">Hi ${esc(name)},</p>
      <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 20px;">You have been added to the Poker Ledger group. Amit will share the group password separately — ask him for it when you are ready to play.</p>
      <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0;">See you at the tables,<br>Poker Ledger</p>`
    ),
    text: `Hi ${name},

You have been added to the Poker Ledger group. Amit will share the group password separately — ask him for it when you are ready to play.

See you at the tables,
Poker Ledger`
  };
}

// ---------------------------------------------------------------------------
// Session notices — metadata updates, voids, and result corrections.
// These NEVER embed a dispute token/link: notice outbox rows are not paired
// with a freshly minted token, so any previously emailed token may be stale.
// ---------------------------------------------------------------------------

/** Session metadata update notice — informational, no dispute link. */
export function renderSessionUpdatedEmail(
  data: WithoutTokenReceiptData
): RenderedEmail {
  const intro = `This is a receipt update, not a new request — no action is needed on your part. The group admin updated the session${
    data.session.title ? ` “${esc(data.session.title)}”` : ""
  }, and the results below are current as of that update.`;
  const statusLine = `Status: ${statusLabel(data.session.status)} · Version ${data.session.version}`;
  const note =
    "No dispute link is included in this notice. If the results are corrected, a fresh receipt link will be sent with the correction.";
  return {
    subject: `Poker session updated — ${sessionLabel(data.session)}`,
    html: receiptHtml(data, "Session updated", intro, { statusLine, note }),
    text: receiptText(data, intro, { statusLine, note })
  };
}

/** Session voided notice — the session no longer counts toward the ledger. */
export function renderSessionVoidedEmail(
  data: WithoutTokenReceiptData
): RenderedEmail {
  const intro =
    "This session was voided by the group admin and no longer counts toward the ledger. The results below are what was recorded — kept here for your reference.";
  const statusLine = `Status: Voided · Version ${data.session.version}`;
  return {
    subject: "Poker session voided",
    html: receiptHtml(data, "Session voided", intro, { statusLine }),
    text: receiptText(data, intro, { statusLine })
  };
}

export interface ResultsCorrectedEmailData {
  origin: string;
  memberName: string;
  session: {
    id: string;
    playedAt: Date | string;
    title: string | null;
    version: number;
    status: string;
  };
  beforeAmountCents: number;
  afterAmountCents: number;
  changeCents: number;
  totalCents: number;
}

/** Results-corrected notice — this member's before/after/change only. */
export function renderResultsCorrectedEmail(
  data: ResultsCorrectedEmailData
): RenderedEmail {
  const label = sessionLabel(data.session);
  const intro = `The group admin corrected the results for “${esc(
    label
  )}” — your amount changed as follows.`;
  const statusLine = `Status: ${statusLabel(data.session.status)} · Version ${data.session.version}`;
  const link = `${data.origin}/poker`;
  const amountRows = [
    { name: "Previous amount", value: formatCents(data.beforeAmountCents) },
    { name: "New amount", value: formatCents(data.afterAmountCents) },
    { name: "Change", value: formatCents(data.changeCents) }
  ]
    .map(
      (r, i) =>
        `<tr>
          <th scope="row" style="padding:9px 14px;${i > 0 ? "border-top:1px solid #F0ECE2;" : ""}font-weight:600;text-align:left;">${esc(r.name)}</th>
          <td style="padding:9px 14px;${i > 0 ? "border-top:1px solid #F0ECE2;" : ""}text-align:right;font-weight:600;">${esc(r.value)}</td>
        </tr>`
    )
    .join("");
  const html = emailShell(
    "Poker results corrected",
    `<h1 style="font-size:22px;margin:0 0 4px;">Results corrected</h1>
    <p style="margin:0 0 22px;color:#5A655E;font-family:${FONT_SANS};font-size:13px;">${esc(label)}</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 6px;">Hi ${esc(data.memberName)},</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 20px;">${intro}</p>
    <table role="table" style="width:100%;border-collapse:collapse;background:#FFFFFF;border:1px solid #DDD8CE;border-radius:10px;overflow:hidden;font-family:${FONT_SANS};font-size:15px;">
      <tbody>
        ${amountRows}
      </tbody>
    </table>
    <p style="font-family:${FONT_SANS};font-size:13px;color:#5A655E;margin:12px 0 0;">${esc(statusLine)}</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:16px 0 0;">The group admin corrected the session — the ledger now reflects the corrected results.</p>
    <p style="margin:20px 0 0;">
      <a href="${esc(link)}" style="display:inline-block;background:#1F6B4F;color:#FFFFFF;padding:12px 22px;border-radius:8px;text-decoration:none;font-family:${FONT_SANS};font-size:15px;font-weight:600;">Open the poker ledger</a>
    </p>
    <p style="margin:16px 0 0;font-family:${FONT_SANS};font-size:13px;color:#5A655E;">
      <a href="${esc(link)}" style="color:#1F6B4F;">${esc(link)}</a>
    </p>`
  );
  const text = `Hi ${data.memberName},

${intro}

Previous amount: ${formatCents(data.beforeAmountCents)}
New amount: ${formatCents(data.afterAmountCents)}
Change: ${formatCents(data.changeCents)}

${statusLine}

The group admin corrected the session — the ledger now reflects the corrected results.
Open the poker ledger: ${link}`;
  return { subject: "Poker results corrected", html, text };
}

// ---------------------------------------------------------------------------
// Dispute notices — admin alert + participant acknowledgements.
// Links go to /poker only: the portal requires the group password (shared
// separately, never emailed) and raw tokens are never embedded here.
// ---------------------------------------------------------------------------

export interface DisputeNoticeEmailData {
  origin: string;
  memberName: string;
  reason: string;
  sessionTitle: string | null;
  playedAt: Date | string;
  sessionId: string;
}

function disputeSessionLabel(
  data: Pick<DisputeNoticeEmailData, "sessionTitle" | "playedAt">
): string {
  return data.sessionTitle ?? formatPlayedAt(data.playedAt);
}

function ledgerLinkHtml(origin: string): string {
  const link = `${origin}/poker`;
  return `<p style="margin:24px 0 0;">
    <a href="${esc(link)}" style="display:inline-block;background:#1F6B4F;color:#FFFFFF;padding:12px 22px;border-radius:8px;text-decoration:none;font-family:${FONT_SANS};font-size:15px;font-weight:600;">Open the poker ledger</a>
  </p>
  <p style="margin:18px 0 0;font-family:${FONT_SANS};font-size:13px;color:#5A655E;">
    <a href="${esc(link)}" style="color:#1F6B4F;">${esc(link)}</a>
  </p>`;
}

/** Admin alert when a participant opens a dispute. */
export function renderDisputeOpenedEmail(
  data: DisputeNoticeEmailData
): RenderedEmail {
  const label = disputeSessionLabel(data);
  const html = emailShell(
    `Dispute opened — ${label}`,
    `<h1 style="font-size:22px;margin:0 0 4px;">Dispute opened</h1>
    <p style="margin:0 0 22px;color:#5A655E;font-family:${FONT_SANS};font-size:13px;">${esc(label)}</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 6px;">Hi,</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 20px;"><strong>${esc(data.memberName)}</strong> disputes the session “${esc(label)}” (${esc(formatPlayedAt(data.playedAt))}). Their reason:</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 20px;padding:14px 16px;background:#FFFFFF;border:1px solid #DDD8CE;border-radius:10px;">${esc(data.reason)}</p>
    ${ledgerLinkHtml(data.origin)}
    <p style="margin:22px 0 0;font-family:${FONT_SANS};font-size:12px;color:#8A918B;line-height:1.6;">Resolve it from the admin portal once you have signed in — the portal requires the group password, which is shared separately and never included in email.</p>`
  );
  const text = `Hi,

${data.memberName} disputes the session "${label}" (${formatPlayedAt(data.playedAt)}).

Reason:
${data.reason}

Resolve it from the admin portal (requires the group password — shared separately, never emailed):
${data.origin}/poker`;
  return { subject: `Dispute opened — ${label}`, html, text };
}

/** Acknowledgment to the participant who opened the dispute. */
export function renderDisputeAckEmail(
  data: Omit<DisputeNoticeEmailData, "memberName">
): RenderedEmail {
  const label = disputeSessionLabel(data);
  const html = emailShell(
    "Dispute received",
    `<h1 style="font-size:22px;margin:0 0 4px;">Dispute received</h1>
    <p style="margin:0 0 22px;color:#5A655E;font-family:${FONT_SANS};font-size:13px;">${esc(label)}</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 6px;">Hi there,</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 20px;">Your dispute about the session “${esc(label)}” (${esc(formatPlayedAt(data.playedAt))}) was received. The group admin will review it.</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 20px;">Reason: ${esc(data.reason)}</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 20px;">The ledger is unchanged until the dispute is resolved.</p>
    ${ledgerLinkHtml(data.origin)}
    <p style="margin:22px 0 0;font-family:${FONT_SANS};font-size:12px;color:#8A918B;line-height:1.6;">Signing in may require the group password — the group admin shares it separately, and it is never included in email.</p>`
  );
  const text = `Hi there,

Your dispute about the session "${label}" (${formatPlayedAt(data.playedAt)}) was received. The group admin will review it.

Reason:
${data.reason}

The ledger is unchanged until the dispute is resolved.
Open the poker ledger: ${data.origin}/poker

(Signing in may require the group password — the group admin shares it separately, and it is never included in email.)`;
  return { subject: "Dispute received", html, text };
}

/** Resolution notice to the disputing participant (neutral phrasing). */
export function renderDisputeResolvedEmail(
  data: DisputeNoticeEmailData
): RenderedEmail {
  const label = disputeSessionLabel(data);
  const html = emailShell(
    `Dispute resolved — ${label}`,
    `<h1 style="font-size:22px;margin:0 0 4px;">Dispute resolved</h1>
    <p style="margin:0 0 22px;color:#5A655E;font-family:${FONT_SANS};font-size:13px;">${esc(label)}</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 6px;">Hi ${esc(data.memberName)},</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 20px;">The group admin resolved the dispute about the session “${esc(label)}” (${esc(formatPlayedAt(data.playedAt))}). Check the ledger for the current totals — the session may have been corrected as part of the resolution.</p>
    ${ledgerLinkHtml(data.origin)}
    <p style="margin:22px 0 0;font-family:${FONT_SANS};font-size:12px;color:#8A918B;line-height:1.6;">Signing in may require the group password — the group admin shares it separately, and it is never included in email.</p>`
  );
  const text = `Hi ${data.memberName},

The group admin resolved the dispute about the session "${label}" (${formatPlayedAt(data.playedAt)}). Check the ledger for the current totals — the session may have been corrected as part of the resolution.

Open the poker ledger: ${data.origin}/poker

(Signing in may require the group password — the group admin shares it separately, and it is never included in email.)`;
  return { subject: `Dispute resolved — ${label}`, html, text };
}

/** Dismissal notice to the disputing participant — the session stands. */
export function renderDisputeDismissedEmail(
  data: DisputeNoticeEmailData
): RenderedEmail {
  const label = disputeSessionLabel(data);
  const html = emailShell(
    `Dispute dismissed — ${label}`,
    `<h1 style="font-size:22px;margin:0 0 4px;">Dispute dismissed</h1>
    <p style="margin:0 0 22px;color:#5A655E;font-family:${FONT_SANS};font-size:13px;">${esc(label)}</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 6px;">Hi ${esc(data.memberName)},</p>
    <p style="font-family:${FONT_SANS};font-size:15px;line-height:1.5;margin:0 0 20px;">The group admin dismissed the dispute about the session “${esc(label)}” (${esc(formatPlayedAt(data.playedAt))}). The session stands as recorded.</p>
    ${ledgerLinkHtml(data.origin)}
    <p style="margin:22px 0 0;font-family:${FONT_SANS};font-size:12px;color:#8A918B;line-height:1.6;">Signing in may require the group password — the group admin shares it separately, and it is never included in email.</p>`
  );
  const text = `Hi ${data.memberName},

The group admin dismissed the dispute about the session "${label}" (${formatPlayedAt(data.playedAt)}). The session stands as recorded.

Open the poker ledger: ${data.origin}/poker

(Signing in may require the group password — the group admin shares it separately, and it is never included in email.)`;
  return { subject: `Dispute dismissed — ${label}`, html, text };
}

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

function formatPlayedAt(playedAt: Date | string): string {
  const d = typeof playedAt === "string" ? new Date(playedAt) : playedAt;
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" });
}

function sessionLabel(data: ReceiptEmailData): string {
  return data.session.title ?? formatPlayedAt(data.session.playedAt);
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

function receiptHtml(data: ReceiptEmailData, headline: string, intro: string): string {
  const link = receiptLink(data);
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
    `Poker receipt — ${sessionLabel(data)}`,
    `<h1 style="font-size:22px;margin:0 0 4px;">${esc(headline)}</h1>
    <p style="margin:0 0 22px;color:#5A655E;font-family:${FONT_SANS};font-size:13px;">${esc(sessionLabel(data))}</p>
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
    <p style="margin:24px 0 0;">
      <a href="${esc(link)}" style="display:inline-block;background:#1F6B4F;color:#FFFFFF;padding:12px 22px;border-radius:8px;text-decoration:none;font-family:${FONT_SANS};font-size:15px;font-weight:600;">View or dispute</a>
    </p>
    <p style="margin:18px 0 0;font-family:${FONT_SANS};font-size:13px;color:#5A655E;">
      <a href="${esc(link)}" style="color:#1F6B4F;">${esc(link)}</a>
    </p>
    <p style="margin:22px 0 0;font-family:${FONT_SANS};font-size:12px;color:#8A918B;line-height:1.6;">Poker Ledger is a friendly home game ledger. If something looks off, open the link above to dispute it before the group settles up.</p>`
  );
}

function receiptText(data: ReceiptEmailData, intro: string): string {
  const lines = [
    `Hi ${data.memberName},`,
    "",
    intro,
    "",
    `Session: ${sessionLabel(data)}`,
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
  lines.push("View or dispute: " + receiptLink(data));
  return lines.join("\n");
}

/** Session receipt — sent to every participant when a session is recorded. */
export function renderReceiptEmail(data: ReceiptEmailData): RenderedEmail {
  const intro = `Here is your receipt for the session${
    data.session.title ? ` “${esc(data.session.title)}”` : ""
  }.`;
  return {
    subject: `Poker receipt — ${sessionLabel(data)}`,
    html: receiptHtml(data, "Your poker receipt", intro),
    text: receiptText(data, intro)
  };
}

/** Correction/resolution receipt — sent after an admin updates a session. */
export function renderResolutionEmail(data: ReceiptEmailData): RenderedEmail {
  const intro = `The session was updated${
    data.session.title ? ` (“${esc(data.session.title)}”)` : ""
  } — here is the current receipt.`;
  const label = sessionLabel(data);
  return {
    subject: `Poker receipt — ${label} (updated)`,
    html: receiptHtml(data, "Updated poker receipt", intro),
    text: receiptText(data, intro)
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

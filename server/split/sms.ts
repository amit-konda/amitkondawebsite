import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "../errors.js";
import { isTwilioMessagingConfigured, isTwilioVerifyConfigured, splitDevMode, splitEnv } from "./env.js";
import { normalizePhone } from "./phone.js";

export interface SmsResult { providerId: string; status: string }

function twilioAuth(e: ReturnType<typeof splitEnv>): string {
  return Buffer.from(`${e.TWILIO_ACCOUNT_SID}:${e.TWILIO_AUTH_TOKEN}`).toString("base64");
}

export async function startPhoneVerification(phone: string): Promise<{ status: string }> {
  const to = normalizePhone(phone);
  if (!isTwilioVerifyConfigured()) {
    if (splitDevMode() || process.env.NODE_ENV === "test") return { status: "pending" };
    throw unavailable();
  }
  const e = splitEnv();
  const body = new URLSearchParams({ To: to, Channel: "sms" });
  const response = await fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(e.TWILIO_VERIFY_SERVICE_SID!)}/Verifications`, {
    method: "POST",
    headers: { Authorization: `Basic ${twilioAuth(e)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    console.error("Twilio Verify start failure", response.status);
    throw new ApiError(502, "verification_failed", "Could not send a verification code.");
  }
  const result = await response.json() as { status?: string };
  return { status: result.status ?? "pending" };
}

export async function checkPhoneVerification(phone: string, code: string): Promise<boolean> {
  const to = normalizePhone(phone);
  if (!/^\d{4,10}$/.test(code)) return false;
  if (!isTwilioVerifyConfigured()) {
    if (splitDevMode() || process.env.NODE_ENV === "test") return code === "000000";
    throw unavailable();
  }
  const e = splitEnv();
  const body = new URLSearchParams({ To: to, Code: code });
  const response = await fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(e.TWILIO_VERIFY_SERVICE_SID!)}/VerificationCheck`, {
    method: "POST",
    headers: { Authorization: `Basic ${twilioAuth(e)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    console.error("Twilio Verify check failure", response.status);
    throw new ApiError(502, "verification_failed", "Could not verify the code.");
  }
  const result = await response.json() as { status?: string };
  return result.status === "approved";
}

export async function sendSms(toInput: string, message: string, statusCallbackUrl?: string): Promise<SmsResult> {
  const to = normalizePhone(toInput);
  if (!isTwilioMessagingConfigured()) {
    if (splitDevMode() || process.env.NODE_ENV === "test") {
      return { providerId: `dev-${createHmac("sha256", "split-dev").update(`${to}:${message}`).digest("hex").slice(0, 24)}`, status: "sent" };
    }
    throw unavailable();
  }
  const e = splitEnv();
  const values: Record<string, string> = { To: to, From: e.TWILIO_MESSAGING_FROM!, Body: message };
  if (statusCallbackUrl) values.StatusCallback = statusCallbackUrl;
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(e.TWILIO_ACCOUNT_SID!)}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${twilioAuth(e)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    console.error("Twilio Messaging failure", response.status);
    throw new ApiError(502, "sms_failed", "Could not send the text message.");
  }
  const result = await response.json() as { sid?: string; status?: string };
  if (!result.sid) throw new ApiError(502, "sms_failed", "Could not send the text message.");
  return { providerId: result.sid, status: result.status ?? "queued" };
}

/** Parse Twilio's application/x-www-form-urlencoded webhook body. */
export function parseTwilioForm(rawBody: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(rawBody));
}

/** Verify the X-Twilio-Signature over the exact public request URL and sorted form fields. */
export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined): boolean {
  const token = splitEnv().TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;
  const canonical = url + Object.keys(params).sort().map((key) => `${key}${params[key] ?? ""}`).join("");
  const expected = createHmac("sha1", token).update(canonical).digest("base64");
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

function unavailable(): ApiError {
  return new ApiError(503, "sms_unavailable", "Text messaging is temporarily unavailable.");
}

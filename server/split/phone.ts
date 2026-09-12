import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes
} from "node:crypto";
import { badRequest } from "../errors.js";
import { splitEnv } from "./env.js";

/** Normalize US numbers to E.164. Explicit +country-code numbers are retained. */
export function normalizePhone(input: string): string {
  const raw = input.trim();
  if (!/^\+?[\d\s().-]+$/.test(raw)) {
    throw badRequest("invalid_phone", "Enter a valid phone number.");
  }
  const digits = raw.replace(/\D/g, "");
  let normalized: string;
  if (raw.startsWith("+")) normalized = `+${digits}`;
  else if (digits.length === 10) normalized = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) normalized = `+${digits}`;
  else throw badRequest("invalid_phone", "Enter a valid phone number.");
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw badRequest("invalid_phone", "Enter a valid phone number.");
  }
  return normalized;
}

export function phoneHash(e164: string): string {
  return createHmac("sha256", splitEnv().SPLIT_PHONE_HASH_SECRET)
    .update(normalizePhone(e164))
    .digest("hex");
}

function encryptionKey(): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      splitEnv().SPLIT_PHONE_ENCRYPTION_KEY,
      "amitkonda-split",
      "phone-encryption-v1",
      32
    )
  );
}

/** AES-256-GCM envelope: v1.iv.ciphertext.tag (base64url segments). */
export function encryptPhone(e164: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(normalizePhone(e164), "utf8"),
    cipher.final()
  ]);
  return ["v1", iv.toString("base64url"), encrypted.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function decryptPhone(value: string): string {
  const [version, ivRaw, dataRaw, tagRaw] = value.split(".");
  if (version !== "v1" || !ivRaw || !dataRaw || !tagRaw) {
    throw new Error("Invalid encrypted phone envelope");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function maskPhone(e164: string): string {
  const normalized = normalizePhone(e164);
  return `••• ••• ${normalized.slice(-4)}`;
}

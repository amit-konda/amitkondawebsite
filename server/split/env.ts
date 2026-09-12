import "dotenv/config";
import { z } from "zod";

const SplitEnvSchema = z.object({
  SPLIT_PHONE_HASH_SECRET: z.string().min(32),
  SPLIT_PHONE_ENCRYPTION_KEY: z.string().min(32),
  SPLIT_SESSION_SECRET: z.string().min(32),
  SPLIT_INVITE_SECRET: z.string().min(32),
  PUBLIC_APP_ORIGIN: z.string().url().default("https://amitkonda.com"),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_RECEIPT_MODEL: z.string().min(1).default("gpt-5-mini"),
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_VERIFY_SERVICE_SID: z.string().min(1).optional(),
  TWILIO_MESSAGING_FROM: z.string().min(1).optional(),
  CRON_SECRET: z.string().min(16).optional(),
  SPLIT_CRON_SECRET: z.string().min(16).optional(),
  SPLIT_DEV_MODE: z.enum(["true", "false"]).default("false")
});

export type SplitEnv = z.infer<typeof SplitEnvSchema>;
let cached: SplitEnv | null = null;

export function splitEnv(): SplitEnv {
  if (!cached) cached = SplitEnvSchema.parse(process.env);
  return cached;
}

export function splitDevMode(): boolean {
  return splitEnv().SPLIT_DEV_MODE === "true";
}

export function isOpenAiConfigured(): boolean {
  return Boolean(splitEnv().OPENAI_API_KEY);
}

export function isTwilioConfigured(): boolean {
  const e = splitEnv();
  return Boolean(
    e.TWILIO_ACCOUNT_SID &&
      e.TWILIO_AUTH_TOKEN &&
      e.TWILIO_VERIFY_SERVICE_SID &&
      e.TWILIO_MESSAGING_FROM
  );
}

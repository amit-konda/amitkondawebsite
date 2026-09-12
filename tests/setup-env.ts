/**
 * Vitest setup: injects a safe test environment BEFORE any server module loads.
 * The test DB is local Postgres (poker_test, see POKER_TEST_DATABASE_URL).
 */
import { scryptSync, randomBytes } from "node:crypto";

// Local Postgres: postgres/postgres@localhost:5432/poker_test
const TEST_DATABASE_URL =
  process.env.POKER_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/poker_test";

function testHash(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.POKER_PASSWORD_HASH = process.env.POKER_PASSWORD_HASH ?? testHash("group-pass-test");
process.env.POKER_ADMIN_PASSWORD_HASH =
  process.env.POKER_ADMIN_PASSWORD_HASH ?? testHash("admin-pass-test");
process.env.POKER_SESSION_SECRET = process.env.POKER_SESSION_SECRET ?? "test-session-secret-0123456789abcdef";
process.env.POKER_ADMIN_SESSION_SECRET =
  process.env.POKER_ADMIN_SESSION_SECRET ?? "test-admin-secret-0123456789abcdef";
process.env.POKER_AUTH_VERSION = process.env.POKER_AUTH_VERSION ?? "1";
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";
process.env.RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET ?? "test-webhook-secret";
process.env.POKER_EMAIL_FROM = process.env.POKER_EMAIL_FROM ?? "Poker Test <test@example.com>";
process.env.PUBLIC_APP_ORIGIN = process.env.PUBLIC_APP_ORIGIN ?? "http://localhost:8788";

// Split's crypto helpers validate these secrets at module call time. Keep the
// defaults local and deterministic in tests; callers can still override them
// when a test explicitly needs a different key.
process.env.SPLIT_PHONE_HASH_SECRET =
  process.env.SPLIT_PHONE_HASH_SECRET ?? "test-split-phone-hash-secret-0123456789";
process.env.SPLIT_PHONE_ENCRYPTION_KEY =
  process.env.SPLIT_PHONE_ENCRYPTION_KEY ?? "test-split-phone-encryption-0123456789";
process.env.SPLIT_SESSION_SECRET =
  process.env.SPLIT_SESSION_SECRET ?? "test-split-session-secret-0123456789";
process.env.SPLIT_INVITE_SECRET =
  process.env.SPLIT_INVITE_SECRET ?? "test-split-invite-secret-0123456789";
process.env.SPLIT_DEV_MODE = process.env.SPLIT_DEV_MODE ?? "true";

// Never let a developer's real provider key cause unit tests to make an
// external OCR request. OCR's deterministic fallback is the intended test
// behavior unless a test deliberately mocks the provider.
delete process.env.OPENAI_API_KEY;
delete process.env.OPENCODE_GO_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "test-twilio-signing-token";
delete process.env.TWILIO_VERIFY_SERVICE_SID;
delete process.env.TWILIO_MESSAGING_FROM;

#!/usr/bin/env node
/**
 * Poker Ledger — dev/preview demo-data seeder.
 *
 * Creates a small fake group (5 members, 3 balanced zero-sum sessions, and a
 * dispute token per participant) in whatever DATABASE_URL is active, then
 * prints a receipt link per participant — raw token included — to STDOUT so
 * the dispute flow can be exercised locally WITHOUT email.
 *
 * Usage:
 *   npx tsx scripts/seed-preview.mjs
 *
 * Prereqs:
 *   - migrations already applied (npm run db:migrate)
 *   - DATABASE_URL in the environment or in .env (dotenv/config is loaded)
 *
 * SAFETY:
 *   - Inserts ONLY fake data (<name>+preview@example.com — never real
 *     addresses) and prints only fake data.
 *   - Idempotent: if preview members already exist it exits without touching
 *     the database.
 *   - Raw tokens are printed to stdout ONLY and never persisted — the DB
 *     stores their SHA-256 hashes (hashToken), exactly like production email.
 */
import "dotenv/config";
import { randomBytes, scryptSync } from "node:crypto";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Environment — server modules validate the FULL env schema at import time,
// so provide safe throwaway values for anything missing (real values from
// .env or the environment always win: dotenv/config never overrides).
// ---------------------------------------------------------------------------
if (!process.env.DATABASE_URL) {
  console.error("seed-preview: missing required env var DATABASE_URL");
  process.exit(1);
}
if (!process.env.POKER_PASSWORD_HASH) {
  const salt = randomBytes(16);
  const hash = scryptSync("preview-only", salt, 64, { N: 16384, r: 8, p: 1 });
  process.env.POKER_PASSWORD_HASH =
    `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}
if (!process.env.POKER_ADMIN_PASSWORD_HASH) {
  const salt = randomBytes(16);
  const hash = scryptSync("preview-only-admin", salt, 64, { N: 16384, r: 8, p: 1 });
  process.env.POKER_ADMIN_PASSWORD_HASH =
    `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}
for (const key of ["POKER_SESSION_SECRET", "POKER_ADMIN_SESSION_SECRET"]) {
  process.env[key] ??= randomBytes(48).toString("base64url");
}
process.env.POKER_AUTH_VERSION ??= "1";

// Server modules are imported AFTER the env above is ensured (env() fails
// closed at import time). Dynamic imports keep that ordering explicit.
const [{ db }, schemaMod, tokensMod] = await Promise.all([
  import("../server/db/client.js"),
  import("../server/db/schema.js"),
  import("../server/domain/tokens.js")
]);
const { members, pokerSessions, sessionResults, disputeTokens } = schemaMod;
const { generateToken, hashToken } = tokensMod;

// ---------------------------------------------------------------------------
// Fake data — never real names or addresses.
// ---------------------------------------------------------------------------
const PEOPLE = [
  ["Alex", "alex+preview@example.com"],
  ["Bailey", "bailey+preview@example.com"],
  ["Casey", "casey+preview@example.com"],
  ["Drew", "drew+preview@example.com"],
  ["Elliot", "elliot+preview@example.com"]
];

// [title, [name, amountCents][] — every session sums to exactly zero cents.]
const SESSIONS = [
  ["Friday Night Game", [["Alex", 30000], ["Bailey", -18000], ["Casey", -12000]]],
  ["Home Game", [["Casey", 15000], ["Drew", -9000], ["Elliot", -6000]]],
  ["Heads-Up Quickie", [["Alex", 5000], ["Drew", -5000]]]
];

const RECEIPT_ORIGIN = process.env.PREVIEW_APP_ORIGIN ?? "http://localhost:8788";

// ---------------------------------------------------------------------------
// Idempotency guard — leave the DB alone if preview data already exists.
// ---------------------------------------------------------------------------
const alreadySeeded = await db.execute(
  sql`select 1 from members where email_normalized like '%+preview@example.com' limit 1`
);
if (Array.isArray(alreadySeeded) && alreadySeeded.length > 0) {
  console.log(
    "seed-preview: preview members already present — nothing to do (idempotent)."
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Seed. Raw tokens are kept in memory ONLY for the stdout report below.
// ---------------------------------------------------------------------------
const issued = []; // { title, name, token }

await db.transaction(async (tx) => {
  const inserted = {};
  for (const [name, email] of PEOPLE) {
    const [row] = await tx
      .insert(members)
      .values({ displayName: name, emailNormalized: email })
      .returning({
        id: members.id,
        displayName: members.displayName,
        emailNormalized: members.emailNormalized
      });
    if (!row) throw new Error(`seed-preview: member insert failed for ${email}`);
    inserted[name] = row;
  }

  let i = 0;
  for (const [title, participants] of SESSIONS) {
    i += 1;
    const [session] = await tx
      .insert(pokerSessions)
      .values({
        playedAt: new Date(Date.now() - i * 7 * 24 * 3600 * 1000),
        title,
        notes: "Seeded demo data — preview only.",
        recordedByMemberId: null,
        status: "active",
        version: 1,
        requestKey: `preview-${i}-${randomBytes(6).toString("hex")}`
      })
      .returning({ id: pokerSessions.id });
    if (!session) throw new Error("seed-preview: session insert failed");

    const results = [];
    const tokens = [];
    for (const [name, amountCents] of participants) {
      const member = inserted[name];
      if (!member) throw new Error(`seed-preview: unknown member "${name}"`);
      results.push({ sessionId: session.id, memberId: member.id, amountCents });
      const token = generateToken(); // 256-bit, base64url
      issued.push({ title, name, token }); // stdout report only
      tokens.push({
        sessionId: session.id,
        memberId: member.id,
        tokenHash: hashToken(token), // only the hash is persisted
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000)
      });
    }
    await tx.insert(sessionResults).values(results);
    await tx.insert(disputeTokens).values(tokens);
  }
});

// ---------------------------------------------------------------------------
// Report — fake data and raw (now unprintable-elsewhere) tokens only.
// ---------------------------------------------------------------------------
const [memberCount] = await db.execute(sql`select count(*)::int as n from members`);
const [sessionCount] = await db.execute(
  sql`select count(*)::int as n from poker_sessions`
);
const [tokenCount] = await db.execute(
  sql`select count(*)::int as n from dispute_tokens`
);

console.log("");
console.log("=======================================================");
console.log("  POKER LEDGER — PREVIEW SEED DATA");
console.log("  preview only — not for production");
console.log("=======================================================");
console.log(`Members: ${memberCount?.n ?? 0}`);
console.log(`Sessions: ${sessionCount?.n ?? 0}`);
console.log(`Dispute tokens: ${tokenCount?.n ?? 0}`);
console.log("");
console.log(
  "Receipt links (dev convenience — exercise the dispute flow without email;"
);
console.log("raw tokens exist only in this stdout output, never in the DB):");
console.log("");

const bySession = (sessionTitle) => issued.filter((e) => e.title === sessionTitle);
for (const [title] of SESSIONS) {
  console.log(`— ${title}`);
  for (const { name, token } of bySession(title)) {
    console.log(`    ${name.padEnd(8)} ${RECEIPT_ORIGIN}/poker/?token=${token}`);
  }
}
console.log("");
console.log("Reset: drop the poker database or run once against a fresh DB.");
console.log("(The app itself has no delete route — finance records are never");
console.log("hard-deleted.)");

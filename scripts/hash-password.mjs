#!/usr/bin/env node
/**
 * Generate a scrypt password hash for POKER_PASSWORD_HASH / POKER_ADMIN_PASSWORD_HASH.
 *
 * Usage:
 *   node scripts/hash-password.mjs            # prompts on stdin
 *   node scripts/hash-password.mjs "my-pass"  # or pass as argv
 *
 * Output format: scrypt$16384$8$1$<salt_b64url>$<hash_b64url>
 * Must match server/auth.js verifyScryptPassword.
 */
import { scryptSync, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

async function readStdin(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const password = process.argv[2] ?? (await readStdin("Password (not echoed): "));

if (!password || password.length < 6) {
  console.error("Password must be at least 6 characters.");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
console.log(`scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`);

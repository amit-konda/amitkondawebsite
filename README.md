# amitkonda.com — Poker Ledger

A private poker-group ledger at **https://amitkonda.com/poker**. The homepage
(`index.html`, `style.css`, `data/*.json` feeds) is untouched and deploys from
the same repo alongside the poker app.

- **Hosting:** Vercel (existing project + custom domain) — no Cloudflare.
- **Poker UI:** static HTML/CSS/JS in `poker/` (no build step, CSP `script-src 'self'`).
- **Backend:** one catch-all Vercel Function `api/poker/[...route].ts` — routing,
  auth, validation, and DB access are centralized in `server/`.
- **Database:** Neon Postgres (Drizzle ORM + postgres.js driver) — migrations in `migrations/`.
- **Email:** Resend (receipts, approval/welcome), idempotent outbox + verified webhook.
- **Auth:** one shared group password (no accounts) + a separate admin PIN.
  Cookies are signed, HttpOnly, Secure, SameSite=Lax (30 days; admin 4 hours).

## Local development

Prereqs: Node 20+, a local Postgres (Homebrew `postgres` is fine).

```sh
npm install
cp .env.example .env
# fill DATABASE_URL (e.g. postgres://postgres:postgres@localhost:5432/poker_dev)
npm run db:migrate
node scripts/hash-password.mjs   # run twice: group password + admin PIN → paste into .env
npm run dev                      # http://localhost:8788 (static + API)
```

Dev passwords already configured in the local `.env`: group `poker-dev-pass`,
admin `admin-dev-pass`. Dev mode emails (when `RESEND_API_KEY` is unset or
starts with `re_dev`) log receipt links to the server console instead of
sending — that's how you test the dispute flow locally.

Preview demo data (fake members + sessions + printable receipt links):

```sh
npx tsx scripts/seed-preview.mjs   # against whatever DATABASE_URL is in .env
```

## Environment variables

| Variable | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | Neon Postgres connection | separate Preview/Production values |
| `POKER_PASSWORD_HASH` | scrypt hash of the group password | `node scripts/hash-password.mjs` |
| `POKER_SESSION_SECRET` | HMAC key for group cookies | ≥32 random bytes (`openssl rand -base64 32`) |
| `POKER_AUTH_VERSION` | cookie version; bump to invalidate all sessions | integer, default `1` |
| `POKER_ADMIN_PASSWORD_HASH` | scrypt hash of the admin PIN | separate from group password |
| `POKER_ADMIN_SESSION_SECRET` | HMAC key for admin cookies | ≥32 random bytes |
| `RESEND_API_KEY` | Resend sender key | optional: unset degrades to retryable failures |
| `RESEND_WEBHOOK_SECRET` | base64 ed25519 public key for webhook verification | from Resend dashboard |
| `POKER_EMAIL_FROM` | sender address, e.g. `Poker Ledger <poker@amitkonda.com>` | must be verified in Resend |
| `PUBLIC_APP_ORIGIN` | canonical origin used for receipt links | `https://amitkonda.com` in prod |

## Password rotation

1. Generate a new hash: `node scripts/hash-password.mjs`
2. Set the new `POKER_PASSWORD_HASH` **and** bump `POKER_AUTH_VERSION` (e.g. `2`) — this
   invalidates every outstanding cookie immediately, which is the right move after
   suspected password sharing.
3. Redeploy. Old sessions' data is unaffected; only logins change.

## Admin unlock

Group password unlocks the shared gate. The admin PIN (`POKER_ADMIN_PASSWORD_HASH`)
is a separate secret entered from the admin link on the gate or dashboard; the
admin cookie lasts 4 hours. Admin routes require **both** cookies server-side.

## Approvals

Visitors request access from the public gate (name/email/note). Amit opens
Admin → Requests and approves or rejects. Approval creates the member and sends
an approval email; **the shared password is never sent by email** — Amit shares
it separately. Amit can also add members directly (Admin → Members), with an
optional welcome email.

## Disputes

Every participant gets a receipt email containing a high-entropy link
(`/poker?token=...`). The DB stores only the SHA-256 hash of the token (30-day
expiry). Opening the link shows the receipt; with the group password (or an
existing session) the recipient can file a dispute. A dispute flags the session
("Included pending review") **without** changing balances until Amit resolves
(optionally with corrected amounts, which re-issues tokens and sends updated
receipts) or dismisses it. Never share the raw token; it grants receipt view +
dispute for that one session/member until used, revoked, or expired.

## Email reliability

Sessions (and their receipt rows) are committed to Postgres *before* any email
is attempted — email failure never rolls back a session. The outbox
(`email_deliveries`) is idempotent per (event, entity, version, recipient), so
retries never duplicate. If receipts are pending, the UI says so; an admin can
retry from Admin → (email failures) or via
`POST /api/poker/admin/email-deliveries/:id/retry`. Resend webhooks
(`POST /api/poker/webhooks/resend`, svix/ed25519-verified) update delivery
status; invalid signatures are rejected (401).

## Migrations

```sh
npm run db:generate   # after changing server/db/schema.ts — review the SQL!
npm run db:migrate    # applies pending migrations to DATABASE_URL
```

Migrations are committed and reviewed; **never edit an applied migration**.

## Backup

Neon console: Database → Backups (point-in-time restore) is the primary path.
For a manual dump:

```sh
pg_dump "$DATABASE_URL" --no-owner --no-privileges -Fc -f poker-$(date +%F).dump
```

## Deploy

Push to `main` — Vercel auto-deploys the linked project (static site + the
catch-all function). Set Preview and Production environment values in the Vercel
dashboard (Project → Settings → Environment Variables); **never commit `.env`**.
After each deploy, verify: (1) homepage + rails + `favicon.svg`; (2) `/poker`
gate; (3) group login + admin unlock; (4) a test session lands in the ledger.

## Rollback

Vercel → Deployments → previous deployment → Redeploy. Note: DB migrations are
forward-only — if a migration must be undone, restore from a backup taken before
it ran (see Backup).

## Testing

```sh
npm test          # vitest: unit (money/hash/signatures) + API integration (80 tests, local poker_test)
npm run e2e       # Playwright critical flows (homepage untouched, anonymous privacy,
                  # request→approve, subset session + receipts, token dispute + resolve,
                  # direct add, void)
```

The e2e suite boots the real dev server with the test environment; make sure
port 8788 is free (`lsof -ti :8788 | xargs kill`) so the config-managed server
starts with the right env.

## Security notes

- Every private route validates the signed cookie server-side; the client only hides buttons.
- `Cache-Control: no-store` on all `/poker` and `/api/poker` responses; CSP with
  `frame-ancestors 'none'`, `nosniff`, no-referrer token pages.
- Origin/CSRF checks on all mutations; rate limits keyed by hashed IP for
  login, admin unlock, join requests, tokens, and disputes.
- Passwords are scrypt-hashed; cookies are HMAC-signed with per-purpose secrets;
  dispute tokens are 256-bit random, stored only as SHA-256 hashes.
- Audit events (redacted before/after JSON) track member/request/session/
  dispute/email administrative actions. No passwords, raw tokens, or email
  bodies are ever logged.

## Out of scope

Individual accounts (Better Auth), Cloudflare, multiple groups, payment
settlement, buy-ins/chips analytics, public leaderboards, chat.

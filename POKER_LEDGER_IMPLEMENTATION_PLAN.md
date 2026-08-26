# Poker Ledger Tracker — Revised Implementation Plan

## 1. Goal

Add a private ledger at `https://amitkonda.com/poker` while preserving the current homepage and its books/films feed workflow.

Required features:

1. Add a poker session with any subset of group members and each participant's net result.
2. View the running all-time ledger.
3. Protect all private data with one shared group password.
4. Let Amit directly add members with names/emails.
5. Let outsiders request access, subject to Amit's approval.
6. Email every included participant a receipt; no approval is required.
7. Let a receipt recipient dispute the session.

This plan intentionally avoids individual accounts and Better Auth.

## 2. Product decisions

### Shared-password model

- Everyone uses one group password.
- Store only a slow hash of the password in Vercel environment variables.
- Successful login creates a signed `HttpOnly`, `Secure`, `SameSite=Lax` cookie lasting about 30 days.
- Anonymous visitors see only a generic password/request-access screen. No names, emails, balances, sessions, or counts may be included in public HTML/API responses.
- Amit uses a separate admin password/PIN after entering the group password. The admin cookie should last 1–4 hours.
- Neither password is sent by email. Amit shares the group password separately with approved friends.
- Add `auth_version` to cookies so rotating a version value invalidates all sessions.

This is appropriate for a small trusted group. The accepted limitation is that a person with the shared password can share it or select another person's name.

### Lightweight identity

- After unlocking the group, the visitor selects their name from active members.
- Store that member ID inside a signed cookie and allow changing it later.
- Record it as `recorded_by_member_id` on new sessions.
- Label this “Recorded by,” not “verified creator,” because shared-password identity is not strong authentication.
- Email dispute tokens identify the intended recipient more reliably than the selected browser identity.

### Ledger rules

- Store money as integer cents, never floating-point dollars.
- Positive means won; negative means lost.
- Each session includes at least two active members, with no duplicates.
- Participant results must sum to exactly `0` cents.
- Not every group member participates in every session.
- Sessions count immediately; receipt emails are informational.
- A dispute flags a session but does not remove it from balances.
- Only Amit can edit, resolve, or void sessions in v1.
- Never hard-delete financial records; use `voided` status and audit changes.

The ledger shows name, all-time result, sessions played, last-played date, and a current-viewer marker. Sort net result descending, then name. Include a visible total that must always be `$0.00`. Disputed sessions remain included with an “Included pending review” label; voided sessions are excluded.

## 3. Architecture

Keep the existing Vercel hosting. Do not migrate to Cloudflare.

### Stack

- **Hosting:** existing Vercel project/custom domain
- **Homepage:** existing static files unchanged
- **Poker UI:** static HTML/CSS/TypeScript or lightweight React only for `/poker`
- **Backend:** one catch-all Node.js Vercel Function at `/api/poker/*`
- **Database:** Neon Postgres attached through Vercel Marketplace
- **Schema/migrations:** Drizzle ORM + Drizzle Kit
- **Email:** Resend using a verified address such as `poker@amitkonda.com`
- **Validation:** Zod
- **Tests:** Vitest plus Playwright for critical flows

Neon is the default recommendation because it provides relational transactions and integrates with the existing Vercel project. Prisma Postgres or Turso is acceptable if already connected, but use one database only and document the deviation.

Use a single catch-all handler such as `api/poker/[...route].ts` with a small router so authentication, rate limits, errors, and database access stay centralized.

### Routing

- `/` keeps serving the current homepage.
- `/poker` and `/poker/*` serve the poker shell.
- `/api/poker/*` invokes the server function.
- `/data/*`, CSS, favicon, and current image paths remain valid.

The poker shell can be public but must contain no private data or secrets. It loads private content only after the API validates the signed password cookie.

Before scaffolding, inspect the existing linked Vercel project. If production uses a framework/configuration not committed here, reconcile that first rather than creating a conflicting app.

## 4. Suggested files

```text
/
  index.html                       # preserve
  style.css                        # preserve
  data/                            # preserve
  scripts/fetch-feeds.mjs          # preserve
  poker/
    index.html
    poker.css
    poker.ts
  api/poker/[...route].ts          # one Vercel Function
  server/
    router.ts
    auth.ts                        # password verification/cookies
    env.ts
    db/{client,schema,queries}.ts
    domain/{money,sessions,tokens}.ts
    email/{send,templates}.ts
  migrations/
  tests/
  vercel.json
  package.json
  tsconfig.json
  .env.example
```

## 5. Environment variables

Use separate Preview and Production values:

```text
DATABASE_URL=
POKER_PASSWORD_HASH=
POKER_SESSION_SECRET=
POKER_AUTH_VERSION=1
POKER_ADMIN_PASSWORD_HASH=
POKER_ADMIN_SESSION_SECRET=
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=
POKER_EMAIL_FROM=Poker Ledger <poker@amitkonda.com>
PUBLIC_APP_ORIGIN=https://amitkonda.com
```

- Generate hashes locally using Node `crypto.scrypt` or Argon2id.
- Signing secrets should contain at least 32 random bytes.
- Validate required server variables at startup and fail closed.
- Commit placeholders only; never expose secrets with `VITE_`/`NEXT_PUBLIC_` prefixes.

## 6. Authentication behavior

### Group login

`POST /api/poker/auth/login`

1. Accept password.
2. Rate-limit by hashed IP plus a global rolling threshold.
3. Verify the slow hash with constant-time comparison.
4. Issue a signed cookie containing version, selected member ID if any, issued time, and expiry.
5. Return no password-derived data.

`POST /api/poker/auth/logout` clears group and admin cookies. `POST /api/poker/viewer` changes the selected member in a newly signed cookie.

### Admin unlock

`POST /api/poker/admin/unlock` requires a valid group cookie, verifies the separate admin hash, and issues a short-lived admin cookie. Every admin route validates both cookies server-side. `POST /api/poker/admin/lock` clears only admin authorization.

Changing `POKER_AUTH_VERSION` and redeploying invalidates existing cookies after suspected password sharing.

## 7. Data model

Use UUIDs and UTC timestamps. Normalize emails to lowercase/trimmed form.

### `members`

- `id` UUID primary key
- `display_name` text, 1–80 characters
- `email_normalized` text unique
- `status`: `active` or `inactive`
- `created_at`, `updated_at`

### `join_requests`

- `id`, `display_name`, `email_normalized`, optional `note`
- `status`: `pending`, `approved`, or `rejected`
- `requested_at`, `reviewed_at`
- optional hashed request IP; never retain raw IP
- partial unique index allowing only one pending request per email

### `poker_sessions`

- `id`
- `played_at`, optional `title` and `notes`
- nullable `recorded_by_member_id`
- `status`: `active`, `disputed`, `resolved`, `voided`
- integer `version`, starting at 1
- unique `request_key` to prevent double submission
- created/updated/voided timestamps

### `session_results`

- `id`, `session_id`, `member_id`
- `amount_cents` as Postgres `bigint`, non-zero and constrained to a safe product limit
- unique `(session_id, member_id)`

### `dispute_tokens`

- `id`, `session_id`, `member_id`
- unique SHA-256 `token_hash`; never store raw token
- `expires_at` (suggest 30 days), `used_at`, `revoked_at`, `created_at`

### `disputes`

- `id`, `session_id`, `member_id` derived from the receipt token
- required `reason`, max 1,000 characters
- `status`: `open`, `resolved`, `dismissed`
- optional `resolution_note`, created/resolved timestamps
- only one open dispute per member/session

### `email_deliveries`

Track event type, entity/version, recipient, provider ID, status, attempts, safe error code, and timestamps. Add uniqueness for each intended receipt/version/recipient.

### `audit_events`

Track actor label/member hint, action, entity type/ID, redacted before/after JSON, and timestamp. Never store passwords, cookies, or raw tokens.

Indexes should support results by member/session, sessions by status/date, pending requests, open disputes, and failed email deliveries.

## 8. Authorization matrix

| Action | Anonymous | Group unlocked | Admin unlocked |
|---|---:|---:|---:|
| Generic login/request form | Yes | Yes | Yes |
| Submit join request | Yes | Yes | Yes |
| View members/ledger/sessions | No | Yes | Yes |
| Add session/change viewer | No | Yes | Yes |
| Use valid email dispute token | Password + token | Yes | Yes |
| Add/deactivate member | No | No | Yes |
| Approve/reject request | No | No | Yes |
| Edit/void session | No | No | Yes |
| Resolve dispute/retry email | No | No | Yes |

Server handlers enforce this matrix; hidden buttons are not authorization.

## 9. API surface

Public/auth:

- `POST /api/poker/auth/login`
- `POST /api/poker/auth/logout`
- `GET /api/poker/auth/status`
- `POST /api/poker/join-requests`

Group-protected:

- `GET /api/poker/members`
- `POST /api/poker/viewer`
- `GET /api/poker/ledger`
- `GET /api/poker/sessions?cursor=...`
- `POST /api/poker/sessions`
- `GET /api/poker/sessions/:id`
- `POST /api/poker/disputes/verify-token`
- `POST /api/poker/disputes`

Admin-protected:

- `POST /api/poker/admin/unlock`
- `POST /api/poker/admin/lock`
- `GET /api/poker/admin/join-requests`
- `POST /api/poker/admin/join-requests/:id/approve`
- `POST /api/poker/admin/join-requests/:id/reject`
- `POST /api/poker/admin/members`
- `PATCH /api/poker/admin/members/:id`
- `PATCH /api/poker/admin/sessions/:id`
- `POST /api/poker/admin/sessions/:id/void`
- `GET /api/poker/admin/disputes`
- `POST /api/poker/admin/disputes/:id/resolve`
- `POST /api/poker/admin/email-deliveries/:id/retry`

Provider:

- `POST /api/poker/webhooks/resend`, verifying the Resend signature before processing

Return errors as `{ error: { code, message, fieldErrors? } }`; never expose stack traces, SQL messages, secrets, or member existence publicly.

## 10. Key workflows

### Request access

1. Visitor submits name, email, optional note from the generic gate.
2. Server validates/rate-limits and returns a generic success message.
3. Amit unlocks admin mode and approves/rejects.
4. Approval creates an active member and emails “Approved—contact Amit for the group password.”
5. Amit shares the password separately.

### Direct member addition

1. Amit enters name/email in Admin → Members.
2. Server rejects duplicates and creates the member.
3. Send a welcome email without the shared password.

### Add session

1. Member enters group password and selects their name.
2. They enter date/time, optional title/notes, and only participating members.
3. Each row has a signed dollar amount; UI shows “Remaining to balance: $X.XX.”
4. Disable submit until it reaches `$0.00`, but revalidate server-side.
5. Client sends a unique request key.
6. Server validates active/unique members, cents, safe limits, and exact zero sum.
7. In one database transaction insert session, results, audit event, per-recipient dispute tokens, and email-outbox rows.
8. Commit before sending email, then redirect to detail with delivery status.

### Receipt/dispute

- Receipt shows date/title, recorded-by name, full results, recipient result, `$0.00` total, and “View or dispute.”
- Link contains a high-entropy token while the database stores its hash.
- If group cookie is missing, require the shared password then return to the link.
- Verify token, expiry, revocation, and member before showing details.
- Submission consumes the token, opens a dispute, and marks the session disputed.
- Balances stay unchanged until Amit dismisses, edits, or voids it.
- Send resolution/correction receipts to affected participants.

### Corrections

- Admin edits include the loaded version; return `409 Conflict` if stale.
- Preserve before/after audit data and increment version.
- Revoke old dispute tokens, create new tokens, and send corrected receipts.
- Voiding excludes the session from ledger totals without deleting it.

## 11. Email reliability

- Commit session/outbox data before calling Resend.
- Use idempotency keys like `session-receipt/{sessionId}/{version}/{memberId}`.
- Email failure never rolls back the session.
- Show “Session saved; some receipts pending” when needed.
- Admin can retry without duplicating messages.
- Verify webhook signatures and track delivered/bounced/failed status.
- Build links from configured `PUBLIC_APP_ORIGIN`, not the request host.
- Escape all user-entered text in HTML and provide plain-text versions.

## 12. Visual direction

Minimal, warm, and lightly colorful—no neon casino styling.

- Warm off-white background `#F7F5F0`
- White cards
- Charcoal text `#17211B`
- Felt green accent `#1F6B4F`
- Muted gold secondary `#C3913F`
- Positive green `#18794E`; negative brick `#B5473C`
- Border `#DDD8CE`
- Serif headings can echo the existing site; forms/tables use a system sans-serif
- Tabular numerals for money, 10–14px radius, minimal shadow

Dashboard: compact header, selected viewer, Add Session button, ledger, recent sessions, and admin badges for requests/disputes. Mobile is single-column with 44px controls and stacked participant rows.

Include accessible labels/focus, AA contrast, loading/empty/error/expired-token/partial-email-failure states, and never communicate win/loss or status by color alone.

## 13. Security checklist

- Validate group/admin cookies on every private server route.
- Use `Cache-Control: no-store` on private HTML/API responses.
- Add CSP, production HSTS, `frame-ancestors 'none'`, `nosniff`, and no-referrer token pages.
- Validate Origin/CSRF on mutations.
- Rate-limit password, admin, join, token, and dispute endpoints.
- Use generic public responses to prevent enumeration.
- Enforce body/text limits and Zod allowlists.
- Recompute all money rules server-side.
- Parameterize all database queries and escape HTML.
- Never log passwords, cookies, raw tokens, email bodies, or sensitive request payloads.
- Keep secrets only in Vercel environment variables.
- Audit member/request/session/dispute/email administrative actions.

## 14. Implementation phases

### Phase 0 — Verify Vercel

1. Inspect the linked Vercel project and confirm `amitkonda.com` points here.
2. Record current build/output settings and baseline homepage/feed behavior.
3. Do not change DNS or create Cloudflare infrastructure.

### Phase 1 — Foundation

1. Add tooling without rewriting the homepage.
2. Add `/poker` shell and catch-all API.
3. Connect a Preview database and add migrations.
4. Confirm the homepage is unchanged in Vercel Preview.

### Phase 2 — Password gates

1. Add password-hash generation utility.
2. Implement login/logout/status, cookies, viewer selection, and admin unlock.
3. Prove private APIs fail closed.

### Phase 3 — Members

1. Implement public join request with rate limits.
2. Add admin request queue and approval/rejection.
3. Add direct member create/edit/deactivate and approval/welcome email.

### Phase 4 — Ledger

1. Build money tests/parsing first.
2. Add transactional/idempotent session creation.
3. Build participant form, live remainder, ledger, history, and detail.

### Phase 5 — Receipts/disputes

1. Add receipt templates/outbox/idempotent delivery.
2. Add per-recipient hashed tokens and password-gated dispute flow.
3. Add admin resolve/edit/void, audit history, corrections, webhook, and retries.

### Phase 6 — Rollout

1. Complete responsive/accessibility/security work and tests.
2. Validate with fake data on Vercel Preview.
3. Attach separate Production database/secrets and migrate.
4. Promote through existing Vercel deployment; no DNS migration is expected.

## 15. Tests

Unit:

- Correct dollar-to-cent parsing; reject malformed, excessive-decimal, and unsafe values.
- Accept `+10000, -6000, -4000`; reject a one-cent imbalance.
- Reject duplicate members and fewer than two participants.
- Ledger includes disputed/excludes voided sessions and always sums to zero.
- Password/token hashing, cookie signature/expiry/version work.

API/integration:

- Anonymous users cannot read private data; group cookie cannot use admin routes.
- Bad passwords are generic and rate-limited.
- Client cannot spoof status/creator/admin fields.
- Duplicate request keys create one session and one receipt per recipient.
- Server rejects non-zero-sum input even if UI is bypassed.
- Concurrent edits produce one success and one `409`.
- Invalid/expired/revoked/used tokens fail.
- Email failure leaves the session committed and retryable.
- Invalid webhook signatures fail; private responses are `no-store`.

End to end:

1. Request → admin approval → member appears.
2. Amit directly adds a friend.
3. Friend unlocks, selects name, creates a three-player subset session.
4. Only participants get receipts; ledger totals `$0.00`.
5. Recipient unlocks from email, disputes, and Amit resolves.
6. Correction updates ledger, audit, tokens, and receipts.
7. Password-version rotation invalidates an old cookie.
8. Anonymous visitor learns no private group data.
9. Homepage, rails, favicon, feeds, and domain still work.

## 16. Definition of done

- `/poker` is live in the existing Vercel project.
- Shared password protects every private page/API; separate admin secret protects administration.
- Amit can add members and approve/reject requests.
- Members can select themselves and add zero-sum sessions with any subset.
- Ledger/history persist and calculate correctly.
- Participants receive receipts without approval and can dispute after group unlock.
- Amit can resolve/edit/void with audit history.
- Email failures are retryable without duplicates.
- Existing homepage/feed behavior is unchanged.
- Preview/Production have separate databases and secrets.
- No password, credential, API key, raw token, or private data is committed/client-exposed.
- Operations README covers password rotation, admin unlock, approvals, disputes, email retry, migrations, backup, deploy, and rollback.

## 17. Out of scope

- Individual accounts or Better Auth
- Cloudflare migration
- Multiple groups
- Payment transfers/settlement optimization
- Buy-ins, rebuys, chips, or per-hand analytics
- Public leaderboards/share links
- Voting, chat, SMS/push, or native apps

## 18. Handoff instructions

- Read this plan and inspect the existing Vercel configuration first.
- Preserve the homepage and scheduled feeds.
- Use the existing Vercel project; do not migrate to Cloudflare.
- Use one group password plus one separate admin secret; do not add account registration.
- Keep private state server-side and durable records in Postgres.
- Pin supported package versions, commit the lockfile and inspected migrations.
- Build vertical slices: gate → members → session/ledger → receipts/disputes → admin hardening.
- Stay on Vercel Preview until tests pass and production secrets are supplied.


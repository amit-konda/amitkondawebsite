/**
 * e2e helpers — UI contract + test-data seeding for the Poker Ledger.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HARNESS ISOLATION (how the suite stays deterministic)
 * ─────────────────────────────────────────────────────────────────────────
 * - The suite runs on its OWN port (playwright.config.ts: E2E_PORT, override
 *   with POKER_E2E_PORT, default 8790) — never the :8788 dev-server port, so
 *   `npm run dev` and the suite coexist.
 * - The tests NEVER reuse a running dev server (webServer
 *   reuseExistingServer: false in playwright.config.ts). A stale process on
 *   the suite's port makes Playwright fail fast (port-in-use / probe
 *   timeout) instead of silently running against a server with the wrong
 *   env/DB/state — kill it (`lsof -ti :8790 | xargs kill`) and re-run.
 * - The suite refuses non-local databases: global-setup.ts throws before its
 *   destructive reset unless DATABASE_URL points at localhost/127.0.0.1/::1,
 *   and refuses the production amitkonda.com origin.
 * - All URLs in this suite are RELATIVE on purpose and resolve against the
 *   config baseURL — nothing here hardcodes a port.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UI CONTRACT (what the /poker shell must provide for the suite to pass)
 * ─────────────────────────────────────────────────────────────────────────
 * The tests drive the REAL UI. They prefer accessible roles/labels and only
 * fall back to optional `data-testid` hooks. The required hooks:
 *
 * Gate (anonymous /poker page):
 *   - password input: <input type="password">, ideally labeled "Password"
 *   - unlock button: accessible name containing "Unlock"
 *   - request-access toggle: link/button named "Request access"
 *   - request form: inputs labeled "Name" and "Email" (optional "Note"),
 *     submit named like "Request access"; success text after submit
 *
 * Dashboard (group unlocked):
 *   - "Add Session" button whose name contains "Add Session"
 *   - viewer selector: <select> labeled like "Viewer"/"Your name", or the
 *     first <select> on the page; options = active member display names
 *   - optional admin toggle: button/link named "Admin"
 *   - recent sessions: each row is a link/button whose accessible name
 *     includes the session title
 *
 * Admin surface (group + admin unlocked):
 *   - heading "Admin" once unlocked
 *   - panels/sections named "Requests", "Members", "Disputes"
 *     (nav buttons/links or headings)
 *
 * Add-session form:
 *   - one checkbox per member, accessible name = display name (exact)
 *   - one amount input per checked row, aria-label/label containing the
 *     member name and "amount" (e.g. "Maya amount") — fallback
 *     data-testid="amount-<lowercase-member-name>"
 *   - remainder indicator: an element containing the text
 *     "Remaining to balance: $X.XX" (fallback data-testid="remainder")
 *   - submit/save session button (name containing "Save" or "Session")
 *     DISABLED until the remainder reads $0.00
 *
 * Session detail:
 *   - participant names + amounts + a "$0.00" total
 *   - status text ("Voided", "Disputed", "Resolved") when applicable
 *   - "Void session" button for admins
 *
 * Receipt view (/poker/?token=...):
 *   - results for all participants, "$0.00" total, the token recipient's
 *     row marked with data-testid="receipt-self" (optional but asserted if
 *     present)
 *   - dispute form: textarea labeled like "Reason"/"What's wrong",
 *     submit named "Submit dispute"/"Dispute"; generic success text after
 *
 * Admin dispute review:
 *   - dispute rows in the Disputes panel; a "Resolve" (or "Review") button
 *   - correction form: per-member amount inputs (same naming as add-session)
 *     + a resolve/submit button
 *
 * Generic success/error texts are matched loosely (regex), and login forms
 * accept either explicit labels or a lone <input type="password">.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { expect } from "playwright/test";
import type { Locator, Page } from "playwright/test";
import { and, eq, ne } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { TestDb } from "../helpers/db.js";
import { hashToken } from "../../server/domain/tokens.js";
import {
  members,
  pokerSessions,
  sessionResults,
  disputeTokens,
  emailDeliveries
} from "../../server/db/schema.js";

export const GROUP_PASSWORD = "group-pass-test";
export const ADMIN_PASSWORD = "admin-pass-test";
// >= 20 chars: the server enforces a minimum token length for dispute links.
export const DISPUTE_TOKEN = "e2e-token-abcdefghijklmnopqrstuvwxyz";

// ---------------------------------------------------------------------------
// Locator helpers — try candidates in order, use the first that exists.
// This keeps the suite resilient to small markup differences while still
// failing loudly when an element is missing entirely.
// ---------------------------------------------------------------------------
async function pickFirst(candidates: Array<() => Locator>): Promise<Locator> {
  for (const make of candidates) {
    const loc = make();
    if ((await loc.count()) > 0) {
      // Labels can match hidden elements (e.g. the gate's admin PIN under a
      // collapsed form) — interaction requires a visible candidate.
      const visible = loc.filter({ visible: true });
      if ((await visible.count()) > 0) return visible.first();
    }
  }
  throw new Error(
    "e2e helper: none of the candidate locators matched. See the UI CONTRACT " +
      "comment in tests/e2e/helpers.ts."
  );
}

async function clickFirst(candidates: Array<() => Locator>): Promise<void> {
  await (await pickFirst(candidates)).click();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Auth helpers — drive the real gate/admin forms.
// ---------------------------------------------------------------------------

/**
 * Unlocks the shared-password gate. Assumes the gate (password field) is on
 * screen, which is true for anonymous visitors at /poker and for the token
 * receipt flow (receipt links require the group password when no cookie).
 */
export async function unlockGroupGate(page: Page, password: string): Promise<void> {
  const field = await pickFirst([
    () => page.getByLabel(/password/i),
    () => page.locator('input[type="password"]').first()
  ]);
  await field.fill(password);
  const button = await pickFirst([
    () => page.getByRole("button", { name: /^unlock$/i }),
    () => page.getByRole("button", { name: /unlock|sign in|log in|enter/i }).first()
  ]);
  await button.click();
  // The gate must go away (login round-trip completes).
  await expect(field).toBeHidden({ timeout: 10_000 });
}

/** Full group login: unlock the gate and confirm the dashboard is showing. */
export async function loginAsGroup(page: Page, password: string = GROUP_PASSWORD): Promise<void> {
  // Idempotent: if the group cookie is already set there is no gate to unlock.
  const gateField = page
    .locator('input[type="password"]')
    .filter({ visible: true })
    .first();
  if ((await gateField.count()) > 0) {
    await unlockGroupGate(page, password);
  }
  // Tab-agnostic: the default landing tab is "Ledger" (Overall), and the
  // Add-session button only lives under the "Poker" tab, so assert on the
  // always-visible tab nav rather than a button that may be on a hidden view.
  await expect(page.getByRole("button", { name: "Poker", exact: true })).toBeVisible({
    timeout: 10_000
  });
}

/**
 * Admin unlock from an already-unlocked group session: opens the Admin
 * surface (if it is behind a toggle), enters the admin PIN and asserts the
 * admin surface is live (Requests panel reachable).
 */
export async function unlockAdmin(page: Page, adminPassword: string = ADMIN_PASSWORD): Promise<void> {
  // Idempotent: admin badges are already visible when admin is unlocked.
  const already = page.getByRole("button", { name: /requests/i }).filter({ visible: true });
  if ((await already.count()) > 0) return;
  const adminHeading = page.getByRole("heading", { name: /^admin$/i });
  const adminToggle = await pickFirst([
    () => page.getByRole("button", { name: /admin sign-in|^admin$/i }),
    () => page.getByRole("link", { name: /admin sign-in|^admin$/i })
  ]);
  if ((await adminHeading.count()) === 0) {
    await adminToggle.click();
  }
  const pin = await pickFirst([
    () => page.getByLabel(/admin (pin|password)/i),
    () => page.locator('input[type="password"]').first()
  ]);
  await pin.fill(adminPassword);
  await clickFirst([
    () => page.getByRole("button", { name: /unlock admin|enter admin|unlock/i }),
    () => page.getByRole("button", { name: /unlock|enter|submit/i }).first()
  ]);
  // Admin surface is live when the Requests badge is visible (async round-trip).
  const live = page
    .getByRole("button", { name: /requests/i })
    .or(page.getByRole("heading", { name: /requests/i }))
    .or(page.getByRole("link", { name: /requests/i }));
  await expect(live.first()).toBeVisible({ timeout: 10_000 });
}

/** Navigate to an admin panel section ("Requests" | "Members" | "Disputes"). */
export async function openAdminPanel(page: Page, section: "Requests" | "Members" | "Disputes"): Promise<void> {
  // Badge buttons read e.g. "Requests 2" — anchor on the section word.
  const re = new RegExp(`^${section}(\\b|\\s|$|\\d)`, "i");
  const el = await pickFirst([
    () => page.getByRole("button", { name: re }),
    () => page.getByRole("link", { name: re }),
    () => page.getByRole("heading", { name: re })
  ]);
  await el.click();
}

/** Select the current viewer (lightweight identity) from the dashboard dropdown. */
export async function setViewer(page: Page, memberName: string): Promise<void> {
  const select = await pickFirst([
    () => page.getByLabel(/viewer|your name|select your name/i),
    () => page.locator("select").first()
  ]);
  await select.selectOption({ label: memberName });
}

/** Open the Add Session form and wait for the participant checkboxes. */
export async function openAddSession(page: Page): Promise<void> {
  // The Add-session button lives under the "Poker" tab, not the default
  // "Ledger" (Overall) tab — switch tabs first so the button is present.
  await page.getByRole("button", { name: "Poker", exact: true }).click();
  await page.getByRole("button", { name: /add (past )?session/i }).click();
  await expect(page.getByRole("checkbox").first()).toBeVisible({ timeout: 10_000 });
}

/** Check a participant in the add-session form (checkbox named by display name). */
export async function checkParticipant(page: Page, name: string): Promise<void> {
  await page.getByRole("checkbox", { name, exact: true }).check();
}

/** Enter a signed dollar amount ("100", "-60") for a participant row. */
export async function setParticipantAmount(page: Page, name: string, dollars: string): Promise<void> {
  const input = await pickFirst([
    () => page.getByLabel(new RegExp(`^amount for ${escapeRegExp(name)}`, "i")),
    () => page.getByLabel(new RegExp(`corrected amount for ${escapeRegExp(name)}`, "i")),
    () => page.getByLabel(new RegExp(`^${escapeRegExp(name)} (amount|result)`, "i")),
    () => page.getByTestId(`amount-${name.toLowerCase().replace(/\s+/g, "-")}`)
  ]);
  await input.fill(dollars);
}

/** Current "Remaining to balance: $X.XX" text, or "" if not rendered. */
export async function remainderText(page: Page): Promise<string> {
  const el = await pickFirst([
    () => page.getByTestId("remainder"),
    () => page.getByText(/remaining to balance/i)
  ]);
  return (await el.textContent()) ?? "";
}

/** Open a session's detail view from the dashboard's recent-sessions list. */
export async function openSessionDetail(page: Page, title: string): Promise<void> {
  await clickFirst([
    () => page.getByRole("link", { name: new RegExp(escapeRegExp(title), "i") }),
    () => page.getByRole("button", { name: new RegExp(escapeRegExp(title), "i") }),
    () => page.getByText(title, { exact: false }).first()
  ]);
}

/** Void the session shown on the detail page (UI uses a two-click confirm, no dialog). */
export async function voidSession(page: Page): Promise<void> {
  // The button's accessible name changes to "Click again to confirm void" once
  // armed, so anchor on its class (unique on the detail view) instead.
  const btn = page.locator("button.btn-danger").first();
  await expect(btn).toBeVisible({ timeout: 10_000 });
  await btn.click();
  await expect(btn).toContainText(/click again|confirm/i, { timeout: 5_000 });
  await btn.click();
}

// ---------------------------------------------------------------------------
// Seeding helpers — direct DB inserts. The global-setup reset runs ONCE per
// suite; tests use distinct fake emails so they never collide and the suite
// stays append-only (no per-test resets).
// ---------------------------------------------------------------------------

export async function seedMember(
  tdb: TestDb,
  name: string,
  email: string,
  status: "active" | "inactive" = "active"
): Promise<{ id: string; displayName: string; emailNormalized: string }> {
  const [row] = await tdb.db
    .insert(members)
    .values({ displayName: name, emailNormalized: email.toLowerCase().trim(), status })
    .returning({
      id: members.id,
      displayName: members.displayName,
      emailNormalized: members.emailNormalized
    });
  if (!row) throw new Error(`seedMember failed for ${email}`);
  return row;
}

export interface SeedParticipant {
  memberId: string;
  amountCents: number;
}

export async function seedSession(
  tdb: TestDb,
  opts: {
    participants: SeedParticipant[];
    recordedByMemberId?: string | null;
    title?: string | null;
    notes?: string | null;
    playedAt?: Date;
    status?: "active" | "disputed" | "resolved" | "voided";
    requestKey?: string;
  }
): Promise<string> {
  const {
    participants,
    recordedByMemberId = null,
    title = null,
    notes = null,
    playedAt = new Date(),
    status = "active",
    requestKey = `e2e-${randomUUID()}`
  } = opts;
  const sum = participants.reduce((s, p) => s + p.amountCents, 0);
  if (sum !== 0) throw new Error(`seedSession: participants must sum to 0 (got ${sum})`);
  const [session] = await tdb.db
    .insert(pokerSessions)
    .values({ playedAt, title, notes, recordedByMemberId, status, version: 1, requestKey })
    .returning({ id: pokerSessions.id });
  if (!session) throw new Error("seedSession failed");
  await tdb.db
    .insert(sessionResults)
    .values(
      participants.map((p) => ({
        sessionId: session.id,
        memberId: p.memberId,
        amountCents: p.amountCents
      }))
    );
  return session.id;
}

/**
 * Insert dispute tokens for a session. The FIRST member gets exactly
 * `baseToken` (e.g. "e2e-token-abc"); the rest get "-2", "-3", ... suffixes
 * so each token_hash stays unique.
 */
export async function seedDisputeTokens(
  tdb: TestDb,
  sessionId: string,
  memberIds: string[],
  baseToken: string = DISPUTE_TOKEN
): Promise<void> {
  await tdb.db.insert(disputeTokens).values(
    memberIds.map((memberId, i) => ({
      sessionId,
      memberId,
      tokenHash: hashToken(i === 0 ? baseToken : `${baseToken}-${i + 1}`),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000)
    }))
  );
}

/** Sum of ALL non-voided session results, in cents. Must always be 0. */
export async function ledgerTotalCents(tdb: TestDb): Promise<number> {
  const rows = await tdb.db
    .select({ amountCents: sessionResults.amountCents })
    .from(sessionResults)
    .innerJoin(pokerSessions, eq(sessionResults.sessionId, pokerSessions.id))
    .where(ne(pokerSessions.status, "voided"));
  return rows.reduce((s, r) => s + r.amountCents, 0);
}

/** Number of non-voided sessions a member participated in. */
export async function memberSessionsPlayed(tdb: TestDb, memberId: string): Promise<number> {
  const rows = await tdb.db
    .select({ id: pokerSessions.id })
    .from(sessionResults)
    .innerJoin(pokerSessions, eq(sessionResults.sessionId, pokerSessions.id))
    .where(and(eq(sessionResults.memberId, memberId), ne(pokerSessions.status, "voided")));
  return rows.length;
}

export interface EmailDeliveryRow {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string;
  version: number;
  recipientEmail: string;
  status: string;
}

/** All outbox rows for an entity (optionally filtered by eventType/recipient). */
export async function emailDeliveriesFor(
  tdb: TestDb,
  entityId: string,
  opts: { eventType?: string; recipientEmail?: string } = {}
): Promise<EmailDeliveryRow[]> {
  const where: SQL[] = [eq(emailDeliveries.entityId, entityId)];
  if (opts.eventType) where.push(eq(emailDeliveries.eventType, opts.eventType));
  if (opts.recipientEmail)
    where.push(eq(emailDeliveries.recipientEmail, opts.recipientEmail.toLowerCase()));
  const rows =
    where.length === 1
      ? await tdb.db.select().from(emailDeliveries).where(where[0]!)
      : await tdb.db.select().from(emailDeliveries).where(and(...where));
  return rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    entityType: r.entityType,
    entityId: r.entityId,
    version: r.version,
    recipientEmail: r.recipientEmail,
    status: r.status
  }));
}

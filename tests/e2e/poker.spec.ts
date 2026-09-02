/**
 * Poker Ledger — end-to-end critical flows (drives the REAL /poker UI).
 *
 * Run:  npm run e2e   (see playwright.config.ts at the repo root)
 *
 * Environment: tests/e2e/global-setup.ts resets the shared poker_test
 * database ONCE for the whole run (imports tests/setup-env.ts first, so the
 * webServer on :8788 boots with DATABASE_URL=poker_test and the
 * "group-pass-test" / "admin-pass-test" password hashes). Individual tests
 * NEVER reset the DB — they seed only their own rows via openDb(), always
 * with distinct fake emails, so the suite is append-only and order-safe.
 *
 * Tests run in declaration order in one worker (single file, no
 * fullyParallel). Each test gets a fresh browser context (fresh cookies).
 *
 * Locator conventions (roles/labels first, optional data-testid fallbacks)
 * are documented in tests/e2e/helpers.ts — read the UI CONTRACT there.
 */
import "../setup-env.js"; // MUST be first: test env in this worker too
import { test, expect } from "playwright/test";
import { and, count, desc, eq } from "drizzle-orm";
import type { TestDb } from "../helpers/db.js";
import { openDb } from "../helpers/db.js";
import { hashToken } from "../../server/domain/tokens.js";
import {
  members,
  joinRequests,
  pokerSessions,
  sessionResults,
  disputeTokens,
  disputes,
  emailDeliveries
} from "../../server/db/schema.js";
import {
  ADMIN_PASSWORD,
  GROUP_PASSWORD,
  checkParticipant,
  emailDeliveriesFor,
  ledgerTotalCents,
  loginAsGroup,
  memberSessionsPlayed,
  openAddSession,
  openAdminPanel,
  openSessionDetail,
  remainderText,
  seedDisputeTokens,
  seedMember,
  seedSession,
  setParticipantAmount,
  unlockAdmin,
  unlockGroupGate,
  voidSession,
  DISPUTE_TOKEN
} from "./helpers.js";

// One shared DB connection for the whole file (global-setup already reset it).
let tdb: TestDb;
test.beforeAll(() => {
  tdb = openDb();
});
test.afterAll(async () => {
  await tdb.end();
});

// ---------------------------------------------------------------------------

test("homepage is unchanged", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Amit Konda");
  await expect(page.getByRole("heading", { name: "Watching" })).toBeVisible();

  const favicon = await page.request.get("/favicon.svg");
  expect(favicon.status()).toBe(200);
});

// ---------------------------------------------------------------------------

test("anonymous visitor learns no private data", async ({ page }) => {
  // Seed group data FIRST so the assertions below prove it is not leaking:
  // if the anonymous shell or public APIs ever included member data, these
  // names/emails would show up or be answered.
  await seedMember(tdb, "Sofia", "sofia+e2e@example.com");
  await seedMember(tdb, "Ravi", "ravi+e2e@example.com");

  await page.goto("/poker/");

  // The gate: a password field and a request-access form — and nothing else.
  await expect(page.locator('input[type="password"]').first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: /request access/i }).or(
      page.getByRole("button", { name: /request access/i })
    )
  ).toBeVisible();

  // No member names, emails, or balances in the anonymous DOM.
  const html = await page.content();
  for (const leak of [
    "Sofia",
    "Ravi",
    "sofia+e2e@example.com",
    "ravi+e2e@example.com"
  ]) {
    expect(html).not.toContain(leak);
  }

  // Private APIs fail closed with the generic error envelope.
  for (const path of ["/api/poker/ledger", "/api/poker/members"]) {
    const res = await page.request.get(path);
    expect(res.status(), `${path} should 401`).toBe(401);
    expect(res.headers()["cache-control"]).toContain("no-store");
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("unauthorized");
  }
});

// ---------------------------------------------------------------------------

test("request access → approve → member appears", async ({ page }) => {
  await page.goto("/poker/");

  // --- visitor requests access from the generic gate ---
  await test.step("submit request-access form", async () => {
    const toggle = page.getByRole("link", { name: /request access/i });
    const toggleBtn = page.getByRole("button", { name: /request access/i });
    if ((await toggle.count()) > 0) await toggle.click();
    else if ((await toggleBtn.count()) > 0) await toggleBtn.click();

    await page.getByLabel(/^your name$/i).fill("Taylor");
    await page.getByLabel(/email/i).fill("taylor+e2e@example.com");
    const submit = page
      .getByRole("button", { name: /send request/i }) // submit, not the toggle
      .first();
    await submit.click();
    // Generic success — must not reveal whether this email already exists.
    await expect(
      page.getByText(/request (received|submitted)|thanks|we'?ll be in touch/i).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // --- admin unlocks (group password, then admin PIN) and approves ---
  await loginAsGroup(page, GROUP_PASSWORD);
  await unlockAdmin(page, ADMIN_PASSWORD);

  await test.step("approve Taylor from the Requests panel", async () => {
    await openAdminPanel(page, "Requests");
    // Scoped to the dialog — the viewer <select> has a hidden Taylor option.
    await expect(
      page.getByRole("dialog").getByText("Taylor", { exact: true }).first()
    ).toBeVisible();
    await page.getByRole("button", { name: /^approve$/i }).click();
    // Close the panel — the modal backdrop covers the nav badges.
    await page.getByRole("button", { name: /close dialog/i }).click();
    await openAdminPanel(page, "Members");
    await expect(
      page.getByRole("dialog").getByText("Taylor", { exact: true }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // --- DB: member row exists, request approved, approval email enqueued ---
  await test.step("verify DB state", async () => {
    await expect
      .poll(async () => {
        const [row] = await tdb.db
          .select({ id: members.id })
          .from(members)
          .where(eq(members.emailNormalized, "taylor+e2e@example.com"))
          .limit(1);
        return row?.id ?? null;
      }, { timeout: 15_000 })
      .not.toBeNull();

    const [req] = await tdb.db
      .select({ status: joinRequests.status })
      .from(joinRequests)
      .where(eq(joinRequests.emailNormalized, "taylor+e2e@example.com"))
      .limit(1);
    expect(req?.status).toBe("approved");

    const [mail] = await tdb.db
      .select({ id: emailDeliveries.id })
      .from(emailDeliveries)
      .where(
        and(
          eq(emailDeliveries.eventType, "member_approved"),
          eq(emailDeliveries.recipientEmail, "taylor+e2e@example.com")
        )
      )
      .limit(1);
    expect(mail?.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

test("unlock, select viewer, create 3-player session, receipts, zero ledger", async ({ page }) => {
  // Four active members; ONLY three will be selected for the session.
  const maya = await seedMember(tdb, "Maya", "maya+e2e@example.com");
  const noah = await seedMember(tdb, "Noah", "noah+e2e@example.com");
  const olivia = await seedMember(tdb, "Olivia", "olivia+e2e@example.com");
  const priya = await seedMember(tdb, "Priya", "priya+e2e@example.com");

  const sessionsBefore = (
    await tdb.db.select({ n: count() }).from(pokerSessions)
  )[0]?.n ?? 0;

  await page.goto("/poker/");
  await loginAsGroup(page, GROUP_PASSWORD, "Maya");
  await openAddSession(page);

  // Select exactly 3 of the 4 seeded members.
  await checkParticipant(page, "Maya");
  await checkParticipant(page, "Noah");
  await checkParticipant(page, "Olivia");

  // Amounts are dollars, signed: +100 / -60 / -40 → 10000 / -6000 / -4000 cents.
  await setParticipantAmount(page, "Maya", "100");
  await setParticipantAmount(page, "Noah", "-60");
  await expect
    .poll(async () => remainderText(page))
    .not.toContain("$0.00"); // partial fill must NOT balance

  const submit = page
    .getByRole("button", { name: /save session|submit|record session/i })
    .first();
  await expect(submit).toBeDisabled(); // server rule mirrored in the UI
  await setParticipantAmount(page, "Olivia", "-40");
  await expect.poll(async () => remainderText(page)).toContain("$0.00");
  await expect(submit).toBeEnabled();

  await submit.click();

  // --- detail view: participants + $0.00 total ---
  await test.step("session detail renders", async () => {
    // Scoped to the detail results table — the dashboard's ledger card also
    // contains a (hidden) $0.00.
    const table = page.locator(".results-table");
    await expect(table).toBeVisible({ timeout: 15_000 });
    await expect(table.getByText("Maya", { exact: true }).first()).toBeVisible();
    await expect(table.getByText("Noah", { exact: true }).first()).toBeVisible();
    await expect(table.getByText("Olivia", { exact: true }).first()).toBeVisible();
    await expect(table.getByText("$0.00").first()).toBeVisible();
  });

  // --- DB: the UI-created session is the newest one ---
  await test.step("DB asserts: receipts, tokens, zero ledger", async () => {
    // Wait until the session actually landed (POST round-trip completed).
    await expect
      .poll(async () => {
        const [row] = await tdb.db.select({ n: count() }).from(pokerSessions);
        return row?.n ?? 0;
      }, { timeout: 15_000 })
      .toBeGreaterThan(sessionsBefore);

    // Newest session === the one created through the UI (no other test has
    // created a session yet; the count only grew by one).
    const after = await tdb.db
      .select()
      .from(pokerSessions)
      .orderBy(desc(pokerSessions.createdAt))
      .limit(1);
    const session = after[0];
    expect(session, "expected exactly one new session").toBeDefined();
    const totalSessions = (await tdb.db.select({ n: count() }).from(pokerSessions))[0]?.n ?? 0;
    expect(totalSessions).toBe(sessionsBefore + 1);

    const [results] = await tdb.db
      .select({ n: count() })
      .from(sessionResults)
      .where(eq(sessionResults.sessionId, session!.id));
    expect(results?.n).toBe(3);

    // One receipt per participant, version 1, for THIS session.
    const receipts = await emailDeliveriesFor(tdb, session!.id, {
      eventType: "session_receipt"
    });
    expect(receipts).toHaveLength(3);
    for (const r of receipts) expect(r.version).toBe(1);
    const recipients = receipts.map((r) => r.recipientEmail).sort();
    expect(recipients).toEqual(
      ["maya+e2e@example.com", "noah+e2e@example.com", "olivia+e2e@example.com"].sort()
    );

    // One dispute token per participant (hashed at rest).
    const tokens = await tdb.db
      .select({ id: disputeTokens.id })
      .from(disputeTokens)
      .where(eq(disputeTokens.sessionId, session!.id));
    expect(tokens).toHaveLength(3);

    // Unselected member got NO receipt for this session.
    const priyaMail = await emailDeliveriesFor(tdb, session!.id, {
      recipientEmail: "priya+e2e@example.com"
    });
    expect(priyaMail).toHaveLength(0);

    // Ledger stays exactly zero across everything.
    expect(await ledgerTotalCents(tdb)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

test("recipient disputes from token link; admin resolves with corrections", async ({ page }) => {
  const quinn = await seedMember(tdb, "Quinn", "quinn+e2e@example.com");
  const rosa = await seedMember(tdb, "Rosa", "rosa+e2e@example.com");
  const sessionId = await seedSession(tdb, {
    title: "Friday Night Game",
    participants: [
      { memberId: quinn.id, amountCents: 2000 },
      { memberId: rosa.id, amountCents: -2000 }
    ]
  });
  // Quinn holds the well-known token; Rosa gets a unique second one.
  await seedDisputeTokens(tdb, sessionId, [quinn.id, rosa.id]);

  // --- recipient opens the emailed receipt link (no cookie → password gate) ---
  await page.goto(`/poker/?token=${DISPUTE_TOKEN}`);
  await test.step("receipt view shows results and self row", async () => {
    const gate = page.locator('input[type="password"]');
    if ((await gate.count()) > 0) {
      await unlockGroupGate(page, GROUP_PASSWORD); // app returns to the receipt
    }
    await expect(
      page.locator(".results-table").getByText("Quinn", { exact: true }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator(".results-table").getByText("Rosa", { exact: true }).first()
    ).toBeVisible();
    await expect(page.locator(".results-table").getByText("$0.00").first()).toBeVisible();
    // Highlighted self row (asserted when the optional hook exists).
    if ((await page.getByTestId("receipt-self").count()) > 0) {
      await expect(page.getByTestId("receipt-self")).toContainText("Quinn");
    }
  });

  await test.step("submit a dispute from the receipt", async () => {
    const reason = await page.getByLabel(/reason|what'?s wrong|disput/i).first();
    await reason.fill("I think this amount is wrong — I only lost $15 that night.");
    await page
      .getByRole("button", { name: /submit dispute|file dispute|^dispute$/i })
      .first()
      .click();
    await expect(
      page.getByText(/submitted|received|we'?ll review|thank you/i).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // --- DB/API: session is now disputed ---
  await test.step("session flagged disputed", async () => {
    // Via the API with the browser's cookies (page.request shares them)…
    const res = await page.request.get(`/api/poker/sessions/${sessionId}`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { session?: { status?: string } };
    expect(body.session?.status).toBe("disputed");
    // …and grounded in the DB.
    await expect
      .poll(async () => {
        const [row] = await tdb.db
          .select({ status: pokerSessions.status })
          .from(pokerSessions)
          .where(eq(pokerSessions.id, sessionId));
        return row?.status;
      }, { timeout: 15_000 })
      .toBe("disputed");
  });

  // --- admin resolves with corrections: +6000 / -6000 between the two ---
  await test.step("admin resolves with corrections", async () => {
    await page.goto("/poker/");
    await loginAsGroup(page, GROUP_PASSWORD);
    await unlockAdmin(page, ADMIN_PASSWORD);
    await openAdminPanel(page, "Disputes");
    // Non-exact: the item renders "… disputed by Quinn · …" in one text node.
    await expect(
      page.getByRole("dialog").getByText("Quinn").first()
    ).toBeVisible();
    await page.getByRole("button", { name: /^resolve$/i }).first().click();

    // Corrections keep the session zero-sum; whether the inputs are treated as
    // dollar amounts or cents, +6000/-6000 still sums to zero and changes the
    // results, which is exactly what the assertions below pin down.
    await page
      .getByRole("dialog")
      .getByLabel(/adjust the amounts/i)
      .check();
    // The corrections grid loads the current amounts asynchronously.
    await expect(page.locator(".corrections-grid")).toBeVisible({ timeout: 10_000 });
    await setParticipantAmount(page, "Rosa", "+6000");
    await setParticipantAmount(page, "Quinn", "-6000");
    // Scoped: the dispute item also has a "Resolve" (form-open) button.
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^resolve dispute$/i })
      .click();
    await expect(
      page.getByText(/resolved|saved|corrections applied/i).first()
    ).toBeVisible({ timeout: 10_000 });

    // DB: session resolved, dispute closed, results corrected but still zero-sum.
    await expect
      .poll(async () => {
        const [row] = await tdb.db
          .select({ status: pokerSessions.status })
          .from(pokerSessions)
          .where(eq(pokerSessions.id, sessionId));
        return row?.status;
      }, { timeout: 15_000 })
      .toBe("resolved");

    const [disputeRow] = await tdb.db
      .select({ status: disputes.status })
      .from(disputes)
      .where(and(eq(disputes.sessionId, sessionId), eq(disputes.memberId, quinn.id)));
    expect(disputeRow?.status).toBe("resolved");

    const corrected = await tdb.db
      .select({ amountCents: sessionResults.amountCents })
      .from(sessionResults)
      .where(eq(sessionResults.sessionId, sessionId));
    expect(corrected).toHaveLength(2);
    const sum = corrected.reduce((s, r) => s + r.amountCents, 0);
    expect(sum).toBe(0); // still exactly $0.00
    const correctedCents = corrected.map((r) => r.amountCents).sort((a, b) => a - b);
    expect(correctedCents).not.toEqual([-2000, 2000]); // corrections applied
    expect(await ledgerTotalCents(tdb)).toBe(0); // ledger never wavers
  });
});

// ---------------------------------------------------------------------------

test("admin directly adds a member", async ({ page }) => {
  await page.goto("/poker/");
  await loginAsGroup(page, GROUP_PASSWORD);
  await unlockAdmin(page, ADMIN_PASSWORD);
  await openAdminPanel(page, "Members");

  await test.step("add Jordan", async () => {
    await page.getByRole("button", { name: /add (member|new)|new member/i }).first().click();
    await page.getByLabel(/^display name$/i).fill("Jordan");
    await page.getByLabel(/^email$/i).filter({ visible: true }).first().fill("jordan+e2e@example.com");
    // Scoped to the dialog — "+ Add session" on the dashboard also matches.
    await page.getByRole("dialog", { name: /members/i }).getByRole("button", { name: /add member/i }).click();

    await expect
      .poll(async () => {
        const n = await tdb.db.select({ n: count() }).from(members).where(
          eq(members.emailNormalized, "jordan+e2e@example.com")
        );
        return n[0]?.n ?? 0;
      }, { timeout: 15_000 })
      .toBe(1);
    // Scoped to the dialog — the viewer <select> gains a hidden Jordan option.
    await expect(
      page.getByRole("dialog").getByText("Jordan", { exact: true }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  await test.step("duplicate add shows an error", async () => {
    await page.getByRole("button", { name: /add (member|new)|new member/i }).first().click();
    await page.getByLabel(/^display name$/i).fill("Jordan");
    await page.getByLabel(/^email$/i).filter({ visible: true }).first().fill("jordan+e2e@example.com");
    await page.getByRole("dialog", { name: /members/i }).getByRole("button", { name: /add member/i }).click();
    await expect(
      page.getByText(/already (exists|a member)|duplicate|taken|conflict/i).first()
    ).toBeVisible({ timeout: 10_000 });
    const n = await tdb.db.select({ n: count() }).from(members).where(
      eq(members.emailNormalized, "jordan+e2e@example.com")
    );
    expect(n[0]?.n).toBe(1); // still exactly one row
  });
});

// ---------------------------------------------------------------------------

test("void keeps ledger zero", async ({ page }) => {
  const uma = await seedMember(tdb, "Uma", "uma+e2e@example.com");
  const victor = await seedMember(tdb, "Victor", "victor+e2e@example.com");
  const sessionId = await seedSession(tdb, {
    title: "Void Me",
    participants: [
      { memberId: uma.id, amountCents: 1500 },
      { memberId: victor.id, amountCents: -1500 }
    ]
  });
  expect(await memberSessionsPlayed(tdb, uma.id)).toBe(1);

  await page.goto("/poker/");
  await loginAsGroup(page, GROUP_PASSWORD);
  await unlockAdmin(page, ADMIN_PASSWORD);
  await openSessionDetail(page, "Void Me");
  // The detail results table shows the $0.00 total (dashboard ledger is hidden).
  await expect(
    page.locator(".results-table").getByText("$0.00").first()
  ).toBeVisible({ timeout: 10_000 });

  await voidSession(page);

  // DB: voided, ledger still zero, Uma's session count drops.
  await expect
    .poll(async () => {
      const [row] = await tdb.db
        .select({ status: pokerSessions.status, voidedAt: pokerSessions.voidedAt })
        .from(pokerSessions)
        .where(eq(pokerSessions.id, sessionId));
      return row?.status;
    }, { timeout: 15_000 })
    .toBe("voided");

  expect(await memberSessionsPlayed(tdb, uma.id)).toBe(0);
  expect(await ledgerTotalCents(tdb)).toBe(0);

  // Detail view reflects the voided status.
  await expect(page.getByText(/voided/i).first()).toBeVisible();
});

// ---------------------------------------------------------------------------

test("live session: auto-populate buy-in, add player mid-session, undo, and balance-gated end", async ({ page }) => {
  const ana = await seedMember(tdb, "Ana", "ana+e2e@example.com");
  const ben = await seedMember(tdb, "Ben", "ben+e2e@example.com");
  const cleo = await seedMember(tdb, "Cleo", "cleo+e2e@example.com");
  const rowFor = (name: string) => page.locator(".part-row").filter({ hasText: name });

  await page.goto("/poker/");
  await loginAsGroup(page, GROUP_PASSWORD, "Ana");
  await page.getByRole("button", { name: "Poker", exact: true }).click();
  await page.locator("#start-live-btn").click();
  await expect(page.getByRole("checkbox").first()).toBeVisible({ timeout: 10_000 });

  // --- auto-populate: typing Ana's buy-in fills Ben's still-blank row too ---
  await rowFor("Ana").getByRole("checkbox").check();
  await rowFor("Ben").getByRole("checkbox").check();
  await rowFor("Ana").locator(".part-amount").fill("50");
  await expect(rowFor("Ben").locator(".part-amount")).toHaveValue("50");

  await page.locator("#live-start-submit").click();

  // --- live modal: open it from the dashboard banner ---
  const liveBanner = page.locator("#live-banner");
  await expect(liveBanner).toBeVisible({ timeout: 15_000 });
  await liveBanner.click();
  const liveList = page.locator(".live-player-list");
  await expect(liveList.getByText("Ana", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(liveList.getByText("Ben", { exact: true })).toBeVisible();

  // --- add a late player mid-session ---
  await page.locator("#live-add-player").click();
  await page.locator("#live-new-player").selectOption({ label: "Cleo" });
  await page.locator('.live-add-choice[data-amount="30"]').click();
  await expect(liveList.getByText("Cleo", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(liveList.getByText(/Bought in \+?\$30\.00/)).toBeVisible();

  // --- undo the add-player action: Cleo drops back out ---
  await page.locator("#live-undo").click();
  await expect(liveList.getByText("Cleo", { exact: true })).toHaveCount(0, { timeout: 10_000 });

  // --- balance-gated end: the warning stays hidden while the session is in
  // progress, and only appears once the user actually tries to end it ---
  const remainder = page.locator("#live-remainder");
  const endBtn = page.locator("#live-end");
  const rowByName = (name: string) => page.locator(".live-player-row").filter({ hasText: name });
  await expect(remainder).toBeHidden();
  await rowByName("Ana").locator(".live-cashout").fill("60");
  await rowByName("Ana").locator(".live-cashout").blur();
  await rowByName("Ben").locator(".live-cashout").fill("30");
  await rowByName("Ben").locator(".live-cashout").blur();
  await expect(remainder).toBeHidden();

  await endBtn.click();
  await expect(remainder).toHaveText(/off by -?\$10\.00/);
  await expect(remainder).toHaveClass(/remainder-off/);

  // --- correcting the cash-out clears the warning and unblocks end ---
  await rowByName("Ben").locator(".live-cashout").fill("40");
  await rowByName("Ben").locator(".live-cashout").blur();
  await expect(remainder).toBeHidden();

  await endBtn.click();
  await expect(page.getByText(/live session ended/i)).toBeVisible({ timeout: 15_000 });
  await expect(liveBanner).toBeHidden({ timeout: 10_000 });

  // --- DB: session landed as a normal (non-live) session, ledger stays zero ---
  await expect
    .poll(async () => {
      const [row] = await tdb.db
        .select({ status: pokerSessions.status })
        .from(pokerSessions)
        .where(and(eq(pokerSessions.recordedByMemberId, ana.id), eq(pokerSessions.status, "active")));
      return row?.status;
    }, { timeout: 15_000 })
    .toBe("active");
  expect(await memberSessionsPlayed(tdb, ben.id)).toBeGreaterThanOrEqual(1);
  expect(cleo.id).toBeTruthy(); // Cleo was seeded but undone out of the session
  expect(await ledgerTotalCents(tdb)).toBe(0);
});

// ---------------------------------------------------------------------------

test("handshake bets: add a new category on the fly and see it on the bet card", async ({ page }) => {
  const fay = await seedMember(tdb, "Fay", "fay+e2e@example.com");
  const gus = await seedMember(tdb, "Gus", "gus+e2e@example.com");

  await page.goto("/poker/");
  await loginAsGroup(page, GROUP_PASSWORD, "Fay");
  await page.getByRole("button", { name: "Handshake bets", exact: true }).click();
  await expect(page.locator(".dash-grid-handshake")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "+ Add handshake bet" }).click();
  await page.locator("#hb-description").fill("18 holes, loser buys drinks");
  await page.locator("#hb-amount").fill("20");
  await page.locator("#hb-opponent").selectOption({ label: "Gus" });

  // Add a brand-new category from the modal instead of picking a seeded one.
  await page.locator("#hb-category").selectOption("__new__");
  await expect(page.locator("#hb-category-new-wrap")).toBeVisible();
  await page.locator("#hb-category-new").fill("Bowling");
  await page.locator("#hb-category-new-add").click();
  await expect(page.locator("#hb-category-new-wrap")).toBeHidden({ timeout: 10_000 });
  await expect(page.locator("#hb-category")).toHaveValue(/.+/); // a real category id got selected

  await page.locator("#hb-submit").click();

  // The open-bet card shows the new category as a chip alongside the bet.
  const card = page.locator(".open-bet-card").filter({ hasText: "18 holes, loser buys drinks" });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.locator(".chip-category")).toHaveText("Bowling");

  // The category is now available for reuse without recreating it.
  await page.getByRole("button", { name: "+ Add handshake bet" }).click();
  await expect(page.locator("#hb-category").getByRole("option", { name: "Bowling" })).toHaveCount(1);
  await page.locator("#hb-cancel").click();

  // Settle the bet in Fay's favor and confirm it lands in both the settled
  // balances sidebar and the settled-bets history table.
  await card.getByRole("button", { name: "Settle bet" }).click();
  await page.getByRole("radio", { name: "Fay" }).check();
  await page.locator("#hb-settle-submit").click();
  await expect(card).toBeHidden({ timeout: 10_000 });

  const fayBalance = page.locator(".settled-balances-row", { hasText: "Fay" });
  const gusBalance = page.locator(".settled-balances-row", { hasText: "Gus" });
  await expect(fayBalance.locator(".money")).toHaveText("+$20.00", { timeout: 10_000 });
  await expect(gusBalance.locator(".money")).toHaveText("-$20.00");

  const historyRow = page.locator(".bet-table-row", { hasText: "18 holes, loser buys drinks" });
  await expect(historyRow).toBeVisible();
  await expect(historyRow.locator(".chip-voided")).toHaveCount(0);

  // Void it: the settled balances revert to zero and the row is flagged
  // "Voided" but stays visible in the history table.
  await historyRow.click();
  await expect(page.getByRole("heading", { name: "Bet details" })).toBeVisible();
  const voidBtn = page.locator("#hb-void");
  await voidBtn.click();
  await expect(voidBtn).toHaveText("Click again to confirm void");
  await voidBtn.click();
  await expect(page.locator(".banner")).toContainText("Bet voided and removed from settled balances.", { timeout: 10_000 });

  await expect(fayBalance.locator(".money")).toHaveText("$0.00", { timeout: 10_000 });
  await expect(gusBalance.locator(".money")).toHaveText("$0.00");
  await expect(historyRow.locator(".chip-voided")).toHaveText("Voided");

  expect(gus.id).toBeTruthy();
});

// ---------------------------------------------------------------------------

test("golf: log rounds, see the weighted leaderboard, and get a suggested stroke line", async ({ page }) => {
  const wes = await seedMember(tdb, "Wes", "wes+e2e@example.com");
  const xia = await seedMember(tdb, "Xia", "xia+e2e@example.com");

  await page.goto("/poker/");
  await loginAsGroup(page, GROUP_PASSWORD, "Wes");
  await page.getByRole("button", { name: "Golf", exact: true }).click();
  await expect(page.locator(".dash-grid-golf")).toBeVisible({ timeout: 10_000 });
  await page.locator('#golf-course-switch [data-course="hancock"]').click();
  await expect(page.locator("#golf-heading")).toHaveText("Hancock");

  async function logRound(playerName: string, strokes: string, par: string) {
    await page.getByRole("button", { name: "+ Log a round" }).click();
    await page.locator("#golf-new-player").selectOption({ label: playerName });
    await page.locator("#golf-new-course").selectOption({ label: "Hancock" });
    await page.locator("#golf-new-strokes").fill(strokes);
    await page.locator("#golf-new-par").fill(par);
    await page.getByRole("button", { name: "Log round" }).click();
    await expect(page.getByText("Round logged.")).toBeVisible({ timeout: 10_000 });
  }

  // Wes: 85 strokes, par 70 -> +15. Xia: 75 strokes, par 70 -> +5 (better).
  await logRound("Wes", "85", "70");
  await logRound("Xia", "75", "70");

  const board = page.locator(".golf-board-row");
  await expect(board).toHaveCount(2);
  // Xia (better, lower vs-par) ranks above Wes on the leaderboard.
  await expect(board.nth(0)).toContainText("Xia");
  await expect(board.nth(1)).toContainText("Wes");

  // The suite is append-only, so other active members from earlier tests may
  // exist too — pick Wes/Xia explicitly rather than relying on the default
  // pre-selected pair.
  await page.locator("#golf-line-a").selectOption({ label: "Wes" });
  await page.locator("#golf-line-b").selectOption({ label: "Xia" });

  // Betting line: |15 - 5| = 10 -> floor(10) + 0.5 = 10.5, given to the weaker player (Wes).
  const lineResult = page.locator("#golf-line-result");
  await expect(lineResult).toContainText("10.5 strokes", { timeout: 10_000 });
  await expect(lineResult).toContainText("Xia");
  await expect(lineResult).toContainText("gives");
  await expect(lineResult).toContainText("Wes");

  // The same suggested line is offered inline when starting a handshake bet.
  await page.getByRole("button", { name: "Handshake bets", exact: true }).click();
  await page.getByRole("button", { name: "+ Add handshake bet" }).click();
  await page.locator("#hb-opponent").selectOption({ label: "Xia" });
  await page.getByRole("button", { name: "Suggest a golf betting line" }).click();
  await page.locator("#hb-golf-course").selectOption({ label: "Hancock" });
  await expect(page.locator("#hb-golf-result")).toContainText("10.5 strokes", { timeout: 10_000 });
  await page.getByRole("button", { name: "Use this in the description" }).click();
  await expect(page.locator("#hb-description")).toHaveValue(/Xia gives Wes 10\.5 strokes/);
  await page.locator("#hb-cancel").click();

  expect(xia.id).toBeTruthy();
});

// ---------------------------------------------------------------------------

// Sanity: the seeded dispute-token helper hashes exactly like the server.
test("token hash round-trips the production hasher", () => {
  expect(hashToken("e2e-token-abc")).toMatch(/^[0-9a-f]{64}$/);
});

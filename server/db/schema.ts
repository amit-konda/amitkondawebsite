/**
 * Poker Ledger schema — Drizzle ORM, Postgres.
 * All timestamps are timezone-aware UTC. Money is integer cents (bigint).
 * UUIDs generated database-side.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const memberStatus = pgEnum("member_status", ["active", "inactive"]);
export const joinRequestStatus = pgEnum("join_request_status", ["pending", "approved", "rejected"]);
export const sessionStatus = pgEnum("session_status", ["active", "live", "disputed", "resolved", "voided"]);
export const gameType = pgEnum("game_type", ["poker", "blackjack"]);
export const handshakeBetStatus = pgEnum("handshake_bet_status", ["open", "settled", "voided"]);
export const golfCourse = pgEnum("golf_course", ["butler", "hancock"]);
export const liveSessionEventKind = pgEnum("live_session_event_kind", ["buy_in", "cash_out"]);
export const disputeStatus = pgEnum("dispute_status", ["open", "resolved", "dismissed"]);
export const gameDisputeEntity = pgEnum("game_dispute_entity", ["handshake_bet", "golf_round"]);
export const settlementStatus = pgEnum("settlement_status", ["pending", "confirmed", "voided"]);
export const emailStatus = pgEnum("email_status", [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "failed",
  "processing",
  "delayed",
  "dead_letter"
]);

// Split is intentionally namespaced from the poker ledger. Phone identities,
// sessions and payment attestations are not shared with poker members.
export const splitUserStatus = pgEnum("split_user_status", ["active", "disabled"]);
export const splitBillStatus = pgEnum("split_bill_status", [
  "processing",
  "review",
  "open",
  "locked",
  "settled",
  "voided"
]);
export const splitReceiptStatus = pgEnum("split_receipt_status", [
  "pending",
  "uploaded",
  "processing",
  "ready",
  "failed",
  "deleted"
]);
export const splitInvitationStatus = pgEnum("split_invitation_status", [
  "pending",
  "queued",
  "sent",
  "viewed",
  "accepted",
  "failed"
]);
export const splitSelectionStatus = pgEnum("split_selection_status", [
  "pending",
  "selecting",
  "complete"
]);
export const splitPaymentStatus = pgEnum("split_payment_status", [
  "unpaid",
  "reported_paid",
  "confirmed",
  "rejected",
  "voided"
]);
export const splitPaymentReportSource = pgEnum("split_payment_report_source", [
  "web",
  "sms",
  "organizer"
]);
export const splitAllocationKind = pgEnum("split_allocation_kind", [
  "quantity",
  "equal_share",
  "manual"
]);
export const splitSmsEventType = pgEnum("split_sms_event_type", [
  "invitation",
  "final_amount",
  "payment_reminder",
  "payment_clarification"
]);
export const splitSmsStatus = pgEnum("split_sms_status", [
  "queued",
  "processing",
  "sent",
  "delivered",
  "failed",
  "undelivered",
  "suppressed",
  "dead_letter"
]);

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ---------------------------------------------------------------------------
// members
// ---------------------------------------------------------------------------
export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name").notNull(),
    emailNormalized: text("email_normalized").notNull().unique(),
    // Optional contact number for future SMS/payment workflows. Kept private
    // to admin member management; the public member list never exposes it.
    phoneNumber: text("phone_number"),
    // Venmo handle (no leading "@"), shown to other members so a settle-up
    // payment link can be prefilled with the right recipient. Optional —
    // nothing breaks if it's unset, the payer just has to pick the person
    // themselves inside Venmo.
    venmoUsername: text("venmo_username"),
    status: memberStatus("status").notNull().default("active"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date())
  },
  (t) => [
    check("members_display_name_len", sql`char_length(${t.displayName}) between 1 and 80`),
    check("members_email_len", sql`char_length(${t.emailNormalized}) between 3 and 320`),
    check(
      "members_phone_number_len",
      sql`${t.phoneNumber} is null or char_length(${t.phoneNumber}) between 7 and 32`
    ),
    check(
      "members_venmo_username_len",
      sql`${t.venmoUsername} is null or char_length(${t.venmoUsername}) between 1 and 30`
    ),
    index("members_status_idx").on(t.status)
  ]
);

// ---------------------------------------------------------------------------
// join_requests
// ---------------------------------------------------------------------------
export const joinRequests = pgTable(
  "join_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    note: text("note"),
    status: joinRequestStatus("status").notNull().default("pending"),
    requestedAt: ts("requested_at").notNull().defaultNow(),
    reviewedAt: ts("reviewed_at"),
    // Hashed request IP only — never store raw IPs.
    requestIpHash: text("request_ip_hash")
  },
  (t) => [
    check("join_requests_display_name_len", sql`char_length(${t.displayName}) between 1 and 80`),
    check("join_requests_email_len", sql`char_length(${t.emailNormalized}) between 3 and 320`),
    check("join_requests_note_len", sql`${t.note} is null or char_length(${t.note}) <= 500`),
    // Only one pending request per email.
    uniqueIndex("join_requests_pending_email_uidx")
      .on(t.emailNormalized)
      .where(sql`${t.status} = 'pending'`),
    index("join_requests_status_idx").on(t.status)
  ]
);

// ---------------------------------------------------------------------------
// poker_sessions
// ---------------------------------------------------------------------------
export const pokerSessions = pgTable(
  "poker_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playedAt: ts("played_at").notNull(),
    title: text("title"),
    notes: text("notes"),
    gameType: gameType("game_type").notNull().default("poker"),
    recordedByMemberId: uuid("recorded_by_member_id").references(() => members.id),
    status: sessionStatus("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    // Idempotency key — prevents double submission.
    requestKey: text("request_key").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
    voidedAt: ts("voided_at")
  },
  (t) => [
    check(
      "poker_sessions_title_len",
      sql`${t.title} is null or char_length(${t.title}) <= 120`
    ),
    check(
      "poker_sessions_notes_len",
      sql`${t.notes} is null or char_length(${t.notes}) <= 2000`
    ),
    check(
      "poker_sessions_request_key_len",
      sql`char_length(${t.requestKey}) between 8 and 64`
    ),
    check("poker_sessions_version_gt0", sql`${t.version} >= 1`),
    index("poker_sessions_status_played_idx").on(t.status, t.playedAt),
  ]
);

// Handshake bet categories are a small, user-extensible tag list (Golf,
// Football, Meals, ...) rather than a fixed enum — anyone can add a new one
// from the "Add handshake bet" modal, so it's a normal table with a
// case-insensitive unique name, not a pgEnum.
export const handshakeBetCategories = pgTable(
  "handshake_bet_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    check("handshake_bet_categories_name_len", sql`char_length(${t.name}) between 1 and 40`),
    uniqueIndex("handshake_bet_categories_name_ci_idx").on(sql`lower(${t.name})`)
  ]
);

export const handshakeBets = pgTable(
  "handshake_bets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    description: text("description").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    firstMemberId: uuid("first_member_id").notNull().references(() => members.id),
    secondMemberId: uuid("second_member_id").notNull().references(() => members.id),
    winnerMemberId: uuid("winner_member_id").references(() => members.id),
    categoryId: uuid("category_id").references(() => handshakeBetCategories.id),
    status: handshakeBetStatus("status").notNull().default("open"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    settledAt: ts("settled_at")
  },
  (t) => [
    check("handshake_bets_amount_positive", sql`${t.amountCents} > 0`),
    check("handshake_bets_amount_limit", sql`${t.amountCents} <= 100000000`),
    check("handshake_bets_distinct_members", sql`${t.firstMemberId} <> ${t.secondMemberId}`),
    index("handshake_bets_status_idx").on(t.status),
    index("handshake_bets_member_idx").on(t.firstMemberId, t.secondMemberId),
    index("handshake_bets_category_idx").on(t.categoryId)
  ]
);

// ---------------------------------------------------------------------------
// golf_rounds — one row per player per round played (Butler Pitch & Putt or
// Hancock). Feeds the weighted-average betting-line calculator in
// server/domain/golf.ts: each player's last 3 rounds at a course are
// weighted 80%, everything older 20%, to suggest a fair stroke line for
// handshake bets. Unlike poker/blackjack sessions this isn't a shared
// multi-player entity with amounts that net to zero — it's just one
// player's score for one round, so a group outing is simply several rows
// sharing a date rather than one linked session.
// ---------------------------------------------------------------------------
export const golfRounds = pgTable(
  "golf_rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id").notNull().references(() => members.id),
    course: golfCourse("course").notNull(),
    strokes: integer("strokes").notNull(),
    par: integer("par").notNull(),
    playedAt: ts("played_at").notNull(),
    recordedByMemberId: uuid("recorded_by_member_id").references(() => members.id),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    check("golf_rounds_strokes_range", sql`${t.strokes} between 1 and 300`),
    check("golf_rounds_par_range", sql`${t.par} between 1 and 200`),
    index("golf_rounds_member_course_idx").on(t.memberId, t.course, t.playedAt)
  ]
);

// ---------------------------------------------------------------------------
// session_results
// ---------------------------------------------------------------------------
export const sessionResults = pgTable(
  "session_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => pokerSessions.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull()
  },
  (t) => [
    check("session_results_amount_limit", sql`abs(${t.amountCents}) <= 100000000`),
    uniqueIndex("session_results_session_member_uidx").on(t.sessionId, t.memberId),
    index("session_results_member_idx").on(t.memberId)
  ]
);

// Individual buy-ins are append-only so the live total remains auditable.
export const liveBuyIns = pgTable(
  "live_buy_ins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => pokerSessions.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").notNull().references(() => members.id),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    recordedByMemberId: uuid("recorded_by_member_id").references(() => members.id),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    check("live_buy_ins_amount_positive", sql`${t.amountCents} > 0`),
    check("live_buy_ins_amount_limit", sql`${t.amountCents} <= 100000000`),
    index("live_buy_ins_session_idx").on(t.sessionId),
    index("live_buy_ins_member_idx").on(t.memberId)
  ]
);

export const liveCashOuts = pgTable(
  "live_cash_outs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => pokerSessions.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").notNull().references(() => members.id),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    recordedByMemberId: uuid("recorded_by_member_id").references(() => members.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date())
  },
  (t) => [
    check("live_cash_outs_amount_nonnegative", sql`${t.amountCents} >= 0`),
    check("live_cash_outs_amount_limit", sql`${t.amountCents} <= 100000000`),
    uniqueIndex("live_cash_outs_session_member_uidx").on(t.sessionId, t.memberId),
    index("live_cash_outs_session_idx").on(t.sessionId)
  ]
);

// Undo log for the live-session modal: one row per buy-in/cash-out mutation,
// newest first. Undo pops the most recent row and reverses just that change
// (delete the buy-in row it points at, or restore the cash-out's prior
// value) — a simple LIFO stack, not a full history browser. Session-start
// buy-ins are NOT logged here (nothing to "undo" back to before the session
// existed); only actions taken from the live modal are.
export const liveSessionEvents = pgTable(
  "live_session_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => pokerSessions.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").notNull().references(() => members.id),
    kind: liveSessionEventKind("kind").notNull(),
    // Set when kind = 'buy_in': the live_buy_ins row to delete on undo.
    buyInId: uuid("buy_in_id").references(() => liveBuyIns.id, { onDelete: "cascade" }),
    // Set when kind = 'cash_out': what to restore the cash-out to on undo.
    // hadPreviousCashOut distinguishes "restore to $0.00" from "no prior
    // cash-out — remove the row entirely".
    previousCashOutCents: bigint("previous_cash_out_cents", { mode: "number" }),
    hadPreviousCashOut: boolean("had_previous_cash_out").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [index("live_session_events_session_idx").on(t.sessionId, t.createdAt)]
);

// ---------------------------------------------------------------------------
// dispute_tokens
// ---------------------------------------------------------------------------
export const disputeTokens = pgTable(
  "dispute_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => pokerSessions.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    index("dispute_tokens_session_idx").on(t.sessionId),
    index("dispute_tokens_member_idx").on(t.memberId)
  ]
);

// ---------------------------------------------------------------------------
// disputes
// ---------------------------------------------------------------------------
export const disputes = pgTable(
  "disputes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => pokerSessions.id),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    reason: text("reason").notNull(),
    status: disputeStatus("status").notNull().default("open"),
    resolutionNote: text("resolution_note"),
    createdAt: ts("created_at").notNull().defaultNow(),
    resolvedAt: ts("resolved_at")
  },
  (t) => [
    check("disputes_reason_len", sql`char_length(${t.reason}) between 1 and 1000`),
    // Only one open dispute per member/session.
    uniqueIndex("disputes_open_session_member_uidx")
      .on(t.sessionId, t.memberId)
      .where(sql`${t.status} = 'open'`),
    index("disputes_status_idx").on(t.status),
    index("disputes_session_idx").on(t.sessionId)
  ]
);

// Disputes for non-session game records (handshake bets and golf rounds).
// Poker and blackjack continue using `disputes` because they are backed by
// poker_sessions and support the existing receipt/correction workflow.
export const gameDisputes = pgTable(
  "game_disputes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: gameDisputeEntity("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    memberId: uuid("member_id").notNull().references(() => members.id),
    reason: text("reason").notNull(),
    status: disputeStatus("status").notNull().default("open"),
    resolutionNote: text("resolution_note"),
    createdAt: ts("created_at").notNull().defaultNow(),
    resolvedAt: ts("resolved_at")
  },
  (t) => [
    check("game_disputes_reason_len", sql`char_length(${t.reason}) between 1 and 1000`),
    uniqueIndex("game_disputes_open_entity_member_uidx")
      .on(t.entityType, t.entityId, t.memberId)
      .where(sql`${t.status} = 'open'`),
    index("game_disputes_status_idx").on(t.status),
    index("game_disputes_entity_idx").on(t.entityType, t.entityId)
  ]
);

// ---------------------------------------------------------------------------
// settlements — a self-attested "I paid this outside the app" record used to
// settle up real balances. The app never moves money itself (Venmo has no
// API for that, and most processors won't touch poker/gambling money
// movement anyway) — a settlement just records that a Venmo (or other)
// payment happened, starting "pending" and becoming "confirmed" once
// someone taps confirm, at which point it nets against the ledger exactly
// like a settled handshake bet does.
// ---------------------------------------------------------------------------
export const settlements = pgTable(
  "settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromMemberId: uuid("from_member_id").notNull().references(() => members.id),
    toMemberId: uuid("to_member_id").notNull().references(() => members.id),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    // e.g. "venmo" — free text rather than an enum since it's just a label
    // for the payment link/UI, not something the app validates or acts on.
    method: text("method").notNull().default("venmo"),
    note: text("note"),
    status: settlementStatus("status").notNull().default("pending"),
    // Idempotency key — prevents double submission (mirrors poker_sessions).
    requestKey: text("request_key").notNull().unique(),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id),
    confirmedByMemberId: uuid("confirmed_by_member_id").references(() => members.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    confirmedAt: ts("confirmed_at"),
    voidedAt: ts("voided_at")
  },
  (t) => [
    check("settlements_amount_positive", sql`${t.amountCents} > 0`),
    check("settlements_amount_limit", sql`${t.amountCents} <= 100000000`),
    check("settlements_distinct_members", sql`${t.fromMemberId} <> ${t.toMemberId}`),
    check("settlements_method_len", sql`char_length(${t.method}) between 1 and 30`),
    check("settlements_note_len", sql`${t.note} is null or char_length(${t.note}) <= 500`),
    check("settlements_request_key_len", sql`char_length(${t.requestKey}) between 8 and 64`),
    index("settlements_status_idx").on(t.status),
    index("settlements_from_idx").on(t.fromMemberId),
    index("settlements_to_idx").on(t.toMemberId)
  ]
);

// ---------------------------------------------------------------------------
// email_deliveries — outbox + provider status tracking
// ---------------------------------------------------------------------------
export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // e.g. "session_receipt" | "member_approved" | "member_welcome" | "dispute_resolution"
    eventType: text("event_type").notNull(),
    entityType: text("entity_type").notNull(), // "session" | "member" | "dispute"
    entityId: uuid("entity_id").notNull(),
    version: integer("version").notNull().default(1),
    recipientEmail: text("recipient_email").notNull(),
    recipientMemberId: uuid("recipient_member_id").references(() => members.id),
    providerId: text("provider_id"),
    status: emailStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    errorCode: text("error_code"),
    lastAttemptAt: ts("last_attempt_at"),
    // Claim/lease fields for concurrency-safe delivery (see server/email/send.ts).
    claimedAt: ts("claimed_at"),
    claimId: text("claim_id"),
    nextAttemptAt: ts("next_attempt_at"),
    sentAt: ts("sent_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date())
  },
  (t) => [
    // One intended receipt per event/entity/version/recipient.
    uniqueIndex("email_deliveries_entity_version_recipient_uidx").on(
      t.eventType,
      t.entityId,
      t.version,
      t.recipientEmail
    ),
    index("email_deliveries_status_idx").on(t.status),
    index("email_deliveries_pending_idx").on(t.status, t.nextAttemptAt),
    index("email_deliveries_provider_idx").on(t.providerId)
  ]
);

// ---------------------------------------------------------------------------
// webhook_events — idempotent provider webhook processing (dedup by event id)
// ---------------------------------------------------------------------------
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Resend/Svix message event id — unique so replays cannot re-apply.
    eventId: text("event_id").notNull().unique(),
    eventType: text("event_type").notNull(),
    providerMessageId: text("provider_message_id"),
    deliveryId: uuid("delivery_id").references(() => emailDeliveries.id),
    processedAt: ts("processed_at").notNull().defaultNow()
  },
  (t) => [index("webhook_events_provider_msg_idx").on(t.providerMessageId)]
);

// ---------------------------------------------------------------------------
// rate_limit_buckets — durable per-scope sliding windows (Postgres-backed)
// ---------------------------------------------------------------------------
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    scope: text("scope").notNull(),
    keyHash: text("key_hash").notNull(),
    windowStartedAt: ts("window_started_at").notNull(),
    requestCount: integer("request_count").notNull().default(0),
    expiresAt: ts("expires_at").notNull()
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.keyHash, t.windowStartedAt] }),
    index("rate_limit_buckets_expires_idx").on(t.expiresAt)
  ]
);

// ---------------------------------------------------------------------------
// audit_events
// ---------------------------------------------------------------------------
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // e.g. "member:Alice", "admin", "system"
    actorLabel: text("actor_label").notNull(),
    memberHint: text("member_hint"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    beforeJson: jsonb("before_json"),
    afterJson: jsonb("after_json"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    index("audit_events_entity_idx").on(t.entityType, t.entityId),
    index("audit_events_created_idx").on(t.createdAt)
  ]
);

// ---------------------------------------------------------------------------
// Split — phone identities, receipt itemization, allocation and settlement
// ---------------------------------------------------------------------------
export const splitUsers = pgTable(
  "split_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name").notNull(),
    // AES-GCM ciphertext for delivery; the keyed HMAC is used for equality
    // lookup without exposing the E.164 number in indexes or logs.
    phoneEncrypted: text("phone_encrypted").notNull(),
    phoneLookupHash: text("phone_lookup_hash").notNull(),
    status: splitUserStatus("status").notNull().default("active"),
    paymentProvider: text("payment_provider"),
    paymentHandle: text("payment_handle"),
    smsConsentAt: ts("sms_consent_at"),
    smsOptedOutAt: ts("sms_opted_out_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date())
  },
  (t) => [
    check("split_users_display_name_len", sql`char_length(${t.displayName}) between 1 and 80`),
    check("split_users_phone_encrypted_len", sql`char_length(${t.phoneEncrypted}) between 16 and 2048`),
    check("split_users_phone_hash_len", sql`char_length(${t.phoneLookupHash}) between 32 and 128`),
    check(
      "split_users_payment_provider_len",
      sql`${t.paymentProvider} is null or char_length(${t.paymentProvider}) between 1 and 30`
    ),
    check(
      "split_users_payment_handle_len",
      sql`${t.paymentHandle} is null or char_length(${t.paymentHandle}) between 1 and 120`
    ),
    uniqueIndex("split_users_phone_lookup_hash_uidx").on(t.phoneLookupHash),
    index("split_users_status_idx").on(t.status)
  ]
);

export const splitSessions = pgTable(
  "split_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => splitUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    lastUsedAt: ts("last_used_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    check("split_sessions_token_hash_len", sql`char_length(${t.tokenHash}) between 32 and 128`),
    uniqueIndex("split_sessions_token_hash_uidx").on(t.tokenHash),
    index("split_sessions_user_idx").on(t.userId),
    index("split_sessions_expires_idx").on(t.expiresAt)
  ]
);

export const splitBills = pgTable(
  "split_bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizerUserId: uuid("organizer_user_id").notNull().references(() => splitUsers.id),
    payerUserId: uuid("payer_user_id").notNull().references(() => splitUsers.id),
    merchantName: text("merchant_name"),
    purchasedAt: ts("purchased_at"),
    currency: text("currency").notNull().default("USD"),
    subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull().default(0),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
    tipCents: bigint("tip_cents", { mode: "number" }).notNull().default(0),
    feeCents: bigint("fee_cents", { mode: "number" }).notNull().default(0),
    discountCents: bigint("discount_cents", { mode: "number" }).notNull().default(0),
    totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
    status: splitBillStatus("status").notNull().default("processing"),
    version: integer("version").notNull().default(1),
    requestKey: text("request_key").notNull(),
    lockedAt: ts("locked_at"),
    settledAt: ts("settled_at"),
    voidedAt: ts("voided_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date())
  },
  (t) => [
    check("split_bills_merchant_name_len", sql`${t.merchantName} is null or char_length(${t.merchantName}) <= 160`),
    check("split_bills_currency_iso_len", sql`char_length(${t.currency}) = 3`),
    check("split_bills_amounts_nonnegative", sql`${t.subtotalCents} >= 0 and ${t.taxCents} >= 0 and ${t.tipCents} >= 0 and ${t.feeCents} >= 0 and ${t.discountCents} >= 0 and ${t.totalCents} >= 0`),
    check("split_bills_amount_limit", sql`${t.totalCents} <= 100000000`),
    check("split_bills_version_gt0", sql`${t.version} >= 1`),
    check("split_bills_request_key_len", sql`char_length(${t.requestKey}) between 8 and 128`),
    uniqueIndex("split_bills_request_key_uidx").on(t.requestKey),
    index("split_bills_organizer_status_idx").on(t.organizerUserId, t.status),
    index("split_bills_payer_status_idx").on(t.payerUserId, t.status),
    index("split_bills_created_idx").on(t.createdAt)
  ]
);

export const splitReceiptFiles = pgTable(
  "split_receipt_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    billId: uuid("bill_id").notNull().references(() => splitBills.id, { onDelete: "cascade" }),
    blobPathname: text("blob_pathname").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    status: splitReceiptStatus("status").notNull().default("pending"),
    ocrProvider: text("ocr_provider"),
    ocrModel: text("ocr_model"),
    ocrRawJson: jsonb("ocr_raw_json"),
    ocrErrorCode: text("ocr_error_code"),
    retentionExpiresAt: ts("retention_expires_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date())
  },
  (t) => [
    check("split_receipt_files_size_positive", sql`${t.sizeBytes} > 0`),
    check("split_receipt_files_size_limit", sql`${t.sizeBytes} <= 20971520`),
    check("split_receipt_files_checksum_len", sql`char_length(${t.checksumSha256}) = 64`),
    uniqueIndex("split_receipt_files_blob_path_uidx").on(t.blobPathname),
    index("split_receipt_files_bill_idx").on(t.billId),
    index("split_receipt_files_status_idx").on(t.status),
    index("split_receipt_files_retention_idx").on(t.retentionExpiresAt)
  ]
);

export const splitItems = pgTable(
  "split_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    billId: uuid("bill_id").notNull().references(() => splitBills.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
    lineTotalCents: bigint("line_total_cents", { mode: "number" }).notNull(),
    displayOrder: integer("display_order").notNull(),
    ocrRawText: text("ocr_raw_text"),
    ocrConfidenceBasisPoints: integer("ocr_confidence_basis_points"),
    organizerCorrected: boolean("organizer_corrected").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date())
  },
  (t) => [
    check("split_items_description_len", sql`char_length(${t.description}) between 1 and 300`),
    check("split_items_quantity_positive", sql`${t.quantity} > 0`),
    check("split_items_prices_nonnegative", sql`${t.unitPriceCents} >= 0 and ${t.lineTotalCents} >= 0`),
    check("split_items_price_limit", sql`${t.lineTotalCents} <= 100000000`),
    check("split_items_display_order_nonnegative", sql`${t.displayOrder} >= 0`),
    check("split_items_ocr_confidence_range", sql`${t.ocrConfidenceBasisPoints} is null or ${t.ocrConfidenceBasisPoints} between 0 and 10000`),
    uniqueIndex("split_items_bill_order_uidx").on(t.billId, t.displayOrder),
    index("split_items_bill_idx").on(t.billId)
  ]
);

export const splitParticipants = pgTable(
  "split_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    billId: uuid("bill_id").notNull().references(() => splitBills.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => splitUsers.id),
    invitedByUserId: uuid("invited_by_user_id").notNull().references(() => splitUsers.id),
    displayName: text("display_name").notNull(),
    invitedPhoneEncrypted: text("invited_phone_encrypted").notNull(),
    invitedPhoneLookupHash: text("invited_phone_lookup_hash").notNull(),
    inviteTokenHash: text("invite_token_hash").notNull(),
    invitationStatus: splitInvitationStatus("invitation_status").notNull().default("pending"),
    selectionStatus: splitSelectionStatus("selection_status").notNull().default("pending"),
    paymentStatus: splitPaymentStatus("payment_status").notNull().default("unpaid"),
    itemSubtotalCents: bigint("item_subtotal_cents", { mode: "number" }).notNull().default(0),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
    tipCents: bigint("tip_cents", { mode: "number" }).notNull().default(0),
    feeCents: bigint("fee_cents", { mode: "number" }).notNull().default(0),
    discountCents: bigint("discount_cents", { mode: "number" }).notNull().default(0),
    finalAmountCents: bigint("final_amount_cents", { mode: "number" }).notNull().default(0),
    inviteSentAt: ts("invite_sent_at"),
    selectionCompletedAt: ts("selection_completed_at"),
    lastReminderAt: ts("last_reminder_at"),
    nextReminderAt: ts("next_reminder_at"),
    reminderCount: integer("reminder_count").notNull().default(0),
    remindersSnoozedUntil: ts("reminders_snoozed_until"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date())
  },
  (t) => [
    check("split_participants_display_name_len", sql`char_length(${t.displayName}) between 1 and 80`),
    check("split_participants_phone_encrypted_len", sql`char_length(${t.invitedPhoneEncrypted}) between 16 and 2048`),
    check("split_participants_phone_hash_len", sql`char_length(${t.invitedPhoneLookupHash}) between 32 and 128`),
    check("split_participants_invite_token_hash_len", sql`char_length(${t.inviteTokenHash}) between 32 and 128`),
    check("split_participants_amounts_nonnegative", sql`${t.itemSubtotalCents} >= 0 and ${t.taxCents} >= 0 and ${t.tipCents} >= 0 and ${t.feeCents} >= 0 and ${t.discountCents} >= 0 and ${t.finalAmountCents} >= 0`),
    check("split_participants_reminder_count_nonnegative", sql`${t.reminderCount} >= 0`),
    uniqueIndex("split_participants_invite_token_uidx").on(t.inviteTokenHash),
    uniqueIndex("split_participants_bill_phone_uidx").on(t.billId, t.invitedPhoneLookupHash),
    uniqueIndex("split_participants_bill_user_uidx").on(t.billId, t.userId).where(sql`${t.userId} is not null`),
    index("split_participants_user_idx").on(t.userId),
    index("split_participants_due_reminder_idx").on(t.paymentStatus, t.nextReminderAt),
    index("split_participants_bill_status_idx").on(t.billId, t.paymentStatus)
  ]
);

export const splitItemAllocations = pgTable(
  "split_item_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id").notNull().references(() => splitItems.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").notNull().references(() => splitParticipants.id, { onDelete: "cascade" }),
    kind: splitAllocationKind("kind").notNull(),
    quantity: integer("quantity"),
    shareUnits: integer("share_units"),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date())
  },
  (t) => [
    check("split_item_allocations_amount_nonnegative", sql`${t.amountCents} >= 0`),
    check("split_item_allocations_quantity_positive", sql`${t.quantity} is null or ${t.quantity} > 0`),
    check("split_item_allocations_share_units_positive", sql`${t.shareUnits} is null or ${t.shareUnits} > 0`),
    check("split_item_allocations_kind_values", sql`(${t.kind} = 'quantity' and ${t.quantity} is not null and ${t.shareUnits} is null) or (${t.kind} = 'equal_share' and ${t.shareUnits} is not null and ${t.quantity} is null) or (${t.kind} = 'manual' and ${t.quantity} is null and ${t.shareUnits} is null)`),
    uniqueIndex("split_item_allocations_item_participant_uidx").on(t.itemId, t.participantId),
    index("split_item_allocations_participant_idx").on(t.participantId)
  ]
);

export const splitPayments = pgTable(
  "split_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    billId: uuid("bill_id").notNull().references(() => splitBills.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").notNull().references(() => splitParticipants.id, { onDelete: "cascade" }),
    payerUserId: uuid("payer_user_id").notNull().references(() => splitUsers.id),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    status: splitPaymentStatus("status").notNull().default("unpaid"),
    reportSource: splitPaymentReportSource("report_source"),
    requestKey: text("request_key").notNull(),
    reportedAt: ts("reported_at"),
    confirmedAt: ts("confirmed_at"),
    rejectedAt: ts("rejected_at"),
    voidedAt: ts("voided_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date())
  },
  (t) => [
    check("split_payments_amount_positive", sql`${t.amountCents} > 0`),
    check("split_payments_amount_limit", sql`${t.amountCents} <= 100000000`),
    check("split_payments_request_key_len", sql`char_length(${t.requestKey}) between 8 and 128`),
    uniqueIndex("split_payments_request_key_uidx").on(t.requestKey),
    index("split_payments_participant_idx").on(t.participantId),
    index("split_payments_bill_status_idx").on(t.billId, t.status)
  ]
);

export const splitSmsDeliveries = pgTable(
  "split_sms_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: splitSmsEventType("event_type").notNull(),
    billId: uuid("bill_id").notNull().references(() => splitBills.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").references(() => splitParticipants.id, { onDelete: "cascade" }),
    recipientPhoneEncrypted: text("recipient_phone_encrypted").notNull(),
    recipientPhoneLookupHash: text("recipient_phone_lookup_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    billVersion: integer("bill_version").notNull().default(1),
    reminderNumber: integer("reminder_number"),
    providerMessageId: text("provider_message_id"),
    status: splitSmsStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    errorCode: text("error_code"),
    claimedAt: ts("claimed_at"),
    claimId: text("claim_id"),
    nextAttemptAt: ts("next_attempt_at"),
    lastAttemptAt: ts("last_attempt_at"),
    sentAt: ts("sent_at"),
    deliveredAt: ts("delivered_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date())
  },
  (t) => [
    check("split_sms_deliveries_phone_encrypted_len", sql`char_length(${t.recipientPhoneEncrypted}) between 16 and 2048`),
    check("split_sms_deliveries_phone_hash_len", sql`char_length(${t.recipientPhoneLookupHash}) between 32 and 128`),
    check("split_sms_deliveries_idempotency_len", sql`char_length(${t.idempotencyKey}) between 8 and 180`),
    check("split_sms_deliveries_version_gt0", sql`${t.billVersion} >= 1`),
    check("split_sms_deliveries_attempts_nonnegative", sql`${t.attempts} >= 0`),
    check("split_sms_deliveries_reminder_number_positive", sql`${t.reminderNumber} is null or ${t.reminderNumber} > 0`),
    uniqueIndex("split_sms_deliveries_idempotency_uidx").on(t.idempotencyKey),
    uniqueIndex("split_sms_deliveries_provider_message_uidx").on(t.providerMessageId).where(sql`${t.providerMessageId} is not null`),
    index("split_sms_deliveries_pending_idx").on(t.status, t.nextAttemptAt),
    index("split_sms_deliveries_participant_idx").on(t.participantId)
  ]
);

export const splitWebhookEvents = pgTable(
  "split_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    providerMessageId: text("provider_message_id"),
    deliveryId: uuid("delivery_id").references(() => splitSmsDeliveries.id),
    payloadSha256: text("payload_sha256"),
    processedAt: ts("processed_at").notNull().defaultNow()
  },
  (t) => [
    check("split_webhook_events_provider_len", sql`char_length(${t.provider}) between 1 and 40`),
    uniqueIndex("split_webhook_events_provider_event_uidx").on(t.provider, t.eventId),
    index("split_webhook_events_provider_message_idx").on(t.providerMessageId)
  ]
);

export const splitAuditEvents = pgTable(
  "split_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => splitUsers.id),
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    requestKey: text("request_key"),
    beforeJson: jsonb("before_json"),
    afterJson: jsonb("after_json"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    check("split_audit_events_actor_label_len", sql`char_length(${t.actorLabel}) between 1 and 100`),
    uniqueIndex("split_audit_events_request_key_uidx").on(t.requestKey).where(sql`${t.requestKey} is not null`),
    index("split_audit_events_entity_idx").on(t.entityType, t.entityId),
    index("split_audit_events_actor_idx").on(t.actorUserId),
    index("split_audit_events_created_idx").on(t.createdAt)
  ]
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type MemberRow = typeof members.$inferSelect;
export type NewMemberRow = typeof members.$inferInsert;
export type JoinRequestRow = typeof joinRequests.$inferSelect;
export type PokerSessionRow = typeof pokerSessions.$inferSelect;
export type GolfRoundRow = typeof golfRounds.$inferSelect;
export type SessionResultRow = typeof sessionResults.$inferSelect;
export type DisputeTokenRow = typeof disputeTokens.$inferSelect;
export type DisputeRow = typeof disputes.$inferSelect;
export type GameDisputeRow = typeof gameDisputes.$inferSelect;
export type SettlementRow = typeof settlements.$inferSelect;
export type EmailDeliveryRow = typeof emailDeliveries.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type WebhookEventRow = typeof webhookEvents.$inferSelect;
export type RateLimitBucketRow = typeof rateLimitBuckets.$inferSelect;
export type SplitUserRow = typeof splitUsers.$inferSelect;
export type NewSplitUserRow = typeof splitUsers.$inferInsert;
export type SplitSessionRow = typeof splitSessions.$inferSelect;
export type SplitBillRow = typeof splitBills.$inferSelect;
export type NewSplitBillRow = typeof splitBills.$inferInsert;
export type SplitReceiptFileRow = typeof splitReceiptFiles.$inferSelect;
export type SplitItemRow = typeof splitItems.$inferSelect;
export type NewSplitItemRow = typeof splitItems.$inferInsert;
export type SplitParticipantRow = typeof splitParticipants.$inferSelect;
export type NewSplitParticipantRow = typeof splitParticipants.$inferInsert;
export type SplitItemAllocationRow = typeof splitItemAllocations.$inferSelect;
export type SplitPaymentRow = typeof splitPayments.$inferSelect;
export type SplitSmsDeliveryRow = typeof splitSmsDeliveries.$inferSelect;
export type SplitWebhookEventRow = typeof splitWebhookEvents.$inferSelect;
export type SplitAuditEventRow = typeof splitAuditEvents.$inferSelect;

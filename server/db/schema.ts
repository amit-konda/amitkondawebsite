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
export const liveSessionEventKind = pgEnum("live_session_event_kind", ["buy_in", "cash_out"]);
export const disputeStatus = pgEnum("dispute_status", ["open", "resolved", "dismissed"]);
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
    status: memberStatus("status").notNull().default("active"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date())
  },
  (t) => [
    check("members_display_name_len", sql`char_length(${t.displayName}) between 1 and 80`),
    check("members_email_len", sql`char_length(${t.emailNormalized}) between 3 and 320`),
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

export const handshakeBets = pgTable(
  "handshake_bets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    description: text("description").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    firstMemberId: uuid("first_member_id").notNull().references(() => members.id),
    secondMemberId: uuid("second_member_id").notNull().references(() => members.id),
    winnerMemberId: uuid("winner_member_id").references(() => members.id),
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
    index("handshake_bets_member_idx").on(t.firstMemberId, t.secondMemberId)
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
// Types
// ---------------------------------------------------------------------------
export type MemberRow = typeof members.$inferSelect;
export type NewMemberRow = typeof members.$inferInsert;
export type JoinRequestRow = typeof joinRequests.$inferSelect;
export type PokerSessionRow = typeof pokerSessions.$inferSelect;
export type SessionResultRow = typeof sessionResults.$inferSelect;
export type DisputeTokenRow = typeof disputeTokens.$inferSelect;
export type DisputeRow = typeof disputes.$inferSelect;
export type EmailDeliveryRow = typeof emailDeliveries.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type WebhookEventRow = typeof webhookEvents.$inferSelect;
export type RateLimitBucketRow = typeof rateLimitBuckets.$inferSelect;

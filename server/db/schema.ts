/**
 * Poker Ledger schema — Drizzle ORM, Postgres.
 * All timestamps are timezone-aware UTC. Money is integer cents (bigint).
 * UUIDs generated database-side.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
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
    uniqueIndex("poker_sessions_one_live_uidx").on(t.status).where(sql`${t.status} = 'live'`)
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

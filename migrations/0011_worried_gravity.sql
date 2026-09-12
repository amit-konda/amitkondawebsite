CREATE TYPE "public"."split_allocation_kind" AS ENUM('quantity', 'equal_share', 'manual');--> statement-breakpoint
CREATE TYPE "public"."split_bill_status" AS ENUM('processing', 'review', 'open', 'locked', 'settled', 'voided');--> statement-breakpoint
CREATE TYPE "public"."split_invitation_status" AS ENUM('pending', 'queued', 'sent', 'viewed', 'accepted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."split_payment_report_source" AS ENUM('web', 'sms', 'organizer');--> statement-breakpoint
CREATE TYPE "public"."split_payment_status" AS ENUM('unpaid', 'reported_paid', 'confirmed', 'rejected', 'voided');--> statement-breakpoint
CREATE TYPE "public"."split_receipt_status" AS ENUM('pending', 'uploaded', 'processing', 'ready', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."split_selection_status" AS ENUM('pending', 'selecting', 'complete');--> statement-breakpoint
CREATE TYPE "public"."split_sms_event_type" AS ENUM('invitation', 'final_amount', 'payment_reminder', 'payment_clarification');--> statement-breakpoint
CREATE TYPE "public"."split_sms_status" AS ENUM('queued', 'processing', 'sent', 'delivered', 'failed', 'undelivered', 'suppressed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."split_user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "split_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"request_key" text,
	"before_json" jsonb,
	"after_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_audit_events_actor_label_len" CHECK (char_length("split_audit_events"."actor_label") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "split_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_user_id" uuid NOT NULL,
	"payer_user_id" uuid NOT NULL,
	"merchant_name" text,
	"purchased_at" timestamp with time zone,
	"currency" text DEFAULT 'USD' NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"tip_cents" bigint DEFAULT 0 NOT NULL,
	"fee_cents" bigint DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"status" "split_bill_status" DEFAULT 'processing' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"request_key" text NOT NULL,
	"locked_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_bills_merchant_name_len" CHECK ("split_bills"."merchant_name" is null or char_length("split_bills"."merchant_name") <= 160),
	CONSTRAINT "split_bills_currency_iso_len" CHECK (char_length("split_bills"."currency") = 3),
	CONSTRAINT "split_bills_amounts_nonnegative" CHECK ("split_bills"."subtotal_cents" >= 0 and "split_bills"."tax_cents" >= 0 and "split_bills"."tip_cents" >= 0 and "split_bills"."fee_cents" >= 0 and "split_bills"."discount_cents" >= 0 and "split_bills"."total_cents" >= 0),
	CONSTRAINT "split_bills_amount_limit" CHECK ("split_bills"."total_cents" <= 100000000),
	CONSTRAINT "split_bills_version_gt0" CHECK ("split_bills"."version" >= 1),
	CONSTRAINT "split_bills_request_key_len" CHECK (char_length("split_bills"."request_key") between 8 and 128)
);
--> statement-breakpoint
CREATE TABLE "split_item_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"kind" "split_allocation_kind" NOT NULL,
	"quantity" integer,
	"share_units" integer,
	"amount_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_item_allocations_amount_nonnegative" CHECK ("split_item_allocations"."amount_cents" >= 0),
	CONSTRAINT "split_item_allocations_quantity_positive" CHECK ("split_item_allocations"."quantity" is null or "split_item_allocations"."quantity" > 0),
	CONSTRAINT "split_item_allocations_share_units_positive" CHECK ("split_item_allocations"."share_units" is null or "split_item_allocations"."share_units" > 0),
	CONSTRAINT "split_item_allocations_kind_values" CHECK (("split_item_allocations"."kind" = 'quantity' and "split_item_allocations"."quantity" is not null and "split_item_allocations"."share_units" is null) or ("split_item_allocations"."kind" = 'equal_share' and "split_item_allocations"."share_units" is not null and "split_item_allocations"."quantity" is null) or ("split_item_allocations"."kind" = 'manual' and "split_item_allocations"."quantity" is null and "split_item_allocations"."share_units" is null))
);
--> statement-breakpoint
CREATE TABLE "split_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"line_total_cents" bigint NOT NULL,
	"display_order" integer NOT NULL,
	"ocr_raw_text" text,
	"ocr_confidence_basis_points" integer,
	"organizer_corrected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_items_description_len" CHECK (char_length("split_items"."description") between 1 and 300),
	CONSTRAINT "split_items_quantity_positive" CHECK ("split_items"."quantity" > 0),
	CONSTRAINT "split_items_prices_nonnegative" CHECK ("split_items"."unit_price_cents" >= 0 and "split_items"."line_total_cents" >= 0),
	CONSTRAINT "split_items_price_limit" CHECK ("split_items"."line_total_cents" <= 100000000),
	CONSTRAINT "split_items_display_order_nonnegative" CHECK ("split_items"."display_order" >= 0),
	CONSTRAINT "split_items_ocr_confidence_range" CHECK ("split_items"."ocr_confidence_basis_points" is null or "split_items"."ocr_confidence_basis_points" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "split_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"user_id" uuid,
	"invited_by_user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"invited_phone_encrypted" text NOT NULL,
	"invited_phone_lookup_hash" text NOT NULL,
	"invite_token_hash" text NOT NULL,
	"invitation_status" "split_invitation_status" DEFAULT 'pending' NOT NULL,
	"selection_status" "split_selection_status" DEFAULT 'pending' NOT NULL,
	"payment_status" "split_payment_status" DEFAULT 'unpaid' NOT NULL,
	"item_subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"tip_cents" bigint DEFAULT 0 NOT NULL,
	"fee_cents" bigint DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"final_amount_cents" bigint DEFAULT 0 NOT NULL,
	"invite_sent_at" timestamp with time zone,
	"selection_completed_at" timestamp with time zone,
	"last_reminder_at" timestamp with time zone,
	"next_reminder_at" timestamp with time zone,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"reminders_snoozed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_participants_display_name_len" CHECK (char_length("split_participants"."display_name") between 1 and 80),
	CONSTRAINT "split_participants_phone_encrypted_len" CHECK (char_length("split_participants"."invited_phone_encrypted") between 16 and 2048),
	CONSTRAINT "split_participants_phone_hash_len" CHECK (char_length("split_participants"."invited_phone_lookup_hash") between 32 and 128),
	CONSTRAINT "split_participants_invite_token_hash_len" CHECK (char_length("split_participants"."invite_token_hash") between 32 and 128),
	CONSTRAINT "split_participants_amounts_nonnegative" CHECK ("split_participants"."item_subtotal_cents" >= 0 and "split_participants"."tax_cents" >= 0 and "split_participants"."tip_cents" >= 0 and "split_participants"."fee_cents" >= 0 and "split_participants"."discount_cents" >= 0 and "split_participants"."final_amount_cents" >= 0),
	CONSTRAINT "split_participants_reminder_count_nonnegative" CHECK ("split_participants"."reminder_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "split_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"payer_user_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" "split_payment_status" DEFAULT 'unpaid' NOT NULL,
	"report_source" "split_payment_report_source",
	"request_key" text NOT NULL,
	"reported_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_payments_amount_positive" CHECK ("split_payments"."amount_cents" > 0),
	CONSTRAINT "split_payments_amount_limit" CHECK ("split_payments"."amount_cents" <= 100000000),
	CONSTRAINT "split_payments_request_key_len" CHECK (char_length("split_payments"."request_key") between 8 and 128)
);
--> statement-breakpoint
CREATE TABLE "split_receipt_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"blob_pathname" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum_sha256" text NOT NULL,
	"status" "split_receipt_status" DEFAULT 'pending' NOT NULL,
	"ocr_provider" text,
	"ocr_model" text,
	"ocr_raw_json" jsonb,
	"ocr_error_code" text,
	"retention_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_receipt_files_size_positive" CHECK ("split_receipt_files"."size_bytes" > 0),
	CONSTRAINT "split_receipt_files_size_limit" CHECK ("split_receipt_files"."size_bytes" <= 20971520),
	CONSTRAINT "split_receipt_files_checksum_len" CHECK (char_length("split_receipt_files"."checksum_sha256") = 64)
);
--> statement-breakpoint
CREATE TABLE "split_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_sessions_token_hash_len" CHECK (char_length("split_sessions"."token_hash") between 32 and 128)
);
--> statement-breakpoint
CREATE TABLE "split_sms_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" "split_sms_event_type" NOT NULL,
	"bill_id" uuid NOT NULL,
	"participant_id" uuid,
	"recipient_phone_encrypted" text NOT NULL,
	"recipient_phone_lookup_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"bill_version" integer DEFAULT 1 NOT NULL,
	"reminder_number" integer,
	"provider_message_id" text,
	"status" "split_sms_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"claimed_at" timestamp with time zone,
	"claim_id" text,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_sms_deliveries_phone_encrypted_len" CHECK (char_length("split_sms_deliveries"."recipient_phone_encrypted") between 16 and 2048),
	CONSTRAINT "split_sms_deliveries_phone_hash_len" CHECK (char_length("split_sms_deliveries"."recipient_phone_lookup_hash") between 32 and 128),
	CONSTRAINT "split_sms_deliveries_idempotency_len" CHECK (char_length("split_sms_deliveries"."idempotency_key") between 8 and 180),
	CONSTRAINT "split_sms_deliveries_version_gt0" CHECK ("split_sms_deliveries"."bill_version" >= 1),
	CONSTRAINT "split_sms_deliveries_attempts_nonnegative" CHECK ("split_sms_deliveries"."attempts" >= 0),
	CONSTRAINT "split_sms_deliveries_reminder_number_positive" CHECK ("split_sms_deliveries"."reminder_number" is null or "split_sms_deliveries"."reminder_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "split_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"phone_encrypted" text NOT NULL,
	"phone_lookup_hash" text NOT NULL,
	"status" "split_user_status" DEFAULT 'active' NOT NULL,
	"payment_provider" text,
	"payment_handle" text,
	"sms_consent_at" timestamp with time zone,
	"sms_opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_users_display_name_len" CHECK (char_length("split_users"."display_name") between 1 and 80),
	CONSTRAINT "split_users_phone_encrypted_len" CHECK (char_length("split_users"."phone_encrypted") between 16 and 2048),
	CONSTRAINT "split_users_phone_hash_len" CHECK (char_length("split_users"."phone_lookup_hash") between 32 and 128),
	CONSTRAINT "split_users_payment_provider_len" CHECK ("split_users"."payment_provider" is null or char_length("split_users"."payment_provider") between 1 and 30),
	CONSTRAINT "split_users_payment_handle_len" CHECK ("split_users"."payment_handle" is null or char_length("split_users"."payment_handle") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "split_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"provider_message_id" text,
	"delivery_id" uuid,
	"payload_sha256" text,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_webhook_events_provider_len" CHECK (char_length("split_webhook_events"."provider") between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "split_audit_events" ADD CONSTRAINT "split_audit_events_actor_user_id_split_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."split_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_bills" ADD CONSTRAINT "split_bills_organizer_user_id_split_users_id_fk" FOREIGN KEY ("organizer_user_id") REFERENCES "public"."split_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_bills" ADD CONSTRAINT "split_bills_payer_user_id_split_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."split_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_item_allocations" ADD CONSTRAINT "split_item_allocations_item_id_split_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."split_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_item_allocations" ADD CONSTRAINT "split_item_allocations_participant_id_split_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."split_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_items" ADD CONSTRAINT "split_items_bill_id_split_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."split_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_participants" ADD CONSTRAINT "split_participants_bill_id_split_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."split_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_participants" ADD CONSTRAINT "split_participants_user_id_split_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."split_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_participants" ADD CONSTRAINT "split_participants_invited_by_user_id_split_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."split_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_payments" ADD CONSTRAINT "split_payments_bill_id_split_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."split_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_payments" ADD CONSTRAINT "split_payments_participant_id_split_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."split_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_payments" ADD CONSTRAINT "split_payments_payer_user_id_split_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."split_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_receipt_files" ADD CONSTRAINT "split_receipt_files_bill_id_split_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."split_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_sessions" ADD CONSTRAINT "split_sessions_user_id_split_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."split_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_sms_deliveries" ADD CONSTRAINT "split_sms_deliveries_bill_id_split_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."split_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_sms_deliveries" ADD CONSTRAINT "split_sms_deliveries_participant_id_split_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."split_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_webhook_events" ADD CONSTRAINT "split_webhook_events_delivery_id_split_sms_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."split_sms_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "split_audit_events_request_key_uidx" ON "split_audit_events" USING btree ("request_key") WHERE "split_audit_events"."request_key" is not null;--> statement-breakpoint
CREATE INDEX "split_audit_events_entity_idx" ON "split_audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "split_audit_events_actor_idx" ON "split_audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "split_audit_events_created_idx" ON "split_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "split_bills_request_key_uidx" ON "split_bills" USING btree ("request_key");--> statement-breakpoint
CREATE INDEX "split_bills_organizer_status_idx" ON "split_bills" USING btree ("organizer_user_id","status");--> statement-breakpoint
CREATE INDEX "split_bills_payer_status_idx" ON "split_bills" USING btree ("payer_user_id","status");--> statement-breakpoint
CREATE INDEX "split_bills_created_idx" ON "split_bills" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "split_item_allocations_item_participant_uidx" ON "split_item_allocations" USING btree ("item_id","participant_id");--> statement-breakpoint
CREATE INDEX "split_item_allocations_participant_idx" ON "split_item_allocations" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "split_items_bill_order_uidx" ON "split_items" USING btree ("bill_id","display_order");--> statement-breakpoint
CREATE INDEX "split_items_bill_idx" ON "split_items" USING btree ("bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "split_participants_invite_token_uidx" ON "split_participants" USING btree ("invite_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "split_participants_bill_phone_uidx" ON "split_participants" USING btree ("bill_id","invited_phone_lookup_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "split_participants_bill_user_uidx" ON "split_participants" USING btree ("bill_id","user_id") WHERE "split_participants"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "split_participants_user_idx" ON "split_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "split_participants_due_reminder_idx" ON "split_participants" USING btree ("payment_status","next_reminder_at");--> statement-breakpoint
CREATE INDEX "split_participants_bill_status_idx" ON "split_participants" USING btree ("bill_id","payment_status");--> statement-breakpoint
CREATE UNIQUE INDEX "split_payments_request_key_uidx" ON "split_payments" USING btree ("request_key");--> statement-breakpoint
CREATE INDEX "split_payments_participant_idx" ON "split_payments" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "split_payments_bill_status_idx" ON "split_payments" USING btree ("bill_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "split_receipt_files_blob_path_uidx" ON "split_receipt_files" USING btree ("blob_pathname");--> statement-breakpoint
CREATE INDEX "split_receipt_files_bill_idx" ON "split_receipt_files" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "split_receipt_files_status_idx" ON "split_receipt_files" USING btree ("status");--> statement-breakpoint
CREATE INDEX "split_receipt_files_retention_idx" ON "split_receipt_files" USING btree ("retention_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "split_sessions_token_hash_uidx" ON "split_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "split_sessions_user_idx" ON "split_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "split_sessions_expires_idx" ON "split_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "split_sms_deliveries_idempotency_uidx" ON "split_sms_deliveries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "split_sms_deliveries_provider_message_uidx" ON "split_sms_deliveries" USING btree ("provider_message_id") WHERE "split_sms_deliveries"."provider_message_id" is not null;--> statement-breakpoint
CREATE INDEX "split_sms_deliveries_pending_idx" ON "split_sms_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "split_sms_deliveries_participant_idx" ON "split_sms_deliveries" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "split_users_phone_lookup_hash_uidx" ON "split_users" USING btree ("phone_lookup_hash");--> statement-breakpoint
CREATE INDEX "split_users_status_idx" ON "split_users" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "split_webhook_events_provider_event_uidx" ON "split_webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "split_webhook_events_provider_message_idx" ON "split_webhook_events" USING btree ("provider_message_id");
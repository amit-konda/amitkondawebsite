ALTER TYPE "public"."email_status" ADD VALUE 'processing';--> statement-breakpoint
ALTER TYPE "public"."email_status" ADD VALUE 'delayed';--> statement-breakpoint
ALTER TYPE "public"."email_status" ADD VALUE 'dead_letter';--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"scope" text NOT NULL,
	"key_hash" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_buckets_scope_key_hash_window_started_at_pk" PRIMARY KEY("scope","key_hash","window_started_at")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"provider_message_id" text,
	"delivery_id" uuid,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "claim_id" text;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_delivery_id_email_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."email_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_expires_idx" ON "rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "webhook_events_provider_msg_idx" ON "webhook_events" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "disputes_session_idx" ON "disputes" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "email_deliveries_pending_idx" ON "email_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "email_deliveries_provider_idx" ON "email_deliveries" USING btree ("provider_id");
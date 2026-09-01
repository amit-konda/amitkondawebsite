CREATE TYPE "public"."live_session_event_kind" AS ENUM('buy_in', 'cash_out');--> statement-breakpoint
CREATE TABLE "live_session_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "member_id" uuid NOT NULL,
  "kind" "live_session_event_kind" NOT NULL,
  "buy_in_id" uuid,
  "previous_cash_out_cents" bigint,
  "had_previous_cash_out" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "live_session_events" ADD CONSTRAINT "live_session_events_session_id_poker_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."poker_sessions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "live_session_events" ADD CONSTRAINT "live_session_events_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "live_session_events" ADD CONSTRAINT "live_session_events_buy_in_id_live_buy_ins_id_fk" FOREIGN KEY ("buy_in_id") REFERENCES "public"."live_buy_ins"("id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "live_session_events_session_idx" ON "live_session_events" USING btree ("session_id", "created_at");

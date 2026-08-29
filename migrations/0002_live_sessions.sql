ALTER TYPE "public"."session_status" ADD VALUE 'live';--> statement-breakpoint
ALTER TABLE "session_results" DROP CONSTRAINT "session_results_amount_nonzero";--> statement-breakpoint
CREATE TABLE "live_buy_ins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "member_id" uuid NOT NULL,
  "amount_cents" bigint NOT NULL,
  "recorded_by_member_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "live_buy_ins_amount_positive" CHECK ("live_buy_ins"."amount_cents" > 0),
  CONSTRAINT "live_buy_ins_amount_limit" CHECK ("live_buy_ins"."amount_cents" <= 100000000)
);--> statement-breakpoint
CREATE TABLE "live_cash_outs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "member_id" uuid NOT NULL,
  "amount_cents" bigint NOT NULL,
  "recorded_by_member_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "live_cash_outs_amount_nonnegative" CHECK ("live_cash_outs"."amount_cents" >= 0),
  CONSTRAINT "live_cash_outs_amount_limit" CHECK ("live_cash_outs"."amount_cents" <= 100000000)
);--> statement-breakpoint
ALTER TABLE "live_buy_ins" ADD CONSTRAINT "live_buy_ins_session_id_poker_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."poker_sessions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "live_buy_ins" ADD CONSTRAINT "live_buy_ins_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "live_buy_ins" ADD CONSTRAINT "live_buy_ins_recorded_by_member_id_members_id_fk" FOREIGN KEY ("recorded_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "live_cash_outs" ADD CONSTRAINT "live_cash_outs_session_id_poker_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."poker_sessions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "live_cash_outs" ADD CONSTRAINT "live_cash_outs_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "live_cash_outs" ADD CONSTRAINT "live_cash_outs_recorded_by_member_id_members_id_fk" FOREIGN KEY ("recorded_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action;--> statement-breakpoint
CREATE INDEX "live_buy_ins_session_idx" ON "live_buy_ins" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "live_buy_ins_member_idx" ON "live_buy_ins" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "live_cash_outs_session_member_uidx" ON "live_cash_outs" USING btree ("session_id", "member_id");--> statement-breakpoint
CREATE INDEX "live_cash_outs_session_idx" ON "live_cash_outs" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "poker_sessions_one_live_uidx" ON "poker_sessions" ("status") WHERE "status" = 'live';

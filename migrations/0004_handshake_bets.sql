CREATE TYPE "public"."handshake_bet_status" AS ENUM('open', 'settled', 'voided');--> statement-breakpoint
CREATE TABLE "handshake_bets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "description" text NOT NULL,
  "amount_cents" bigint NOT NULL,
  "first_member_id" uuid NOT NULL,
  "second_member_id" uuid NOT NULL,
  "winner_member_id" uuid,
  "status" "handshake_bet_status" DEFAULT 'open' NOT NULL,
  "created_by_member_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  CONSTRAINT "handshake_bets_amount_positive" CHECK ("handshake_bets"."amount_cents" > 0),
  CONSTRAINT "handshake_bets_amount_limit" CHECK ("handshake_bets"."amount_cents" <= 100000000),
  CONSTRAINT "handshake_bets_distinct_members" CHECK ("handshake_bets"."first_member_id" <> "handshake_bets"."second_member_id")
);--> statement-breakpoint
ALTER TABLE "handshake_bets" ADD CONSTRAINT "handshake_bets_first_member_id_members_id_fk" FOREIGN KEY ("first_member_id") REFERENCES "public"."members"("id");--> statement-breakpoint
ALTER TABLE "handshake_bets" ADD CONSTRAINT "handshake_bets_second_member_id_members_id_fk" FOREIGN KEY ("second_member_id") REFERENCES "public"."members"("id");--> statement-breakpoint
ALTER TABLE "handshake_bets" ADD CONSTRAINT "handshake_bets_winner_member_id_members_id_fk" FOREIGN KEY ("winner_member_id") REFERENCES "public"."members"("id");--> statement-breakpoint
ALTER TABLE "handshake_bets" ADD CONSTRAINT "handshake_bets_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id");--> statement-breakpoint
CREATE INDEX "handshake_bets_status_idx" ON "handshake_bets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "handshake_bets_member_idx" ON "handshake_bets" USING btree ("first_member_id", "second_member_id");

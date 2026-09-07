CREATE TYPE "public"."game_dispute_entity" AS ENUM('handshake_bet', 'golf_round');--> statement-breakpoint
CREATE TABLE "game_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" "game_dispute_entity" NOT NULL,
	"entity_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "game_disputes_reason_len" CHECK (char_length("game_disputes"."reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "game_disputes" ADD CONSTRAINT "game_disputes_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_disputes_open_entity_member_uidx" ON "game_disputes" USING btree ("entity_type","entity_id","member_id") WHERE "game_disputes"."status" = 'open';--> statement-breakpoint
CREATE INDEX "game_disputes_status_idx" ON "game_disputes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "game_disputes_entity_idx" ON "game_disputes" USING btree ("entity_type","entity_id");
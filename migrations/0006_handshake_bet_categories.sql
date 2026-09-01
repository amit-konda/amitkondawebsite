CREATE TABLE "handshake_bet_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "created_by_member_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "handshake_bet_categories_name_len" CHECK (char_length("handshake_bet_categories"."name") between 1 and 40)
);--> statement-breakpoint
ALTER TABLE "handshake_bet_categories" ADD CONSTRAINT "handshake_bet_categories_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handshake_bet_categories_name_ci_idx" ON "handshake_bet_categories" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "handshake_bets" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "handshake_bets" ADD CONSTRAINT "handshake_bets_category_id_handshake_bet_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."handshake_bet_categories"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "handshake_bets_category_idx" ON "handshake_bets" USING btree ("category_id");--> statement-breakpoint
INSERT INTO "handshake_bet_categories" ("name") VALUES ('Golf'), ('Football'), ('Meals'), ('Other');

CREATE TYPE "public"."settlement_status" AS ENUM('pending', 'confirmed', 'voided');--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_member_id" uuid NOT NULL,
	"to_member_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"method" text DEFAULT 'venmo' NOT NULL,
	"note" text,
	"status" "settlement_status" DEFAULT 'pending' NOT NULL,
	"request_key" text NOT NULL,
	"created_by_member_id" uuid,
	"confirmed_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	CONSTRAINT "settlements_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "settlements_amount_positive" CHECK ("settlements"."amount_cents" > 0),
	CONSTRAINT "settlements_amount_limit" CHECK ("settlements"."amount_cents" <= 100000000),
	CONSTRAINT "settlements_distinct_members" CHECK ("settlements"."from_member_id" <> "settlements"."to_member_id"),
	CONSTRAINT "settlements_method_len" CHECK (char_length("settlements"."method") between 1 and 30),
	CONSTRAINT "settlements_note_len" CHECK ("settlements"."note" is null or char_length("settlements"."note") <= 500),
	CONSTRAINT "settlements_request_key_len" CHECK (char_length("settlements"."request_key") between 8 and 64)
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "venmo_username" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_from_member_id_members_id_fk" FOREIGN KEY ("from_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_to_member_id_members_id_fk" FOREIGN KEY ("to_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_confirmed_by_member_id_members_id_fk" FOREIGN KEY ("confirmed_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settlements_status_idx" ON "settlements" USING btree ("status");--> statement-breakpoint
CREATE INDEX "settlements_from_idx" ON "settlements" USING btree ("from_member_id");--> statement-breakpoint
CREATE INDEX "settlements_to_idx" ON "settlements" USING btree ("to_member_id");--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_venmo_username_len" CHECK ("members"."venmo_username" is null or char_length("members"."venmo_username") between 1 and 30);
ALTER TABLE "split_users" DROP CONSTRAINT "split_users_phone_encrypted_len";--> statement-breakpoint
ALTER TABLE "split_users" DROP CONSTRAINT "split_users_phone_hash_len";--> statement-breakpoint
ALTER TABLE "split_users" ALTER COLUMN "phone_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "split_users" ALTER COLUMN "phone_lookup_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "split_users" ADD COLUMN "google_subject" text;--> statement-breakpoint
ALTER TABLE "split_users" ADD COLUMN "email" text;--> statement-breakpoint
CREATE UNIQUE INDEX "split_users_google_subject_uidx" ON "split_users" USING btree ("google_subject");--> statement-breakpoint
ALTER TABLE "split_users" ADD CONSTRAINT "split_users_phone_encrypted_len" CHECK ("split_users"."phone_encrypted" is null or char_length("split_users"."phone_encrypted") between 16 and 2048);--> statement-breakpoint
ALTER TABLE "split_users" ADD CONSTRAINT "split_users_phone_hash_len" CHECK ("split_users"."phone_lookup_hash" is null or char_length("split_users"."phone_lookup_hash") between 32 and 128);
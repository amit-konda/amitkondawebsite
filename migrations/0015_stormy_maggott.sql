CREATE TABLE "jobs_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_members_name_unique" UNIQUE("name"),
	CONSTRAINT "jobs_members_name_len" CHECK (char_length("jobs_members"."name") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "submitted_by_member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "submitted_by_jobs_member_id" uuid;--> statement-breakpoint
INSERT INTO "jobs_members" ("name") SELECT DISTINCT m."display_name" FROM "members" m INNER JOIN "jobs" j ON j."submitted_by_member_id" = m."id" ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
UPDATE "jobs" j SET "submitted_by_jobs_member_id" = jm."id" FROM "jobs_members" jm INNER JOIN "members" m ON m."display_name" = jm."name" WHERE j."submitted_by_member_id" = m."id";--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "submitted_by_jobs_member_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_submitted_by_jobs_member_id_jobs_members_id_fk" FOREIGN KEY ("submitted_by_jobs_member_id") REFERENCES "public"."jobs_members"("id") ON DELETE no action ON UPDATE no action;

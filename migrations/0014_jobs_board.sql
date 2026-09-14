CREATE TYPE "public"."job_type" AS ENUM('software_engineering', 'data_ai', 'product', 'design', 'finance', 'consulting', 'sales', 'marketing', 'operations', 'legal_policy', 'other');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"application_url" text NOT NULL,
	"job_type" "job_type" NOT NULL,
	"description" text,
	"application_deadline" timestamp with time zone,
	"submitted_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_title_len" CHECK (char_length("jobs"."title") between 1 and 180),
	CONSTRAINT "jobs_company_len" CHECK (char_length("jobs"."company") between 1 and 160),
	CONSTRAINT "jobs_url_len" CHECK (char_length("jobs"."application_url") between 8 and 2000),
	CONSTRAINT "jobs_description_len" CHECK ("jobs"."description" is null or char_length("jobs"."description") <= 4000)
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_submitted_by_member_id_members_id_fk" FOREIGN KEY ("submitted_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_type_created_idx" ON "jobs" USING btree ("job_type","created_at");--> statement-breakpoint
CREATE INDEX "jobs_deadline_idx" ON "jobs" USING btree ("application_deadline");--> statement-breakpoint
CREATE INDEX "jobs_submitter_idx" ON "jobs" USING btree ("submitted_by_member_id");
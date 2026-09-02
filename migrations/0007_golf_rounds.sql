CREATE TYPE "public"."golf_course" AS ENUM('butler', 'hancock');--> statement-breakpoint
CREATE TABLE "golf_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"course" "golf_course" NOT NULL,
	"strokes" integer NOT NULL,
	"par" integer NOT NULL,
	"played_at" timestamp with time zone NOT NULL,
	"recorded_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "golf_rounds_strokes_range" CHECK ("golf_rounds"."strokes" between 1 and 300),
	CONSTRAINT "golf_rounds_par_range" CHECK ("golf_rounds"."par" between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "golf_rounds" ADD CONSTRAINT "golf_rounds_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golf_rounds" ADD CONSTRAINT "golf_rounds_recorded_by_member_id_members_id_fk" FOREIGN KEY ("recorded_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "golf_rounds_member_course_idx" ON "golf_rounds" USING btree ("member_id","course","played_at");

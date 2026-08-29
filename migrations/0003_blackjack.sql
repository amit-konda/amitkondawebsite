CREATE TYPE "public"."game_type" AS ENUM('poker', 'blackjack');--> statement-breakpoint
ALTER TABLE "poker_sessions" ADD COLUMN "game_type" "game_type" DEFAULT 'poker' NOT NULL;

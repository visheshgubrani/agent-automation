CREATE TYPE "public"."notification_delivery_policy" AS ENUM('at_most_once', 'at_least_once');--> statement-breakpoint
ALTER TYPE "public"."notification_status" ADD VALUE 'quarantined';--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "delivery_policy" "notification_delivery_policy" DEFAULT 'at_most_once' NOT NULL;--> statement-breakpoint
-- Backfill existing urgent-kind rows: the column default alone would assign them
-- at_most_once, which is the wrong policy for email_triage/approval_request (D021).
UPDATE "notification_outbox" SET "delivery_policy" = 'at_least_once' WHERE "kind" IN ('email_triage', 'approval_request');

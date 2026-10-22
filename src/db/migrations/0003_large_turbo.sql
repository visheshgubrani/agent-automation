CREATE TYPE "public"."classification_decision_source" AS ENUM('classifier', 'rule', 'correction');--> statement-breakpoint
CREATE TYPE "public"."classification_topic" AS ENUM('banking', 'work', 'career', 'other');--> statement-breakpoint
CREATE TYPE "public"."mail_rule_action" AS ENUM('notify', 'ignore');--> statement-breakpoint
CREATE TYPE "public"."mail_rule_match_type" AS ENUM('sender', 'domain');--> statement-breakpoint
CREATE TYPE "public"."reasoning_effort" AS ENUM('medium', 'high');--> statement-breakpoint
CREATE TABLE "company_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" text NOT NULL,
	"label" text,
	"note" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_domains_domain_check" CHECK ("company_domains"."domain" = lower(btrim("company_domains"."domain")) and length("company_domains"."domain") > 0)
);
--> statement-breakpoint
CREATE TABLE "mail_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" "mail_rule_action" NOT NULL,
	"match_type" "mail_rule_match_type" NOT NULL,
	"match_value" text NOT NULL,
	"subject_contains" text,
	"account_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_rules_match_value_check" CHECK ("mail_rules"."match_value" = lower(btrim("mail_rules"."match_value")) and length("mail_rules"."match_value") > 0),
	CONSTRAINT "mail_rules_subject_contains_check" CHECK ("mail_rules"."subject_contains" is null or length(btrim("mail_rules"."subject_contains")) > 0)
);
--> statement-breakpoint
DROP VIEW "public"."classifier_feedback_examples";--> statement-breakpoint
ALTER TABLE "llm_calls" DROP CONSTRAINT "llm_calls_nonnegative_check";--> statement-breakpoint
ALTER TABLE "email_classifications" DROP CONSTRAINT "email_classifications_confidence_check";--> statement-breakpoint
ALTER TABLE "user_settings" DROP CONSTRAINT "user_settings_batch_window_check";--> statement-breakpoint
ALTER TABLE "email_classifications" ALTER COLUMN "confidence" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_classifications" ALTER COLUMN "model" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_classifications" ALTER COLUMN "prompt_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_classifications" ALTER COLUMN "classifier_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "timezone" SET DEFAULT 'Asia/Kolkata';--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "batch_window_minutes" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "batch_window_minutes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "daily_spend_limit_usd" SET DEFAULT '1.00';--> statement-breakpoint
ALTER TABLE "mailbox_sync_state" ADD COLUMN "notification_boundary_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "reasoning_effort" "reasoning_effort";--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "reserved_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_classifications" ADD COLUMN "topic" "classification_topic" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_classifications" ADD COLUMN "should_notify" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "email_classifications" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "email_classifications" ADD COLUMN "decision_source" "classification_decision_source" DEFAULT 'classifier' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_classifications" ADD COLUMN "applied_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "email_classifications" ADD COLUMN "reasoning_effort" "reasoning_effort";--> statement-breakpoint
ALTER TABLE "mail_rules" ADD CONSTRAINT "mail_rules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_domains_domain_lower_uq" ON "company_domains" USING btree (lower("domain"));--> statement-breakpoint
CREATE INDEX "mail_rules_match_idx" ON "mail_rules" USING btree ("match_type","match_value","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "mail_rules"."active";--> statement-breakpoint
CREATE INDEX "mail_rules_account_idx" ON "mail_rules" USING btree ("account_id") WHERE "mail_rules"."account_id" is not null;--> statement-breakpoint
ALTER TABLE "email_classifications" ADD CONSTRAINT "email_classifications_applied_rule_id_mail_rules_id_fk" FOREIGN KEY ("applied_rule_id") REFERENCES "public"."mail_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_classifications_applied_rule_idx" ON "email_classifications" USING btree ("applied_rule_id") WHERE "email_classifications"."applied_rule_id" is not null;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_nonnegative_check" CHECK ("llm_calls"."prompt_tokens" >= 0
        and "llm_calls"."cached_input_tokens" >= 0
        and "llm_calls"."completion_tokens" >= 0
        and "llm_calls"."reasoning_tokens" >= 0
        and "llm_calls"."reserved_cost_usd" >= 0
        and "llm_calls"."cost_usd" >= 0
        and "llm_calls"."latency_ms" >= 0);--> statement-breakpoint
ALTER TABLE "email_classifications" ADD CONSTRAINT "email_classifications_decision_source_check" CHECK ((
        ("email_classifications"."decision_source" = 'classifier'
          and "email_classifications"."model" is not null
          and "email_classifications"."prompt_version" is not null
          and "email_classifications"."classifier_version" is not null
          and "email_classifications"."confidence" is not null
          and "email_classifications"."applied_rule_id" is null)
        or ("email_classifications"."decision_source" = 'rule'
          and "email_classifications"."model" is null
          and "email_classifications"."prompt_version" is null
          and "email_classifications"."classifier_version" is null
          and "email_classifications"."confidence" is null
          and "email_classifications"."reasoning_effort" is null
          and "email_classifications"."applied_rule_id" is not null)
        or ("email_classifications"."decision_source" = 'correction'
          and "email_classifications"."model" is null
          and "email_classifications"."prompt_version" is null
          and "email_classifications"."classifier_version" is null
          and "email_classifications"."confidence" is null
          and "email_classifications"."reasoning_effort" is null
          and "email_classifications"."applied_rule_id" is null)
      ));--> statement-breakpoint
ALTER TABLE "email_classifications" ADD CONSTRAINT "email_classifications_confidence_check" CHECK ("email_classifications"."confidence" is null or ("email_classifications"."confidence" >= 0 and "email_classifications"."confidence" <= 1));--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_batch_window_check" CHECK ("user_settings"."batch_window_minutes" is null or "user_settings"."batch_window_minutes" > 0);--> statement-breakpoint
CREATE VIEW "public"."classifier_feedback_examples" AS (select "classification_feedback"."id" as "feedback_id", "classification_feedback"."rating" as "rating", "classification_feedback"."reason" as "reason", "classification_feedback"."note" as "note", "classification_feedback"."updated_at" as "labeled_at", "email_classifications"."id" as "classification_id", "email_classifications"."category" as "category", "email_classifications"."topic" as "topic", "email_classifications"."should_notify" as "should_notify", "email_classifications"."confidence" as "confidence", "email_classifications"."summary" as "summary", "email_classifications"."model" as "model", "email_classifications"."prompt_version" as "prompt_version", "email_classifications"."classifier_version" as "classifier_version", "email_classifications"."decision_source" as "decision_source", "email_classifications"."applied_rule_id" as "applied_rule_id", "email_classifications"."reasoning_effort" as "reasoning_effort", "messages"."id" as "message_id", "messages"."account_id" as "account_id", "messages"."rfc_message_id" as "rfc_message_id", "messages"."from_email" as "from_email", "messages"."subject" as "subject", "messages"."clean_text" as "clean_text", "messages"."received_at" as "received_at", "notification_outbox"."id" as "notification_id", "notification_outbox"."sent_at" as "notification_sent_at" from "classification_feedback" inner join "email_classifications" on "email_classifications"."id" = "classification_feedback"."classification_id" inner join "messages" on "messages"."id" = "email_classifications"."message_id" left join "notification_outbox" on "notification_outbox"."id" = "classification_feedback"."notification_id");--> statement-breakpoint
-- Backfill existing classifier rows. No prior row is treated as a rule/correction decision.
UPDATE "email_classifications"
SET "should_notify" = ("category" IN ('urgent', 'needs_reply'))
WHERE "decision_source" = 'classifier' AND "should_notify" = false;--> statement-breakpoint
-- Seed the singleton only when absent; never overwrite user-chosen preferences.
INSERT INTO "user_settings" ("id", "timezone", "quiet_hours_start", "quiet_hours_end", "batch_window_minutes", "daily_spend_limit_usd")
VALUES (1, 'Asia/Kolkata', NULL, NULL, NULL, 1.00)
ON CONFLICT ("id") DO NOTHING;
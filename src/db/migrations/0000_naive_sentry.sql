CREATE TYPE "public"."account_provider" AS ENUM('gmail');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('active', 'paused', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."approval_resolver" AS ENUM('telegram', 'api', 'system');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'denied', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."credential_kind" AS ENUM('oauth_refresh_token', 'oauth_access_token');--> statement-breakpoint
CREATE TYPE "public"."feedback_rating" AS ENUM('useful', 'not_useful');--> statement-breakpoint
CREATE TYPE "public"."feedback_reason" AS ENUM('missed_important', 'wrong_category', 'too_noisy', 'other');--> statement-breakpoint
CREATE TYPE "public"."llm_call_status" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('telegram');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('email_triage', 'approval_request', 'system');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'batched', 'sending', 'sent', 'failed', 'expired', 'cancelled', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."risk_tier" AS ENUM('read', 'notify', 'draft', 'send');--> statement-breakpoint
CREATE TYPE "public"."run_kind" AS ENUM('mail_sync', 'mail_triage', 'notification_dispatch', 'agent_chat', 'approval_execution', 'system');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('schedule', 'webhook', 'manual', 'telegram', 'retry', 'approval');--> statement-breakpoint
CREATE TYPE "public"."telegram_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."telegram_update_kind" AS ENUM('message', 'edited_message', 'callback_query', 'other');--> statement-breakpoint
CREATE TYPE "public"."tone_sample_source" AS ENUM('manual', 'approved_draft', 'feedback');--> statement-breakpoint
CREATE TYPE "public"."tool_call_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."triage_category" AS ENUM('urgent', 'needs_reply', 'fyi', 'ignore');--> statement-breakpoint
CREATE TYPE "public"."triage_status" AS ENUM('pending', 'in_progress', 'classified', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."watchlist_kind" AS ENUM('ticker', 'company', 'topic', 'person');--> statement-breakpoint
CREATE TABLE "account_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "credential_kind" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"key_version" smallint NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_credentials_account_kind_uq" UNIQUE("account_id","kind"),
	CONSTRAINT "account_credentials_key_version_check" CHECK ("account_credentials"."key_version" > 0),
	CONSTRAINT "account_credentials_ciphertext_check" CHECK (octet_length("account_credentials"."ciphertext") > 0),
	CONSTRAINT "account_credentials_nonce_check" CHECK (octet_length("account_credentials"."nonce") = 12),
	CONSTRAINT "account_credentials_auth_tag_check" CHECK (octet_length("account_credentials"."auth_tag") = 16)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "account_provider" NOT NULL,
	"email_address" text NOT NULL,
	"display_name" text,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_sync_state" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"history_id" text,
	"needs_full_resync" boolean DEFAULT false NOT NULL,
	"initial_sync_completed_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"backoff_until" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_sync_state_failures_check" CHECK ("mailbox_sync_state"."consecutive_failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "run_kind" NOT NULL,
	"trigger" "run_trigger" NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"parent_run_id" uuid,
	"boss_job_id" uuid,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_status_finished_check" CHECK (("runs"."status" = 'running') = ("runs"."finished_at" is null)),
	CONSTRAINT "runs_finished_after_started_check" CHECK ("runs"."finished_at" is null or "runs"."finished_at" >= "runs"."started_at"),
	CONSTRAINT "runs_parent_not_self_check" CHECK ("runs"."parent_run_id" is null or "runs"."parent_run_id" <> "runs"."id")
);
--> statement-breakpoint
CREATE TABLE "email_classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"category" "triage_category" NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"reason" text,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"classifier_version" text NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_classifications_confidence_check" CHECK ("email_classifications"."confidence" >= 0 and "email_classifications"."confidence" <= 1),
	CONSTRAINT "email_classifications_superseded_check" CHECK ("email_classifications"."superseded_at" is null or "email_classifications"."superseded_at" >= "email_classifications"."created_at")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"provider_thread_id" text,
	"rfc_message_id" text,
	"from_email" text NOT NULL,
	"from_name" text,
	"to_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"cc_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"provider_labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"raw_text" text NOT NULL,
	"raw_content_type" text DEFAULT 'text/plain' NOT NULL,
	"clean_text" text DEFAULT '' NOT NULL,
	"cleaner_version" smallint DEFAULT 1 NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"triage_status" "triage_status" DEFAULT 'pending' NOT NULL,
	"triage_attempts" integer DEFAULT 0 NOT NULL,
	"triage_last_error" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_account_provider_message_uq" UNIQUE("account_id","provider_message_id"),
	CONSTRAINT "messages_triage_attempts_check" CHECK ("messages"."triage_attempts" >= 0),
	CONSTRAINT "messages_cleaner_version_check" CHECK ("messages"."cleaner_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"risk_tier" "risk_tier" NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"retry_of_approval_id" uuid,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolver" "approval_resolver",
	"resolver_ref" text,
	"resolution_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_dedupe_key_uq" UNIQUE("dedupe_key"),
	CONSTRAINT "approvals_expiry_check" CHECK ("approvals"."expires_at" > "approvals"."requested_at"),
	CONSTRAINT "approvals_pending_resolved_check" CHECK (("approvals"."status" = 'pending') = ("approvals"."resolved_at" is null)),
	CONSTRAINT "approvals_pending_resolver_check" CHECK (("approvals"."status" = 'pending') = ("approvals"."resolver" is null)),
	CONSTRAINT "approvals_retry_not_self_check" CHECK ("approvals"."retry_of_approval_id" is null or "approvals"."retry_of_approval_id" <> "approvals"."id")
);
--> statement-breakpoint
CREATE TABLE "classification_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"classification_id" uuid NOT NULL,
	"notification_id" uuid,
	"rating" "feedback_rating" NOT NULL,
	"reason" "feedback_reason",
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classification_feedback_classification_uq" UNIQUE("classification_id")
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"channel" "notification_channel" DEFAULT 'telegram' NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"dedupe_key" text NOT NULL,
	"batch_key" text,
	"body" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"classification_id" uuid,
	"approval_id" uuid,
	"run_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"telegram_message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_dedupe_key_uq" UNIQUE("dedupe_key"),
	CONSTRAINT "notification_outbox_attempts_check" CHECK ("notification_outbox"."attempt_count" >= 0),
	CONSTRAINT "notification_outbox_sent_at_check" CHECK (("notification_outbox"."status" = 'sent') = ("notification_outbox"."sent_at" is not null)),
	CONSTRAINT "notification_outbox_expires_check" CHECK ("notification_outbox"."expires_at" is null or "notification_outbox"."expires_at" > "notification_outbox"."created_at"),
	CONSTRAINT "notification_outbox_kind_context_check" CHECK ((
        ("notification_outbox"."kind" = 'email_triage' and "notification_outbox"."classification_id" is not null and "notification_outbox"."approval_id" is null)
        or ("notification_outbox"."kind" = 'approval_request' and "notification_outbox"."approval_id" is not null and "notification_outbox"."classification_id" is null)
        or ("notification_outbox"."kind" = 'system' and "notification_outbox"."classification_id" is null and "notification_outbox"."approval_id" is null)
      ))
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"status" "llm_call_status" NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"provider_request_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_calls_nonnegative_check" CHECK ("llm_calls"."prompt_tokens" >= 0
        and "llm_calls"."cached_input_tokens" >= 0
        and "llm_calls"."completion_tokens" >= 0
        and "llm_calls"."reasoning_tokens" >= 0
        and "llm_calls"."cost_usd" >= 0
        and "llm_calls"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"risk_tier" "risk_tier" NOT NULL,
	"status" "tool_call_status" NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"approval_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"latency_ms" integer,
	CONSTRAINT "tool_calls_status_finished_check" CHECK (("tool_calls"."status" = 'running') = ("tool_calls"."finished_at" is null)),
	CONSTRAINT "tool_calls_finished_after_started_check" CHECK ("tool_calls"."finished_at" is null or "tool_calls"."finished_at" >= "tool_calls"."started_at"),
	CONSTRAINT "tool_calls_latency_check" CHECK ("tool_calls"."latency_ms" is null or "tool_calls"."latency_ms" >= 0),
	CONSTRAINT "tool_calls_send_requires_approval_check" CHECK ("tool_calls"."risk_tier" <> 'send' or "tool_calls"."approval_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "interests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tone_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"content" text NOT NULL,
	"source" "tone_sample_source" DEFAULT 'manual' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"quiet_hours_start" time,
	"quiet_hours_end" time,
	"quiet_hours_allow_urgent" boolean DEFAULT true NOT NULL,
	"batch_window_minutes" integer DEFAULT 15 NOT NULL,
	"approval_ttl_minutes" integer DEFAULT 1440 NOT NULL,
	"daily_spend_limit_usd" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_singleton_check" CHECK ("user_settings"."id" = 1),
	CONSTRAINT "user_settings_quiet_hours_pair_check" CHECK (("user_settings"."quiet_hours_start" is null) = ("user_settings"."quiet_hours_end" is null)),
	CONSTRAINT "user_settings_batch_window_check" CHECK ("user_settings"."batch_window_minutes" > 0),
	CONSTRAINT "user_settings_approval_ttl_check" CHECK ("user_settings"."approval_ttl_minutes" > 0),
	CONSTRAINT "user_settings_spend_limit_check" CHECK ("user_settings"."daily_spend_limit_usd" is null or "user_settings"."daily_spend_limit_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "vip_senders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"note" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "watchlist_kind" NOT NULL,
	"value" text NOT NULL,
	"label" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_chats_telegram_chat_id_uq" UNIQUE("telegram_chat_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"direction" "telegram_direction" NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"reply_to_telegram_message_id" bigint,
	"text" text DEFAULT '' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_messages_chat_message_uq" UNIQUE("chat_id","telegram_message_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"kind" "telegram_update_kind" NOT NULL,
	"telegram_chat_id" bigint,
	"telegram_message_id" bigint,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_sync_state" ADD CONSTRAINT "mailbox_sync_state_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_classifications" ADD CONSTRAINT "email_classifications_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_classifications" ADD CONSTRAINT "email_classifications_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_retry_of_approval_id_approvals_id_fk" FOREIGN KEY ("retry_of_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_feedback" ADD CONSTRAINT "classification_feedback_classification_id_email_classifications_id_fk" FOREIGN KEY ("classification_id") REFERENCES "public"."email_classifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_feedback" ADD CONSTRAINT "classification_feedback_notification_id_notification_outbox_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification_outbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_classification_id_email_classifications_id_fk" FOREIGN KEY ("classification_id") REFERENCES "public"."email_classifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_chat_id_telegram_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."telegram_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email_address_lower_uq" ON "accounts" USING btree (lower("email_address"));--> statement-breakpoint
CREATE INDEX "runs_kind_started_idx" ON "runs" USING btree ("kind","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_running_started_idx" ON "runs" USING btree ("started_at") WHERE "runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "runs_parent_run_idx" ON "runs" USING btree ("parent_run_id") WHERE "runs"."parent_run_id" is not null;--> statement-breakpoint
CREATE INDEX "runs_boss_job_idx" ON "runs" USING btree ("boss_job_id") WHERE "runs"."boss_job_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "email_classifications_current_uq" ON "email_classifications" USING btree ("message_id") WHERE "email_classifications"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "email_classifications_run_idx" ON "email_classifications" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "messages_account_received_idx" ON "messages" USING btree ("account_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_from_email_lower_idx" ON "messages" USING btree (lower("from_email"));--> statement-breakpoint
CREATE INDEX "messages_triage_pending_idx" ON "messages" USING btree ("triage_status","received_at") WHERE "messages"."triage_status" in ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "messages_rfc_message_id_idx" ON "messages" USING btree ("rfc_message_id") WHERE "messages"."rfc_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("account_id","provider_thread_id") WHERE "messages"."provider_thread_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_fts_idx" ON "messages" USING gin (to_tsvector('english', coalesce("subject", '') || ' ' || "clean_text"));--> statement-breakpoint
CREATE INDEX "approvals_pending_expiry_idx" ON "approvals" USING btree ("expires_at") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approvals_run_idx" ON "approvals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "approvals_retry_of_idx" ON "approvals" USING btree ("retry_of_approval_id") WHERE "approvals"."retry_of_approval_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "classification_feedback_notification_uq" ON "classification_feedback" USING btree ("notification_id") WHERE "classification_feedback"."notification_id" is not null;--> statement-breakpoint
CREATE INDEX "notification_outbox_due_idx" ON "notification_outbox" USING btree ("scheduled_for") WHERE "notification_outbox"."status" in ('pending', 'batched');--> statement-breakpoint
CREATE INDEX "notification_outbox_expiry_idx" ON "notification_outbox" USING btree ("expires_at") WHERE "notification_outbox"."status" in ('pending', 'batched') and "notification_outbox"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "notification_outbox_approval_idx" ON "notification_outbox" USING btree ("approval_id") WHERE "notification_outbox"."approval_id" is not null;--> statement-breakpoint
CREATE INDEX "notification_outbox_run_idx" ON "notification_outbox" USING btree ("run_id") WHERE "notification_outbox"."run_id" is not null;--> statement-breakpoint
CREATE INDEX "llm_calls_run_idx" ON "llm_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "llm_calls_created_at_idx" ON "llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_calls_approval_uq" ON "tool_calls" USING btree ("approval_id") WHERE "tool_calls"."approval_id" is not null;--> statement-breakpoint
CREATE INDEX "tool_calls_run_idx" ON "tool_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "tool_calls_running_started_idx" ON "tool_calls" USING btree ("started_at") WHERE "tool_calls"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "interests_topic_lower_uq" ON "interests" USING btree (lower("topic"));--> statement-breakpoint
CREATE UNIQUE INDEX "vip_senders_email_lower_uq" ON "vip_senders" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_items_kind_value_lower_uq" ON "watchlist_items" USING btree ("kind",lower("value"));--> statement-breakpoint
CREATE INDEX "telegram_messages_history_idx" ON "telegram_messages" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "telegram_messages_run_idx" ON "telegram_messages" USING btree ("run_id") WHERE "telegram_messages"."run_id" is not null;--> statement-breakpoint
CREATE INDEX "telegram_updates_received_idx" ON "telegram_updates" USING btree ("received_at");--> statement-breakpoint
CREATE VIEW "public"."classifier_feedback_examples" AS (select "classification_feedback"."id" as "feedback_id", "classification_feedback"."rating" as "rating", "classification_feedback"."reason" as "reason", "classification_feedback"."note" as "note", "classification_feedback"."updated_at" as "labeled_at", "email_classifications"."id" as "classification_id", "email_classifications"."category" as "category", "email_classifications"."confidence" as "confidence", "email_classifications"."model" as "model", "email_classifications"."prompt_version" as "prompt_version", "email_classifications"."classifier_version" as "classifier_version", "messages"."id" as "message_id", "messages"."account_id" as "account_id", "messages"."rfc_message_id" as "rfc_message_id", "messages"."from_email" as "from_email", "messages"."subject" as "subject", "messages"."clean_text" as "clean_text", "messages"."received_at" as "received_at", "notification_outbox"."id" as "notification_id", "notification_outbox"."sent_at" as "notification_sent_at" from "classification_feedback" inner join "email_classifications" on "email_classifications"."id" = "classification_feedback"."classification_id" inner join "messages" on "messages"."id" = "email_classifications"."message_id" left join "notification_outbox" on "notification_outbox"."id" = "classification_feedback"."notification_id");
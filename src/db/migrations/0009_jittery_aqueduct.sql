CREATE TYPE "public"."artifact_kind" AS ENUM('screenshot');--> statement-breakpoint
CREATE TYPE "public"."browser_handoff_reason" AS ENUM('captcha', 'login', 'two_factor', 'verification', 'other');--> statement-breakpoint
CREATE TYPE "public"."browser_handoff_status" AS ENUM('waiting', 'resolved', 'cancelled', 'timed_out', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."browser_task_source" AS ENUM('telegram', 'schedule', 'retry');--> statement-breakpoint
CREATE TYPE "public"."browser_task_status" AS ENUM('queued', 'running', 'waiting_for_human', 'awaiting_approval', 'executing', 'succeeded', 'unverified', 'outcome_unknown', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "artifact_kind" NOT NULL,
	"task_id" uuid,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"byte_size" integer NOT NULL,
	"storage_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "artifacts_sha256_check" CHECK ("artifacts"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "artifacts_byte_size_check" CHECK ("artifacts"."byte_size" > 0),
	CONSTRAINT "artifacts_storage_path_check" CHECK ("artifacts"."storage_path" <> '' and "artifacts"."storage_path" !~ '^/' and "artifacts"."storage_path" !~ '(^|/)\.\.(/|$)')
);
--> statement-breakpoint
CREATE TABLE "browser_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"reason" "browser_handoff_reason" NOT NULL,
	"detail" text,
	"page_url" text,
	"screenshot_artifact_id" uuid,
	"notification_id" uuid,
	"status" "browser_handoff_status" DEFAULT 'waiting' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolver_ref" text,
	CONSTRAINT "browser_handoffs_waiting_resolved_check" CHECK (("browser_handoffs"."status" = 'waiting') = ("browser_handoffs"."resolved_at" is null)),
	CONSTRAINT "browser_handoffs_expiry_check" CHECK ("browser_handoffs"."expires_at" > "browser_handoffs"."requested_at"),
	CONSTRAINT "browser_handoffs_bounds_check" CHECK (("browser_handoffs"."detail" is null or char_length("browser_handoffs"."detail") <= 1000)
        and ("browser_handoffs"."page_url" is null or char_length("browser_handoffs"."page_url") <= 2048))
);
--> statement-breakpoint
CREATE TABLE "browser_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "browser_task_source" NOT NULL,
	"request_message_id" uuid,
	"retry_of_task_id" uuid,
	"run_id" uuid,
	"site" text NOT NULL,
	"action" text NOT NULL,
	"target_url" text NOT NULL,
	"instruction" text DEFAULT '' NOT NULL,
	"spec" jsonb NOT NULL,
	"status" "browser_task_status" DEFAULT 'queued' NOT NULL,
	"status_reason" text,
	"approval_id" uuid,
	"cancel_requested_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"result" jsonb,
	"cdp_target_id" text,
	"boss_job_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_tasks_active_finished_check" CHECK (("browser_tasks"."status" in ('queued', 'running', 'waiting_for_human', 'awaiting_approval', 'executing'))
        = ("browser_tasks"."finished_at" is null)),
	CONSTRAINT "browser_tasks_submitted_check" CHECK ("browser_tasks"."status" not in ('succeeded', 'unverified', 'outcome_unknown')
        or "browser_tasks"."submitted_at" is not null),
	CONSTRAINT "browser_tasks_retry_not_self_check" CHECK ("browser_tasks"."retry_of_task_id" is null or "browser_tasks"."retry_of_task_id" <> "browser_tasks"."id"),
	CONSTRAINT "browser_tasks_bounds_check" CHECK (char_length("browser_tasks"."instruction") <= 4000
        and char_length("browser_tasks"."target_url") between 1 and 2048
        and ("browser_tasks"."status_reason" is null
          or char_length("browser_tasks"."status_reason") between 1 and 64))
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "agent_daily_limit_usd" numeric(10, 2) DEFAULT '0.50';--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_browser_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."browser_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_task_id_browser_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."browser_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_screenshot_artifact_id_artifacts_id_fk" FOREIGN KEY ("screenshot_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_notification_id_notification_outbox_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification_outbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_tasks" ADD CONSTRAINT "browser_tasks_request_message_id_telegram_messages_id_fk" FOREIGN KEY ("request_message_id") REFERENCES "public"."telegram_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_tasks" ADD CONSTRAINT "browser_tasks_retry_of_task_id_browser_tasks_id_fk" FOREIGN KEY ("retry_of_task_id") REFERENCES "public"."browser_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_tasks" ADD CONSTRAINT "browser_tasks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_tasks" ADD CONSTRAINT "browser_tasks_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_kind_sha256_uq" ON "artifacts" USING btree ("kind","sha256");--> statement-breakpoint
CREATE INDEX "artifacts_live_created_idx" ON "artifacts" USING btree ("created_at") WHERE "artifacts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "artifacts_task_idx" ON "artifacts" USING btree ("task_id") WHERE "artifacts"."task_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_handoffs_one_waiting_uq" ON "browser_handoffs" USING btree ("task_id") WHERE "browser_handoffs"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "browser_handoffs_task_idx" ON "browser_handoffs" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_tasks_one_active_uq" ON "browser_tasks" USING btree ((true)) WHERE "browser_tasks"."status" in ('running', 'waiting_for_human', 'awaiting_approval', 'executing');--> statement-breakpoint
CREATE UNIQUE INDEX "browser_tasks_request_message_uq" ON "browser_tasks" USING btree ("request_message_id") WHERE "browser_tasks"."request_message_id" is not null;--> statement-breakpoint
CREATE INDEX "browser_tasks_open_status_created_idx" ON "browser_tasks" USING btree ("status","created_at") WHERE "browser_tasks"."status" in ('queued', 'running', 'waiting_for_human', 'awaiting_approval', 'executing');--> statement-breakpoint
CREATE INDEX "browser_tasks_created_idx" ON "browser_tasks" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "browser_tasks_submitted_idx" ON "browser_tasks" USING btree ("site","action","submitted_at") WHERE "browser_tasks"."submitted_at" is not null;--> statement-breakpoint
CREATE INDEX "browser_tasks_approval_idx" ON "browser_tasks" USING btree ("approval_id") WHERE "browser_tasks"."approval_id" is not null;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_agent_limit_check" CHECK ("user_settings"."agent_daily_limit_usd" is null or "user_settings"."agent_daily_limit_usd" >= 0);
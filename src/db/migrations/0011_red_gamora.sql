CREATE TABLE "browser_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"instruction" text NOT NULL,
	"site" text NOT NULL,
	"action" text NOT NULL,
	"spec_template" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_from_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_schedules_bounds_check" CHECK (char_length("browser_schedules"."cron") between 1 and 120 and char_length("browser_schedules"."instruction") <= 4000),
	CONSTRAINT "browser_schedules_timezone_check" CHECK ("browser_schedules"."timezone" = 'Asia/Kolkata')
);
--> statement-breakpoint
ALTER TABLE "browser_tasks" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "browser_tasks" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "browser_schedules" ADD CONSTRAINT "browser_schedules_created_from_message_id_telegram_messages_id_fk" FOREIGN KEY ("created_from_message_id") REFERENCES "public"."telegram_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_schedules_due_idx" ON "browser_schedules" USING btree ("next_run_at") WHERE "browser_schedules"."enabled";--> statement-breakpoint
CREATE UNIQUE INDEX "browser_schedules_message_uq" ON "browser_schedules" USING btree ("created_from_message_id") WHERE "browser_schedules"."created_from_message_id" is not null;--> statement-breakpoint
ALTER TABLE "browser_tasks" ADD CONSTRAINT "browser_tasks_schedule_id_browser_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."browser_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_tasks_schedule_slot_uq" ON "browser_tasks" USING btree ("schedule_id","scheduled_for") WHERE "browser_tasks"."schedule_id" is not null;--> statement-breakpoint
ALTER TABLE "browser_tasks" ADD CONSTRAINT "browser_tasks_schedule_pair_check" CHECK (("browser_tasks"."schedule_id" is null) = ("browser_tasks"."scheduled_for" is null));
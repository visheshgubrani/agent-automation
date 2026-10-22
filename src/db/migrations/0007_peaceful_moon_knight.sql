ALTER TABLE "llm_calls" DROP CONSTRAINT "llm_calls_nonnegative_check";--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "cache_write_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "triage_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_nonnegative_check" CHECK ("llm_calls"."prompt_tokens" >= 0
        and "llm_calls"."cached_input_tokens" >= 0
        and "llm_calls"."cache_write_tokens" >= 0
        and "llm_calls"."completion_tokens" >= 0
        and "llm_calls"."reasoning_tokens" >= 0
        and "llm_calls"."reserved_cost_usd" >= 0
        and "llm_calls"."cost_usd" >= 0
        and "llm_calls"."latency_ms" >= 0);
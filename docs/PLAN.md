# Plan

## Goal

A single-user personal assistant that triages mail from four or five Gmail inboxes, sends
notifications only when they matter, digests news/markets, runs an on-demand
Telegram agent, and later performs approved cold outreach. Postgres is the source
of truth; pg-boss schedules/executes jobs; OpenAI does classification/drafting;
Telegram is the interface.

Success is end-to-end traceability: any job, LLM call, tool call, approval, notification,
and feedback label can be followed by `run_id` and entity ids. Notification deliveries
carry an explicit per-kind at-most-once/at-least-once policy.

## Phases

| Phase | Scope | Status |
| --- | --- | --- |
| 01 Database foundation | Schema design + Drizzle implementation, enums, constraints, indexes, feedback view, audit/spend query, invariant tests | done — approved with review tweaks 2026-10-18 |
| 02 Runtime skeleton | Env/config, structured logging, health routes, credential encryption, run/audit helpers, pg-boss worker, outbox dispatcher, Telegram bot, heartbeat | done — code/tests complete 2026-10-21; live Telegram heartbeat/callback exit checks verified 2026-10-23 |
| 03 Mail ingestion + important alerts | OAuth connect/store encrypted credentials, Gmail sync, cleaning, rules, classification, budget, Telegram alerts/review, feedback | in progress — increments 1–7 implemented 2026-10-22/23; live Gmail sync, classification, alerts, noisy correction, restart, and evaluation verified; missed-important/rule live checks pending |
| 04 (retired — merged into 03) | Original mail triage + notification scope | retired 2026-10-21; number retained for stable references, not an active phase |
| 05 Telegram agent + approvals | Agent tool loop, conversation history, approval payload/execution, at-most-once send policy (bot/long-poll base in 02) | planned |
| 06 News/market digest | Sources, items, story clustering, watchlist scoring, digest + breaking outbox, never-resend deliveries | planned |
| 07 Cold outreach | Leads state machine, suppression, sending inbox + daily caps, approval-gated sends, reply detection | planned |

Phase 04's scope was merged into phase 03 on 2026-10-21. Its number is kept in the
roadmap only so existing references to phases 05–07 and historical records stay stable;
there is no separate phase 04 to implement.

Phases 06 and 07 are LATER per the current V1 table constraint; their table design is
outlined in [DATABASE.md](DATABASE.md#later-migrations-designed-not-implemented) so they
arrive as additive migrations.

## Current phase

Phase 03 (mail ingestion + important alerts) is in progress:
[docs/phases/03-important-email-alerts.md](phases/03-important-email-alerts.md). Increments 1–7 are
implemented. Live verification confirmed Telegram heartbeat delivery, real Gmail backfill/incremental
sync, OpenAI classification, five canonical alerts, a noisy-alert correction, graceful restart, and
100% medium/high evaluation recall/precision on the synthetic held-out set. The remaining live
checks are a missed-important correction and a future rule changing subsequent behavior.

Phase 02 (runtime skeleton) is done; its live Telegram heartbeat and inbound callback checks were
verified on 2026-10-23: [docs/phases/02-runtime-skeleton.md](phases/02-runtime-skeleton.md). Phase
01 is complete: [docs/phases/01-database-foundation.md](phases/01-database-foundation.md).

## Constraints

- Single user; no `users` table or multi-tenant RLS in V1.
- Postgres 17 + pgvector; JSONB only for variable payloads; timestamptz for instants.
- pg-boss manages its own `pgboss` schema.
- One worker process, enforced by a Postgres advisory lock; the API process stays stateless.
- Notification delivery policy is per outbox row (`at_most_once`/`at_least_once`). Uncertain
  at-most-once deliveries are quarantined, never auto-resent; at-least-once rows may duplicate.
- Public health is minimal; readiness requires the worker lock and detailed runtime state is
  token-protected.
- Mail decision precedence is message correction → explicit rule → classifier. Corrections
  never create rules; rules apply to future processing only.
- Automatic mail alerts require a persisted per-account connection boundary; the initial
  seven-day backfill is silent and reconnecting must not reset the boundary.
- Model calls reserve their bounded worst-case cost durably before the request; the daily
  budget is local to `Asia/Kolkata` and unknown outcomes stay counted.
- Gmail accounts connect through a local Desktop OAuth flow (PKCE, one-use state, loopback
  callback) and request only `gmail.readonly`; tokens remain ciphertext at rest.
- Gmail sync is per-account serialized, commits messages + labels + cursors per page, captures the
  initial history checkpoint before the seven-day backfill, and recovers expired cursors from the
  last success with overlap (not a fixed seven-day cap). Gmail deletions never delete app history.
- Email/news content is untrusted input.
- Every send requires explicit approval; approvals store the exact payload executed.
- OAuth tokens, encryption keys, and health tokens never enter logs; tokens are ciphertext only.

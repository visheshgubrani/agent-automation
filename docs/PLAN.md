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
| 03 Mail ingestion + important alerts | OAuth connect/store encrypted credentials, Gmail sync, cleaning, rules, classification, budget, Telegram alerts/review, feedback | done — closed 2026-10-23 at the user's request; increments 1–7 implemented and automated checks complete; two live checks deferred to ongoing use (D040) |
| 04 (retired — merged into 03) | Original mail triage + notification scope | retired 2026-10-21; number retained for stable references, not an active phase |
| 05 Telegram agent + approvals | Agent tool loop, approval payload/execution, at-most-once send policy; first send tools are approved browser actions (Reddit, YC Work at a Startup, Wellfound) with phone handoff. Conversation history deferred | in progress — increment 0 done 2026-10-25; increments 1 (schema, config, browser host), 2 (budgeted model, driver, guarded tools; library only), 3 (Reddit comment end to end), 4 (human handoff), and 5 (free-text intake, replay confirmation, Reddit posts) implemented 2026-10-25; increment 1 live spike checks and increments 3–5 live checks pending; increment 6 (profile-backed YC/Wellfound applications) implemented with live checks pending; increment 7 (confirmed schedules, operations and retention) implemented; credential-backed live checks deferred to the next session at the user’s request |
| 06 News/market digest | Sources, items, story clustering, watchlist scoring, digest + breaking outbox, never-resend deliveries | planned |
| 07 Cold outreach | Leads state machine, suppression, sending inbox + daily caps, approval-gated sends, reply detection | planned |

Phase 04's scope was merged into phase 03 on 2026-10-21. Its number is kept in the
roadmap only so existing references to phases 05–07 and historical records stay stable;
there is no separate phase 04 to implement.

Phases 06 and 07 are LATER per the current V1 table constraint; their table design is
outlined in [DATABASE.md](DATABASE.md#later-migrations-designed-not-implemented) so they
arrive as additive migrations.

## Current phase

Phase 05 (Telegram agent, approvals, and browser actions) is the current phase:
[docs/phases/05-telegram-agent-browser-actions.md](phases/05-telegram-agent-browser-actions.md).
The user approved increment 0 (proposal records and decisions D041–D047) and increment 1 on
2026-10-25. Increment 0 is done. Increment 1 added migrations 0008/0009 (browser tasks, handoffs,
artifacts, agent sub-limit), the agent/browser configuration, shared `src/llm/` helpers, the
browser container, and `pnpm browser:check`; its live spike checks that need the user's logins,
Tailscale, or phone are still open. Increment 2 (approved 2026-10-25) added the budgeted AI SDK
model middleware, the Playwright driver, snapshot/guards/detectors/site registry, and the audited
browser tool layer as a library. Increment 3 (approved 2026-10-25) wires the Reddit comment path
end to end: `/comment` intake, the `agent-intake` and `browser-task` queues, the browser task run
and daily cap, prepared-form approval with photo cards, the model-free executor, result cards, and
startup recovery. Increment 4 (approved 2026-10-25) adds human handoffs with screenshot/phone
link cards, Done/Stop callbacks, bounded waits, detector rechecks, and the three-handoff limit
(D047, D049). Its live phone-login check is pending. Increment 5 (approved 2026-10-25) adds
current-message structured intake, exact-substring provenance checks, stale-request Start cards,
inert schedule drafts, and Reddit title/body posts with multi-field approvals (D050). Its live
post check is pending on agent/model/view setup and the user login. Increment 6 (approved 2026-10-25) adds migration 0010, the bounded profile CLI, profile-backed application-note composition, and YC Work at a Startup/Wellfound adapters (D051). Its real application checks remain pending. Increment 7 (approved 2026-10-25) adds migration 0011, confirmed hourly-or-slower Kolkata schedules, transactional slot enqueue, /tasks, /stop, /schedules, agent health/spend visibility and 14-day screenshot retention (D052). Phase 05 increments 0–7 are implemented; credential setup and live verification are explicitly deferred to the next session, and phase 05 stays in progress. Live testing has now begun: live fix 1 corrects the reproduced background-CAPTCHA false positive (D053), verified by 610 tests including real-Chromium fixtures. The next check is the user’s live Reddit prepare/Cancel retry after a worker restart. Live fix 2 lists task controls past a cut snapshot so a composer below a long Reddit thread is reachable without scrolling (D054), verified by 612 tests and a read-only live snapshot check. Increment 8 (approved 2026-10-26) adds thread-aware `/comment <url> [thoughts]` drafting, one optional direct-reply advice question, cumulative resumed-task budgets, and pinned top-level composer checks (D055). Automated verification passed (640 tests including Chromium fixtures, lint, typecheck and build); the idle worker was reloaded. Live Telegram draft/tone review and an explicitly approved owned/test-thread submit remain open.

Phase 03 (mail ingestion + important alerts) is done as of 2026-10-23:
[docs/phases/03-important-email-alerts.md](phases/03-important-email-alerts.md). Increments 1–7 are
implemented. Live verification confirmed Telegram heartbeat delivery, real Gmail backfill/incremental
sync for two accounts, OpenAI classification, five canonical alerts, a noisy-alert correction,
and graceful restart. Medium/high evaluation scored 100% recall/precision on 13 synthetic held-out
cases; this is not a real-inbox accuracy estimate. The user explicitly deferred the missed-important
correction and future-rule live checks to ongoing use; neither is recorded as passed (D040).
Additional inbox connections and classification preference tuning remain routine setup/use.

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

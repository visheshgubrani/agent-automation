# Architecture

Status: phase 01 (database foundation) is implemented. Phase 02 (runtime skeleton) is done: config/
logging, credential encryption, run/audit helpers, the delivery-policy schema migration, the outbox
dispatcher with its Telegram sender, the pg-boss worker with the advisory lock and drain-on-shutdown,
the long-polling Telegram bot, the split health routes, and the heartbeat smoke tool were verified,
including a live Telegram heartbeat and inbound callback updates on 2026-10-23.

Phase 03 (mail ingestion + important alerts, combining the old 03/04 scope) has **increments 1–7**
implemented: persisted mail rules/company domains, classification topic/notification/summary/
decision provenance, the per-account connection boundary, LLM budget reservation + unknown-outcome
audit support, mail-enabled worker configuration, the local Gmail account connection/credential
lifecycle, reliable scheduled ingestion (OAuth-backed sync, history cursors, recovery scans,
MIME cleaning, idempotent storage, per-account failure backoff, and Gmail request pacing), mail
classification (rule-first decisions, bounded feedback examples, structured `gpt-6-luna` Responses
output, fair live-first triage, and local-day spending pause/resume), canonical alert production
with bounded plain-text rendering and validated inline buttons, deterministic Telegram review/
correction controls (ignored/search review, feedback, canonical corrections, rule previews/listing/
disable, status, and mail health/heartbeat visibility), and a labeled offline evaluation harness.
Two Gmail accounts are connected and real seven-day backfill/incremental sync were verified. Live
verification also confirmed Telegram heartbeat delivery, OpenAI classification, five canonical
email alerts, a noisy-alert correction, and graceful restart without duplicate ingestion/alerts;
medium/high evaluation scored 100% recall/precision on the synthetic held-out set. The remaining
live checks are a missed-important correction and a future rule changing subsequent behavior.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| Postgres 17 + pgvector | Source of truth: accounts, mail, classifications, rules/company domains, feedback, outbox, approvals, audit/budget reservations, preferences, Telegram history |
| Drizzle (`src/db`) | Schema, migrations, typed DB access, spend/budget queries, credential storage helpers |
| pg-boss (`src/queue.ts`) | Durable job scheduling/retries in the `pgboss` schema; orchestration only, not business state |
| Hono (`src/app.ts` via `src/index.ts`) | Health split (public liveness, public readiness, token-protected details), request logs; admin/webhook/callback routes are later phases |
| Workers | Mail sync coordinator/jobs (increment 3) and the bounded mail-triage job (increment 4), which also produces canonical alerts (increment 5), are implemented; digest, outreach, and approval execution land later |
| Telegram bot (implemented) | `src/telegram/bot.ts` long polling in the worker, locked to one chat with update dedupe. `/start`, `/ping`, `/mail ignored|search|rules|status`, callback queries, and paginated review/rule previews are implemented; the conversational agent loop is later |
| Mail review and rules (implemented) | `src/mail/review.ts` (ignored/search pages from stored mail), `src/mail/corrections.ts` (feedback upsert, canonical correction application, alert cancellation/reactivation), `src/mail/rules-admin.ts` (preview/save/list/disable), and `src/telegram/mail.ts` (deterministic commands, callback validation, rendering) |
| OpenAI client (implemented for mail) | `src/mail/openai-classifier.ts` calls the Responses API with structured output, `reasoning.effort`, no tools, no storage, and SDK retries disabled. Drafting, digest scoring/summaries, and the agent loop remain later phases |
| Credential crypto (implemented) | `src/crypto/credentials.ts`: AES-256-GCM envelope for OAuth tokens; key ring by `key_version`; AAD binds account/kind/version. `src/gmail/connect.ts`, `src/gmail/auth.ts`, and `src/db/queries/accounts.ts` own the connect/refresh lifecycle |
| Gmail connector (implemented) | `src/gmail/oauth.ts` (Desktop OAuth, PKCE S256, one-use state, 127.0.0.1 loopback callback, 5-minute bound) and `src/gmail/connect.ts` (profile/scope verification before atomic account/credential/boundary persistence). `src/gmail/auth.ts` reuses or refreshes access tokens, preserves omitted refresh tokens, and marks revoked/error accounts |
| Local mail controls (implemented) | `src/tools/gmail-connect.ts`, `src/tools/mail-accounts.ts`, and `src/tools/mail-config.ts`: connect, list/pause/resume, company domains, and bank senders. No command prints token material |
| Mail ingestion (implemented) | `src/mail/sync.ts`, `src/mail/ingestion.ts`, `src/mail/mime.ts`, `src/mail/sync-lock.ts`, and `src/mail/coordinator.ts`: per-account sync coordinator/jobs, initial checkpoint + seven-day silent backfill, replay, paginated history with page-atomic cursors, recovery scans, MIME/HTML cleaning, idempotent storage, and per-account backoff |
| Mail classification (implemented) | `src/mail/triage-state.ts` (fair live-first claims, rule-aware scans, retry backoff, explicit requeue), `src/mail/rules.ts`, `src/mail/examples.ts`, `src/mail/classifier-prompt.ts`, `src/mail/openai-classifier.ts`, `src/mail/pricing.ts`, `src/mail/budget.ts`, `src/mail/classification.ts`, `src/mail/triage.ts`, and `src/jobs/mail-triage.ts`: rule-first decisions, bounded correction examples, validated structured output, serialized reserved model calls, local-day budget pause/notice, and visible failures |
| Mail alerts (implemented) | `src/mail/alerts.ts`: canonical `email_triage` production inside the decision transaction, silent-boundary enforcement, RFC dedupe/correction precedence, bounded plain-text rendering with identifier/OTP redaction, Gmail link, validated inline-button payloads, and cancelled/undelivered alert reactivation. `src/notifications/dispatcher.ts` forwards payload buttons to `src/telegram/sender.ts` |
| Mail status and health (implemented) | `src/mail/status.ts`: one snapshot of account sync health, backlog/failures, local-day spend/reservation, and outbox counts for `/mail status`, token-protected `/health/details`, and the daily heartbeat. Public health responses remain minimal |
| Config (implemented) | `src/env.ts` base validation plus `src/config.ts` worker/mail/connect validation. Mail credentials are required only when `MAIL_ENABLED=true`; Gmail connect needs Gmail OAuth + encryption only; the heartbeat-only worker path stays available |
| Audit helpers (implemented) | `src/audit/runs.ts` (`withRun`) and `src/audit/calls.ts` (`withLlmCall`/`withToolCall`). `withLlmCall` reserves worst-case cost as an `in_flight` row before the request, records known-failure usage (`LlmCallFailedError`), and recovers stale reservations as `unknown`; the classifier is its first runtime consumer |
| Outbox dispatcher (implemented) | `src/notifications/outbox.ts` (enqueue/claim/expire/recover/mark helpers; enqueue accepts a caller transaction) + `src/notifications/dispatcher.ts` (run-gated tick: expire, policy-aware recovery, claim → send → finalize). `src/telegram/sender.ts` delivers plain text and validated inline buttons to the one configured chat |
| Worker (implemented) | `src/worker.ts` + `src/queue.ts` + `src/worker-lock.ts`: pg-boss in the `pgboss` schema, heartbeat/dispatch jobs and schedules, single-worker session advisory lock, policy-aware startup recovery (outbox, stale model-call reservations, and abandoned triage claims), drain-on-shutdown, and the long-polling bot. When `MAIL_ENABLED=true` it also runs the mail coordinator, per-account sync, and mail-triage workers/schedule; the heartbeat-only path omits them. `src/tools/smoke-heartbeat.ts` (`pnpm smoke:heartbeat`) sends a manual heartbeat through this path and polls the outbox |

## Data flows

### Account connection and token lifecycle (phase 03 increment 2, implemented)
1. `pnpm gmail:connect --email <address>` starts a local Desktop OAuth flow: PKCE S256, a one-use
   state value, a random-port callback bound to `127.0.0.1`, and a five-minute flow deadline. Only
   `gmail.readonly` and offline access are requested.
2. After the code exchange the connector verifies the Gmail profile address matches `--email` and
   the granted scopes are exactly `gmail.readonly`. Verification failure saves nothing.
3. Account, encrypted access/refresh envelopes, and the first-connection notification boundary are
   upserted in one transaction. Reconnects preserve the boundary, sync history, and an existing
   refresh token when Google omits a replacement; rotated tokens are re-encrypted.
4. `getGmailAuthorization` reuses a stored access token until shortly before expiry, then refreshes
   and persists the new access token/expiry (and any rotated refresh token). `invalid_grant` marks
   the account `revoked`; missing scopes/permanent auth failures mark it `error`; transient
   failures leave the status alone. The bounded reason is visible on `mail:accounts list`.
5. Local controls list/pause/resume accounts. Revoked accounts and accounts missing the readonly
   scope cannot be resumed; reconnect them. Company domains and bank senders (stored in
   `vip_senders`) are local configuration commands.

### Mail sync, triage, alerts, and review (phase 03; increments 1–7 implemented)
1. A coordinator runs about every minute and enqueues one sync job per active, non-backing-off
   account. A session advisory lock keyed to the account serializes sync; pg-boss coalescing is
   not the correctness mechanism. Gmail API calls are paced by `GMAIL_REQUEST_DELAY_MS` (default
   350 ms) so an initial backfill does not exhaust the project's per-minute quota.
2. On the first sync the app captures the Gmail profile history checkpoint **before** paging the
   seven-day backfill, finishes every page, commits `initial_sync_completed_at` + checkpoint, then
   replays history so arrivals during setup are not missed. A crash mid-backfill replays safely
   against the unique provider-message key.
3. Incremental history is paged from the stored cursor. Each page commits message upserts, label
   additions/removals, and the cursor to the last processed record in one transaction; the
   response `historyId` is stored only after the final page. A 404 cursor triggers a scan since
   `last_success_at - 1h` (not a fixed seven-day cap), captures a new checkpoint, and replays
   history. Messages removed before retrieval are skipped; Gmail deletions never delete app history.
4. Raw and cleaned bodies are stored separately. The recursive MIME payload is decoded (headers,
   RFC 2047 words, addresses, charsets, base64url); plain text is preferred, HTML is cleaned with
   `html-to-text`, both are bounded, and attachment metadata is stored without attachment content.
   Only `clean_text`, bounded metadata, attachment metadata, and explicit local configuration
   hints may enter a prompt.
5. The coordinator also enqueues one bounded `mail-triage` job when runnable work exists. The job
   applies matching active rules first (independent of budget and of the classification batch), then
   claims a fair batch: live arrivals before silent backfill, one queue per account round-robined so
   one inbox cannot monopolize. An explicit rule inserts a classification row with
   `decision_source='rule'`, `applied_rule_id`, no model/prompt/confidence/urgency fields, and the
   resulting `should_notify`. Otherwise the classifier path inserts a structured row with topic,
   urgency category, `should_notify`, confidence, summary, reason, prompt/classifier versions, and
   actual model effort. Current rows are superseded and the message becomes `classified` together.
6. The prompt includes only `clean_text`, bounded metadata, attachment metadata, and at most six
   relevant feedback examples (same sender/domain first; current message and RFC copies excluded).
   Email/example text is escaped and delimited as untrusted data; the Responses call has no tools,
   no storage, and SDK retries disabled. Topic, urgency category, `should_notify`, confidence,
   summary, and reason are validated before storage; confidence is diagnostic only.
7. Each classifier attempt runs inside a process-wide serialized section. `withLlmCall` durably
   inserts an `in_flight` `llm_calls` row with the bounded worst-case reservation from the
   snapshotted `gpt-6-luna` rates. Admission uses `getLlmBudgetUsageForRange` against the
   `Asia/Kolkata` local-day limit. The row is finalized with actual input/cache/output/reasoning
   usage, cost, request id, effort, and latency; ambiguous outcomes become `unknown` and keep the
   reservation. Refusals/invalid output are terminal failures; transient failures back off 1m→1h.
8. The same transaction that inserts the current classification and marks the message
   `classified` also produces at most one canonical `email_triage` outbox row. Production uses the
   latest canonical correction when one exists (correction classifications first, then feedback),
   otherwise this decision's `should_notify`. Automatic alerts additionally require a non-null
   connection boundary and `received_at >` it; an explicit missed-important correction may override
   the boundary. The dedupe key is `email_triage:rfc:<normalized Message-ID>` or the stable
   `email_triage:message:<stored id>` fallback, so another inbox copy or reclassification cannot
   notify twice. Different emails in the same thread remain independently eligible.
9. Alerts are bounded plain text with the receiving account, sender, subject, summary, reason, and
   Gmail link. Card/account digit runs are masked, OTP values are redacted, and only stored bounded
   fields are used (no invented facts). The payload carries validated inline buttons for Useful,
   Not important, and Create rule; the dispatcher forwards them to the Telegram sender. The
   existing at-least-once policy, bounded retries, and restart recovery remain unchanged.
10. At budget exhaustion, sync and deterministic rules continue, model-dependent mail stays queued,
    and one system notice keyed by the local day is enqueued. Queued classification resumes at the
    next local midnight without being marked ignored. Refusals, invalid output, and exhausted
    attempts remain visible as `failed` rows with bounded errors; `pnpm mail:triage retry-failed`
    is the explicit recovery path.
11. Telegram `/mail ignored`, `/mail search`, `/mail rules`, and `/mail status` are deterministic
    commands. Review/search pages show five current items with Important/Not important/Rule buttons;
    pagination edits the stored outbound message. Only classified items get correction buttons.
    Search includes ignored and unclassified mail. Bot replies store app-only callback metadata
    (`mailReview`, `mailRuleDraft`, or `mailRuleList`) in `telegram_messages.payload`.
12. Feedback callbacks are validated against the configured chat, the stored review message/alert
    notification, and the target classification. Feedback is upserted against the classification
    originally shown; a notification link is accepted only when the outbox row belongs to that
    classification. Corrections lock canonical message rows, insert correction decisions across
    copies with the same RFC Message-ID (or the stored message only), and update the message status.
    Classifier/rule decisions lock the message and yield to a current correction, preventing an
    in-flight classification race.
13. Important corrections produce an alert with the silent boundary overridden and dedupe/reactivation
    applied; delivered alerts are never rewritten. Unimportant corrections cancel only
    `pending`/`batched` outbox rows. Rule creation is a stored preview plus explicit Save; the preview
    can toggle action, sender/domain, and account scope. `/mail rules` lists and disables active rules
    without deleting past provenance.
14. `/mail status`, token-protected `/health/details`, and the daily heartbeat reuse the mail status
    snapshot: account sync health, backlog/failure counts, local-day spend/reservation, and outbox
    counts. Public `/health` and `/health/ready` stay minimal.

### On-demand agent and approvals
1. A Telegram update is claimed once by inserting `telegram_updates.update_id`.
2. The inbound message is stored in `telegram_messages` and starts a run
   (`trigger = 'telegram'`, `kind = 'agent_chat'`).
3. The model calls read/notify/draft tools; each executed tool call is recorded in
   `tool_calls` under the run. Read tools are auto-run.
4. A risky call creates an `approvals` row with the exact payload, expiry, and tier, plus
   an `approval_request` outbox row. The model is told the action awaits approval.
5. On approval, an execution run is created (`parent_run_id` = requesting run,
   `trigger = 'approval'`). The executor reads arguments **only** from
   `approvals.payload`, claims the approval by inserting a `running` `tool_calls` row
   with `approval_id` (unique), performs the side effect, then finalizes the row.
6. Any failed send needs a fresh approval whose payload is copied from the failed
   approval; `retry_of_approval_id` records the lineage. There is no silent retry under
   the old approval.
7. Agent replies are stored in `telegram_messages` as outbound turns.

### Heartbeat and dispatch
1. The heartbeat cron (daily by default, `HEARTBEAT_CRON`, UTC) enqueues a heartbeat job. The
   handler opens a `system` run, counts terminal `quarantined`/`failed` outbox rows, and inserts
   exactly one `system`/`at_most_once` row with dedupe key `system:heartbeat:<job id>`.
2. The every-minute dispatch job performs a cheap due/expired/stale check. Idle ticks open no run;
   a tick with work opens a `notification_dispatch` run, applies expiry and policy-aware recovery,
   then claims → sends → finalizes one row at a time (bounded per tick).
3. `pnpm smoke:heartbeat` enqueues a manual heartbeat and polls the dedupe key, exiting 0 only when
   the worker marks it `sent`. The worker and worker-side Telegram config must already be running;
   the smoke script never sends Telegram itself.

### Audit and spend
Every work-performing job opens a run through `withRun` (`src/audit/runs.ts`), which records
`succeeded|failed|cancelled`, `finished_at`, and bounded secret-safe error text, and rethrows
so pg-boss can retry; every model/tool call is recorded under that run via `withLlmCall` /
`withToolCall` (`src/audit/calls.ts`), including token, cost, latency, and provider request id
detail. `runs.input` carries ids/references only — never bodies or secrets. Idle dispatch
ticks are the documented exception (no run) so the audit trail stays meaningful.

Model calls reserve budget durably: `withLlmCall` inserts an `in_flight` `llm_calls` row with
`reserved_cost_usd` before the request, then finalizes to `succeeded`/`failed` (actual usage) or
`unknown` when the outcome cannot be determined. Stale `in_flight` rows are recovered as
`unknown` at worker startup (and the helper is available to later classifiers) and keep their
reservation counted. `getLlmSpendForRange` reports recorded actual spend;
`getLlmBudgetUsageForRange` is the admission query and counts reservations conservatively. If the
reservation is non-positive or its insert fails, the model call is not attempted. `withToolCall`
and the credential helpers remain foundation-only until their consumers land.

## Data and boundaries

- **Untrusted input:** email/news/Telegram user content is data. `messages.raw_text` is
  stored for provenance/reprocessing; `clean_text` is the prompt-facing copy. MIME/HTML headers,
  addresses, and bodies are untrusted: decode them defensively, bound stored text/header/attachment
  metadata, and never fetch attachment content. Classification output lives only in
  `email_classifications`. LLM prompts must delimit content and must never execute embedded
  instructions.
- **Secrets:** OAuth tokens exist only as ciphertext/nonce/tag + `key_version` in
  `account_credentials`. Plaintext never enters the DB, logs, or prompts, and the connect command
  never prints tokens. Access tokens are refreshed before expiry; rotated refresh tokens replace
  the envelope, while an omitted replacement leaves the existing refresh token intact. Telegram
  bot token and OpenAI key are env vars for now.
- **pg-boss boundary:** `src/queue.ts` owns pg-boss lifecycle; app code may enqueue jobs and
  read pg-boss job ids for `runs.boss_job_id`. It never queries or migrates pg-boss tables.
- **Single principal:** one settings row, one Telegram chat, no RLS. Postgres is loopback-only
  in dev.
- **State ownership:** explicit enums + checks own legal values; transitions (e.g. pending →
  approved) are application logic. Approvals payload and outbox body are immutable after
  creation.
- **Failure ownership:** workers own retries; DB constraints own idempotency. Delivery policy
  is per row (D021): uncertain sends quarantine at-most-once rows (never resent) and retry
  at-least-once rows (duplicates tolerated); safe transport failures always retry.

## Constraints

- V1 tables only; digest/news, leads, email sends, and embeddings are additive later.
- Every send requires approval; the DB enforces that a `send` tool call has an approval.
- Mail precedence is message correction → explicit rule → classifier. Rules are future-only,
  combine conditions with AND, and the most recently edited active match wins (id tie-break).
  Matching rules run before model admission and cannot be starved by a model-dependent backlog.
- Telegram commands/callbacks are deterministic and chat-locked. Callback data is bounded to
  action + id/page; subjects/scopes stay in stored outbound payloads. A callback must match a stored
  review page, rule draft/list, or an alert outbox row whose classification matches; stale or
  mismatched callbacks are acknowledged and ignored. Every callback is acknowledged once.
- Corrections lock canonical message rows before inserting correction decisions. Classifier and
  rule decision helpers refuse to supersede a current correction, including an in-flight
  classification. Important corrections may override the silent boundary; unimportant corrections
  cancel only unsent outbox rows and never rewrite sent/sending alerts.
- Rule creation is preview + explicit Save. Identical active rules are reused; disabling keeps the
  row so past `applied_rule_id` provenance remains valid.
- Rule/correction classification rows carry no fictitious model call; only classifier rows
  carry model/prompt/classifier/confidence snapshots.
- Automatic alerts respect the per-account connection boundary; initial backfill is silent.
  An explicit missed-important correction may override it. Classification, message status, and the
  canonical outbox insert commit in one transaction.
- Alert bodies are bounded plain text built from stored bounded fields; identifiers are masked,
  OTP values are omitted, and no transaction/deadline facts are invented. Inline buttons are
  validated before reaching Telegram.
- Mail sync is serialized per account by a session advisory lock. Cursors advance only with
  processed pages/checkpoints; recovery scans since the last success with overlap, never a fixed
  seven-day outage cap. Gmail label changes update labels; Gmail deletions do not delete app history.
  Gmail API calls are paced (`GMAIL_REQUEST_DELAY_MS`) to avoid per-minute quota bursts; quota
  failures remain visible and back off per account.
- Initial sync captures the Gmail history checkpoint before the seven-day backfill and replays it;
  arrivals during setup cannot be skipped.
- Gmail connections use Desktop OAuth + PKCE + one-use state on a loopback callback and request
  only `gmail.readonly`. Revoked grants and permanent auth failures are recorded per account
  (`revoked`/`error` + bounded `last_error`) and must not stop other mailboxes.
- One current classification per message; one feedback label per classification; one
  execution per approval.
- Outbox dedupe is unique globally (single user); email triage keys use the normalized RFC
  Message-ID, falling back to the stable stored message id. A canonical correction suppresses or
  permits another inbox copy's automatic alert; same-thread emails with different Message-IDs stay
  independent.
- Model budget admission counts durable in-flight/unknown reservations; the daily budget resets
  at local midnight in `Asia/Kolkata` (default $1/day).
- `/mail status`, `/health/details`, and the heartbeat report counts/spend only. Public health
  responses contain no account addresses, mail metadata, or spend details.
- Classification uses `gpt-6-luna` through the Responses API with structured output, configured
  `medium`/`high` reasoning effort, no tools, no storage, and SDK retries disabled. Only cleaned
  text, bounded metadata, attachment metadata, and explicit local configuration hints enter
  prompts; email/examples are delimited untrusted data. Confidence is diagnostic, not a
  notification threshold.
- See [DATABASE.md](DATABASE.md) for schemas and [DECISIONS.md](DECISIONS.md) for rationale.

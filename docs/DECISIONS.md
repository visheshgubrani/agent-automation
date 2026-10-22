# Decisions

## D001: Schema scope follows the explicit V1 table list
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: the job list calls the news digest "V1", but the constraints say V1 tables are
  limited to mail triage/notifications/feedback/audit/approvals/preferences/foundations and
  list digest with LATER tables.
- Choice and reason: follow the more specific V1 table constraint; ship no news/digest,
  lead, send, draft, or embedding tables now. Foundation tables are designed so those are
  additive migrations.
- Alternative: create all feature tables now; rejected because unused tables drift before
  their consumer exists and the user explicitly asked for V1-only tables.
- Consequence: digest/outreach features need migrations later; V1 queries are unaffected.
- Approval: approved with review tweaks 2026-10-18.

## D002: Postgres enums for state and closed vocabularies, text for open catalogs
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: state fields must have explicit allowed values; some catalogs grow constantly.
- Choice and reason: `pgEnum` for status/type/risk/category/trigger vocabularies. Keep
  `tool_name`, LLM `purpose`, and similar open labels as `text`.
- Alternative: text + CHECK for everything; rejected for churn and weaker typing.
- Consequence: enum additions are migrations. Drizzle's migrator wraps pending migrations
  in one transaction and PostgreSQL forbids using a newly added enum value in that same
  transaction, so enum value additions must be deployed in a migration that does not yet
  use the new value (or in a separate prior migration).
- Approval: approved with review tweaks 2026-10-18.

## D003: UUID keys, timestamptz instants, numeric money
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: external ids vary (Gmail history ids are opaque u64 strings, Telegram ids are
  large ints).
- Choice and reason: UUID v4 PKs for app entities; text for Gmail `historyId`; bigint for
  Telegram ids; `timestamptz` for instants; `numeric` for money/confidence.
- Alternative: serial PKs; rejected because external-facing ids and imports are easier with
  UUIDs. Quiet-hours wall-clock values use `time` + timezone, an intentional exception.
- Consequence: no global ordering by id; use timestamps/indexed columns.
- Approval: approved with review tweaks 2026-10-18.

## D004: Raw and cleaned email are separate; classification is a separate table
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: email is untrusted and classification output is model-generated, not source data.
- Choice and reason: `messages.raw_text`/`raw_content_type` and `messages.clean_text` are
  distinct columns; `email_classifications` is append-only and linked to a run. Only clean
  text is prompt-facing.
- Alternative: one body column; rejected because it blurs provenance and encourages sending
  raw HTML/scripts to models.
- Consequence: raw text is never selected on hot paths; storage may be pruned later without
  losing classifications (which reference the message row, not the raw text).
- Approval: approved with review tweaks 2026-10-18.

## D005: One current classification via append-only rows + partial unique index
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: reclassification must not mutate the label a user already gave feedback on.
- Choice and reason: each classification row is immutable except `superseded_at`; unique
  partial index on `(message_id) WHERE superseded_at IS NULL`.
- Alternative: update one row in place; rejected because feedback pins the shown result.
- Consequence: reclassification is insert + supersede in one transaction; history is kept.
- Approval: approved with review tweaks 2026-10-18.

## D006: Feedback attaches to the classification; the notification is optional
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: feedback on notifications alone cannot capture a missed important email that was
  never notified.
- Choice and reason: `classification_feedback` has required `classification_id` and optional
  `notification_id`; one upsertable label per classification; optional `reason` includes
  `missed_important`, `wrong_category`, `too_noisy`, `other`. `classifier_feedback_examples`
  joins classification → message and LEFT JOINs the notification, so un-notified ignored
  mail is a first-class training example.
- Alternative: keep feedback only on outbox notifications; rejected as the worse failure
  mode is invisible.
- Consequence: labels survive notification pruning (`notification_id ON DELETE SET NULL`);
  the app verifies that a supplied notification belongs to the same classification.
- Approval: approved with review tweaks 2026-10-18.

## D007: One outbox; cross-inbox dedupe; quiet hours and batching
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: proactive Telegram messages need one durable delivery path with dedupe, retries,
  quiet hours, and batching.
- Choice and reason: `notification_outbox` is the only proactive delivery table with a global
  unique `dedupe_key`, status enum, attempts, `scheduled_for`, expiry, `batch_key`, body and
  template payload. Email-triage dedupe keys use `email_triage:rfc:<normalized Message-ID>`
  when available so the same email in two inboxes yields one notification; fallback is
  `email_triage:classification:<id>`. Later rows with the same `batch_key` may share one
  Telegram message id.
- Alternative: send directly from jobs; rejected because retries/quiet hours would leak
  across jobs.
- Consequence: delivery is at-least-once for API ambiguity unless quarantined. A stale
  `sending` row is marked `failed` with an uncertain-delivery error rather than auto-resent.
  Retention may delete old outbox rows without losing classification feedback.
- Approval: approved with review tweaks 2026-10-18.
- Superseded in part by [D021](#d021-per-kind-delivery-policy-stored-on-the-outbox) and
  [D022](#d022-quarantined-status-and-policy-aware-recovery): delivery ambiguity now follows
  the row's snapshotted `delivery_policy`, and a stale `sending` row is quarantined
  (at-most-once) or retried (at-least-once) instead of uniformly marked `failed`. The
  classification-id dedupe fallback is superseded by
  [D032](#d032-stable-email-triage-dedupe-fallback).

## D008: Approval payload is the executed contract; sends are at-most-once
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: a human-approved action must run exactly what was shown, not what the model says
  later; every send needs approval and uncertain delivery must not double-send.
- Choice and reason: `approvals.payload` is immutable after creation and is the only source
  of execution arguments (`tool_calls.args` snapshots that same payload). Unique
  `tool_calls(approval_id)` claims execution once; `send`-tier tool calls must have a non-null
  `approval_id` (DB check). A failed send is terminal for that approval: retry requires a new
  approval whose payload is copied, linked by `retry_of_approval_id`. There is no reset path.
- Alternative: allow re-execution under the same approval after local-only failures or a
  logged reset; rejected because the executor cannot reliably distinguish "nothing left the
  server" from "delivery uncertain".
- Consequence: benign local validation failures also require re-approval; this is deliberate.
  Approval resolution is immutable; execution failure appears on the tool call.
- Approval: approved with review tweaks 2026-10-18.

## D009: Runs are the audit root; token/cost detail is per call
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: jobs must be traceable end to end and daily spend must be queryable.
- Choice and reason: `runs` groups llm_calls/tool_calls; LLM rows store model, purpose,
  prompt/completion/cached-input/reasoning tokens, cost, latency, status. Costs are
  snapshotted. `llm_calls(created_at)` makes range sums cheap; `getLlmSpendForRange` is the
  support query.
- Alternative: derive spend from a pricing table at query time; rejected because prices and
  models change, altering historical spend.
- Consequence: daily guard is app-level; failed jobs may lack a post-call LLM row (no row if
  the process died mid-call).
- Superseded in part by [D031](#d031-durable-daily-model-budget-reservations): attempts now
  reserve worst-case cost before the request and survive process death as `in_flight`/`unknown`.
- Approval: approved with review tweaks 2026-10-18.

## D010: Credentials are separate encrypted rows; scopes live on the account
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: accounts are data rows, tokens must be encrypted, and least-privilege needs the
  actual granted permissions.
- Choice and reason: `account_credentials` stores kind + AES-256-GCM ciphertext/nonce/tag +
  `key_version`, unique per `(account, kind)`. `accounts.granted_scopes text[]` records the
  Google scopes actually granted, so approval code can require compose-only/send-capable
  inboxes explicitly.
- Alternative: tokens on `accounts`; rejected for rotation/provenance clarity.
- Consequence: phase 02 implements encryption; phase 03 (mail ingestion + alerts) updates scopes after
  OAuth; key rotation re-encrypts with a new `key_version` while old keys remain readable.
- Approval: approved with review tweaks 2026-10-18.

## D011: Sync cursor plus explicit full-resync state
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: Gmail history cursors can expire, forcing a full resync.
- Choice and reason: `mailbox_sync_state.history_id` is advanced only in the same transaction
  as message inserts; `needs_full_resync` marks an expired cursor as a normal state that
  resets the cursor and triggers a full scan.
- Alternative: treat cursor expiry as an error and page manually; rejected because it makes
  routine behavior look like an incident.
- Consequence: resync overlaps are deduped by `messages(account_id, provider_message_id)`.
- Note: phase 03 increment 3 implements this with page-atomic history transactions, checkpoint
  replay, and last-success recovery scans; see [D035](#d035-reliable-per-account-gmail-sync-with-page-atomic-cursors-and-recovery-scans).
- Approval: approved with review tweaks 2026-10-18.

## D012: FK actions separate audit detail from business records; documented retention
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: accidental cascades can erase audit; too many restricts make cleanup impossible.
- Choice and reason: owned detail cascades (run → llm/tool calls; message → classifications;
  chat → messages; classification → feedback). Independent records restrict (account →
  messages; runs referenced by classifications/approvals; approvals referenced by tool calls
  and outbox). Optional provenance links set null (outbox/telegram run ids; feedback
  notification id). No audit pruning in V1; retention matrix in DATABASE.md.
- Alternative: cascade everything; rejected for audit loss. Restrict everything; rejected for
  operability.
- Consequence: deleting a run is blocked until classifications/approvals are handled; raw mail
  retention must tombstone instead of deleting message rows.
- Note: rule provenance (`email_classifications.applied_rule_id`) is a restrict link per
  [D029](#d029-rulecorrection-precedence-and-honest-decision-provenance), not one of the
  optional set-null links above.
- Approval: approved with review tweaks 2026-10-18.

## D013: pg-boss owns the pgboss schema
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: pg-boss manages its own tables and migrations.
- Choice and reason: app schema never models or migrates pg-boss; only enqueue/work and persist
  job ids for trace (`runs.boss_job_id`). Tests truncate only `public`.
- Alternative: share pg-boss tables as state; rejected for upgrade fragility.
- Consequence: job state is ephemeral orchestration; business outcomes live in app tables.
- Approval: approved with review tweaks 2026-10-18.

## D014: Single user and minimal preference tables
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: single-user harness; drafting/digest are later consumers of tone/watchlist/
  interests.
- Choice and reason: singleton `user_settings`; keep small `vip_senders`, `watchlist_items`,
  `interests`, `tone_samples` because the brief explicitly asks for this memory. Store no
  scoring weights or embeddings yet to avoid reshaping.
- Alternative: defer these tables; acceptable per review, but keeping them avoids a later
  preferences migration and they are tiny.
- Consequence: relevance/scoring config lives in code until the digest phase; embeddings attach
  via the later `embeddings` table by UUID.
- Approval: approved with review tweaks 2026-10-18.

## D015: Later features arrive as additive migrations
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: leads, digest, sends, drafts, and embeddings are not V1 tables but must slot in.
- Choice and reason: later tables reference V1 rows; new outbox columns stay nullable; new
  enum values are added before any DDL uses them; existing checks are replaced only in the
  migration that introduces the new kind. Blueprint in DATABASE.md.
- Alternative: pre-create nullable later tables; rejected by D001.
- Consequence: a small migration is required per later feature; nothing in V1 breaks.
- Approval: approved with review tweaks 2026-10-18.

## D016: Tests run serially against an isolated app_test database
Date: 2026-10-18 | Status: accepted | Phase: [01](phases/01-database-foundation.md)
- Context: invariant tests share one Postgres database and truncate between tests.
- Choice and reason: vitest global setup validates the DB name ends with `_test`, applies
  migrations once, then tests run with `fileParallelism: false` and truncate `public` tables
  before each test. pg-boss and drizzle schemas are untouched.
- Alternative: parallel workers with per-worker schemas/databases; unnecessary complexity for
  a small suite.
- Consequence: tests are slightly slower but deterministic; they never touch `app`.
- Approval: approved with review tweaks 2026-10-18.

## D017: Two long-running processes (API + worker); the bot runs inside the worker
Date: 2026-10-19 | Status: accepted | Phase: [02](phases/02-runtime-skeleton.md)
- Context: HTTP liveness/readiness and job polling have different lifecycles; Telegram allows
  one poller per bot token.
- Choice and reason: API (`src/index.ts` → `src/app.ts`) serves health and later callbacks and
  never starts pg-boss or the bot; the worker (`src/worker.ts`) owns pg-boss, heartbeat/dispatch
  workers, recovery, and long polling in one process.
- Alternative: a third process for the bot; rejected because two processes already give
  independent restart points and one poller is simpler to guarantee.
- Consequence: a single worker must be enforced (see D026); API deploys stay safe without
  Telegram/encryption config.
- Approval: approved 2026-10-19 for incremental implementation.

## D018: Base env validation for every process; worker-only required config
Date: 2026-10-19 | Status: accepted | Phase: [02](phases/02-runtime-skeleton.md)
- Context: the API must boot without worker secrets, while the worker must fail fast with an
  actionable list when Telegram/encryption config is missing.
- Choice and reason: `src/env.ts` validates base vars for every process; `requireWorkerConfig()`
  aggregates all missing/invalid worker-only values (bot token, chat id, key ring, active
  version) into one error. `HEALTH_DETAILS_TOKEN` is optional; when unset, `/health/details` is
  404. The unused `GMAIL_REFRESH_TOKEN` placeholder was removed: OAuth tokens are DB ciphertext
  only (D010).
- Alternative: one shared required set; rejected because the API would refuse to start without
  integration secrets it never uses.
- Consequence: every entrypoint validates config before starting; secrets never log (pino
  redaction paths).
- Approval: approved 2026-10-19 for incremental implementation.

## D019: AES-256-GCM key ring by key_version, AAD binds account/kind/version
Date: 2026-10-19 | Status: accepted | Phase: [02](phases/02-runtime-skeleton.md)
- Context: OAuth tokens must be decryptable after key rotation; the DB stores ciphertext only
  (D010). Keys arrive as `TOKEN_ENCRYPTION_KEYS=version:base64[,version:base64...]` plus an
  active version.
- Choice and reason: `src/crypto/keys.ts` parses/validates the ring (32-byte keys, unique
  versions, active present). `src/crypto/credentials.ts` encrypts with the ring's active key and
  random 12-byte nonce, stores a 16-byte tag, and binds additional authenticated data to
  `account_id:kind:key_version`; decryption uses the row's `key_version` so old rows stay
  readable after rotation. Empty plaintext, unknown versions, malformed envelopes, and any
  tamper/context mismatch fail closed with typed errors. `src/db/queries/credentials.ts`
  (`upsertCredential`/`readCredential`) is the only storage path; plaintext is never stored or
  logged.
- Alternative: encrypting with one fixed key or DB-level pgcrypto; rejected for rotation and
  key-handling discipline.
- Consequence: the Gmail connect and refresh lifecycle (phase 03 increment 2) consumes these
  helpers inside transactions; the surface was extended with `DbSession` and
  `readCredentialRecord` (expiry metadata). Key rotation continues to work while old keys remain.
- Approval: approved 2026-10-19 for incremental implementation.

## D020: withRun/withLlmCall/withToolCall are the audit contract
Date: 2026-10-19 | Status: accepted | Phase: [02](phases/02-runtime-skeleton.md)
- Context: work-performing jobs must be traceable end to end with no memory of conventions.
- Choice and reason: `src/audit/runs.ts` opens `runs` rows (`startRun`) and finalizes them
  (`finishRun`); `withRun({kind, trigger, input, parentRunId, bossJobId, signal}, handler)`
  records `succeeded|failed|cancelled` with `finished_at`, bounded secret-safe error text, and
  a run-context child logger, then rethrows so pg-boss can retry. Every work-performing
  pg-boss handler and accepted bot update uses `withRun` and stores `runs.boss_job_id`; idle
  dispatch ticks are the documented exception so the audit trail stays meaningful.
  `src/audit/calls.ts` wraps model calls (`withLlmCall`: tokens/cost/latency/provider request
  id rows) and tool executions (`withToolCall`: `running` row first, then success/failure;
  `send` tier rejected without an approval, matching the D008 check).
- Alternative: ad-hoc logging per job; rejected as untestable and lossy.
- Consequence: `runs.input` carries ids/references only — never bodies or secrets.
  Since phase 03 increment 4, the mail classifier is the first `withLlmCall` consumer (reservation
  before the request, actual/unknown reconciliation); `withToolCall` waits for the agent loop
  (phase 05). Small reshaping is possible then.
- Approval: approved 2026-10-19 for incremental implementation.

## D021: Per-kind delivery policy stored on the outbox
Date: 2026-10-19 | Status: accepted | Phase: [02](phases/02-runtime-skeleton.md)
- Context: heartbeat/system messages must not duplicate, while lost urgent alerts or approval
  requests cost more than duplicates; a blanket at-most-once rule throws away recoverable
  deliveries.
- Choice and reason: new enum `notification_delivery_policy` (`at_most_once`, `at_least_once`)
  and a `notification_outbox.delivery_policy` column (not null, default `at_most_once`) that
  snapshots the kind → policy map at insert (`system` → at-most-once; `email_triage`,
  `approval_request` → at-least-once). The enqueue helper sets the policy from the kind; direct
  SQL/test inserts set it explicitly. The dispatcher and recovery paths branch on the stored
  policy, never on kind. Migration `0001` backfilled existing
  `email_triage`/`approval_request` rows to `at_least_once` because the default alone would
  have assigned them the wrong policy.
- Alternative: deriving behavior from `kind` at dispatch time; rejected because later kinds
  (digest) and explicit overrides would fork the logic and re-litigate urgency per row.
- Consequence: supersedes D007's blanket at-most-once consequence in part (see the D007 note);
  phase 02 producers emit only `system`/at-most-once, with the at-least-once branch tested
  directly until triage/approval producers land.
- Approval: approved 2026-10-19 for incremental implementation.

## D022: quarantined status and policy-aware recovery
Date: 2026-10-19 | Status: accepted | Phase: [02](phases/02-runtime-skeleton.md)
- Context: after a crash the worker cannot know whether Telegram accepted a send; a blanket
  retry risks duplicates, a blanket drop risks silence.
- Choice and reason: `notification_status` gains `quarantined` — a distinct terminal status for
  rows whose delivery is uncertain (ambiguous send outcome, stale `sending`) under
  at-most-once policy. At-least-once rows in the same situations return to `pending` and
  tolerate a duplicate; retryable transport failures (429, DNS, refused/unreachable) always
  retry for both policies; terminal `quarantined`/`failed` rows are surfaced by the heartbeat
  and cleared manually until a redrive/admin path exists.
- Alternative: reusing `failed` with an error prefix; rejected because the heartbeat and any
  future redrive need to distinguish "never sent, retryable" from "maybe sent, do not resend".
- Consequence: at-most-once rows can be lost (0 or 1 delivered, never 2) by design; the daily
  heartbeat is the visibility signal.
- Approval: approved 2026-10-19 for incremental implementation.

## D023: Telegram long polling with chat lock and update dedupe
Date: 2026-10-19 | Status: accepted | Phase: [02](phases/02-runtime-skeleton.md)
- Context: inbound commands and (later) approvals must be received reliably; Telegram allows
  only one poller per bot token, and replays after downtime must be safe.
- Choice and reason: the grammy bot long-polls inside the worker process (one poller by the
  advisory lock), locked to the single configured chat: unauthorized or chatless updates are
  logged and dropped with no DB rows and no reply. Updates are claimed by primary key via
  `INSERT ... ON CONFLICT DO NOTHING` on `telegram_updates.update_id`, so replays are no-ops.
  Accepted updates run `withRun(agent_chat, telegram)`, upsert the chat, store the inbound
  message (run id set, conflict-safe on `(chat_id, telegram_message_id)`), reply to `/start`
  and `/ping`, store the outbound message, and mark the update processed; failures store
  `telegram_updates.error` and are not retried. `drop_pending_updates: false` is kept for
  phase 02 — replay is harmless for idempotent `/ping`.
- Alternative: webhook delivery; rejected for the dev topology (no public endpoint yet) and
  because long polling is simpler to make single-poller with the lock.
- Consequence: replay of stale approvals/agent commands becomes non-harmless once approvals
  land in phase 05 — reconsider `drop_pending_updates` and approval expiry deliberately then.
  Agent replies are at-most-once; a crash after a reply before finalize loses the record
  rather than duplicating it.
- Approval: approved 2026-10-19 for incremental implementation.

## D024: Heartbeat is an outbox producer with a job-id dedupe key
Date: 2026-10-21 | Status: accepted | Phase: [02](phases/02-runtime-skeleton.md)
- Context: the daily heartbeat must prove the worker is alive, deliver exactly one Telegram
  message per run, and surface deliveries that were quarantined or failed without a second
  admin/redrive path.
- Choice and reason: the heartbeat cron enqueues a normal job; the handler opens a `system` run
  (`schedule` or `manual`), counts terminal `quarantined`/`failed` outbox rows, then inserts one
  `system`/`at_most_once` outbox row with dedupe key `system:heartbeat:<pg-boss job id>` and the
  run id. Delivery goes through the normal dispatcher, so retries/quarantine/policy apply. The
  body is an ISO timestamp plus `N notifications had uncertain delivery` and `M notifications
  failed` only when non-zero. A retried pg-boss job reuses its job id, so the unique dedupe key
  prevents a second row; the daily schedule remains the dead-man's switch (silence means the
  worker is down). `pnpm smoke:heartbeat` enqueues a manual job and polls the same dedupe key.
- Alternative: sending directly from the cron handler; rejected because it bypasses the outbox
  audit/retry/quarantine path. Repeating the heartbeat until acknowledged; rejected because a
  duplicate heartbeat is noise and at-most-once is the right trade.
- Consequence: phase 02 produces only `system`/at-most-once rows. Quarantined/failed rows have no
  admin redrive yet; the heartbeat count is the visibility signal and the operator clears them
  manually. A paused heartbeat schedule weakens the dead-man's switch, so keep the daily default.
- Approval: approved 2026-10-19 for incremental implementation.

## D025: Health split: public liveness, public readiness, token-protected details
Date: 2026-10-20 | Status: accepted | Phase: [02](phases/02-runtime-skeleton.md)
- Context: public health endpoints must be safe to expose without leaking internals, while
  monitors need a real readiness signal and the operator needs state.
- Choice and reason: `/health` answers only `{ok:true|false}` from DB reachability (no counts,
  timestamps, or internal state). `/health/ready` is 200 only when the DB is reachable and the
  worker's advisory lock is held (a stopped worker is 503 — readiness semantics, not an API
  outage). `/health/details` requires `Authorization: Bearer <HEALTH_DETAILS_TOKEN>` compared
  with `timingSafeEqual` over length-padded buffers; 404 when the token is unset, 401 when
  missing/wrong; it reports db, worker lock, latest heartbeat/dispatch runs, outbox
  due/sending/quarantined/failed counts, `telegramConfigured`, uptime, and timestamp.
- Alternative: localhost-detection for the detailed view; rejected as fragile behind proxies —
  an explicit token is simpler to reason about. Single fat `/health`; rejected because it
  couples public exposure with internals.
- Consequence: the details token is optional; without it the detailed view is simply absent
  (404). All three routes 503 when the DB is down. No pg-boss tables are ever queried.
- Approval: approved 2026-10-19 for incremental implementation.

## D026: Single-worker session advisory lock + drain-on-shutdown
Date: 2026-10-19 | Status: accepted | Phase: [02](phases/02-runtime-skeleton.md)
- Context: exactly one worker may own the Telegram poller, startup recovery, and cron
  schedules; kills and deploys must not double-deliver or lose in-flight sends.
- Choice and reason: the worker takes a session-level `pg_try_advisory_lock(namespace, id)`
  on a dedicated `pg.Client` before starting any subsystem (pg-boss, recovery, schedules,
  bot). A second worker exits 1 with a clear message. Loss of the lock connection is fatal —
  the single-worker guarantee is gone. Readiness checks `pg_locks` for the same key pair
  (`classid` + `objid`; `objsubid` distinguishes key form — two-key locks read 2 on this
  server — so it is not filtered). Shutdown drains: abort the dispatch signal (no new
  claims; the in-flight send finishes and finalizes) → stop bot polling → await in-flight
  bot handlers → `boss.stop({graceful:true, timeout:30_000})` → release the lock → close
  pools → exit 0, with a force-exit fallback. SIGKILL is not drainable; policy-aware startup
  recovery handles the leftovers next boot.
- Alternative: leader election or app-level leases; rejected for complexity — a session
  advisory lock dies with the connection, which is exactly the desired semantics.
- Consequence: direct Postgres connections are required; transaction-pooling PgBouncer in
  front of the lock would break the guarantee and must be addressed before such a deploy.
- Approval: approved 2026-10-19 for incremental implementation.

## D027: Narrow network-error classification for delivery
Date: 2026-10-19 | Status: accepted | Phase: [02](phases/02-runtime-skeleton.md)
- Context: the dispatcher must treat "the request provably never reached Telegram" differently
  from "the send may have happened"; grammy wraps both API answers and transport failures in
  its own error types.
- Choice and reason: `classifyTelegramSendError` (src/errors.ts) walks error/cause chains and
  returns three categories with per-row actions. Retryable (429 with `retry_after`,
  ENOTFOUND/EAI_AGAIN, ECONNREFUSED/ENETUNREACH/EHOSTUNREACH) → pending + backoff. Permanent
  (other 4xx, TLS configuration errors) → failed. Uncertain (timeout/abort — including
  fetch aborts wrapped in `HttpError`, where a `TimeoutError` reason distinguishes the send
  deadline from a shutdown abort — ECONNRESET/EPIPE, 5xx, unknown) → the row's delivery
  policy decides: quarantined (at-most-once) or retried (at-least-once). GrammyError payloads
  are excluded from all error text; retries bound at 5 attempts.
- Alternative: treating all non-2xx as retryable; rejected because a duplicate heartbeat is
  noise and an ambiguous resend can double-deliver.
- Consequence: at-most-once rows can be quarantined after a timeout even when the message was
  actually delivered — the safe direction; the heartbeat reports the count.
- Approval: approved 2026-10-19 for incremental implementation.

## D028: Combine account sync and mail triage/notifications into phase 03
Date: 2026-10-21 | Status: accepted | Phase: [03](phases/03-important-email-alerts.md)
- Context: account sync alone produces no user-visible outcome, while triage/no-alert code has
  no input without sync. The prior roadmap split them across phases 03 and 04.
- Choice and reason: one phase, "Mail ingestion + important alerts", delivered in seven reviewable
  increments: contracts/schema/config → account connection → ingestion → classification/feedback/
  spend → notification production → Telegram review/corrections → verification. The old phase 04
  entry is retired in the roadmap; its number is retained only so existing references to phases
  05–07 and historical records stay stable.
- Alternative: keep separate phases; rejected because each would need a partial, hard-to-verify
  end-to-end story and would duplicate review cycles.
- Consequence: phase 03 is larger and each increment needs its own approval/verification. Phase 02's
  live Telegram exit test remains an independent prerequisite and stays recorded as pending.
- Approval: approved 2026-10-21 for increments 1–2, 2026-10-22 for increment 3, and 2026-10-22
  for increment 4; increments 5–7 remain pending approval.

## D029: Rule/correction precedence and honest decision provenance
Date: 2026-10-21 | Status: accepted | Phase: [03](phases/03-important-email-alerts.md)
- Context: classifier output, explicit rules, and one-message corrections can disagree; recording
  a rule decision as a model call would make audit and tuning dishonest.
- Choice and reason: precedence is **message correction → explicit rule → classifier**. A
  correction stays pinned to the shown classification and applies to stored copies sharing the
  normalized RFC Message-ID (message-only without it); it never creates a rule. Rules are explicit,
  future-only actions (`notify`/`ignore`) matching an exact sender or domain, optional subject text,
  and optional account scope; conditions combine with AND and match case-insensitively. Domains do
  not include subdomains. If several rules match, the most recently edited active rule wins, with
  `id DESC` as the stable tie-breaker. Classification rows carry `decision_source`; rule rows have
  `applied_rule_id` and null category/model/prompt/classifier/confidence/effort, and correction
  rows have null category/model/prompt/classifier/confidence/effort and no rule. Classification
  history stays append-only with one current row.
- Alternative: treat rules as synthetic classifier calls with confidence 1.0; rejected because it
  pollutes model provenance and tuning examples. Auto-create sender/domain rules from corrections;
  rejected because a one-message correction must not silently broaden.
- Consequence: changing a rule affects future processing only; past classifications keep their
  decision source and rule reference. Rule edits are conflict-ordered by `updated_at`/`id`.
- Approval: approved 2026-10-21 for increment 1 implementation of the schema/contracts.

## D030: Importance and urgency are separate; confidence is diagnostic
Date: 2026-10-21 | Status: accepted | Phase: [03](phases/03-important-email-alerts.md)
- Context: a bank transaction or rejection can deserve an alert without requiring a reply or being
  urgent; conflating category with notification decision would suppress useful alerts.
- Choice and reason: `should_notify` is the authoritative alert decision, while `category` remains
  the urgency/response category and `topic` describes the mail domain
  (`banking/work/career/other`). The classifier records a concise summary, reason, confidence, and
  actual reasoning effort. Confidence is diagnostic only: never suppress a positive importance
  decision merely because confidence is low. Favor notifying when importance is genuinely
  ambiguous. Automated/promotional/no-reply senders are not blanket-ignored.
- Alternative: infer notification from the category/confidence thresholds; rejected because it
  couples two independent judgments and makes corrections confusing.
- Consequence: rules can set `should_notify` without inventing an urgency category; classifier
  callers must validate topic, category, `should_notify`, confidence, summary, and reason, and
  preserve the existing urgency enum.
- Approval: approved 2026-10-21 for increment 1 implementation of the schema/contracts.

## D031: Durable daily model-budget reservations
Date: 2026-10-21 | Status: accepted | Phase: [03](phases/03-important-email-alerts.md)
- Context: an in-memory daily counter or post-call audit row loses reservations when a worker dies
  mid-request; retries could then exceed the $1/day budget or unknown outcomes could be treated as
  free.
- Choice and reason: each paid model attempt inserts an `llm_calls` row with
  `status = 'in_flight'` and `reserved_cost_usd` (bounded worst case) **before** the provider
  request. Finalization records actual usage/cost and `reasoning_effort`; ambiguous failures become
  `unknown`; stale in-flight rows are recovered as `unknown`. The reservation remains counted.
  `getLlmBudgetUsageForRange` is the admission query: terminal rows count actual cost,
  in-flight/unknown rows count `greatest(reserved_cost_usd, cost_usd)`. The budget resets at local
  midnight in `Asia/Kolkata`; the initial `user_settings.daily_spend_limit_usd` is $1.00. If the
  reservation is non-positive or its insert fails, the call is not attempted. At exhaustion,
  sync/rules continue, model mail stays queued, one notice per local day is enqueued, and
  classification resumes next local day without marking paused mail ignored.
- Alternative: an app-level counter or a separate reservation table; the counter loses state on
  restart, and a separate table duplicates audit linkage. Rejected.
- Consequence: `getLlmSpendForRange` remains the recorded-spend view, while budget admission must
  use `getLlmBudgetUsageForRange`. Unknown rows can conservatively reduce the remaining budget
  until the next local day; they are never deleted to free it.
- Approval: approved 2026-10-21 for increment 1 implementation of the schema/helpers.

## D032: Stable email-triage dedupe fallback
Date: 2026-10-21 | Status: accepted | Phase: [03](phases/03-important-email-alerts.md)
- Context: reclassification inserts a new classification row, so D007's fallback
  `email_triage:classification:<id>` changes on every reclassification and could notify twice when
  a message lacks an RFC Message-ID.
- Choice and reason: use `email_triage:rfc:<normalized Message-ID>` when present, otherwise
  `email_triage:message:<messages.id>` (stable stored message identity). Normalization trims
  whitespace, extracts the first `<...>` value, and preserves case. The helper is
  `emailTriageDedupeKey` in `src/notifications/dedupe.ts`.
- Alternative: keep the classification-id fallback; rejected because it is not stable across
  reclassification. Hash the subject/body; rejected because unrelated mail can collide and edits
  change the key.
- Consequence: cross-inbox duplicates without an RFC Message-ID are not guaranteed to collapse;
  the fallback only guarantees one alert per stored message. Supersedes D007's fallback only.
- Approval: approved 2026-10-21 for increment 1 implementation.

## D033: Persist the first-connection notification boundary
Date: 2026-10-21 | Status: accepted | Phase: [03](phases/03-important-email-alerts.md)
- Context: an initial seven-day backfill must stay silent across restarts, and reconnecting an
  existing account must not reset notification history.
- Choice and reason: `mailbox_sync_state.notification_boundary_at` records the first successful
  connection instant. Automatic notifications require `messages.received_at >` the boundary.
  Restarts, full resyncs, and reconnects never reset it; an explicit missed-important correction
  may override it for a specific message.
- Alternative: derive silence from `ingested_at` or a process-local startup time; rejected because
  backfill/replay and reconnect would make old mail alert or newly arriving mail silent.
- Consequence: Increment 2 sets the value atomically at first connection; existing accounts with a
  null boundary produce no automatic alerts until it is set. Backfilled mail remains searchable
  and correctable.
- Approval: approved 2026-10-21 for the increment 1 schema and increment 2 connection implementation.

## D034: Local Desktop OAuth with verified, atomic credential persistence
Date: 2026-10-21 | Status: accepted | Phase: [03](phases/03-important-email-alerts.md)
- Context: the connector runs on this computer, must obtain long-lived Gmail read access without
  a public callback or plaintext tokens, and must survive refreshes, reconnects, and revoked grants.
- Choice and reason: use a Google **Desktop** OAuth client with PKCE S256, a random one-use state,
  a callback bound only to `127.0.0.1` on a random port, and a five-minute flow deadline. Request
  only `gmail.readonly` with `access_type=offline`, `prompt=consent`, and no incremental grants.
  Before writing anything, verify the Gmail profile matches `--email` and the granted scopes are
  exactly `gmail.readonly`. Persist the account, encrypted access/refresh envelopes, and the
  first-connection boundary in one transaction. Use `upsertCredential` inside that transaction so
  a failure cannot leave a partial connection.
- Refresh lifecycle: reuse a stored access token until shortly before expiry; otherwise refresh
  and persist the new access token/expiry. Replace the refresh envelope when Google rotates it;
  preserve the existing refresh token when Google omits a replacement. `invalid_grant` marks the
  account `revoked`; missing scopes and permanent authorization failures mark it `error` with a
  bounded `mailbox_sync_state.last_error`; transient failures leave the account active for retry.
  Per-account status keeps one broken mailbox from stopping the others.
- Local controls: account list/pause/resume and company-domain/bank-sender configuration are local
  CLIs. Revoked or missing-scope accounts cannot be resumed; they require reconnect. Bank senders
  use the existing `vip_senders` table; company domains use `company_domains`.
- Alternative: web OAuth with a public callback; rejected for the local-only topology. Storing
  tokens in env; rejected by D010/D019. Refreshing without persisting expiry; rejected because it
  wastes provider calls and loses state across restarts. Reconnect overwriting the boundary;
  rejected by D033.
- Consequence: the connect command needs only Gmail OAuth + encryption config (not Telegram or
  OpenAI); account connection can happen before `MAIL_ENABLED=true`. No schema change was needed.
  Live Google verification still requires real Desktop OAuth credentials and test users.
- Approval: approved 2026-10-21 for increment 2 implementation.

## D035: Reliable per-account Gmail sync with page-atomic cursors and recovery scans
Date: 2026-10-22 | Status: accepted | Phase: [03](phases/03-important-email-alerts.md)
- Context: a crash, Gmail history expiration, a message removal, or two overlapping sync jobs must
  not strand mail, skip a page, duplicate ingestion, or make one broken mailbox stop the others.
- Choice and reason:
  - A coordinator runs about every minute and enqueues one job per active, non-backing-off Gmail
    account. A session advisory lock per account serializes sync. pg-boss `singleton_key` may
    coalesce queue entries, but cursor/ingestion correctness comes only from DB constraints and
    transactional page commits.
  - Initial sync captures the Gmail profile `historyId` **before** the seven-day silent backfill,
    finishes every backfill page, commits the checkpoint + `initial_sync_completed_at`, then
    replays history from the checkpoint. Arrivals during setup are replayed; a crash re-backfills
    idempotently against `(account_id, provider_message_id)`.
  - Incremental history is paged from the stored cursor. Each page commits message upserts, label
    additions/removals, and the cursor to the last processed history record in one transaction.
    The response `historyId` is stored only after the final page, so an unprocessed page is never
    skipped. A failed page leaves the previous cursor intact.
  - An expired/invalid history cursor (404) sets `needs_full_resync`; recovery scans
    `messages.list` from `last_success_at - 1h` (or the first-connection boundary minus seven days
    when no success exists), captures a new checkpoint first, completes every page, then replays
    history. Outages are not capped at seven days.
  - Gmail 404s during `messages.get` are skipped; Gmail deletions never delete retained application
    history; label changes update `provider_labels` on stored messages.
  - Ingest Gmail's recursive `format=full` payload: decode RFC 2047 headers, address lists,
    charsets, base64url bodies, prefer non-empty `text/plain`, and use `html-to-text` for HTML.
    Store raw and clean bodies separately with a cleaner version and normalized Message-ID. Bound
    raw/clean/header/attachment metadata and never fetch attachment content.
  - Persist `last_polled_at`, `last_success_at`, `last_failure_at`, bounded `last_error`,
    `consecutive_failures`, and exponential `backoff_until` (1m base, 1h cap).
  - Triage candidates are found by a DB sweep (not only by ingestion enqueue success); stale
    `in_progress` rows return to `pending`, and claims use `FOR UPDATE SKIP LOCKED`. The classifier
    consumer/enqueue path lands with increment 4.
- Alternative: rely on pg-boss job uniqueness for sync correctness; rejected because job state is
  orchestration, not a durable cursor. Incremental-only sync; rejected because a fresh account
  needs history. Fixed seven-day outage recovery; rejected because it loses older mail. Parse raw
  RFC822 with a new mail-parser dependency; rejected for now because Gmail's structured full
  payload already provides the recursive parts and avoids attachment downloads.
- Consequence: sync may re-fetch duplicate pages after a crash (unique upserts make it harmless),
  and recovery may re-ingest an overlap (labels update, classification state preserved). Long
  backfills are bounded by the pg-boss job expiry; page transactions make interruption safe. Live
  Gmail sync still requires real credentials.
- Approval: approved 2026-10-22 for increment 3 implementation.

## D036: Rule-first classification with fair triage, bounded examples, and local-day reservations

Date: 2026-10-22 | Status: accepted | Phase: [03](phases/03-important-email-alerts.md)
- Context: increment 4 must classify mail without letting a large backfill, one inbox, a provider
  retry, or an ambiguous failure bypass the agreed model budget; it must also honor explicit rules
  before spending and keep correction examples small and relevant.
- Choice and reason:
  - The triage job applies matching active rules first, using an active-rule join over pending mail.
    Rule decisions insert `decision_source='rule'` rows with no fictitious model fields. Only
    non-matching mail enters the classifier path. Message corrections remain the highest precedence
    but their producers/application land in increment 6.
  - Classification uses the Responses API with `gpt-6-luna`, `reasoning.effort` from configuration
    (`medium` default, `high` allowed), structured output, `store: false`, no tools, and SDK
    `maxRetries: 0`. Topic, urgency category, `shouldNotify`, confidence, summary, and reason are
    validated before storage. Confidence is diagnostic only.
  - Prompts are versioned in code and delimit email metadata, bodies, and examples as escaped
    untrusted data. Only `clean_text` and bounded metadata enter the prompt. At most six prior
    feedback examples are selected (same sender/domain first, then recent), and the current message
    plus same-RFC copies are excluded. `missed_important`/`useful` teach alert, `too_noisy` teaches
    no alert, and a category-only correction preserves the shown notification decision.
  - The coordinator enqueues a bounded `mail-triage` job only when runnable work exists. Claims are
    selected per account and round-robined, with live arrivals ahead of silent backfill, so one
    inbox cannot monopolize a batch. The rule pass is budget-independent and cannot be starved by a
    non-matching backlog.
  - Model calls are serialized in the worker. Before each attempt, admission checks the local-day
    range from `user_settings.timezone` and the conservative `getLlmBudgetUsageForRange` total, then
    `withLlmCall` durably reserves the worst-case cost computed from snapshotted `gpt-6-luna` rates.
    Usage/cost records cached input, cache writes, output, and reasoning (reasoning is a subset of
    output, never added twice), plus request id, effort, latency, and bounded errors.
  - Transient failures use `messages.triage_next_attempt_at` with 1m→1h exponential backoff and a
    five-attempt ceiling. Refusals, invalid output, and exhausted attempts become terminal `failed`
    rows; `pnpm mail:triage retry-failed` is the explicit operator recovery. At budget exhaustion,
    rules and sync continue, model mail stays pending, and one `system` notice per local day is
    enqueued (inside the triage run, or with a short `system` run when the preflight inserts it
    without opening a triage run). The next local day admits queued mail again without an ignore
    decision.
- Alternative: keep the queue global and recency-ordered; rejected because a large inbox or backfill
  can starve live mail and other accounts. Include all recent feedback as examples; rejected because
  prompts grow and irrelevant labels add noise. Rely on SDK retries; rejected because each paid
  attempt must have its own reservation/audit row. Store only total output cost and ignore reasoning;
  rejected because the agreed reconciliation needs the usage breakdown.
- Consequence: classification is one model call per non-rule message with no hidden retries; a
  process crash leaves reservations `unknown` until their actual cost is known. Terminal failures
  need the explicit requeue command. Alert production remains increment 5 work; the correction
  precedence branch and Telegram feedback remain increment 6 work. Live OpenAI verification still
  requires a real key and model access.
- Approval: approved 2026-10-22 for increment 4 implementation (user request).

## D037: Transactional canonical email alerts with bounded rendering and validated buttons

Date: 2026-10-22 | Status: accepted | Phase: [03](phases/03-important-email-alerts.md)
- Context: increment 5 must turn a positive classification into exactly one canonical Telegram
  alert without losing an alert on a crash, alerting silent backfill, duplicating a cross-inbox
  copy, or sending unvalidated callback payloads. A correction on the canonical email must also
  govern later copies of the same email.
- Choice and reason:
  - The current classification insert, the message's `classified` transition, and
    `enqueueNotification` run in one transaction. `enqueueNotification`, the decision helpers, and
    the alert producer accept a `DbSession`; transaction-owning wrappers remain for the triage job.
    This makes a crash after classification unable to strand an unsent alert.
  - `src/mail/alerts.ts` loads the message/account/boundary in the same transaction. Automatic
    alerts require a non-null `notification_boundary_at` and `received_at >` it. The latest
    canonical correction for the normalized RFC Message-ID wins over the current decision:
    current `decisionSource='correction'` rows are checked first, with the latest feedback label
    as a fallback when it is newer. A negative correction suppresses another copy; a positive
    missed-important correction permits the alert and overrides the boundary. The explicit
    `allowBeforeBoundary` option exists for the increment 6 missed-important action. Scope is the
    RFC Message-ID (or the single stored message when absent), never the Gmail thread.
  - Dedupe reuses D032: `email_triage:rfc:<normalized Message-ID>` or
    `email_triage:message:<stored message id>`. The existing unique outbox key, at-least-once
    policy, bounded retries, expiry, and restart recovery are unchanged; production never bypasses
    the outbox.
  - Alert bodies are bounded plain text (1,500 characters) built from stored bounded fields only:
    receiving account, sender, subject, classifier summary/reason, and an account-scoped Gmail
    search link. Long card/account digit runs keep only the last four digits; OTP-style values near
    OTP/verification/passcode wording are replaced with `[redacted]`. No transaction details or
    deadlines are invented.
  - The payload contract is `{ version: 1, messageId, accountId, gmailUrl, inlineButtons }`, where
    `inlineButtons` is at most 8 rows × 8 buttons of `{ text, callbackData }`. Text is ≤ 64
    characters and callback data is ≤ 64 UTF-8 bytes. Buttons use
    `mail:useful:<classification id>`, `mail:not_important:<classification id>`, and
    `mail:create_rule:<classification id>`. Production, the dispatcher, and the Telegram sender
    validate the shape; invalid payload buttons are omitted so the alert body still sends.
- Alternative: enqueue after the classification commits; rejected because a crash between the two
  commits loses the alert permanently. Let the dispatcher render from message rows; rejected
  because it would put untrusted full bodies and correction logic on the delivery path. Store a
  Telegram-specific payload without validation; rejected because callback data limits and malformed
  keyboards would fail delivery. Treat thread IDs as the correction/dedupe scope; rejected because
  different emails in one thread must stay independently eligible.
- Consequence: an alert may still be delivered twice after a crash between Telegram acceptance and
  the `sent` finalize (existing at-least-once ambiguity). Callback parsing, chat validation,
  feedback application, rule creation, and unsent-alert cancellation remain increment 6 work.
  Without an RFC Message-ID, cross-inbox duplicate detection is not guaranteed. No schema change
  was needed for increment 5.
- Approval: approved 2026-10-22 for increment 5 implementation (user request).

## D038: Deterministic Telegram mail review, corrections, and rule controls

Date: 2026-10-22 | Status: accepted | Phase: [03](phases/03-important-email-alerts.md)
- Context: increment 6 must let the single allowed chat review ignored/search mail, correct both
  false positives and false negatives, and create/disable future rules without a conversational
  agent, while keeping callbacks valid, idempotent, and bounded.
- Choice and reason:
  - `/mail ignored [page]`, `/mail search <text>`, `/mail rules [page|add|disable]`, and
    `/mail status` are deterministic command handlers. Review/search pages show five items with
    **Important**, **Not important**, and **Rule** buttons; pagination edits the same message.
    Search uses the documented subject/clean-text FTS expression plus a bounded sender substring
    and includes ignored and unclassified mail. Only classified items get correction buttons.
  - Bot replies are stored in `telegram_messages` with an app-only payload (`mailReview`,
    `mailRuleDraft`, or `mailRuleList`). Callback validation uses that stored payload, the
    configured chat, the target classification, and (for alert buttons) the outbox row whose
    `telegram_message_id` and `classification_id` must both match. A mismatched or stale callback
    is acknowledged with a short error and changes nothing. Callback data contains only a short
    action plus a UUID/page; subjects and account scopes live in the stored preview payload.
  - Feedback is upserted against the classification originally shown, with an optional
    notification link only when that notification belongs to the classification. Review callbacks
    without a notification are supported and keep an existing valid link on repeat. Repeated
    same-direction corrections are idempotent; changing direction appends correction history.
  - A correction locks the canonical message rows (`FOR UPDATE`, ordered by id), inserts
    `decision_source='correction'` rows across copies with the same normalized RFC Message-ID (or
    the stored message only), and applies the correction to the displayed classification. Classifier
    and rule decision helpers lock the message and refuse to supersede a current correction, so an
    in-flight classification cannot win the race. Important corrections call the alert producer
    with `allowBeforeBoundary`; unimportant corrections cancel only `pending`/`batched` outbox rows.
    Sent/sending rows are never rewritten. Cancelled, failed, or expired undelivered alerts may be
    reactivated by an explicit important correction, reusing the same dedupe key.
  - Rule creation is a two-step preview + explicit **Save** action. The preview can toggle action
    (`notify`/`ignore`), sender/domain matching, and all-accounts vs. the source account scope.
    `/mail rules add ...` accepts an optional `subject:` condition and `account:` scope. Identical
    active rules are reused; disabling sets `active=false` and keeps the row so past rule
    provenance remains. The existing most-recently-edited/id precedence is unchanged.
  - `/mail status`, token-protected `/health/details`, and the daily heartbeat reuse one mail status
    snapshot: account sync health/counts, backlog/failure counts, local-day spend/reservation, and
    outbox counts. Public `/health` and `/health/ready` responses stay minimal.
- Alternative: store rule drafts in a new table; rejected because the stored outbound preview
  already provides a bounded, message-scoped draft without a schema change. Delete cancelled outbox
  rows; rejected to preserve delivery history and dedupe. Trust callback data alone; rejected because
  stale buttons could target superseded classifications or another chat. Add a conversational agent;
  out of scope for this phase.
- Consequence: callback data stays under Telegram's 64-byte limit; rule subjects/scopes are visible
  only in the stored preview payload. A correction during an in-flight classification blocks the
  classifier's decision insert until the correction commits, then the classifier yields to it.
  Alerts may still be delivered twice only in the existing at-least-once crash window. No schema
  change was needed for increment 6.
- Approval: approved 2026-10-22 for increment 6 implementation (user request).

## D039: Pace Gmail API calls to stay within project quota

Date: 2026-10-22 | Status: accepted | Phase: [03](phases/03-important-email-alerts.md)
- Context: real verification with two connected Gmail accounts hit Google's per-minute
  `Total Query Cost`/units quota during the initial seven-day backfill. The unthrottled sync
  failed after many list/get calls; the same accounts then ingested 220 and 190 messages with a
  throttled verification wrapper (350 ms between calls).
- Choice and reason: add `GMAIL_REQUEST_DELAY_MS` (default 350 ms, range 0–5000) to validated mail
  config and pace every Gmail `getProfile`, `messages.list`, `messages.get`, and `history.list`
  call in `src/mail/sync.ts`. The worker passes the configured delay; tests omit it and stay fast.
  This keeps the backfill under project quota without changing cursor/ingestion transactions.
- Alternative: rely only on the existing failure backoff/retry; rejected because each retry can hit
  the same per-minute burst and repeatedly fail the initial sync. Reduce page size only; rejected
  because per-message `get` calls dominate and page size alone did not address the observed burst.
- Consequence: a 220-message backfill takes roughly 1–2 minutes at the default delay instead of
  seconds. Sync remains per-account serialized; quota failures are still visible, bounded, and
  backed off. Operators can set `GMAIL_REQUEST_DELAY_MS=0` for tests or higher for stricter quotas.
- Approval: approved 2026-10-22 for increment 7 verification.

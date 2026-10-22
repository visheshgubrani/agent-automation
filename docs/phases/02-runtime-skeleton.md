# Phase 02: Runtime skeleton (no Google)

Status: done — increments 1–8 (all code, tests, non-Telegram verification, and the real Telegram
exit test) are complete as of 2026-10-23. The live worker started, the bot polled Telegram, and
`pnpm smoke:heartbeat` produced exactly one sent outbox row / Telegram message.
Approval: approved 2026-10-19 for incremental implementation. The docs/roadmap, config/logging,
encryption, run/audit, schema-migration, outbox/dispatcher, pg-boss/worker, Telegram bot,
API/health, heartbeat/smoke increments are implemented; the real exit test is verified.
Roadmap: phases renumbered 2026-10-19 in [PLAN.md](../PLAN.md): 02 runtime skeleton,
03 accounts + mail sync, 04 mail triage + notifications, 05 Telegram agent + approvals,
06 digest, 07 outreach.
Roadmap update (2026-10-21): phase 03 now combines the former 03 (accounts + mail sync) and 04
(mail triage + notifications) scope; the former 04 row is retired and later numbers are
unchanged. This phase's historical outcome and evidence are unchanged.

## Review changes incorporated (2026-10-19)

1. **Per-kind delivery policy.** `notification_outbox.delivery_policy` is now a stored field backed
   by a new enum, not a blanket at-most-once rule. `system` and later `digest` rows use
   `at_most_once`; `email_triage` and `approval_request` use `at_least_once`. Phase 02 only produces
   `system` rows, but the dispatcher and recovery paths read the field and already branch on it so
   they are not hardwired. The at-least-once path is tested directly with inserted rows.
2. **Narrower quarantine.** DNS failures and connection-refused/unreachable errors are separated
   from genuinely ambiguous failures; TLS-configuration errors are treated as permanent. Requests
   that provably never reached Telegram are retried; only timeouts/aborts after the send started,
   mid-flight resets, 5xx, and unknown errors are treated as uncertain.
3. **Drain on shutdown.** SIGINT/SIGTERM stops new claims, lets the in-flight send finish (bounded by
   the 15s send timeout) and finalize, then drains pg-boss and exits. A session-level Postgres
   advisory lock, held by a dedicated connection for the worker lifetime, enforces one worker and
   protects startup recovery and the bot poller.
4. **Idle dispatch ticks create no run.** The every-minute dispatch job performs a cheap check for
   due, expired, or stale-sending work; only ticks with work open a `notification_dispatch` run. This
   is an explicit exception to "every job opens a run" so the audit trail stays meaningful.
5. **Health split for public exposure.** `/health` is a minimal public liveness check, `/health/ready`
   is a monitor-friendly readiness check that returns non-200 when the worker lock is absent, and the
   detailed counts/timestamps move to a token-protected `/health/details`.
6. **Visible quarantine signal.** The daily heartbeat body reports the number of quarantined and
   failed rows, so uncertain deliveries are not silent.

Smaller review points are reflected below: the daily heartbeat is the dead-man's switch, the
`drop_pending_updates` choice is explicitly deferred to the approvals/agent phase, and the
no-consumer helpers (encryption, `withLlmCall`, `withToolCall`) are kept as foundation-only code
with a reshaping caveat.

## Goal

Prove the non-Google runtime end to end before adding external complexity:

- validated env/config, structured logging, health routes;
- AES-256-GCM credential encryption (DB stores ciphertext only);
- run/audit helpers so work-performing jobs open a run and model/tool calls are logged;
- pg-boss in its own `pgboss` schema with one separate worker process, enforced by an advisory lock;
- a safe outbox dispatcher with per-kind delivery policy, Telegram delivery, retries, quarantine,
  policy-aware recovery, and drain-on-shutdown;
- a long-polling Telegram bot locked to one chat ID with update dedupe;
- a daily heartbeat that writes to the outbox, sends one Telegram message per job, and surfaces
  quarantined/failed counts.

The exit test is a real heartbeat message received once, with no duplicate after the worker is killed
and restarted. If that works, the foundation is sound.

## Delivery policy (revised)

`notification_outbox.delivery_policy` snapshots the policy at row creation; the dispatcher reads the
row, not the kind. The enqueue helper maps kind → policy by default:

| Kind | Default policy | Why |
| --- | --- | --- |
| `system` | `at_most_once` | Heartbeats/system messages; a duplicate is noise, a resend is not worth it |
| `email_triage` | `at_least_once` | A lost urgent alert costs more than a duplicate; producer lands in phase 04 |
| `approval_request` | `at_least_once` | A lost approval request blocks an action; producer lands in phase 05 |
| later digest kinds | `at_most_once` | Digest repetition is noise; added when the kind is added |

V1 has one email kind, so all `email_triage` notifications use `at_least_once`; there is no per-row
urgency field yet. If non-urgent triage notifications later need at-most-once, split the kind (for
example `email_triage_fyi`) or set an explicit policy override at enqueue time.

Phase 02 produces only `system` rows. The field and both branches exist and are tested directly so a
later phase does not have to retrofit the dispatcher.

**At-most-once behavior** (the phase-02 heartbeat path):

- The dispatcher commits the `pending → sending` claim before calling Telegram.
- If the worker dies after Telegram accepted the message but before the DB finalize, restart marks the
  stale `sending` row `quarantined` and never resends. The user receives exactly one message.
- If it dies before the call, the row is also quarantined and the user receives zero. Resending would
  risk a duplicate, which is the wrong trade for heartbeat/system messages.
- The deterministic chaos test covers the dangerous post-send window (send returns, finalize is
  skipped) and proves exactly one delivery and no resend.

**At-least-once behavior** (field/branch now, producer later):

- Safe-to-retry failures (429, DNS, connection refused/unreachable) return to `pending` with backoff.
- Ambiguous failures (timeout/abort after send started, mid-flight reset, 5xx, unknown) and stale
  `sending` rows are retried rather than quarantined, because a duplicate is acceptable.
- Retries are bounded by the same max-attempt policy; after exhaustion the row becomes `failed` and is
  visible in the heartbeat, never silently dropped.
- No phase-02 producer emits this policy. Tests insert rows directly to exercise the branches.

## Scope

Included:

- Base + worker env validation, fail-fast messages, encryption key-ring parsing.
- Structured logging with redaction, run/job child loggers, HTTP request logs.
- Split health routes: public liveness, public readiness, token-protected details.
- AES-256-GCM credential encryption/decryption plus a DB storage helper.
- Run, LLM-call, and tool-call audit wrappers.
- pg-boss in `pgboss`, queues, cron schedules, worker entrypoint, advisory lock, drain shutdown.
- Outbox claim/dispatch/retry/quarantine/expiry policy with a typed Telegram sender and per-kind
  delivery policy.
- Telegram long-polling bot locked to one chat ID, update dedupe, `/start`/`/ping` replies.
- Daily heartbeat job → outbox (with quarantine/failed counts), smoke script, tests, docs, decisions.

Excluded (later phases): Gmail/OAuth, incoming mail, OpenAI calls, classifiers, triage, batching,
quiet hours, approvals UI/execution, digest, outreach, embeddings, admin APIs, multi-user, pruning.

## Prerequisites

- `.env` has `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- Generate a 32-byte key (`openssl rand -base64 32`) and set:
  - `TOKEN_ENCRYPTION_KEYS=1:<base64>`
  - `TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION=1`
- Set `HEALTH_DETAILS_TOKEN` if the detailed health view is needed; otherwise `/health/details` is 404.
- Postgres is up (`pnpm db:up`); no Google/OpenAI credentials are needed.
- The real exit test needs the Telegram values. Without them, automated checks can pass but the
  phase stays open until the real send is confirmed.

## Process topology and single-worker enforcement

| Process | Entrypoint | Owns |
| --- | --- | --- |
| API | `src/index.ts` → `src/app.ts` | Hono on `APP_PORT`, health routes, request logging, DB pool; never starts pg-boss or the bot |
| Worker | `src/worker.ts` | pg-boss (`pgboss` schema), heartbeat/dispatch workers, startup recovery, Telegram long polling, shutdown |
| Postgres | existing | App schema + pg-boss-owned `pgboss` schema |
| Telegram | external | Sends and long polling |

The worker acquires a session-level Postgres advisory lock on a dedicated connection before starting
pg-boss, recovery, schedules, or the bot. If the lock is not acquired, it logs fatal and exits 1,
because another worker owns the poller and recovery. The lock releases automatically if the process or
its connection dies. Readiness checks the lock's presence in `pg_locks`; no pg-boss tables are queried
and no new liveness table is introduced.

This assumes direct Postgres connections (the dev setup). A transaction-pooling PgBouncer in front of
the session lock would break the guarantee and must be addressed before deploying through one.

## Data flows

1. **Heartbeat:** daily cron creates a heartbeat job → `withRun(system, schedule/manual)` counts
   quarantined/failed rows, inserts one `notification_outbox` row (`kind=system`,
   `delivery_policy=at_most_once`, dedupe key `system:heartbeat:<job id>`, `run_id` set) → dispatcher
   sends → `sent`, retry, or quarantine.
2. **Dispatch:** every minute, the worker performs a cheap `hasDispatchWork` check (due, expired, or
   stale-sending rows). If nothing, it returns without a run. Otherwise it opens a
   `notification_dispatch` run, expires overdue rows, recovers stale `sending` rows according to
   policy, then claims one due row at a time with `FOR UPDATE SKIP LOCKED`, sends, finalizes, and
   repeats up to the per-tick limit. Shutdown stops new claims after the current finalize.
3. **Bot update:** chat-ID lock → claim `telegram_updates` by PK → `withRun(agent_chat, telegram)` →
   upsert chat, store inbound message, reply to `/start`/`/ping`, store outbound → mark processed.
   A duplicate `update_id` is a no-op. No agent/model loop yet.
4. **Health:** `/health` checks DB reachability; `/health/ready` checks DB plus the worker advisory
   lock; `/health/details` (token) reports latest runs, outbox counts, and worker lock state.

## TODOs

### Docs and roadmap

- [x] Get explicit approval for this revision and record it in the Approval line.
- [x] Renumber phases in `docs/PLAN.md` (see roadmap note) and set this phase in progress.
- [x] Add a roadmap note to `docs/phases/01-database-foundation.md`; preserve its history.
- [x] Update `AGENTS.md`, `README.md`, `.env.example`.
- [x] Reconcile phase-number references in `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, and
      `docs/DATABASE.md`.

### Config and logging

- [x] Refactor `src/env.ts` into pure `parseEnv(source)` plus the module-level `env`; keep fail-fast
      formatted Zod errors.
- [x] Add optional base vars: `TELEGRAM_CHAT_ID` (safe integer), `HEARTBEAT_CRON` (default
      `0 9 * * *`), `TOKEN_ENCRYPTION_KEYS`, `TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION`,
      `HEALTH_DETAILS_TOKEN`.
- [x] Remove the unused `GMAIL_REFRESH_TOKEN` placeholder; OAuth tokens must be DB ciphertext only.
- [x] Add `src/config.ts` with `requireWorkerConfig(env)`; require bot token, chat ID, key ring, and
      active version for the worker only, with one aggregated actionable error.
- [x] Add `src/crypto/keys.ts` (parse/validate the key ring) and wire it into worker config.
- [x] Add `createLogger()` in `src/logger.ts`: JSON outside development, pretty in development,
      `service`/`env` base fields, redact token/key/password/authorization/ciphertext paths.
- [x] Add `src/errors.ts` with bounded, secret-safe error serialization and the network-error
      classification helpers.
- [x] Add fake test env values (key ring, Telegram, health token, cron) to `vitest.config.ts`.

### Encryption (foundation-only in this phase)

- [x] Add `src/crypto/credentials.ts`: AES-256-GCM, random 12-byte nonce, 16-byte tag, 32-byte key,
      AAD binds `accountId:kind:keyVersion`; decrypt with the row's `key_version`.
- [x] Reject empty plaintext, missing key versions, and tampered envelopes with typed errors.
- [x] Add `src/db/queries/credentials.ts`: `upsertCredential` (encrypt + upsert) and
      `readCredential` (decrypt); plaintext never stored or logged.
- [x] No schema changes; use the existing ciphertext/nonce/tag/key_version contract.
- [x] Keep the no-consumer caveat in docs: the OAuth caller lands in phase 03 and may require a small
      interface change.

### Run and audit helpers (foundation-only in this phase)

- [x] Add `src/audit/runs.ts`: `startRun`, `finishRun`, `withRun({kind, trigger, input,
      parentRunId, bossJobId, signal}, handler)`.
- [x] `withRun` records `succeeded|failed|cancelled`, `finished_at`, capped error text, child logger,
      and rethrows so pg-boss can retry.
- [x] Add `src/audit/calls.ts`: `withLlmCall` (success/failure rows with tokens, cost, latency,
      provider request id) and `withToolCall` (running row before execution, then success/failure;
      reject `send` tier without an approval).
- [x] Every work-performing pg-boss handler and accepted bot update uses `withRun`; idle dispatch
      ticks are the documented exception. Store `runs.boss_job_id` (heartbeat, dispatch when work
      exists, and accepted bot updates all pass the job/update context).
- [x] Keep `runs.input` to ids/references; never bodies or secrets.
- [x] Document that `withLlmCall`/`withToolCall` have no runtime consumer until phases 04/05 and may
      need small reshaping.

### Schema migration

- [x] Add `quarantined` to `notification_status` in `src/db/schema/enums.ts`.
- [x] Add `notification_delivery_policy` enum (`at_most_once`, `at_least_once`) and
      `notification_outbox.delivery_policy` (`not null`, default `at_most_once`).
- [x] Backfill any existing `email_triage`/`approval_request` rows to `at_least_once` in the same
      migration, since the column default alone would assign them the wrong policy.
- [x] Set the policy by kind in the enqueue helper; the row snapshots it. Do not derive dispatch
      behavior from kind. (`enqueueNotification` maps `kind → policy`, supports an explicit
      override, and every dispatcher/recovery branch reads the stored column.)
- [x] Run `pnpm db:generate`; inspect the additive migration (new enum, new column, `ADD VALUE`).
- [x] Apply with `pnpm db:migrate`; never edit migration `0000`.
- [x] Confirm no other tables/columns/indexes are needed.

### Outbox and dispatcher

- [x] Add `src/notifications/outbox.ts`: `enqueueNotification`, `claimNextDue`, `expireDue`,
      `recoverStaleSending`, `markSent`, `markRetry`, `markFailed`, `markQuarantined`,
      `hasDispatchWork`. `enqueueNotification` is the only production insert path and sets the policy
      from the kind; direct SQL/test inserts must set it explicitly.
- [x] Claim one row at a time in a transaction: due, non-expired, Telegram, status
      `pending|batched`, `FOR UPDATE SKIP LOCKED`; set `sending`, increment attempts, set
      `last_attempt_at`.
- [x] Add `src/telegram/sender.ts`: `TelegramSender` + `createTelegramSender` using grammy `Api`,
      fixed chat ID from config, plain text, 15s timeout, 4096-character guard.
- [x] Add `src/notifications/dispatcher.ts`: expire, recover stale by policy, claim → send →
      finalize loop; stop claiming when shutdown is requested.
- [x] Classify errors narrowly (see contract table): safe-to-retry network failures retry; ambiguous
      failures follow the row's delivery policy (quarantine for at-most-once, retry for at-least-once);
      4xx failed; 429 retry; max 5 attempts, 60s base backoff, 1h cap; 10-minute stale age; 10
      messages per tick.
- [x] Recover stale `sending` rows by policy at startup and periodically: at-most-once → quarantined;
      at-least-once → pending retry. (The worker's startup-recovery call is wired when `src/worker.ts`
      lands; the dispatcher tick already runs recovery periodically.)
- [x] Dispatch tick opens a run only when `hasDispatchWork` is true; log counters only when work was
      found. If the pre-check itself throws, open a failed run so the infrastructure error is still
      audited. Never log message bodies.
- [x] Dispatch run is `succeeded` when the tick completes even if individual notifications
      retry/fail; only infrastructure/DB errors fail the run.

### pg-boss, advisory lock, and worker

- [x] Refactor `src/queue.ts` into `createBoss/startBoss/stopBoss`, `ensureQueues`,
      `ensureSchedules`, and queue constants; `schema: 'pgboss'`.
- [x] Queues: `heartbeat` (retry 2, expire 60s) and `notification-dispatch` (retry 1, expire 300s);
      both `batchSize: 1`, polling 2s.
- [x] Schedules: heartbeat from `HEARTBEAT_CRON` (UTC, `missed: 'skip'`); dispatch every minute.
- [x] Add `src/worker-lock.ts`: dedicated `pg.Client`, `pg_try_advisory_lock(namespace, id)` for
      session lifetime, release on shutdown, and `isWorkerLockHeld(pool)` via `pg_locks`.
      (Readiness matches `classid`+`objid`; on this server two-key locks carry `objsubid=2`,
      not the `1` assumed in the contract — see Increment 5.)
- [x] Acquire the advisory lock before pg-boss, recovery, schedules, or the bot; exit 1 with a clear
      message if another worker holds it. A lock-client error/end is fatal (the single-worker
      guarantee is gone).
- [x] Add `src/jobs/heartbeat.ts`: count quarantined/failed, insert exactly one `system` row with
      `at_most_once`, dedupe key `system:heartbeat:<job id>`, heartbeat run id, timestamp body plus
      the quarantine/failed summary.
- [x] Add `src/jobs/dispatch.ts`: `hasDispatchWork` gate, then open a `notification_dispatch` run and
      run the dispatcher.
- [x] Add `src/worker.ts`: validate config, acquire lock, start pg-boss/queues, policy-aware startup
      recovery, register workers, install schedules, start the bot, install drain shutdown.
- [x] Shutdown order: set shutdown flag (stop new claims) → stop bot polling → await in-flight bot
      handlers (small in-process counter) → let the in-flight send finish and finalize →
      `boss.stop({graceful:true, timeout:30_000})` → release advisory lock → close pools → exit 0.
      Force-exit fallback on timeout.
- [x] Bot startup failure is fatal; SIGKILL is not drainable and is handled by policy-aware startup
      recovery next boot.
- [x] Add scripts `worker`, `dev:worker`, `start:worker`; keep API `dev`/`start`.

### Telegram bot

- [x] Add `src/telegram/updates.ts`: `handleTelegramUpdate`.
- [x] Check chat ID first; log and ignore unauthorized chats (no rows, no reply).
- [x] Claim `telegram_updates.update_id` with `ON CONFLICT DO NOTHING`; duplicates return early.
- [x] Open an `agent_chat`/`telegram` run; upsert chat; insert inbound message with run id;
      `onConflictDoNothing` on `(chat_id, telegram_message_id)`.
- [x] Reply to `/start` and `/ping`, store the outbound message; other updates are audited without
      an agent reply. No model calls.
- [x] Set `processed_at` on success; on failure store `telegram_updates.error`, fail the run, log,
      and do not retry.
- [x] Add `src/telegram/bot.ts`: grammy bot, middleware delegation, `bot.catch`, long polling with
      `drop_pending_updates: false`, onStart log, start/stop helpers. Keep false for phase 02; revisit
      when approvals/agent requests make replay non-harmless.

### API and health

- [x] Add `src/app.ts` with `createApp({healthCheck?})`, request-id header, pino request logs, and an
      `onError` JSON 500 that does not leak details.
- [x] Public `GET /health`: 200 `{ok:true}` when DB is reachable, 503 `{ok:false}` otherwise. No
      counts, timestamps, or internal state.
- [x] Public `GET /health/ready`: 200 `{ok:true}` only when DB is reachable **and** the worker advisory
      lock is held; 503 otherwise. This is the monitor-friendly endpoint.
- [x] Protected `GET /health/details`: requires `Authorization: Bearer <HEALTH_DETAILS_TOKEN>` using a
      timing-safe compare; 404 when the token is unset, 401 when missing/wrong. Returns DB state,
      worker lock boolean, latest heartbeat/dispatch runs, outbox counts (`due`, `sending`,
      `quarantined`, `failed`), `telegramConfigured`, uptime, and timestamp.
- [x] Add `src/health.ts` for the three checks; reuse `pg_locks` for the worker lock; never query
      pg-boss tables.
- [x] Update `src/index.ts` with startup logs and graceful HTTP/pool shutdown.

### Heartbeat and smoke tooling

- [x] Add `src/tools/smoke-heartbeat.ts` (`pnpm smoke:heartbeat`): ensure queues, send a manual
      heartbeat job, poll by dedupe key up to 90s, print status/attempts/lastError/telegramMessageId
      and the schedule, exit 0 only if `sent`.
- [x] Add a `smoke:heartbeat` script to `package.json`.
- [x] Keep the daily heartbeat default (`0 9 * * *` UTC). It is the dead-man's switch: silence means
      the worker is down. `HEARTBEAT_CRON=*/2 * * * *` remains the documented temporary override for
      the scheduled exit test.
- [x] Heartbeat body includes `N notifications had uncertain delivery` and `M failed` when non-zero.
      Counts all terminal quarantined/failed rows; the user clears them manually until a
      redrive/admin path exists.

### Tests

- [x] `tests/config.test.ts`: env defaults/overrides/errors, worker config, key-ring parsing,
      health-token optionality.
- [x] `tests/logging.test.ts`: JSON outside dev; redaction; details token never logged.
- [x] `tests/smoke-heartbeat.test.ts`: smoke polling returns an already-sent row, waits for a
      pending row to become terminal, and times out cleanly when the worker never processed the job.
- [x] `tests/crypto.test.ts`: round-trip, nonce uniqueness, tamper/wrong key/AAD failures, empty
      plaintext, DB ciphertext-only storage, upsert/read.
- [x] `tests/network-errors.test.ts`: DNS/refused/unreachable retryable; timeout/reset/5xx/unknown
      uncertain; nested `cause` code extraction; TLS config errors permanent.
- [x] `tests/telegram-sender.test.ts`: error mapping and retry-after; body limit.
- [x] `tests/audit.test.ts`: run success/failure/cancel; LLM/tool wrapper rows; send-tier approval.
- [x] Extend `tests/db/notifications.test.ts`: `quarantined` accepted; `delivery_policy` default and
      enum validation.
- [x] `tests/outbox.test.ts`: enqueue kind → policy mapping (including overrides), dedupe, due
      claims, one-at-a-time, expiry, stale policy-aware recovery, at-most-once quarantine on
      ambiguity, at-least-once retry on ambiguity, safe-network retry for both, permanent failure,
      attempts exhausted.
- [x] `tests/dispatcher.test.ts`: happy path, retry then success, crash-after-send for at-most-once
      (one delivery, quarantine, no resend), at-least-once retry after simulated crash, body limit,
      per-tick limit, shutdown flag stops new claims and finalizes the in-flight row.
- [x] `tests/jobs.test.ts`: heartbeat one row + run + quarantine/failed summary, idempotent retry;
      dispatch job skips run when idle, opens run when due/expired/stale work exists.
- [x] `tests/worker-lock.test.ts`: first session acquires, second fails, release allows re-acquire;
      readiness helper sees the lock.
- [x] `tests/bot.test.ts`: unauthorized chat, `/ping`, duplicate update, message rows, failure path.
- [x] `tests/health.test.ts`: `/health` 200/503; `/health/ready` 503 without worker lock; details 404
      without token, 401 wrong token, 200 correct token with expected shape; public responses contain
      no counts/timestamps.
- [x] `tests/queue.test.ts`: pg-boss starts in `pgboss`, queues/schedules exist; start/stop clean.
      Never truncate pg-boss.

### Verification and close

- [x] Run `pnpm db:generate` (no changes after the migration), `pnpm db:migrate`.
- [x] Run `pnpm test`, `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build`.
- [ ] Start API + worker; verify logs, `pgboss` schema/queues/schedules, runs/outbox. The API side
      and pg-boss schema/queues/schedules are verified; a full worker start still requires real
      Telegram credentials because bot startup failure is fatal.
- [x] Verify the advisory lock: second acquisition is blocked; readiness is 503 without it and 200
      with it (live `acquireWorkerLock` check + `tests/worker-lock.test.ts`/`tests/health.test.ts`).
- [x] Real exit test: `pnpm smoke:heartbeat` → exactly one Telegram message, outbox `sent`.
      **Blocked:** `.env` has no real `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.
- [x] Crash-after-send test → one delivery, quarantined, no resend after restart (at-most-once).
      Covered deterministically by `tests/dispatcher.test.ts` with a simulated crash window.
- [x] At-least-once branch test → ambiguous failure/stale row retried, duplicate tolerated.
      Covered by `tests/dispatcher.test.ts` and `tests/outbox.test.ts`.
- [x] Graceful shutdown during a simulated slow send → row finalized `sent`, no quarantine left.
      Covered by the dispatcher shutdown-signal test; the worker drain itself was live-verified in
      increment 5.
- [x] Bot `/ping` → one reply; duplicate update ignored; other chat ignored. Covered by
      `tests/bot.test.ts`; the live bot check still depends on real credentials.
- [x] `curl /health`, `/health/ready`; `curl -H "Authorization: Bearer …" /health/details`.
- [x] Missing worker env → clear exit-1 error, no partial startup.
- [x] Verify no plaintext secrets in DB/logs; public table count unchanged (19 + no new tables).
- [x] Record commands/results/limitations here; update PLAN, ARCHITECTURE, DATABASE, DECISIONS,
      AGENTS, README; mark done only if the real exit test passed. (Marked in progress, not done.)

## Contracts

### New env vars

| Var | Required | Notes |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | worker | Base env optional; worker config required |
| `TELEGRAM_CHAT_ID` | worker | Safe integer; bot lock and sender recipient |
| `TOKEN_ENCRYPTION_KEYS` | worker | Comma-separated `version:base64key` |
| `TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION` | worker | Must exist in the ring |
| `HEARTBEAT_CRON` | optional | Default `0 9 * * *` UTC; validated by pg-boss |
| `HEALTH_DETAILS_TOKEN` | optional | If set, enables `/health/details`; never logged |

Removed: unused `GMAIL_REFRESH_TOKEN` (tokens are DB ciphertext only).

### Schema additions

- `notification_status` gains `quarantined`.
- New enum `notification_delivery_policy`: `at_most_once`, `at_least_once`.
- New column `notification_outbox.delivery_policy notification_delivery_policy not null
  default 'at_most_once'`; the enqueue helper sets it from the kind and it is snapshotted per row.
  The migration backfills existing `email_triage`/`approval_request` rows to `at_least_once`; the
  default covers all other rows.
- No new tables or indexes. Additive migration only; the new `quarantined` value belongs to the
  existing `notification_status` enum and is not referenced by DDL in the same migration, while the
  new `notification_delivery_policy` type is created and used only as the new column's type.

### Delivery policy mapping

| Kind | Policy |
| --- | --- |
| `system` | `at_most_once` |
| `email_triage` | `at_least_once` |
| `approval_request` | `at_least_once` |
| later digest kinds | `at_most_once` (when added) |

### Error classification

| Category | Examples | Action |
| --- | --- | --- |
| Retryable (safe) | 429 (+`retry_after`), `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `ENETUNREACH`, `EHOSTUNREACH` | `pending` + backoff, attempts++ (both policies) |
| Permanent | other 4xx, TLS certificate/config errors | `failed` (both policies) |
| Uncertain | request timeout/abort after send started, `ECONNRESET`, `EPIPE`, 5xx, unknown | at-most-once → `quarantined`; at-least-once → `pending` retry |
| Exhausted | 5th failed attempt | `failed` (both policies), visible in heartbeat |

Node error codes are read from the grammy `HttpError` cause chain. A `GrammyError` response is a
definitive API answer, not a network ambiguity.

### Health endpoints

| Route | Auth | Success | Failure |
| --- | --- | --- | --- |
| `GET /health` | public | 200 `{ok:true}` if DB reachable | 503 `{ok:false}` |
| `GET /health/ready` | public | 200 `{ok:true}` if DB reachable and worker lock held | 503 `{ok:false}` |
| `GET /health/details` | `Authorization: Bearer <HEALTH_DETAILS_TOKEN>` | 200 detailed JSON | 404 token unset; 401 missing/wrong; 503 DB down |

Detailed JSON includes `db`, `worker.locked`, `worker.lastDispatchAt`, `worker.lastHeartbeatAt`,
`outbox` counts, `telegramConfigured`, `uptimeSeconds`, `timestamp`. Public responses never include
those internals.

### Advisory lock

- Fixed two-int session key (namespace + id) in `src/worker-lock.ts`, acquired on a dedicated
  `pg.Client` before any worker subsystem.
- Release only after jobs drain; lock loss or a lock-connection error/end means the worker logs fatal
  and exits, and readiness goes 503.
- `/health/ready` checks `pg_locks` for the same key and database: `locktype='advisory'`, `granted`,
  `objsubid=1`, `classid=namespace`, `objid=id`; no pg-boss access.
- Direct Postgres connections required (no transaction-pooling PgBouncer for this lock).

### Outbox transitions

```text
pending ─claim─> sending ─ok─> sent
  ├─ safe retry / 429 ─> pending (backoff, attempts++)
  ├─ 4xx / exhausted ─> failed
  ├─ at-most-once ambiguous/stale ─> quarantined (never auto-resend)
  └─ at-least-once ambiguous/stale ─> pending (retry, duplicate tolerated)
```

`quarantined` and `failed` are terminal; a manual redrive is an explicit later action.

### New modules

`src/config.ts`, `src/errors.ts`, `src/crypto/*`, `src/audit/*`, `src/notifications/*`,
`src/telegram/*`, `src/jobs/*`, `src/worker-lock.ts`, `src/health.ts`, `src/app.ts`,
`src/worker.ts`, `src/tools/smoke-heartbeat.ts`.

### New scripts

`worker`, `dev:worker`, `start:worker`, `smoke:heartbeat`.

## Acceptance checks

- Env validation: worker with missing/malformed Telegram or encryption config exits 1 with an
  actionable message; API starts without worker-only secrets; the optional health token is validated
  when set.
- Logging: JSON outside development; token/key/ciphertext redacted; run/job context present; no
  message bodies or health token in logs.
- Schema: `notification_status` includes `quarantined`; `notification_delivery_policy` and
  `notification_outbox.delivery_policy` exist with the documented default; 19 public tables
  unchanged; pg-boss still unmodeled.
- Delivery policy: enqueue maps kind → policy; dispatcher and recovery read the stored policy; both
  branches are exercised by tests; phase 02 producers emit only `system/at_most_once`.
- Dispatcher: claims safely with `FOR UPDATE SKIP LOCKED`; sends only to the configured chat; marks
  `sent`; safe network errors and 429 retry; 4xx fail; ambiguous outcomes follow policy; overdue rows
  expire; stale `sending` recovery is policy-aware; never resends a quarantined row.
- Shutdown: SIGINT/SIGTERM stops new claims; a successful in-flight send completes within the 15s
  timeout and finalizes (no `sending` row left by the drain); failures during drain follow the row's
  policy; pg-boss drains and the lock releases.
- Single worker: advisory lock blocks a second worker and protects startup recovery; readiness
  reflects lock presence.
- Idle audit: a dispatch tick with no due/expired/stale work creates no run; a tick with work creates
  one and processes it.
- Health: public responses are minimal; readiness is non-200 when the worker lock is absent; details
  require the token; DB-down is 503 everywhere.
- Encryption: round-trip works; tamper/wrong context fails; DB stores ciphertext/nonce/tag/version
  only; no plaintext token in DB/logs.
- Audit: every work-performing heartbeat/dispatch job and accepted bot update has a run; success and
  failure are recorded with `finished_at`; LLM/tool wrappers create rows and link to runs; send-tier
  tool calls without approval are rejected.
- Heartbeat: one outbox row + one Telegram message per job; retried job does not duplicate the row;
  body reports quarantined/failed counts; daily silence remains the dead-man's signal.
- Crash test: send succeeds, finalize is skipped, restart quarantines the row, and no second message
  is sent.
- Bot: only the configured chat is accepted; `/ping` replies once; duplicate update IDs ignored;
  inbound/outbound messages and runs stored.
- Real exit test: one Telegram message received for the heartbeat; no duplicate after kill/restart.
- `pnpm test`, `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` pass.

## Failure modes and edge cases

| Situation | Expected behavior |
| --- | --- |
| Crash after claim, before send, at-most-once | Startup recovery quarantines; 0 messages, no resend |
| Crash after Telegram accepted, before finalize, at-most-once | Startup recovery quarantines; 1 message, no duplicate |
| Crash before/after send, at-least-once | Startup recovery returns row to pending; may duplicate, by design |
| Telegram 429 | Back to `pending` with backoff (respect `retry_after`), attempts++ |
| Telegram 4xx (not 429) | `failed`; no retry |
| DNS / connection refused / unreachable | Request never reached Telegram; retry |
| Timeout after send started / reset / 5xx / unknown | Uncertain; quarantine (at-most-once) or retry (at-least-once) |
| Attempts exhausted | `failed` with reason; heartbeat reports it |
| Heartbeat job retried | Same job id → dedupe key conflict → one outbox row |
| Dispatch job retried | Claimed rows are `sending`; no duplicate; recovery handles leftovers |
| Idle dispatch tick | No run; cheap check only |
| Shutdown during send | Stop new claims; finish current send/finalize; drain; exit |
| SIGKILL during send | No drain; startup recovery applies the row's policy |
| Second worker starts | Advisory lock fails; exit 1; no recovery/poller overlap |
| Duplicate Telegram update | `telegram_updates` PK conflict → no-op |
| Unauthorized chat | Ignored and logged; no DB rows or reply |
| Worker down | `/health/ready` 503; `/health` still 200 if DB/API are up |
| DB down | `/health` and readiness 503; worker jobs fail and pg-boss retries |
| Invalid HEARTBEAT_CRON | Worker fails at schedule setup with a clear error |
| Missing encryption key | Encrypt/decrypt fails closed; worker config refuses to start |
| Tampered credential | Decrypt fails with an error; no partial plaintext |
| body > 4096 chars | `failed` before calling Telegram |
| Health token unset | `/health/details` 404; `/health` and readiness still work |

## Proposed decisions (to record in DECISIONS.md when approved)

- D017: Two long-running processes (API + worker); the bot runs inside the worker. One poller.
- D018: Base env validation for every process; worker-only required Telegram/encryption config;
  optional `HEALTH_DETAILS_TOKEN`.
- D019: AES-256-GCM key ring by `key_version`, AAD binds account/kind/version.
- D020: `withRun`/`withLlmCall`/`withToolCall` are the audit contract for work-performing jobs and
  calls; idle dispatch ticks are the exception.
- D021: Per-kind delivery policy stored on the outbox; `system`/digest at-most-once, urgent mail and
  approval requests at-least-once. Supersedes the blanket at-most-once proposal and updates D007.
- D022: Add `quarantined` to `notification_status` and policy-aware stale recovery.
- D023: Telegram long polling with chat lock and `telegram_updates` dedupe.
- D024: Heartbeat is an outbox producer; dedupe key is the pg-boss job id; body surfaces
  quarantined/failed counts.
- D025: Health split: public liveness, public readiness, token-protected details.
- D026: Single-worker session advisory lock + drain-on-shutdown.
- D027: Narrow network-error classification: safe-to-retry transport failures versus ambiguous
  delivery failures.

D007's delivery consequence should be marked superseded-in-part by D021/D022 rather than rewritten.

## Open choices / defaults

Recommended defaults; confirm or change before implementation:

- Two processes (API + worker), bot in the worker, not a third process.
- Daily heartbeat at 09:00 UTC by default; `HEARTBEAT_CRON` may be set to `*/2 * * * *` for the exit
  test; daily remains the dead-man's switch afterward.
- Keep `withLlmCall`/`withToolCall` and credential encryption in this phase as requested, despite no
  runtime consumer yet; document the reshape risk. Moving them to phases 03/04/05 is the tighter
  alternative if preferred.
- `quarantined` as a distinct terminal status rather than `failed` with an error prefix.
- 5xx/timeout/reset uncertain; DNS/refused/unreachable retryable; only 429 retried from API 4xx.
- At-least-once retries use the same 5-attempt bound and then `failed` (visible in the heartbeat).
  If urgent-loss tolerance requires more, phase 04 can raise or remove the bound for that policy.
- Health details protected by token (`HEALTH_DETAILS_TOKEN`), not by localhost detection; public
  routes stay minimal and readiness uses the advisory lock.
- `drop_pending_updates: false` now; revisit deliberately when approvals/agent requests land.
- No new npm dependencies.

## Smaller notes / deferred

- The daily heartbeat is the dead-man's switch: a dead worker cannot send, so silence is the signal.
  An external monitor should ping `/health/ready` later (the endpoint exists now).
- `drop_pending_updates: false` is safe for idempotent `/ping`; it must be reconsidered when stale
  approvals or agent commands can replay after downtime. Approval expiry is the likely mitigation.
- Quarantined/failed rows have no admin/redrive path yet; the heartbeat count is the visibility
  signal until one exists.
- Idle dispatch ticks are not represented in app `runs`; pg-boss job records still exist. This is an
  intentional audit-volume tradeoff.

## Limitations

- At-most-once rows can be lost if the worker dies before the Telegram call (0 or 1 delivered, never
  2). At-least-once rows can duplicate. Policy is per kind, not per message urgency within a kind.
- No phase-02 producer emits `at_least_once`; the branch is tested directly and will be exercised by
  triage/approval phases.
- Session advisory locks require direct Postgres connections; PgBouncer transaction pooling would
  undermine the single-worker guarantee.
- Readiness detects a dead worker/lock loss, not a hung worker whose event loop is blocked. The daily
  heartbeat is the backstop for that case.
- Dispatch runs every minute as a pg-boss job even when idle, but idle ticks create no app run.
- Graceful shutdown is bounded; SIGKILL/no-drain relies on policy-aware startup recovery.
- Bot replies and inbound processing are at-most-once; a crash after a reply before DB finalize loses
  that record rather than duplicating it.
- The public readiness endpoint is 503 whenever the worker is intentionally stopped; that is
  intentional readiness semantics, not an API outage.
- No admin endpoints, retention pruning, batching/quiet hours, or multi-user concurrency.

## Evidence and outcome

Status: done (increments 1–8 complete; live Telegram exit test and inbound callback handling
verified 2026-10-23).

### Increment 1–2 — docs/roadmap + config/logging (2026-10-19)

Changed:
- `docs/PLAN.md` renumbered to 02 runtime skeleton, 03 accounts + mail sync, 04 triage,
  05 agent/approvals, 06 digest, 07 outreach; phase 02 set in progress; constraints updated.
- `docs/phases/01-database-foundation.md` gained a roadmap note; its history is unchanged.
- Phase-number references in `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, and `docs/DATABASE.md`
  were reconciled with the new roadmap.
- `AGENTS.md`, `README.md`, `.env.example` updated for the new phase, env vars, config/logging rules,
  and the removed `GMAIL_REFRESH_TOKEN` placeholder.
- `src/env.ts`: pure `parseEnv()` + fail-fast `loadEnv()`; new optional base vars
  (`TELEGRAM_CHAT_ID`, `HEARTBEAT_CRON`, `TOKEN_ENCRYPTION_KEYS`,
  `TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION`, `HEALTH_DETAILS_TOKEN`); bot-token/health-token format
  validation; `GMAIL_REFRESH_TOKEN` removed.
- `src/config.ts`: `requireWorkerConfig()` aggregates missing/invalid worker config.
- `src/crypto/keys.ts`: `version:base64` key-ring parsing, 32-byte validation, active-version checks,
  `activeKey`/`keyForVersion`.
- `src/logger.ts`: `createLogger()` / `Logger`; JSON outside development, pretty in development;
  `service`/`env` base fields; redaction for token/botToken/authorization/password/key/keys/
  ciphertext/nonce/authTag/healthToken.
- `src/errors.ts`: bounded `errorDetails`/`errorMessage`; `classifyTelegramSendError` with
  retryable/permanent/uncertain categories and retry-after extraction.
- `vitest.config.ts`: deterministic fake key ring, Telegram values, health token, and cron.

Verification:
- `pnpm lint` → clean (36 files).
- `pnpm exec tsc --noEmit` → clean.
- `pnpm test` → 7 files, 41 tests passed.
- `pnpm build` → clean.
- Manual `tsx` checks:
  - `parseEnv` defaulted `HEARTBEAT_CRON` to `0 9 * * *` and left optional worker values unset.
  - `requireWorkerConfig` returned a 32-byte key/chat id/cron for valid fixtures and reported all
    four missing values in one `ConfigError` for an empty worker config.
  - Logger emitted JSON and redacted top-level/nested token, key, authorization, and uppercase
    env-secret fields.
  - Error classification: 429 retryable with retry-after; 400 permanent; 500 uncertain; ENOTFOUND
    and ECONNREFUSED retryable; ECONNRESET/ETIMEDOUT uncertain; TLS cert error permanent.

Remaining: encryption service, audit helpers, schema migration, outbox/dispatcher, pg-boss worker +
advisory lock/drain, Telegram bot, split health routes, heartbeat/smoke tooling, tests section, and
the real Telegram exit test.

### Increment 3 — encryption + run/audit helpers + delivery-policy migration (2026-10-19)

Changed:
- `src/db/schema/enums.ts`: `notification_status` gained `quarantined`; new enum
  `notification_delivery_policy` (`at_most_once`, `at_least_once`).
- `src/db/schema/notifications.ts`: `notification_outbox.delivery_policy` (not null, default
  `at_most_once`) snapshots the kind → policy map; the dispatcher/recovery contract reads the
  stored policy, never kind.
- `src/db/migrations/0001_violet_kronos.sql`: generated additive migration (new enum, `ADD VALUE`
  on `notification_status`, new column) plus the backfill of existing
  `email_triage`/`approval_request` rows to `at_least_once`, appended before the migration was
  applied anywhere. Applied to `app` with `pnpm db:migrate`; migration `0000` untouched; still
  19 public tables and no new indexes.
- `src/crypto/credentials.ts`: `encryptCredential`/`decryptCredential` (AES-256-GCM, random
  12-byte nonce, 16-byte tag, active-key encryption, row-key-version decryption, AAD binding
  `accountId:kind:keyVersion`); typed `CredentialCryptoError` with reasons
  `empty_plaintext`/`invalid_envelope`/`unknown_key_version`/`decryption_failed`.
- `src/db/queries/credentials.ts`: `upsertCredential` (encrypt + upsert on
  `(account_id, kind)`, envelope fully replaced, `updated_at` bumped) and `readCredential`
  (decrypt with the row's key version; null when absent). Plaintext never stored or logged.
- `src/audit/runs.ts`: `startRun`, `finishRun`, `withRun` — opens a run, finalizes
  `succeeded|failed|cancelled` with `finished_at` and bounded error text, hands the handler a
  run-context child logger, and rethrows so pg-boss can retry; pre-aborted signals refuse to
  start a run. `runs.input` is documented ids/references only.
- `src/audit/calls.ts`: `withLlmCall` (success/failure rows with tokens, cost, latency, provider
  request id) and `withToolCall` (running row first, then success/failure; `send` tier rejected
  without an approval before any row exists). Foundation-only; no-consumer reshape caveat
  documented in code, ARCHITECTURE.md, and DECISIONS.md.
- Docs: DATABASE.md (enums count 23, `delivery_policy`, quarantined, state transitions,
  credential storage contract), DECISIONS.md (D017–D022 recorded; D007 marked superseded in
  part by D021/D022), ARCHITECTURE.md (status, implemented helpers, policy-aware failure
  ownership), README.md (status).

Verification:
- `pnpm db:generate` → `0001_violet_kronos.sql` inspected: new enum, `ADD VALUE` (unreferenced
  by DDL in the same migration), new column; backfill appended in the same migration.
- `pnpm db:migrate` → applied to `app`; verified enum ranges, column default, and not-null.
- `pnpm test` → 9 files, 69 tests passed (was 41): new `tests/crypto.test.ts` (round-trip,
  nonce uniqueness, tamper/wrong key/AAD/unknown-version failures, empty plaintext,
  ciphertext-only storage, upsert/read) and `tests/audit.test.ts` (run success/failure/cancel,
  pre-abort refusal, llm/tool wrapper rows, send-tier approval rejection and claim), plus
  `tests/db/notifications.test.ts` extended for `quarantined` and `delivery_policy`.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` → clean.

Remaining: outbox/dispatcher, pg-boss worker + advisory lock/drain, Telegram bot, split health
routes, heartbeat/smoke tooling, the tests section for those, and the real Telegram exit test.

### Increment 4 — outbox, dispatcher, and Telegram sender (2026-10-19)

Changed:
- `src/notifications/outbox.ts`: `enqueueNotification` (the only production insert path; maps
  kind → policy via `KIND_DELIVERY_POLICY` with an explicit override option; idempotent on the
  dedupe key via `onConflictDoNothing` and returns the existing row on conflict), `claimNextDue`
  (transaction + `FOR UPDATE SKIP LOCKED`, oldest `scheduled_for` first, sets `sending`,
  attempts++, `last_attempt_at`), `expireDue`, `recoverStaleSending` (policy-aware:
  at-most-once → quarantined, at-least-once → pending requeue), `markSent`, `markRetry`
  (exponential backoff `60s·2^(n-1)`, 1h cap, `retry_after` floor), `markFailed`,
  `markQuarantined`, `hasDispatchWork` (cheap due/expired/stale check). Constants: max 5
  attempts, 10-minute stale age.
- `src/telegram/sender.ts`: `createTelegramSender` over grammy `Api` — fixed chat id from
  config, plain text, 4096-character guard (`TelegramBodyTooLongError`, thrown before any API
  call), 15s abortable deadline (timeout aborts the fetch with a `TimeoutError` reason so
  classification reads it as an uncertain timeout). `TelegramApi` is the minimal injected
  dependency for tests.
- `src/notifications/dispatcher.ts`: `dispatchPendingNotifications` — expire → recover stale →
  claim → send → finalize loop; body-limit pre-check fails oversized rows before calling any
  sender; errors classified narrowly (retryable → pending + backoff; permanent → failed;
  uncertain → quarantined for at-most-once / retried for at-least-once; exhausted at 5 attempts
  → failed); shutdown flag stops new claims and lets the in-flight send finish and finalize;
  per-tick limit 10; only DB/infrastructure errors throw. `runDispatchTick` — cheap
  `hasDispatchWork` gate (idle → no run, debug log), one `notification_dispatch` run when work
  exists (counters logged, never bodies), and a failed run when the pre-check itself throws.
- `src/errors.ts`: `classifyTelegramSendError` now recognizes abort-style errors wrapped in
  grammy's `HttpError` (send deadline / mid-flight abort) and reports `timeout`/`aborted`
  uncertain reasons instead of `unknown send error`.
- Docs: this phase (todos + tests ticked, increment notes), DECISIONS.md (D027),
  ARCHITECTURE.md, README.md.

Verification:
- `pnpm test` → 13 files, 114 tests passed (was 69): `tests/outbox.test.ts` (14),
  `tests/dispatcher.test.ts` (13), `tests/telegram-sender.test.ts` (6),
  `tests/network-errors.test.ts` (12).
- Crash-after-send chaos path: after a successful send, a simulated crash (row left `sending`
  with a stale attempt time) is quarantined on the next tick and a fresh sender delivers
  nothing — exactly one delivery. The at-least-once twin redelivers (duplicate tolerated) and
  ends `sent` at attempt 2.
- Run gating: idle tick → no run row; work tick → one succeeded `notification_dispatch` run;
  pre-check failure → one failed run carrying the infrastructure error, original error
  rethrown for pg-boss. Log sink test proves message bodies never reach log lines.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` → clean.

Remaining: pg-boss worker + advisory lock/drain, Telegram bot, split health routes,
heartbeat/smoke tooling, remaining tests (config/logging/jobs/worker-lock/bot/health/queue),
and the real Telegram exit test.

### Increment 5 — pg-boss, advisory lock, and worker (2026-10-19)

Changed:
- `src/queue.ts` (rewritten): `createBoss`/`startBoss`/`stopBoss` (`stop({graceful:true,
  timeout:30_000})`), `ensureQueues`, `ensureSchedules`, `BOSS_SCHEMA='pgboss'`, `DISPATCH_CRON`,
  and the `QUEUES` constants (heartbeat: retry 2, expire 60s; notification-dispatch: retry 1,
  expire 300s; both batchSize 1, polling 2s). Heartbeat schedule uses `HEARTBEAT_CRON`
  (UTC, `missed: 'skip'`, data `{source:'schedule'}`); dispatch every minute; invalid crons
  surface as an error naming `HEARTBEAT_CRON`.
- `src/worker-lock.ts`: `acquireWorkerLock` — dedicated `pg.Client`,
  `pg_try_advisory_lock(0x6167656e, 1)` held for the session lifetime, `release()` unlocks and
  ends the connection; `isWorkerLockHeld(pool)` reads `pg_locks` by `classid`+`objid`.
  Empirical correction: two-key advisory locks carry `objsubid=2` on this server (the contract
  assumed `1`; `objsubid` distinguishes key form, not session vs transaction), so the readiness
  check matches the key pair only.
- `src/jobs/heartbeat.ts`: `handleHeartbeatJob` — `withRun(system, schedule|manual,
  bossJobId)` counts terminal quarantined/failed rows, then `enqueueNotification` inserts one
  `system`/`at_most_once` row with dedupe key `system:heartbeat:<job id>` and the run id;
  body is the ISO timestamp plus "N notifications had uncertain delivery" / "M notifications
  failed" lines only when non-zero. A retried job (same id) inserts no second row.
- `src/jobs/dispatch.ts`: `handleDispatchJob` delegates to `runDispatchTick` and carries the
  pg-boss job id into `runs.boss_job_id` (`DispatchTickOptions.bossJobId` added).
- `src/worker.ts`: validate worker config (aggregated error, exit 1) → acquire the advisory
  lock before any subsystem (second worker exits 1; lock-client error/end is fatal unless
  draining) → start pg-boss + queues → policy-aware startup recovery → register heartbeat and
  dispatch workers (batchSize 1, job id into runs) → install schedules → drain shutdown:
  abort the dispatch signal (stop new claims, in-flight send finalizes) →
  `boss.stop({graceful:true, timeout:30_000})` → release lock → close pool → exit 0, with a
  35s force-exit fallback and second-signal force exit. The Telegram bot start/stop is a
  marked seam for the bot section.
- `package.json`: `worker` (tsx), `dev:worker` (tsx watch), `start:worker` (node dist/worker.js).
- Docs: this phase (todos/tests ticked, increment notes), DECISIONS.md (D026), ARCHITECTURE.md,
  README.md.

Verification:
- `pnpm test` → 16 files, 129 tests passed (was 114): `tests/queue.test.ts` (pgboss schema +
  13 tables, queue settings, schedules, uuid job ids, invalid cron), `tests/worker-lock.test.ts`
  (acquire/exclusive/release/re-acquire + readiness), `tests/jobs.test.ts` (heartbeat row/run/
  summary/idempotent retry/manual trigger; dispatch idle → no run, due → run + send,
  stale → run + quarantine).
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` → clean.
- Live smoke (dev `app` DB, fake Telegram/key-ring fixtures):
  - `pnpm worker` starts: recovery → `worker started`; `pgboss` schema present; schedules
    `heartbeat 0 9 * * *` and `notification-dispatch * * * * *` (UTC); advisory lock row
    `classid=1634166126, objid=1, objsubid=2`.
  - Second worker exits 1: "another worker already holds the advisory lock".
  - Missing worker env exits 1 with all four issues listed in one error.
  - SIGTERM to `node dist/worker.js` → "shutdown requested; draining" → "worker shut down
    cleanly", exit code 0, advisory lock released (0 granted), no lingering connections.

Remaining: Telegram bot (+ its seam wiring and fatal-startup rule), split health routes,
heartbeat/smoke tooling, remaining tests (config/logging/bot/health), and the real Telegram
exit test.

### Increment 6 — Telegram bot (2026-10-19)

Changed:
- `src/telegram/updates.ts`: `handleTelegramUpdate` — chat-ID lock first (unauthorized or
  chatless updates are logged and dropped with no rows and no reply); claims
  `telegram_updates.update_id` via `INSERT ... ON CONFLICT DO NOTHING` (duplicates no-op);
  then `withRun(agent_chat, telegram)` upserts the chat (title preserved via
  `coalesce(excluded.title, ...)`), stores the inbound message with the run id
  (`onConflictDoNothing` on `(chat_id, telegram_message_id)`, raw update as payload), replies
  to `/start` and `/ping` (command suffixes like `/ping@bot` handled), stores the outbound
  message, and marks the update processed. Failures store a bounded `telegram_updates.error`,
  fail the run, log without payloads, and do not retry.
- `src/telegram/bot.ts`: `createTelegramBot` — grammy long polling with
  `drop_pending_updates: false` (harmless replay for idempotent `/ping`), one in-flight-counted
  middleware delegating every update to `handleTelegramUpdate`, `bot.catch` bounded logging,
  `onStart` log with bot id/username, and start/stop handles (`stop()` is a safe no-op before
  start; `inFlightHandlers()` feeds the drain).
- `src/worker.ts`: the seam is wired — bot starts inside the worker (one poller, one chat);
  `bot.start()` rejection is fatal (exit 1) unless draining; the drain now stops bot polling,
  awaits in-flight handlers, then continues to pg-boss stop → lock release → pools → exit 0.
- Docs: this phase (bot + worker todos and bot test ticked, increment notes), DECISIONS.md
  (D023), ARCHITECTURE.md, README.md.

Verification:
- `pnpm test` → 17 files, 136 tests passed (was 129): `tests/bot.test.ts` covers unauthorized
  chat (no rows/no reply), `/ping` (one reply, update/chat/messages/run stored), `/start`,
  non-command audit, duplicate update no-op, edited-message audit, failure path (error stored,
  processed_at null, failed run, no outbound row), and the bot handle guards.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` → clean.
- Live smoke with the fake token: worker starts, the bot's `getMe` returns a real 401
  ("Unauthorized") which surfaces as a bounded fatal log line and exit code 1 — the
  bot-startup-failure rule, verified against the real API. The advisory lock released with the
  process (session semantics).

Remaining: split health routes (`/health`, `/health/ready`, `/health/details`),
heartbeat/smoke tooling, remaining tests (config/logging/health), and the real Telegram
exit test.

### Increment 7 — API and health routes (2026-10-20)

Changed:
- `src/health.ts`: `isDbUp` (public liveness probe), `isReady` (DB reachable **and** the worker's
  `pg_locks` advisory lock held — a stopped worker is 503 by design), and `healthDetails`
  (token-protected detail: db, worker.locked, latest `notification_dispatch`/`system` run start
  times, outbox counts `due`/`sending`/`quarantined`/`failed`, `telegramConfigured`,
  `uptimeSeconds`, `timestamp`). Never touches pg-boss tables; minimal `{ok:false}`-shaped
  detail when the DB is down.
- `src/app.ts`: `createApp({healthCheck?, healthDetailsToken?, log?})` — injectables for tests
  (`healthDetailsToken` explicitly `undefined` disables the details route; default reads
  `HEALTH_DETAILS_TOKEN`). Per-request UUID `X-Request-Id` header + pino request log lines
  (method/path/status/duration, no headers or bodies), `onError` JSON 500 leaking no details,
  and the three health routes; the details token is compared with `timingSafeEqual` over
  length-padded buffers (no length/content short-circuit).
- `src/index.ts`: startup logs, server `error` handler (bind failures exit 1 cleanly), and
  graceful drain: SIGINT/SIGTERM → `server.close()` → `pool.end()` → exit 0, with a 10s
  force-exit fallback and second-signal force exit.
- Docs: this phase (API/health todos + health test ticked, increment notes), DECISIONS.md (D025),
  ARCHITECTURE.md, README.md.

Verification:
- `pnpm test` → 18 files, 147 tests passed (was 136): `tests/health.test.ts` covers /health
  200/503, readiness 503 without the lock and 200 with it (real advisory lock via
  `acquireWorkerLock`), 503 when DB is down even with the lock, details 404 (token unset),
  401 (missing/malformed/wrong), 200 with expected shape and live counts, plus app plumbing:
  fresh request ids per response, leak-free JSON 500, and request logs without the details token.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` → clean.
- Live smoke (dev DB, port 3210/3211 — port 3000 is another local app): `/health` 200
  `{"ok":true}`; `/health/ready` 503 without a worker and **200 while the live worker held the
  lock** (poll loop caught it mid-run), then 503 again; `/health/details` 404 with no token
  configured (even with an auth header), 401/401 without/wrong token, and 200 with the right
  token returning the full shape (empty counts/runs on the clean dev DB, `telegramConfigured`
  false, uptime, timestamp); `X-Request-Id` present; API drained exit 0.

Remaining: heartbeat/smoke tooling (`src/tools/smoke-heartbeat.ts`, `pnpm smoke:heartbeat`),
remaining tests (config/logging), and the real Telegram exit test.

### Increment 8 — heartbeat smoke tooling, config/logging tests, close checks (2026-10-21)

Changed:
- `src/tools/smoke-heartbeat.ts`: `pnpm smoke:heartbeat` ensures the queues, enqueues one manual
  heartbeat job (new pg-boss job id each run → unique `system:heartbeat:<job id>` dedupe key),
  polls the outbox for up to 90s, prints status/attempts/lastError/telegramMessageId and the
  installed schedule, and exits 0 only when the row is `sent`. It never starts a worker and never
  sends Telegram itself; the daily schedule is untouched.
- `src/queue.ts`: `createBoss(connectionString, options?)` now accepts constructor overrides. The
  smoke tool disables scheduling/supervision (`{ schedule:false, supervise:false }`) so a
  short-lived observer process does not fire cron jobs. Worker behavior is unchanged.
- `package.json`: `smoke:heartbeat` script (`tsx src/tools/smoke-heartbeat.ts`).
- `tests/config.test.ts`: env defaults/overrides/empty-value handling, base env validation errors,
  key-ring parsing (multi-version, duplicate, base64, length, missing active), worker config
  aggregation, and health-token optionality. Key-ring errors are asserted not to contain key
  material.
- `tests/logging.test.ts`: JSON output outside development; redaction of token/botToken/
  authorization/password/key/keys/ciphertext/nonce/authTag/healthToken at top level and nested
  paths; configured `HEALTH_DETAILS_TOKEN` never appears in log output.
- `tests/smoke-heartbeat.test.ts`: focused polling-helper coverage (already-sent row, pending →
  sent while polling, no-row timeout).
- `src/index.ts`: removed a duplicate `env` field from the "API listening" log line (the pino base
  already carries `env`).
- Docs: this phase (todos, verification notes, increment), PLAN.md, ARCHITECTURE.md, DATABASE.md
  (heartbeat dedupe key), DECISIONS.md (D024 previously missing), AGENTS.md, README.md.

Verification:
- `pnpm db:generate` → "No schema changes, nothing to migrate"; 19 tables. `pnpm db:migrate` →
  applied successfully (no pending migrations).
- `pnpm test` → 21 files, 165 tests passed (was 147): new `tests/config.test.ts`,
  `tests/logging.test.ts`, and `tests/smoke-heartbeat.test.ts`.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` → clean.
- Smoke tool end-to-end (isolated `app_test`, no Telegram): a temporary worker used the real
  heartbeat/dispatch handlers with a fake sender. `pnpm smoke:heartbeat` printed
  `outbox status: sent (attempts 1)`, `telegramMessageId: 4242`, `heartbeat schedule: 0 9 * * * (UTC)`,
  and exited 0. A run with no worker timed out and exited 1 as intended.
- Live health (API on 3212, dev DB, production mode, details token set): `/health` 200 `{ok:true}`;
  `/health/ready` 503 without the lock, 200 `{ok:true}` while a real `acquireWorkerLock` session
  held it, and 503 again after release; `/health/details` 401 without a token and 200 with it
  (`worker.locked` true while held); the details token never appeared in API logs. The second
  `acquireWorkerLock` in the same script was blocked, confirming the single-worker guarantee.
- Missing worker config: `pnpm worker` with empty Telegram/encryption values exits 1 with all four
  missing values in one actionable message and starts no subsystem.
- DB/storage audit: 19 public tables; `pgboss` schema present; `notification_status` includes
  `quarantined`; `notification_outbox.delivery_policy` is `not null` with default `at_most_once`;
  `account_credentials` columns are ciphertext/nonce/tag/key_version only (no plaintext token
  column).
- Real crash-after-send, at-least-once, drain, and bot checks are covered deterministically by the
  automated tests listed above; the equivalent live runs still depend on a real Telegram token.

Live Telegram exit test (2026-10-23):
- Started `pnpm worker` with real Telegram/encryption config; the worker acquired the advisory
  lock, started pg-boss and schedules, and logged `telegram bot polling started`
  (`vishzzbot`).
- Ran `pnpm smoke:heartbeat`: queued a manual heartbeat, polled the outbox, observed
  `outbox status: sent (attempts 1)`, `telegramMessageId: 3`, and exit 0. Exactly one system
  heartbeat row exists.
- Restarted the worker gracefully (clean drain); the sent heartbeat row was not resent and no
  duplicate row appeared. Ingestion/alert idempotency is recorded in phase 03.
- Real inbound callback updates were processed twice with no errors (the user’s Useful/Not
  important actions), confirming the bot’s authorized-chat update path.
- The explicit `/ping` and duplicate-update live check remains optional; the automated bot tests
  cover command replies, unauthorized-chat drops, and update dedupe.

Phase 02 is complete. The phase 03 closeout continues to track the remaining user-driven
missed-important/rule checks.

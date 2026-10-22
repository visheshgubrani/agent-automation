# agent-automation

Hono + TypeScript service with Postgres (pgvector), Drizzle, pg-boss, Telegram, Gmail, and
OpenAI. Single-user personal assistant: mail triage, notifications, an on-demand Telegram
agent, and later news digests and approved cold outreach.

## Quickstart

```sh
cp .env.example .env   # fill in Telegram, the encryption key, and other secrets
pnpm db:up             # start Postgres (pgvector) on localhost:5434, waits for health
pnpm db:migrate        # apply Drizzle migrations to the app database
pnpm dev               # app on :3000, logs via pino-pretty
pnpm worker            # separate worker process (pg-boss, bot, heartbeat/dispatch/mail)
pnpm gmail:connect --email you@example.com  # local Desktop OAuth; stores encrypted tokens
pnpm mail:accounts list                     # account health; pause/resume by email
pnpm mail:config company-domains list       # company domains / bank senders
pnpm mail:triage status                     # classification backlog and daily spend
pnpm test              # vitest (uses app_test; migrates it automatically)
pnpm smoke:heartbeat   # with the worker running: one manual heartbeat, exits 0 only if sent
pnpm db:studio         # Drizzle Studio (DB admin UI)
```

- `DATABASE_URL` → main DB `app`, `TEST_DATABASE_URL` → isolated `app_test`. Tests refuse to
  run against a database whose name does not end in `_test`.
- Schema: add tables in `src/db/schema/*.ts`, export them from `src/db/schema/index.ts`, then
  `pnpm db:generate && pnpm db:migrate`. Never edit an applied migration.
- pg-boss manages its own `pgboss` schema; do not model or migrate its tables.
- Lint/format: `pnpm lint` / `pnpm lint:fix` (Biome; generated migrations are ignored).
- Typecheck: `pnpm exec tsc --noEmit`.

## Configuration

- Base env is validated by `src/env.ts` at import. Invalid values print a formatted error and
  exit before any subsystem starts. `parseEnv()` is pure and testable with fixtures.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TOKEN_ENCRYPTION_KEYS`, and
  `TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION` are required only by the worker and are validated by
  `src/config.ts`; the API can boot without them.
- Mail processing is optional (`MAIL_ENABLED=false` by default). When enabled, the worker also
  requires `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `OPENAI_API_KEY`. `MAIL_MODEL` defaults
  to `gpt-6-luna`; `MAIL_REASONING_EFFORT` is `medium` (or `high`). Request bounds are
  `MAIL_MAX_INPUT_CHARS`, `MAIL_MAX_OUTPUT_TOKENS`, and `MAIL_REQUEST_TIMEOUT_MS`. The
  heartbeat-only worker path stays valid with mail disabled.
- With `MAIL_ENABLED=true`, the worker runs a mail sync coordinator about every minute plus one
  per-account job and a bounded triage job. Initial sync backfills the preceding seven days
  silently, then replays history from a checkpoint captured before the backfill. Incremental pages
  commit messages, labels, and the cursor together; expired cursors recover from the last success
  with overlap. One account's failure/backoff does not stop another. Triage applies explicit
  rules before `gpt-6-luna`, keeps live arrivals ahead of backfill, and pauses model calls when
  the local-day budget is exhausted. `pnpm mail:triage retry-failed --all` requeues terminal
  failures.
- Gmail accounts connect through a local Desktop OAuth flow:
  `pnpm gmail:connect --email <address>`. It requests only `gmail.readonly` with offline access,
  verifies the profile and scope, and stores encrypted credentials. See
  [Gmail account setup](docs/GMAIL-SETUP.md) for the Google Cloud, consent-screen, test-user,
  and Testing-mode token-expiry details. Use `pnpm mail:accounts list|pause|resume` and
  `pnpm mail:config` for local controls.
- `TOKEN_ENCRYPTION_KEYS` is a comma-separated `version:base64key` ring of 32-byte AES-256-GCM
  keys, for example `1:<base64>`. Keep old versions in the ring until credentials are re-encrypted.
- `HEARTBEAT_CRON` defaults to `0 9 * * *` (UTC) and is the daily dead-man's switch. Set
  `HEALTH_DETAILS_TOKEN` to enable the token-protected `/health/details` view.
- The worker must be running before `pnpm smoke:heartbeat`; the script enqueues a manual
  heartbeat and waits for the outbox row to reach `sent`.
- Never put plaintext OAuth tokens in env; tokens live only as ciphertext in `account_credentials`.

## Status

Phase 02 (runtime skeleton) is done; its live Telegram heartbeat and inbound callback checks were
verified on 2026-10-23.
Implemented there: validated env/config, structured logging, key-ring parsing, safe error
helpers, AES-256-GCM credential encryption with DB storage helpers, run/audit wrappers
(`withRun`, `withLlmCall`, `withToolCall`), the delivery-policy schema migration (`quarantined`
status, `notification_delivery_policy` + `notification_outbox.delivery_policy`), the outbox
dispatcher with its Telegram sender, the pg-boss worker (`pgboss` schema, heartbeat/dispatch jobs
and schedules, single-worker advisory lock, startup recovery, drain-on-shutdown; run with
`pnpm worker` / `pnpm dev:worker`), the long-polling Telegram bot locked to one chat with update
dedupe, the split health routes (`/health`, `/health/ready`, token-protected `/health/details`),
and the heartbeat smoke tool (`pnpm smoke:heartbeat`).

Phase 03 (mail ingestion + important alerts; combined old 03/04) has Increments 1–7 implemented:
mail rules/company domains, classification topic/notification/summary/decision provenance,
the per-account connection boundary, LLM budget reservations with unknown-outcome recovery,
optional mail-enabled worker config, the local Gmail connection/credential lifecycle
(`gmail:connect`, account pause/resume, company-domain/bank-sender config), reliable scheduled
ingestion (initial checkpoint/backfill/replay, page-atomic history cursors, recovery scans, MIME/HTML
cleaning, idempotent storage, per-account backoff, and Gmail request pacing), classification/spending
(rule-first decisions, bounded feedback examples, structured `gpt-6-luna` Responses output, fair
live-first triage, and local-day budget pause/resume with one notice per day), canonical alert
production (transactional classification/outbox commit, silent-boundary and correction precedence,
bounded plain-text rendering with identifier/OTP redaction, and validated inline buttons),
deterministic Telegram review/corrections (`/mail ignored`, search, rules, status, feedback, canonical
corrections, rule previews/disable, and mail health/heartbeat visibility), and a labeled offline
evaluation harness (`pnpm mail:evaluate`). Live verification on 2026-10-22/23 confirmed Telegram
heartbeat delivery, real Gmail backfill/incremental sync, OpenAI classification, five canonical
alerts, a noisy-alert correction, graceful restart without duplicates, and 100% medium/high
evaluation recall/precision on the synthetic held-out set. The remaining live checks are a
missed-important correction and a future rule changing subsequent behavior. The daily heartbeat is
still the dead-man's switch.

## Docs

- [Plan and phases](docs/PLAN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Database schema, states, retention, later tables](docs/DATABASE.md)
- [Decisions](docs/DECISIONS.md)
- [Gmail account setup](docs/GMAIL-SETUP.md)
- [Active phase](docs/phases/03-important-email-alerts.md)

## V1 schema notes

- 21 tables + the `classifier_feedback_examples` view. Later tables (leads, digest/news,
  sends/drafts, embeddings) are planned additive migrations.
- OAuth tokens live only as encrypted bytes in `account_credentials` (ciphertext/nonce/tag +
  `key_version`). Email raw and cleaned text are stored separately; only cleaned text and
  bounded metadata are prompt-facing. Gmail connects through a local Desktop OAuth loopback flow and stores only
  verified `gmail.readonly` grants; `mail:accounts list` exposes revoked/error state.
- Mail decisions are message correction → explicit rule → classifier; rule/correction
  classifications carry no fictitious model call. Automatic alerts honor the per-account
  connection boundary, and the initial backfill is silent.
- Model calls reserve worst-case cost in `llm_calls` before the request; the budget query counts
  in-flight/unknown reservations and resets at local midnight in `Asia/Kolkata` ($1/day default).
- Mail sync captures the Gmail history checkpoint before the seven-day backfill, stores recursive
  MIME/cleaned text separately with a cleaner version and normalized Message-ID, updates labels
  without deleting app history, and recovers expired cursors from the last success with overlap.
  Attachment metadata is stored; attachment content is never fetched.
- One outbox with dedupe keys and retry state. Quiet hours/batching remain configurable but are
  off for this phase's initial behavior. One current classification per message; one feedback
  label per classification; one execution per approval. Every send requires an approval, and
  execution uses the approval's stored payload.

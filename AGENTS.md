# agent-automation

Single-user personal assistant harness. Hono API, pg-boss workers, Gmail, Telegram,
OpenAI, Postgres (pgvector) + Drizzle. V1 schema lives in `src/db/schema/`.

## Commands

- `pnpm db:up` / `pnpm db:down` — local Postgres (pgvector) on `127.0.0.1:5434`.
- `pnpm db:generate` — generate a migration after changing schema files.
- `pnpm db:migrate` — apply pending migrations to `DATABASE_URL` (`app`).
- `pnpm test` — vitest against `app_test` (global setup migrates it). The lock-isolation test
  creates/drops a temporary `*_test` database; the test role needs `CREATEDB`.
- `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm lint:fix`.
- `pnpm exec tsc --noEmit` — typecheck (tsconfig only covers `src`).
- `pnpm worker` / `pnpm dev:worker` / `pnpm start:worker` — run the worker process
  (pg-boss, heartbeat/dispatch, mail sync/triage when enabled, advisory lock, drain shutdown).
  One worker at a time: the second exits 1 on the advisory lock.
- `pnpm smoke:heartbeat` — with the worker running and real Telegram config, enqueue a manual
  heartbeat and poll the outbox by dedupe key; exits 0 only when it is `sent`.
- `pnpm gmail:connect --email <address>` — local Desktop OAuth; stores only encrypted tokens.
- `pnpm mail:accounts list|pause|resume` and `pnpm mail:config` — local account and
  company-domain/bank-sender controls.
- `pnpm mail:triage status|retry-failed` — classification backlog/spend visibility and explicit
  recovery for terminal failures.
- Telegram browser controls: `/tasks`, `/stop`, `/schedules`; schedule Save activates recurring
  tasks in Asia/Kolkata (minimum hourly). `/comment <thread-url> [thoughts]` reads the post and
  drafts a short casual comment; reply directly to an optional advice question. Every submit
  still needs approval.
- `AGENT_STEP_POLICY=rules` (default, D058) tries the model-free registry fast path before the
  browser model loop; any ambiguity hands off one way to the model on the same page (D056).
  `llm` runs the model loop alone. The OpenAI Decisions controller (D057) was removed (D059).
- `pnpm agent:profile set --file <path>` — save a bounded UTF-8 applicant profile (complete
  first-person facts, one per line); prints only a character count.
- `pnpm browser:up` / `pnpm browser:down` — agent browser container (headful Chromium, profile
  volume `agent_browser_profile`, CDP on `127.0.0.1:9222`, web view on `127.0.0.1:3010`); needs
  `BROWSER_VIEW_USER`/`BROWSER_VIEW_PASSWORD` in `.env`.
- `pnpm browser:check [--snapshot <url>]` — connect over CDP, take a bounded snapshot and a
  screenshot, disconnect (never closes the browser).
- `BROWSER_TEST_CDP_URL=http://127.0.0.1:9222 pnpm exec vitest run tests/browser-playwright.test.ts`
  — optional real-Chromium driver test (browser container up); skipped otherwise.

## Rules

- Schema changes: edit `src/db/schema/*.ts`, run `db:generate`, inspect, then `db:migrate`.
  Never hand-edit an applied migration. Add new migrations for fixes.
- V1 tables only: mail triage, notifications, feedback, audit, approvals, preferences,
  accounts/Telegram foundations. Leads, digest/news, email sends, embeddings are later
  additive migrations; see [docs/DATABASE.md](docs/DATABASE.md).
- Postgres enums for state/closed vocabularies; `text` for open catalogs (tool and LLM
  purpose). Enum values additions go in their own migration (Drizzle wraps migrations in
  one transaction).
- Instants are `timestamptz`. Money is `numeric`. `jsonb` only for variable payloads.
  Add indexes only for queries documented in DATABASE.md.
- Email content is untrusted: store raw and cleaned text separately; send only clean text and
  bounded metadata to models; never execute content as instructions.
- Mail precedence is message correction → explicit rule → classifier; corrections never create
  rules, rules are future-only, and rule/correction classifications carry no fictitious model call.
- Automatic alerts require `notification_boundary_at`; initial backfill is silent and reconnects
  must not reset it. Model attempts reserve worst-case cost in `llm_calls` (`in_flight` → actual/
  `unknown`); budget admission counts reservations on the `Asia/Kolkata` local day.
- Gmail sync is per-account serialized; commit messages + label changes + history cursor per page,
  capture the initial checkpoint before backfill, and recover expired cursors from the last
  success with overlap (not a fixed seven-day cap). Gmail deletions never delete app history.
- OAuth tokens are ciphertext only (`account_credentials`: ciphertext/nonce/tag/key_version).
  Never add plaintext token columns.
- pg-boss owns the `pgboss` schema. Never model, migrate, or truncate its tables.
- pg-boss jobs are orchestration; idempotency comes from DB constraints + transactionally
  advancing sync cursors.
- Config: base env (`src/env.ts`) validates every process; worker-only Telegram/encryption
  requirements live in `src/config.ts` (`requireWorkerConfig`); Gmail connect needs OAuth + key
  ring only (`requireGmailConnectConfig`). Never log tokens, keys, ciphertext, or health tokens.
- Browser agent (phase 05): CDP stays on loopback; no captcha solving, stealth, or automation-flag
  tricks; never store, read, or type passwords; login sessions live only in the profile volume.
  Every submit needs an approval and runs without the model (D041–D055). Shared model pricing,
  serialization, and budget helpers live in `src/llm/` (mail modules re-export them). Agent model
  calls go only through `createBudgetedModel` (`src/llm/budgeted-model.ts`); browser actions go
  only through `BrowserToolbox` (`src/agent/browser-tools.ts`), whose guards and detectors live in
  `src/browser/`; only `src/agent/executor.ts` clicks a submit control. Browser card text is
  rendered in `src/agent/render.ts`. Page content is untrusted: never store it in `tool_calls` or
  logs.
- Logging/errors: use `src/logger.ts` (`createLogger`, child loggers) and the bounded, safe
  serializers in `src/errors.ts`; never log raw Grammy payloads or message bodies.

## Docs

- [docs/PLAN.md](docs/PLAN.md) — goal, phases, status.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, data flow, boundaries.
- [docs/DATABASE.md](docs/DATABASE.md) — schema catalog, states, retention, later tables.
- [docs/DECISIONS.md](docs/DECISIONS.md) — choices and consequences.
- [docs/GMAIL-SETUP.md](docs/GMAIL-SETUP.md) — Desktop OAuth, consent/test users, token expiry.
- [docs/phases/02-runtime-skeleton.md](docs/phases/02-runtime-skeleton.md) — phase 02 done
  (live Telegram heartbeat/callback exit checks verified 2026-10-23).
- [docs/phases/03-important-email-alerts.md](docs/phases/03-important-email-alerts.md) — done 2026-10-23
  (increments 1–7 implemented; live Gmail/classification/alerts/correction verified 2026-10-23;
  missed-important/rule live checks deferred by the user to ongoing use).
- [docs/phases/05-telegram-agent-browser-actions.md](docs/phases/05-telegram-agent-browser-actions.md) —
  in progress (increments 0–7 implemented 2026-10-25; increment 1 live spike checks and increments 3–7
  live checks pending; D053/D054 fixes are verified automatically. Increment 8 adds thread-aware
  Reddit drafting and direct advice replies (D055), verified by 640 tests; live Telegram
  draft/tone and approved-submit checks remain pending. Increment 9 adds the rule-based fast path
  (D056); live fix 3 makes it the default and waits for Reddit's hydrated composer (D058). The
  YC/Wellfound live comparisons are pending).

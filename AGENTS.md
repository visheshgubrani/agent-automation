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

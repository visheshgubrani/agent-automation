# Phase 01: Database foundation

Status: done
Approval: approved with review tweaks 2026-10-18 (feedback at classification level, enum
count fixed, send retry policy + payload authority, token cost detail, scopes/resync/cross-inbox
dedupe/outbox context check/retention note added; preference tables kept intentionally).

Roadmap/schema note (2026-10-21): the table/enum/index counts in this record describe the phase
01 schema as implemented on 2026-10-18. Phase 03 later added `mail_rules`, `company_domains`, the
classification decision fields, and LLM reservation fields as additive migrations; the phase 01
outcome is unchanged.

## Goal and scope

Design and implement the V1 Postgres schema in Drizzle, including the migration, constraints,
indexes, feedback training view, spend query support, and invariant tests.

Included:
- Accounts/credentials/sync state, mail + classifications.
- Outbox, classification feedback + training view, approvals.
- Runs, LLM calls, tool calls, spend range query.
- Singleton settings, VIP/watchlist/interests/tone samples.
- Telegram chats/messages/updates.
- Docs/design records and test infrastructure.

Excluded (later phases): Gmail OAuth/encryption service, Gmail sync workers, classifiers,
notification dispatcher, Telegram bot, OpenAI calls, Hono admin endpoints, leads, digest/news,
email sends/drafts, embeddings, retention jobs, multi-user.

Related decisions: D001–D016 in [DECISIONS.md](../DECISIONS.md). Full schema:
[DATABASE.md](../DATABASE.md).

## Review changes incorporated

- `classification_feedback` is attached to `email_classifications` with an optional
  notification, an optional `reason` (`missed_important`), and a left-joined training view so
  ignored/important mail can be labeled.
- Enum count is 22 (was incorrectly stated as 19 in the first draft); verified against the DB.
- Failed sends require a **fresh** approval; `retry_of_approval_id` records lineage. Approval
  payload is immutable and is the only execution-argument source; send-tier tool calls must
  have an approval in the DB (check constraint).
- `llm_calls` stores cached input and reasoning tokens plus cost.
- `accounts.granted_scopes`, `mailbox_sync_state.needs_full_resync`, cross-inbox outbox dedupe
  policy via RFC Message-ID (unique `dedupe_key`, tested), DB-enforced outbox kind context, and
  a retention policy are included.
- Preference tables kept (explicit V1 memory requirement); no scoring weights/embeddings.

## TODOs

- [x] Write design records and phase file.
- [x] Add schema modules (enums, accounts, runs, mail, approvals, notifications, feedback,
      audit, preferences, telegram, view, barrel).
- [x] Update drizzle/db config and generated migration.
- [x] Add spend range query helper.
- [x] Add test global setup, DB helpers/fixtures, and invariant tests.
- [x] Update README, Biome ignore for generated migrations, vitest setup.
- [x] Run generate/migrate/test/lint/typecheck and inspect generated SQL.
- [x] Record verification evidence and outcome; update roadmap/docs.

## Acceptance

- 19 tables + 22 enums + `classifier_feedback_examples` view in one migration; no later tables.
  Verified in `app`: 19 public tables, 22 enum types, 1 view.
- DB rejects duplicate mail per account, duplicate current classification, duplicate outbox
  dedupe key, second execution of an approval, duplicate Telegram update/message ids. Covered
  by tests.
- Feedback can be attached to a classification with no notification; the training view returns
  both notified and un-notified labels. Covered by tests.
- Outbox enforces `email_triage` classification context, `approval_request` approval context,
  and terminal sent timestamps; kind check is present. Covered by tests.
- A `send` tool call cannot be inserted without an approval id. Covered by tests.
- LLM calls store cached-input/reasoning tokens; spend helper sums a range; run trace joins work.
  Covered by tests.
- Accounts store scopes and sync state stores `needs_full_resync`; credentials are ciphertext
  only. Covered by tests.
- `pnpm test`, `pnpm lint`, and `pnpm exec tsc --noEmit` pass; `pnpm db:generate` reports no
  changes after the migration; `app_test` migrated from empty. Verified.
- Docs updated; pg-boss schema untouched; retention policy documented. Verified (`pgboss`
  schema absent from the app DB).

## Evidence and outcome

Status: done (2026-10-18).

Implemented:
- `src/db/schema/*`: 19 tables, 22 enums, `classifier_feedback_examples` view, a `bytea` custom
  type, explicit FKs/checks/partial indexes/FTS index. Later tables are not created.
- `src/db/migrations/0000_naive_sentry.sql` + snapshot/journal.
- `src/db/index.ts` binds the schema namespace and exposes `Db`.
- `src/db/queries/audit.ts` exposes `getLlmSpendForRange`.
- `tests/global-setup.ts` migrates `app_test` only (guards on `_test`), `tests/db/*` cover
  ingestion, classification history, credentials/scopes/resync, preferences, outbox dedupe and
  kind contexts, feedback/view, approvals/at-most-once execution, audit/spend, and Telegram
  idempotency.
- `drizzle.config.ts`, `vitest.config.ts`, `biome.json`, `README.md`, docs and AGENTS updated.

Verification:
- `pnpm db:generate` → `0000_naive_sentry.sql`; second run → "No schema changes".
- `pnpm db:migrate` → migrations applied successfully (idempotent rerun).
- `pnpm test` → 7 files, 41 tests passed (global setup migrated empty `app_test`).
- `pnpm lint` → clean (`biome check .`).
- `pnpm exec tsc --noEmit` → clean.
- `psql (app)`: tables=19, enums=22, views=1, indexes=58, `pgboss` schema absent.
- Generated view columns are all aliased and typed; timestamptz view fields map back to `Date`
  via Drizzle `mapWith`.

Limitations:
- No runtime integrations are implemented (Gmail/OAuth/OpenAI/Telegram/pg-boss workers/Hono
  endpoints); this phase is storage and audit foundations only.
- The encryption service and key ring are phase 02; only the encrypted storage contract exists.
- Cross-inbox notification dedupe is enforced by unique `dedupe_key`; the triage service must
  compute the documented `email_triage:rfc:<Message-ID>` key.
- Retention windows are documented but no pruning jobs run yet.

## Final schema review (2026-10-18)

Verified the review tweaks in both the generated migration and the live schema (`app` and
`app_test`):

- **Feedback at classification level** — `feedback_reason` enum, `classification_feedback`
  with required `classification_id`, nullable `notification_id`, unique classification label,
  partial unique notification index, and the left-joined `classifier_feedback_examples` view
  are present (migration lines 7, 151–161, 336–337, 362, 378).
- **Token/cost detail** — `cached_input_tokens` and `reasoning_tokens` exist with non-negative
  checks alongside `prompt_tokens`, `completion_tokens`, `cost_usd`, and `latency_ms`
  (migration lines 202–215).
- **Resync state** — `mailbox_sync_state.needs_full_resync boolean not null default false`
  is present (migration line 55).
- Also rechecked from the review: `accounts.granted_scopes`, `approvals.retry_of_approval_id`,
  the send-tier approval check on `tool_calls`, and the outbox kind-context check.

Mechanical audit:
- 19 public tables, 22 enums, 1 view, 58 backing indexes; all check constraints validated.
- No `timestamp without time zone` columns; all instants are `timestamptz`. Quiet hours use
  `time` intentionally, paired with `user_settings.timezone`.
- 11 `jsonb`/`bytea` columns, matching the documented whitelist; no plaintext credential
  columns; no `pgboss` schema; no later tables.
- `drizzle-kit check` passes; `db:generate` reports no drift; tests/lint/typecheck pass
  (`41` tests).
- `app_test` mirrors the same 19/22/1 structure.

No schema changes were required. Policies that remain application-enforced by design:
cross-inbox dedupe key composition, approval payload immutability/execution source, fresh
approval after a failed send, and delivery/retry semantics. Optional future hardening
(deferred until needed): token-detail subset checks (`cached_input_tokens <= prompt_tokens`,
`reasoning_tokens <= completion_tokens`) and `resolved_at >= requested_at` for approvals.

Next action: propose phase 02 (accounts + Gmail OAuth/sync) after user approval.

## Roadmap note (2026-10-19)

The original next action above is superseded. The user chose the runtime skeleton as phase 02
first; accounts + Gmail OAuth/sync is now phase 03. Phase 01's schema, evidence, and review history
above are unchanged.

# Database

Schema source: `src/db/schema/*.ts`. Migrations: `src/db/migrations/`. Postgres 17 with
pgvector. All instants are `timestamptz`; money/confidence are `numeric`; `jsonb` is limited
to variable payloads listed below.

## Conventions

- UUID v4 primary keys (`gen_random_uuid()`), except `telegram_updates.update_id` (Telegram id).
- Explicit names for enums, checks, indexes, and constraints; migrations are generated and
  never hand-edited after they have been applied.
- `created_at`/`updated_at` default to `now()`; app updates `updated_at` (no triggers).
- No plaintext secrets. Email addresses are normalized lowercase by the app and additionally
  guarded by unique indexes on `lower(...)`.
- pg-boss's `pgboss` schema is not modeled, migrated, or truncated by this project.
- Later enum values are added in a migration that does not reference the new value; Drizzle's
  migrator wraps pending migrations in one transaction.

## Enums (33)

| Enum | Values |
| --- | --- |
| `account_provider` | `gmail` |
| `account_status` | `active`, `paused`, `revoked`, `error` |
| `credential_kind` | `oauth_refresh_token`, `oauth_access_token` |
| `triage_category` | `urgent`, `needs_reply`, `fyi`, `ignore` |
| `triage_status` | `pending`, `in_progress`, `classified`, `failed`, `skipped` |
| `classification_topic` | `banking`, `work`, `career`, `other` |
| `classification_decision_source` | `classifier`, `rule`, `correction` |
| `mail_rule_action` | `notify`, `ignore` |
| `mail_rule_match_type` | `sender`, `domain` |
| `reasoning_effort` | `medium`, `high` |
| `notification_kind` | `email_triage`, `approval_request`, `system` |
| `notification_channel` | `telegram` |
| `notification_delivery_policy` | `at_most_once`, `at_least_once` |
| `notification_status` | `pending`, `batched`, `sending`, `sent`, `failed`, `expired`, `cancelled`, `suppressed`, `quarantined` |
| `feedback_rating` | `useful`, `not_useful` |
| `feedback_reason` | `missed_important`, `wrong_category`, `too_noisy`, `other` |
| `risk_tier` | `read`, `notify`, `draft`, `send` |
| `approval_status` | `pending`, `approved`, `denied`, `expired`, `cancelled` |
| `approval_resolver` | `telegram`, `api`, `system` |
| `run_kind` | `mail_sync`, `mail_triage`, `notification_dispatch`, `agent_chat`, `approval_execution`, `system`, `browser_task` |
| `run_trigger` | `schedule`, `webhook`, `manual`, `telegram`, `retry`, `approval` |
| `run_status` | `running`, `succeeded`, `failed`, `cancelled` |
| `llm_call_status` | `succeeded`, `failed`, `in_flight`, `unknown` |
| `tool_call_status` | `running`, `succeeded`, `failed`, `unknown` |
| `telegram_direction` | `inbound`, `outbound` |
| `telegram_update_kind` | `message`, `edited_message`, `callback_query`, `other` |
| `watchlist_kind` | `ticker`, `company`, `topic`, `person` |
| `tone_sample_source` | `manual`, `approved_draft`, `feedback` |
| `browser_task_status` | `queued`, `running`, `waiting_for_human`, `awaiting_approval`, `executing`, `succeeded`, `unverified`, `outcome_unknown`, `failed`, `cancelled` |
| `browser_task_source` | `telegram`, `schedule`, `retry` |
| `browser_handoff_reason` | `captcha`, `login`, `two_factor`, `verification`, `other` |
| `browser_handoff_status` | `waiting`, `resolved`, `cancelled`, `timed_out`, `interrupted` |
| `artifact_kind` | `screenshot` (`inbound_media` reserved for the later Instagram phase) |

`run_kind.browser_task` and `tool_call_status.unknown` were added in migration `0008` on their
own (D002 staging); no CHECK or index predicate references them.

## Tables (24)

### accounts

Accounts are Gmail mailboxes (four in V1, plus later outreach sending inboxes).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | `gen_random_uuid()` |
| `provider` | `account_provider` | `gmail` |
| `email_address` | text not null | unique on `lower(email_address)` |
| `display_name` | text | |
| `granted_scopes` | text[] not null default `'{}'` | actual Google scopes granted; least-privilege checks |
| `status` | `account_status` not null default `active` | explicit |
| `created_at`, `updated_at` | timestamptz not null | |

No token material. Status is the only auth/operational state: `active`, `paused`, `revoked`
(invalid/expired grant), or `error` (missing scope or permanent auth/config failure); avoid
deleting accounts while messages exist. The local `gmail:connect` command upserts the account,
sets `active`, and clears an auth `last_error`; reconnect preserves the sync boundary and the
existing refresh token when Google omits a replacement.

### account_credentials

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `account_id` | uuid not null | → accounts, on delete cascade |
| `kind` | `credential_kind` not null | unique `(account_id, kind)` |
| `ciphertext` | bytea not null | AES-256-GCM ciphertext |
| `nonce` | bytea not null | 12-byte IV |
| `auth_tag` | bytea not null | 16-byte GCM tag |
| `key_version` | smallint not null | key ring selector, check > 0 |
| `expires_at` | timestamptz | access-token expiry |
| `created_at`, `updated_at` | timestamptz not null | |

Checks: non-empty ciphertext/nonce/tag. Encryption lives in `src/crypto/credentials.ts`
(AES-256-GCM, random 12-byte nonce, 16-byte tag; AAD binds `account_id:kind:key_version` so an
envelope moved to another row or re-tagged with another key version fails authentication).
`src/db/queries/credentials.ts` provides `upsertCredential` (encrypt with the ring's active key +
upsert) and `readCredential`/`readCredentialRecord` (decrypt with the row's `key_version`; the
record also returns access-token expiry); plaintext is never stored or logged. The Gmail
connector and refresh lifecycle use these helpers inside their transactions.

### mailbox_sync_state

One row per account.

| Column | Type | Notes |
| --- | --- | --- |
| `account_id` | uuid PK | → accounts, cascade |
| `history_id` | text | Gmail historyId; null before initial sync |
| `needs_full_resync` | boolean not null default false | expired/invalid cursor → full resync |
| `notification_boundary_at` | timestamptz | first successful connection; automatic alerts require `messages.received_at >` this value |
| `initial_sync_completed_at` | timestamptz | |
| `last_polled_at`, `last_success_at`, `last_failure_at` | timestamptz | |
| `consecutive_failures` | integer not null default 0 | check ≥ 0 |
| `backoff_until` | timestamptz | worker respects before enqueue/claim |
| `last_error` | text | bounded sync or auth-failure reason; safe text only |
| `updated_at` | timestamptz not null | |

Invariant: message inserts and `history_id` advance commit in the same transaction.
Invariant: `notification_boundary_at` is set once at first connection and is never reset by a
restart, full resync, or reconnect of an existing account. The seven-day initial backfill is
therefore silent across deployments; mail received before the boundary is searchable but cannot
produce an automatic alert. An explicit missed-important correction may override the boundary.
The `gmail:connect` command sets the boundary atomically with the account/credential upsert;
permanent auth failures update `accounts.status` and this row's `last_error`/`last_failure_at`.

### messages

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `account_id` | uuid not null | → accounts, restrict |
| `provider_message_id` | text not null | unique `(account_id, provider_message_id)` |
| `provider_thread_id` | text | Gmail thread |
| `rfc_message_id` | text | normalized Message-ID without surrounding angle brackets; cross-inbox foundation |
| `from_email` | text not null | normalized by app; empty only for malformed mail |
| `from_name` | text | |
| `to_emails`, `cc_emails` | text[] not null default `'{}'` | |
| `subject` | text not null default `''` | decoded, bounded |
| `received_at` | timestamptz not null | Gmail internalDate, else Date header, else ingest time |
| `provider_labels` | text[] not null default `'{}'` | current Gmail labels; label changes update this |
| `raw_text` | text not null | chosen decoded body as received (plain or HTML); untrusted; never sent to models |
| `raw_content_type` | text not null default `text/plain` | chosen body MIME type |
| `clean_text` | text not null default `''` | sanitized, bounded prompt-facing text |
| `cleaner_version` | smallint not null default 1 | check > 0 |
| `headers` | jsonb not null default `'{}'` | bounded decoded header map; `__attachments` holds filename/MIME/size metadata only, never attachment content |
| `triage_status` | `triage_status` not null default `pending` | |
| `triage_attempts` | integer not null default 0 | check ≥ 0; terminal failures set it to the max as an exhausted marker |
| `triage_last_error` | text | bounded safe reason |
| `triage_next_attempt_at` | timestamptz | earliest retry after a transient failure; null = no backoff |
| `ingested_at`, `updated_at` | timestamptz not null | |

Indexes: unique `(account_id, provider_message_id)`; `(account_id, received_at desc)`;
`lower(from_email)`; partial `(triage_status, received_at)` where status in (`pending`,
`failed`); partial `(rfc_message_id)` where not null; partial `(account_id,
provider_thread_id)` where thread is not null; GIN on
`to_tsvector('english', coalesce(subject,'') || ' ' || clean_text)` for agent search.

### email_classifications

Append-only classification output, separate from the email. One current row per message.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `message_id` | uuid not null | → messages, cascade |
| `run_id` | uuid not null | → runs, restrict |
| `category` | `triage_category` | urgency category; required for classifier rows, null for rule/correction decisions |
| `topic` | `classification_topic` not null default `other` | banking/work/career/other; independent of urgency |
| `should_notify` | boolean not null default false | notification decision; independent of category/topic |
| `confidence` | numeric(4,3) | required for classifier rows, null for rule/correction rows; check 0–1 |
| `summary` | text | concise alert summary; nullable when unavailable (for example a rule decision) |
| `reason` | text | short rationale |
| `decision_source` | `classification_decision_source` not null default `classifier` | classifier/rule/correction |
| `applied_rule_id` | uuid | → mail_rules, restrict; required for rule decisions |
| `reasoning_effort` | `reasoning_effort` | actual API effort; classifier only |
| `model` | text | null for rule/correction decisions |
| `prompt_version` | text | null for rule/correction decisions |
| `classifier_version` | text | null for rule/correction decisions |
| `superseded_at` | timestamptz | check ≥ created_at |
| `created_at` | timestamptz not null | |

Checks:
- `(message_id)` unique where `superseded_at IS NULL` — one current row.
- Confidence is null or between 0 and 1.
- Classifier rows must have `category`, `model`, `prompt_version`, `classifier_version`, and
  `confidence`, with no `applied_rule_id`.
- Rule rows must have `applied_rule_id` and null category/model/prompt/classifier/confidence/
  reasoning effort. Correction rows have null category/model/prompt/classifier/confidence/
  reasoning effort and no applied rule. Rule/correction decisions therefore never pretend a
  model call or an urgency judgment happened.
- `superseded_at IS NULL OR superseded_at >= created_at`.

Indexes: the current-row unique partial index; `(run_id)`; partial `(applied_rule_id)` where not
null for rule provenance. Reclassification inserts a new row and supersedes the previous current
row in one transaction.

### mail_rules

Explicit user notification rules; future processing only.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | stable conflict tie-breaker |
| `action` | `mail_rule_action` not null | `notify` or `ignore` |
| `match_type` | `mail_rule_match_type` not null | exact `sender` address or exact `domain` |
| `match_value` | text not null | stored lowercase/trimmed; app normalizes |
| `subject_contains` | text | optional case-insensitive substring condition |
| `account_id` | uuid | → accounts, cascade; null = all connected accounts |
| `active` | boolean not null default true | disable instead of deleting when possible |
| `created_at`, `updated_at` | timestamptz not null | `updated_at` is the edit time used for precedence |

Checks: `match_value = lower(btrim(match_value))` and non-empty; `subject_contains` is null or
non-blank. Conditions combine with AND and match case-insensitively; domain rules do not include
subdomains. If several rules match, the most recently edited active rule wins, with `id DESC` as
the stable tie-breaker. Rules apply to future processing and never trigger a historical alert
burst; a message correction never creates a rule automatically.

Indexes: `(match_type, match_value, updated_at DESC, id DESC)` where `active` for rule evaluation;
partial `(account_id)` where not null for account-scoped rules.

Telegram rule controls (D038): `/mail rules` lists active rules newest-edit-first and disables by
button or `/mail rules disable <id>`. `/mail rules add ...` and the alert/review **Rule** button
produce a stored preview (`telegram_messages.payload.mailRuleDraft`) and require an explicit
**Save** callback before inserting. The preview can toggle action, sender/domain, and all-accounts
vs. source-account scope; optional `subject:` and `account:` conditions are accepted from the
command. Identical active rules are reused rather than duplicated. Disabling sets `active=false`
and keeps the row, so past `email_classifications.applied_rule_id` provenance remains valid.

### company_domains

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `domain` | text not null | normalized lowercase company domain |
| `label`, `note` | text | optional context |
| `active` | boolean not null default true | |
| `created_at`, `updated_at` | timestamptz not null | |

Unique on `lower(domain)`; check requires `domain = lower(btrim(domain))` and non-empty. These are
classifier hints (company mail), not notification rules. The local `mail:config` command adds,
lists, and disables entries. Known bank senders use `vip_senders` (below) and apply across all
inboxes.

### notification_outbox

Single proactive delivery outbox.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `kind` | `notification_kind` not null | |
| `channel` | `notification_channel` not null default `telegram` | |
| `status` | `notification_status` not null default `pending` | |
| `delivery_policy` | `notification_delivery_policy` not null default `at_most_once` | snapshot of the kind → policy map at insert; dispatcher/recovery read this, never kind |
| `dedupe_key` | text not null unique | canonical idempotency key |
| `batch_key` | text | same-key rows may be one Telegram message |
| `body` | text not null | rendered message |
| `payload` | jsonb not null default `'{}'` | template data |
| `scheduled_for` | timestamptz not null default now() | earliest send/retry time |
| `expires_at` | timestamptz | null = never |
| `classification_id` | uuid | → email_classifications, restrict |
| `approval_id` | uuid | → approvals, restrict |
| `run_id` | uuid | → runs, set null |
| `attempt_count` | integer not null default 0 | check ≥ 0 |
| `last_attempt_at`, `last_error` | timestamptz / text | |
| `sent_at`, `telegram_message_id` | timestamptz / bigint | sent only |
| `created_at`, `updated_at` | timestamptz not null | |

Checks:
- `(status = 'sent') = (sent_at IS NOT NULL)`.
- `expires_at IS NULL OR expires_at > created_at`.
- kind context:
  - `email_triage`: `classification_id` not null, `approval_id` null;
  - `approval_request`: `approval_id` not null, `classification_id` null;
  - `system`: both null.

Dedupe policy (D032): for `email_triage`, use `email_triage:rfc:<normalized Message-ID>` when the
message has one, else `email_triage:message:<messages.id>`. The fallback is the stable stored message
identity, not the classification id, so reclassification cannot notify twice. The unique key
collapses the same email arriving in two inboxes. Other kinds use their own canonical keys
(`approval:<approval_id>`, `system:heartbeat:<pg-boss job id>`, later `digest:<...>`). The heartbeat
key is derived from the pg-boss job id so a retried job cannot insert a second row. RFC
Message-ID normalization trims whitespace, extracts the first `<...>` value, and is case-sensitive;
the helper lives in `src/notifications/dedupe.ts`. Without an RFC Message-ID, cross-inbox duplicate
detection is not guaranteed; the fallback only makes the same stored message stable.

Delivery policy (D021): the enqueue helper sets `delivery_policy` from the kind at insert
(`system` → `at_most_once`; `email_triage`, `approval_request` → `at_least_once`) and the row
snapshots it; direct SQL/test inserts must set it explicitly. Migration `0001` backfilled
existing `email_triage`/`approval_request` rows to `at_least_once` because the column default
alone would have assigned them the wrong policy.

Email alert production (D037): `src/mail/alerts.ts` runs inside the same transaction that inserts
the current classification and marks the message `classified`, so all three commit or roll back
together. `enqueueNotification` accepts the caller's `DbSession`. Production applies the latest
canonical correction for the normalized RFC Message-ID (current `correction` classifications first,
then the latest feedback label), enforces `notification_boundary_at` for automatic alerts, and lets
an explicit missed-important correction override that boundary. It renders bounded plain text from
stored bounded fields, masks card/account identifiers, redacts OTP values, and stores the validated
button payload below. Duplicate inserts are harmless: the unique dedupe key returns the existing row.
The correction lookup uses the existing `messages_rfc_message_id_idx`,
`email_classifications_current_uq`, and feedback uniqueness indexes; no new index was required.

`email_triage` payload contract (version 1):

```json
{
  "version": 1,
  "messageId": "<messages.id>",
  "accountId": "<accounts.id>",
  "gmailUrl": "https://mail.google.com/mail/u/?authuser=...",
  "inlineButtons": [[{ "text": "Useful", "callbackData": "mail:useful:<classification id>" }]]
}
```

Inline buttons are validated before insert and again by the dispatcher: at most 8 rows × 8 buttons,
button text ≤ 64 characters, callback data ≤ 64 UTF-8 bytes. Invalid payload buttons are omitted
and the alert body is still delivered. Callback handling, chat validation, and stored-record
matching are implemented in increment 6.

Telegram cancellation/reactivation (D038): marking the canonical email unimportant sets eligible
`pending`/`batched` rows to `cancelled` with a bounded reason; `sending`/`sent` rows are untouched.
A later explicit important correction may return a `cancelled` row (or an undelivered `failed`/
`expired` row) to `pending`, resetting attempts, delivery ids, errors, and expiry while keeping the
same unique dedupe key. A delivered (`sent`) alert is never rewritten or duplicated.

Mail review/search queries (D038) use the existing `messages_fts_idx` expression plus a bounded
sender substring and the current-classification partial unique index. They add no new index; the
Telegram page sizes keep result sets and inline keyboards small.

Indexes: unique `dedupe_key`; partial `(scheduled_for)` where status in (`pending`,
`batched`); partial `(expires_at)` where status in (`pending`, `batched`) and expires_at is
not null; partial `(approval_id)`; partial `(run_id)`.

Later kinds (digest/breaking/outreach) require an enum addition and a replacement of the
kind-context check in a later migration; no V1 rows break.

### classification_feedback

One label per classification; notification is optional so ignored mail can be flagged later.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `classification_id` | uuid not null | → email_classifications, cascade; unique |
| `notification_id` | uuid | → notification_outbox, set null; unique where not null |
| `rating` | `feedback_rating` not null | useful/not_useful |
| `reason` | `feedback_reason` | optional, e.g. `missed_important` |
| `note` | text | |
| `created_at`, `updated_at` | timestamptz not null | |

Rules: upsert by `classification_id`; a notification-based label must reference a
notification whose `classification_id` matches. Deleting an old notification keeps the label
(`notification_id` becomes null). Deleting the classification/message removes the label.
`reason = missed_important` is valid with no notification (the classifier buried it).

Telegram corrections (D038): **Useful**/important upserts `rating='useful'` (with
`missed_important` when the shown decision was ignore); **Not important** upserts
`rating='not_useful'` (with `too_noisy` when the shown decision was notify). The label is pinned to
the displayed classification even though a correction row supersedes it. A notification link is
accepted only when that outbox row belongs to the displayed classification; review callbacks without
a notification leave the link null (or preserve an existing valid link on repeat). The correction
service locks canonical message rows and inserts one current `decision_source='correction'` row per
copy sharing the normalized RFC Message-ID (or only the stored message when absent). Repeating the
same direction is a no-op; changing direction appends correction history.

### approvals

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `run_id` | uuid not null | → runs, restrict (requesting run) |
| `tool_name` | text not null | open catalog |
| `risk_tier` | `risk_tier` not null | snapshot at request time |
| `summary` | text not null | human-readable request |
| `payload` | jsonb not null default `'{}'` | immutable; the exact execution args |
| `dedupe_key` | text unique | request idempotency |
| `retry_of_approval_id` | uuid | → approvals, set null; retry lineage |
| `status` | `approval_status` not null default `pending` | |
| `requested_at` | timestamptz not null default now() | |
| `expires_at` | timestamptz not null | check > requested_at |
| `resolved_at`, `resolver`, `resolver_ref`, `resolution_note` | timestamptz / `approval_resolver` / text | resolver non-null iff not pending |
| `updated_at` | timestamptz not null | |

Checks: `(status = 'pending') = (resolved_at IS NULL)`; same for `resolver`;
`retry_of_approval_id IS NULL OR retry_of_approval_id <> id`. Indexes: unique `dedupe_key`;
partial `(expires_at)` where pending; `(run_id)`; partial `(retry_of_approval_id)`.

Execution contract: the executor reads `payload` only; `tool_calls.args` copies it. A failed
send is retired; a new approval (copy of payload) is required, linked via
`retry_of_approval_id`.

### runs

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `kind` | `run_kind` not null | |
| `trigger` | `run_trigger` not null | |
| `status` | `run_status` not null default `running` | |
| `parent_run_id` | uuid | → runs, set null; check not self |
| `boss_job_id` | uuid | pg-boss correlation, no FK |
| `input` | jsonb not null default `'{}'` | ids/references, no secrets |
| `error` | text | |
| `started_at` | timestamptz not null | |
| `finished_at` | timestamptz | required iff not running; not before start |

Indexes: `(kind, started_at desc)`; partial `(started_at)` where running; partial
`(parent_run_id)`; partial `(boss_job_id)`.

### llm_calls

One model call attempt. A row is inserted as `in_flight` before the external request with a
durable worst-case reservation, then finalized with actual usage.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `run_id` | uuid not null | → runs, cascade |
| `purpose` | text not null | open catalog (classify_email, draft_reply, ...) |
| `model` | text not null | |
| `status` | `llm_call_status` not null | succeeded/failed/in_flight/unknown |
| `reasoning_effort` | `reasoning_effort` | actual effort requested; null for non-reasoning calls |
| `reserved_cost_usd` | numeric(12,6) not null default 0 | bounded worst-case reservation before the request |
| `prompt_tokens` | integer not null default 0 | total input, includes cached and cache-write tokens |
| `cached_input_tokens` | integer not null default 0 | subset of `prompt_tokens`; priced at the cached rate |
| `cache_write_tokens` | integer not null default 0 | subset of `prompt_tokens`; priced at the cache-write rate |
| `completion_tokens` | integer not null default 0 | total output, includes reasoning |
| `reasoning_tokens` | integer not null default 0 | subset of `completion_tokens`; diagnostic, never added to cost again |
| `cost_usd` | numeric(12,6) not null default 0 | snapshot of recorded cost at call time |
| `latency_ms` | integer not null default 0 | |
| `provider_request_id` | text | OpenAI response id |
| `error` | text | |
| `created_at` | timestamptz not null | reservation/attempt time |

Checks: all token/cost/latency fields non-negative, including `reserved_cost_usd`.
`withLlmCall` inserts `in_flight` + reservation before calling the provider, finalizes to
`succeeded`/`failed`, or records `unknown` for an ambiguous outcome. A known provider failure may
carry available usage/request id via `LlmCallFailedError`; an ambiguous outcome carries them via
`LlmCallOutcomeUnknownError`. If the process dies, the row stays `in_flight`;
`recoverStaleInFlightLlmCalls` marks stale rows `unknown`. The reservation stays counted for
in-flight/unknown outcomes. Model rates are snapshotted in `src/llm/pricing.ts` (re-exported by
`src/mail/pricing.ts`); the classifier uses `gpt-6-luna`, and `AGENT_MODEL` must also be listed; cost is computed from uncached input, cached input, cache writes, and
output, without adding the reasoning subset twice.

Queries:
- `getLlmSpendForRange` sums recorded `cost_usd` for a local-day range (actual spend).
- `getLlmBudgetUsageForRange` is the admission query: terminal rows count actual cost;
  in-flight/unknown rows count `greatest(reserved_cost_usd, cost_usd)` and are reported separately.
  Callers pause when the next reservation would exceed `user_settings.daily_spend_limit_usd`.
  The optional `{ purposePrefix }` filter (matched with `starts_with`, so `_` is literal) gives
  the agent sub-limit usage for `agent_*` purposes against `agent_daily_limit_usd` (D044); it
  uses the same `(created_at)` range index.
- `getLlmBudgetUsageForRun` sums one run's calls with the same conservative accounting (the
  per-task cap, `AGENT_TASK_MAX_USD`); it uses the `(run_id)` index.
  Since phase 05 increment 5, browser model admission also sums the pinned intake run id from
  `telegram_messages.payload.browserIntakeRunId` into the same task cap; run ids are deduplicated.
  Each run still uses `llm_calls(run_id)`; daily admission counts every `agent_*` call once.
- If the reservation is non-positive or its insert fails, the model call is not attempted.

Indexes: `(run_id)`; `(created_at)` for daily spend/budget ranges; partial `(created_at)` where
status is not succeeded/failed for stale in-flight/unknown recovery.

### tool_calls

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `run_id` | uuid not null | → runs, cascade |
| `tool_name` | text not null | |
| `risk_tier` | `risk_tier` not null | snapshot |
| `status` | `tool_call_status` not null | running/succeeded/failed/unknown (an uncertain send; never retried) |
| `args` | jsonb not null default `'{}'` | copy of approval payload for approved calls |
| `result` | jsonb | cap size in app |
| `error` | text | |
| `approval_id` | uuid | → approvals, restrict |
| `started_at` | timestamptz not null | |
| `finished_at` | timestamptz | null iff running; not before start |
| `latency_ms` | integer | null while running; check ≥ 0 |

Checks: `(status = 'running') = (finished_at IS NULL)`; **send-tier calls require a non-null
`approval_id`**. `withToolCall` sets `finished_at` from the DB clock (never before `started_at`)
and accepts `auditResult` so callers store bounded audit data instead of page content; browser
tools store refs, field keys, and snapshot generations, never field values or snapshot text. Indexes: unique partial `(approval_id)` where not null — at most one
execution per approval; `(run_id)`; partial `(started_at)` where running.

### user_settings

Singleton (`id = 1`).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | smallint PK default 1 | check `id = 1` |
| `timezone` | text not null default `Asia/Kolkata` | IANA, validated by app |
| `quiet_hours_start`, `quiet_hours_end` | time | both null (initial: no quiet hours) or both set; may cross midnight |
| `quiet_hours_allow_urgent` | boolean not null default true | urgent bypass |
| `batch_window_minutes` | integer | null = batching disabled (initial behavior); check null or > 0 |
| `approval_ttl_minutes` | integer not null default 1440 | check > 0 |
| `daily_spend_limit_usd` | numeric(10,2) default 1.00 | nullable = no limit; check ≥ 0 |
| `applicant_profile` | text nullable | complete first-person facts, one per line; app bound 8000 characters, SQL nonblank/length check; local `agent:profile` CLI; never printed in full (D051) |
| `agent_daily_limit_usd` | numeric(10,2) default 0.50 | agent sub-limit inside the global limit (D044); counts `agent_*` purposes; nullable = global limit only; check ≥ 0 |
| `created_at`, `updated_at` | timestamptz not null | |

Migration `0003` seeds row `id = 1` with `Asia/Kolkata`, null quiet hours, null batch window, and
`$1.00` only when absent; it never overwrites existing preferences. New rows get the same defaults.

### vip_senders

`id uuid PK`, `email text not null`, `display_name`, `note`, `active boolean not null default
true`, timestamps. Unique on `lower(email)`. VIP status applies across all inboxes. Known bank
senders are configured here with `pnpm mail:config bank-senders ...`; the same row can inform
classifier/rule matching without adding a separate sender table.

### watchlist_items

`id uuid PK`, `kind watchlist_kind not null`, `value text not null`, `label`, `notes`, `active`,
timestamps. Unique `(kind, lower(value))`. Explicit entities used by digest relevance later.

### interests

`id uuid PK`, `topic text not null`, `notes`, `active`, timestamps. Unique `lower(topic)`.
Broader subjects; scoring weights live in code until the digest phase.

### tone_samples

`id uuid PK`, `label text not null`, `content text not null`, `source tone_sample_source not
null default manual`, `active`, timestamps. Later embeddings attach by UUID.

### telegram_chats

`id uuid PK`, `telegram_chat_id bigint not null unique`, `title`, timestamps. One allowed chat
in V1.

### telegram_messages

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `chat_id` | uuid not null | → telegram_chats, cascade |
| `direction` | `telegram_direction` not null | inbound/outbound |
| `telegram_message_id` | bigint not null | unique `(chat_id, telegram_message_id)` |
| `reply_to_telegram_message_id` | bigint | |
| `text` | text not null default `''` | |
| `payload` | jsonb not null default `'{}'` | raw Telegram message |
| `run_id` | uuid | → runs, set null |
| `created_at` | timestamptz not null | |

Indexes: unique `(chat_id, telegram_message_id)`; `(chat_id, created_at)`; partial `(run_id)`.

Outbound bot replies store app-only callback metadata in `payload`: `mailReview` (kind, page,
query, and the classification ids on the current page), `mailRuleDraft` (action, match, subject,
scope, source classification/account, saved/cancelled state), or `mailRuleList` (page and rule ids).
These keys are never sent to Telegram. Callback handlers validate the configured chat, the stored
message row/payload, and the target classification or rule before changing anything; alert buttons
additionally require an `email_triage` outbox row with matching `telegram_message_id` and
`classification_id`.

### telegram_updates

`update_id bigint PK`, `kind telegram_update_kind not null`, `telegram_chat_id bigint`,
`telegram_message_id bigint`, `payload jsonb not null`, `received_at timestamptz not null`,
`processed_at timestamptz`, `error text`. Index `(received_at)` for pruning. Claim via
`INSERT ... ON CONFLICT (update_id) DO NOTHING`.

### browser_tasks

One requested browser action (phase 05, D042/D055). `spec` pins user field values or a pending
composition request at intake; generated values are persisted with provenance before browser fill.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `source` | `browser_task_source` not null | telegram/schedule/retry |
| `request_message_id` | uuid | → telegram_messages, set null; unique where not null (intake idempotency) |
| `retry_of_task_id` | uuid | → browser_tasks, set null; not self |
| `run_id` | uuid | → runs, restrict; the `browser_task` run, null until the job starts |
| `site`, `action` | text not null | validated by the site registry in code (open catalog) |
| `target_url` | text not null | 1–2048 chars |
| `instruction` | text not null default `''` | ≤ 4000 chars |
| `spec` | jsonb not null | task spec v1 (below) |
| `status` | `browser_task_status` not null default `queued` | |
| `status_reason` | text | catalog below; 1–64 chars |
| `approval_id` | uuid | → approvals, restrict |
| `cancel_requested_at` | timestamptz | Stop tapped |
| `submitted_at` | timestamptz | set when the submit click starts |
| `result` | jsonb | result v1: bounded evidence URL / screenshot artifact id / summary only |
| `cdp_target_id`, `boss_job_id` | text, uuid | correlation |
| `started_at`, `finished_at` | timestamptz | |
| `created_at`, `updated_at` | timestamptz not null | |

Checks: `finished_at` is null exactly when status is `queued`, `running`, `waiting_for_human`,
`awaiting_approval`, or `executing`; `submitted_at` is not null for `succeeded`, `unverified`, and
`outcome_unknown`; the bounds above. Indexes: unique `((true))` where status is `running`,
`waiting_for_human`, `awaiting_approval`, or `executing` (one task holds the browser); unique
partial `(request_message_id)`; partial `(status, created_at)` for open statuses (recovery and the
queue); `(created_at desc)` for `/tasks`; partial `(site, action, submitted_at)` where submitted
(daily caps); partial `(approval_id)`.

`status_reason` catalog (`src/agent/contracts.ts`): `interrupted`, `approval_expired`,
`budget_exhausted`, `daily_cap`, `precondition_failed`, `step_limit`, `login_required`,
`handoff_timeout`, `handoff_limit`, `cancelled_by_user`, `confirmation_required` (a queued task
that cannot start until the user taps its unexpired Start card), `advice_required` (queued
awaiting a reply; never automatically claimed/requeued), `already_applied`, and `schedule_missed`.

### browser_handoffs

A pause for the user to fix a captcha/login/2FA/verification page over the phone view (D047).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `task_id` | uuid not null | → browser_tasks, cascade |
| `run_id` | uuid not null | → runs, restrict |
| `reason` | `browser_handoff_reason` not null | |
| `detail` | text | ≤ 1000 chars |
| `page_url` | text | ≤ 2048 chars |
| `screenshot_artifact_id` | uuid | → artifacts, set null |
| `notification_id` | uuid | → notification_outbox, set null (the outbox never links back) |
| `status` | `browser_handoff_status` not null default `waiting` | |
| `requested_at`, `expires_at` | timestamptz not null | expiry after request (`BROWSER_HANDOFF_TIMEOUT_MINUTES`) |
| `resolved_at` | timestamptz | null exactly while `waiting` |
| `resolver_ref` | text | `update:<telegram update id>`; null for system resolutions |

Indexes: unique `(task_id)` where waiting; `(task_id)`.

Increment 4 creates the handoff, `waiting_for_human` task transition, and linked `system`
notification atomically. The notification explicitly uses `at_least_once` and dedupe key
`browser:handoff:<handoff id>`; its photo and buttons reference stored artifact/handoff ids.
Done conditionally resolves only an unexpired waiting handoff from the linked delivered card.
The job then resumes `running` and takes a fresh snapshot; a remaining detector hit creates
another handoff (at most three rows per task, counted through the task history index).
Stop, timeout, and shutdown close the task and waiting handoff together. Done/Stop/resume
serialize on the task row lock; replayed callbacks cannot resume a later handoff.

### artifacts

Stored files (screenshots) content-addressed under `ARTIFACT_DIR` (directories 0700, files 0600).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `kind` | `artifact_kind` not null | |
| `task_id` | uuid | → browser_tasks, set null |
| `sha256` | text not null | check `^[0-9a-f]{64}$` |
| `mime` | text not null | |
| `byte_size` | integer not null | check > 0 |
| `storage_path` | text not null | relative to `ARTIFACT_DIR` (`<aa>/<sha256>.<ext>`); check: not empty, not absolute, no `..` segment |
| `created_at` | timestamptz not null | |
| `deleted_at` | timestamptz | retention tombstone; the file is removed, the row kept |

Indexes: unique `(kind, sha256)`; partial `(created_at)` where not deleted (retention);
partial `(task_id)`.

### Browser payload contracts (phase 05)

Schemas live in `src/agent/contracts.ts` (zod, strict objects).

- **Task spec v1** (`browser_tasks.spec`): `{version: 1, targetUrl: https, fields: [{key, value,
  provenance: user_verbatim|drafted}]}`; 1–8 unique keys; values 1–3000 chars. Reddit posts
  require `post_title` (≤300 chars) and `post_body`; the subreddit is pinned in the canonical
  target URL. The complete approval text must fit one Telegram card (≤3800 chars). Pending
  application notes instead have `composeNote: true` and empty fields; their profile-backed
  drafted `application_note` is persisted before fill (≤1500 chars; D051). Pending Reddit comments
  instead have empty fields and `composeComment: {thoughts, priorRunIds, question?, answer?}`
  (thoughts/answer ≤3000 chars, question ≤300 chars, at most eight run UUIDs). Only one composer
  can be pending. The resulting `comment_text` is `drafted` and ≤800 chars (D055).
- **Submit approval payload v1** (`approvals.payload`, `tool_name = 'browser.submit'`,
  `risk_tier = 'send'`, dedupe key `browser:approval:<taskId>`): `{version: 1, taskId, site, action,
  targetUrl, pageUrl, fields: [{key, label, role, name, value, provenance}], submit: {role, name},
  screenshot: {artifactId, sha256}, preparedAt}`. Immutable; the executor's only argument source.
- **Task result v1** (`browser_tasks.result`): `{version: 1, evidenceUrl?, screenshotArtifactId?,
  summary? (≤ 500)}`.
- **Outbox payload v1 (in use since increment 3, no schema change):** optional
  `photo: {artifactId, sha256}` and an https URL button variant `{text, url}` (D045). The
  dispatcher sends a photo with the body as its caption when the artifact row exists, its sha256
  matches, and the body fits Telegram's 1024-character caption limit; otherwise it sends text,
  still one API call per row. Browser card dedupe keys:
  `browser:approval:<taskId>` (`approval_request`), `browser:task:<taskId>:queued|result|recovered`
  (`system`), `browser:task:<taskId>:draft` (`system`, at-least-once),
  `browser:handoff:<handoffId>` (`system`, at-least-once), and
  `browser:intake:<messageId>:invalid|unclear|schedule` (`system`).
- **Intake metadata v1** (`telegram_messages.payload`, increment 5): `browserIntake` caches
  `{version:1, kind:one_off|schedule|unclear|invalid, ...}`. Action decisions include site,
  action and a validated spec; schedules additionally include cron/timezone (Asia/Kolkata).
  `browserIntakeRunId` links paid parsing to subsequent task-budget admission.
  `browserScheduleDraft` retains the inert schedule decision plus the original instruction.
  The original Telegram update stays present; `reply_to_telegram_message_id` is stored for
  traceability but reply content/history never enters the parse prompt.
- **Replay card metadata v1** (`notification_outbox.payload`):
  `browserTaskDraft: {version:1, taskId}` with Start/Stop. The associated task is queued with
  `status_reason=confirmation_required`. Start validates the delivered outbox row and expiry
  (30 minutes after task creation), queues while holding the task lock, then clears the gate.
  Browser consumers lock before reading the gate, avoiding early consumption before Start commits.
- **Comment advice (D055):** `browser:task:<taskId>:advice` is an at-least-once system notification
  with `browserCommentAdvice: {version:1,taskId}` and Stop. The task remains `queued/advice_required`
  until a reply to the delivered message from its originating chat arrives or the task is cancelled.
  Original chat identity follows retry ancestry when needed. Accepted inbound messages cache
  `browserCommentAdviceConsumed: {taskId}`. Consumption and pg-boss enqueue share one transaction.
  Stale replies use `browser:task:<taskId>:answer-draft` with the usual `browserTaskDraft` metadata
  and a fresh 30-minute expiry from answer consumption; fresh answers use `:answer` for acknowledgement.
  No new columns, enums, tables or indexes are required.
  Active schedules and paginated `browserTaskList`/`browserScheduleList` metadata are implemented in increment 7.

## View: `classifier_feedback_examples`

Joins `classification_feedback` → `email_classifications` → `messages`, LEFT JOIN
`notification_outbox`. Columns (all explicitly aliased):

`feedback_id`, `rating`, `reason`, `note`, `labeled_at`, `classification_id`, `category`,
`topic`, `should_notify`, `confidence`, `summary`, `model`, `prompt_version`,
`classifier_version`, `decision_source`, `applied_rule_id`, `reasoning_effort`, `message_id`,
`account_id`, `rfc_message_id`, `from_email`, `subject`, `clean_text`, `received_at`,
`notification_id`, `notification_sent_at`.

Excludes `raw_text`. Includes un-notified labels (`notification_id IS NULL`), which makes
missed-important mail a training example. Classifier-owned columns (`category`, `confidence`,
`model`, `prompt_version`, `classifier_version`) are nullable because rule/correction
classifications do not pretend a model call or urgency judgment happened. The Drizzle view maps
`labeled_at`, `received_at`, and `notification_sent_at` back to `Date`; the DB columns are
`timestamptz`.

## Mail sync and ingestion

- **Scheduling:** a coordinator runs about every minute, selects active Gmail accounts whose
  `backoff_until` has elapsed, and enqueues one `mail-sync` job per account. A session advisory
  lock keyed to the account serializes sync; pg-boss `singleton_key` is queue coalescing only,
  never the correctness mechanism.
- **Initial sync:** capture the Gmail profile `historyId` checkpoint **before** the seven-day
  backfill. Page through `messages.list` with the configured exclusions, then commit
  `initial_sync_completed_at` and the checkpoint. Replay history from that checkpoint so mail
  arriving during setup is ingested. A crash mid-backfill replays from the start; the unique
  `(account_id, provider_message_id)` constraint makes it idempotent.
- **Incremental sync:** page `history.list` from the stored cursor. Each page commits message
  upserts, label additions/removals, and the cursor to the last processed history record in one
  transaction. The response `historyId` is stored only after the final page, so an unprocessed
  page cannot be skipped. Replaying a page refreshes labels but preserves body text and triage
  state.
- **Recovery:** an expired/invalid history cursor (Gmail 404) triggers a scan from
  `last_success_at - 1h` (or the first-connection boundary minus the seven-day initial window when
  there has been no success), captures a new checkpoint, scans all pages, and then replays history
  from the checkpoint. Outage recovery is not capped at seven days.
- **Labels/removals:** label additions/removals update `provider_labels` for retained messages.
  A message deleted from Gmail is not deleted from application history; a message removed before
  `messages.get` returns 404 and is skipped without blocking the mailbox.
- **Content:** decode the recursive Gmail `format=full` payload, headers, addresses, RFC 2047
  words, base64url bodies, and declared charsets. Prefer a non-empty `text/plain` part; otherwise
  clean HTML with `html-to-text`. Raw and clean bodies are bounded separately; attachments are
  metadata-only in `headers.__attachments` and their content is never fetched.
- **Failures:** persist `last_polled_at`, `last_success_at`, `last_failure_at`, a bounded
  `last_error`, `consecutive_failures`, and exponential `backoff_until` (1m base, 1h cap). One
  account's failure never stops another.
- **Triage sweep:** the coordinator counts runnable rows and enqueues a bounded `mail-triage` job.
  `claimPendingMessages` selects up to one batch per account, round-robins accounts, prioritizes
  live arrivals over silent backfill, and claims with conditional `in_progress` updates plus
  `FOR UPDATE SKIP LOCKED`; `recoverAbandonedTriage` returns stale `in_progress` rows to `pending`
  after 45 minutes (longer than the maximum bounded batch, so a live job's claims are not stolen).
  Worker startup also releases all `in_progress` claims immediately after acquiring the single-
  worker advisory lock, because no peer can own them. The rule pass uses an active-rule join (`listRuleMatchedMessages`) so a large
  non-matching backlog cannot starve deterministic rules. Transient model failures set
  `triage_next_attempt_at` with 1m→1h exponential backoff; refusals, invalid output, and exhausted
  attempts become terminal `failed` rows. `pnpm mail:triage retry-failed` explicitly requeues them.
  Pending/failed rows are never silently discarded or recorded as an ignore decision.

## Mail classification, examples, and spend

- **Precedence:** explicit rules are evaluated before the classifier. A rule decision inserts an
  `email_classifications` row with `decision_source='rule'`, `applied_rule_id`, `should_notify`
  from the action, `topic='other'`, and null urgency/model/confidence fields. The classifier path
  inserts a structured row with topic, urgency category, `should_notify`, confidence, summary,
  reason, model/prompt/classifier versions, and actual reasoning effort. In both paths the current
  row is superseded and the message becomes `classified` in one transaction.
- **Prompt boundary:** only `messages.clean_text`, bounded metadata, attachment metadata, and
  explicit company/bank configuration hints enter prompts. Email and correction examples are
  escaped and wrapped in untrusted-data delimiters; the classifier receives no tools.
  Prompt/classifier versions are constants recorded on every classifier row.
- **Examples:** `classifier_feedback_examples` supplies at most six same-sender/same-domain first
  examples (then recent labels), each excerpt bounded. `missed_important`/`useful` teach alert,
  `too_noisy` teaches no alert, and `wrong_category` leaves the shown notification decision
  unchanged. The current message and stored copies with the same normalized RFC Message-ID are
  excluded.
- **Admission:** the local-day range comes from `user_settings.timezone`; usage comes from
  `getLlmBudgetUsageForRange`; one worst-case classifier reservation comes from the snapshotted
  model rates and `MAIL_MAX_INPUT_CHARS`/`MAIL_MAX_OUTPUT_TOKENS`. Calls are serialized, and
  `withLlmCall` inserts the reservation before the provider request with SDK retries disabled.
- **Pause/resume:** when the next reservation would exceed `daily_spend_limit_usd`, rule work and
  sync continue, model-dependent mail stays `pending`, and a `system` outbox row keyed
  `system:mail-budget:<YYYY-MM-DD>` is enqueued once per local day. The next local day changes the
  budget range, so queued rows are picked up without being marked ignored.
- **Failures:** transient provider/network outcomes use the recorded/unknown reservation policy and
  backoff; refusals and invalid output are terminal `failed` rows with bounded errors. A failure
  never inserts a classification.

## State transitions

### notification_outbox

```text
pending ──claim──> sending ──ok──> sent
  ├──quiet hours/batch window──> batched ──claim──> sending
  ├──safe retry (429, DNS, refused/unreachable)──> pending (backoff, attempts++)
  ├──attempts exhausted──> failed (terminal; redrive is explicit)
  ├──expires_at passed──> expired
  └──superseded/policy──> cancelled | suppressed

ambiguous outcome (timeout/abort after send, reset, 5xx, unknown) or stale `sending`:
  at_most_once rows  ──> quarantined (terminal; never auto-resent)
  at_least_once rows ──> pending (retry; a duplicate is tolerated)
```

Only `sent` has `sent_at`/`telegram_message_id`. Later batching may share one Telegram message
id across rows. The claim (`pending → sending`) commits before the Telegram call, so recovery
can tell a send may have started. `quarantined` and `failed` are terminal; the heartbeat
reports their counts and the user clears them manually until a redrive/admin path exists.

### approvals

```text
pending → approved | denied | expired | cancelled
```

Non-pending requires `resolved_at` + `resolver`. Approval `payload` is immutable. Approved is
terminal for that approval; execution success/failure is on the linked tool call. Failed sends
require a new approval linked by `retry_of_approval_id`.

### mailbox_sync_state

```text
history_id null or initial_sync_completed_at null → initial backfill → checkpoint committed
history_id present + needs_full_resync false      → incremental history pages
history cursor expired/invalid (404)               → needs_full_resync=true → recovery scan
failure                                            → last_error/backoff; retry after backoff
success                                            → clear error/backoff, update last_success_at
```

The notification boundary is independent of cursor state and is never changed by a sync/resync
or reconnect.

### messages.triage_status

```text
pending → in_progress → classified | skipped | failed
failed (transient, attempts < 5) → in_progress after triage_next_attempt_at
failed (refusal/invalid output/attempts exhausted) → terminal; explicit retry-failed → pending
in_progress → pending (stale/abandoned recovery; attempts stay consumed)
pending + attempts = 5 (repeated crashes) → explicit retry-failed → pending, attempts 0
```

Classification rows are immutable except `superseded_at`; reclassification supersedes the old
current row. The notification decision is `should_notify`, not the urgency category. The current
classification, the message's `classified` status, and any canonical outbox row are committed in
one transaction (increment 5); a failed insert rolls all of them back. A transient failure schedules
an exponential retry (1m base, 1h cap); a terminal failure sets `triage_attempts` to the
five-attempt maximum as a durable exhausted marker and leaves `triage_next_attempt_at` null.
`pnpm mail:triage retry-failed` is the explicit operator recovery.

Mail decision precedence is **message correction → explicit rule → classifier**:

- A one-message correction is pinned to the classification originally shown and applies to
  stored copies with the same normalized RFC Message-ID; without that header it applies only to
  the stored message. A correction never creates a sender/domain rule. Automatic production checks
  the latest canonical correction (current correction rows, then feedback) so a later inbox copy
  cannot notify after the user marked the email unimportant, and a positive missed-important
  correction can still alert. Emails in the same thread with different Message-IDs are independent.
- Explicit rules are future-only and are evaluated before the classifier. If several active
  rules match, the most recently edited wins, with `id DESC` as the stable tie-breaker.
- Automatic notification requires `should_notify` and `received_at >`
  `mailbox_sync_state.notification_boundary_at`, except for an explicit missed-important
  correction. The initial seven-day backfill is silent.

### llm_calls

```text
in_flight → succeeded | failed | unknown
```

`in_flight` is inserted before the provider request with the reserved worst-case cost. A stale
`in_flight` row (process death) becomes `unknown`; its reservation remains counted. A known
failure is `failed`; ambiguous outcomes are `unknown`. The application records usage fields on
terminal statuses; only the reservation is guaranteed for `in_flight`/`unknown`.

### runs / tool_calls

```text
run:        running → succeeded | failed | cancelled
tool_call:  running → succeeded | failed | unknown
```

Terminal rows require `finished_at`; running tool calls can be found and reconciled. `unknown`
is a send whose outcome could not be determined (crash mid-click); it is never retried.

### browser_tasks / browser_handoffs (phase 05)

```text
task:      queued → running ⇄ waiting_for_human
           running → awaiting_approval → executing → succeeded | unverified | outcome_unknown | failed
           running → queued(advice_required) → queued(ready | confirmation_required) → running
           running → succeeded (read-only report) | failed | cancelled
           awaiting_approval → cancelled | failed(approval_expired)
           held browser states → failed(interrupted) on shutdown or startup recovery
handoff:   waiting → resolved | cancelled | timed_out | interrupted
```

Transitions are conditional updates in application code (increment 3). Approval execution claims
the approval through the unique `tool_calls.approval_id` index before any click. A Stop ends
queued/awaiting-approval tasks immediately, asks a running agent to stop through
`cancel_requested_at`, and never aborts a submit that has started (`executing`). Startup recovery
maps a `running` send tool call to `outcome_unknown`, a `succeeded` send call to `unverified`
(the deterministic verification was not persisted), and a `failed`/missing call to
`failed(interrupted)`; the approval stays consumed in every case. Note: the submitted CHECK
requires `submitted_at` for `succeeded`, so a read-only report task cannot end `succeeded`
without a submission; v1 site actions all submit, and a read-only action would need its own
decision before it ships.

## Index → query map

| Index | Query served |
| --- | --- |
| `messages(account_id, provider_message_id)` unique | idempotent ingestion / duplicate detection |
| `messages(account_id, received_at desc)` | recent mail per inbox |
| `messages lower(from_email)` | VIP match, later lead reply matching |
| `messages(triage_status, received_at)` partial | pending/failed triage sweep and recovery |
| `messages(rfc_message_id)` partial | cross-inbox matching, notification dedupe keys |
| `messages(account_id, provider_thread_id)` partial | reply/thread context |
| `messages_fts_idx` GIN | agent email search |
| `email_classifications(message_id)` unique partial | one current classification |
| `email_classifications(run_id)` | run trace |
| `email_classifications(applied_rule_id)` partial | rule provenance / past rule decisions |
| `mail_rules(match_type, match_value, updated_at desc, id desc)` partial active | rule matching and newest-edit precedence |
| `mail_rules(account_id)` partial | account-scoped rule lookup |
| `company_domains lower(domain)` unique | company-domain dedupe/classifier hints |
| `notification_outbox(dedupe_key)` unique | idempotent notifications, cross-inbox collapse |
| `notification_outbox(scheduled_for)` partial | dispatcher claim |
| `notification_outbox(expires_at)` partial | expiry sweeper |
| `notification_outbox(approval_id)`, `(run_id)` partial | approval/delivery lookups, trace |
| `classification_feedback(classification_id)` unique | one label per classification |
| `classification_feedback(notification_id)` unique partial | one label per notification |
| `approvals(dedupe_key)` unique | request idempotency |
| `approvals(expires_at)` partial | expiry sweeper |
| `approvals(run_id)`, `(retry_of_approval_id)` | trace / retry lineage |
| `runs(kind, started_at desc)` | run listing |
| `runs(started_at)` partial running | stale worker sweep |
| `runs(parent_run_id)`, `(boss_job_id)` partial | trace tree / job correlation |
| `llm_calls(run_id)`, `(created_at)` | trace and per-task cap (`getLlmBudgetUsageForRun`) / daily spend, budget ranges |
| `llm_calls(created_at)` partial unresolved | stale in-flight/unknown reservation recovery |
| `tool_calls(approval_id)` unique partial | at-most-once execution |
| `tool_calls(run_id)`, `(started_at)` partial running | trace / stuck calls |
| `accounts lower(email_address)` unique | account identity |
| `account_credentials(account_id, kind)` unique | one credential per kind |
| `vip_senders lower(email)` unique | VIP lookup/dedupe |
| `watchlist_items(kind, lower(value))` unique | watchlist dedupe |
| `interests lower(topic)` unique | interest dedupe |
| `telegram_chats(telegram_chat_id)` unique | chat identity |
| `telegram_messages(chat_id, telegram_message_id)` unique | update replay protection |
| `telegram_messages(chat_id, created_at)` | conversation history |
| `telegram_updates(update_id)` PK | update idempotency |
| `telegram_updates(received_at)` | pruning |
| `browser_tasks ((true))` unique partial holding statuses | one task holds the browser |
| `browser_tasks(request_message_id)` unique partial | intake idempotency on replay |
| `browser_tasks(status, created_at)` partial open | queue scan / startup recovery |
| `browser_tasks(created_at desc)` | `/tasks` recent list |
| `browser_tasks(site, action, submitted_at)` partial | per-site daily caps |
| `browser_tasks(approval_id)` partial | approval → task lookup |
| `browser_handoffs(task_id)` unique partial waiting | one waiting handoff per task |
| `browser_handoffs(task_id)` | task handoff history / limit |
| `artifacts(kind, sha256)` unique | content-addressed dedupe |
| `artifacts(created_at)` partial live | retention sweep |
| `artifacts(task_id)` partial | task artifacts |

## Retention and pruning

No pruning jobs run in V1. This is the intended policy for later phases:

- **runs, llm_calls, tool_calls:** append-only audit. Keep indefinitely (or at least the
  spend-audit horizon). `llm_calls`/`tool_calls` cascade only if a run is deliberately
  deleted; run deletion is blocked while classifications or approvals reference it. Unknown
  in-flight outcomes remain counted in the budget query and are not deleted to "free" budget.
- **mail_rules, company_domains:** configuration, not audit. Prefer `active = false` over
  deletion for rules; deleting a rule is restricted while a classification references it, so
  past rule provenance cannot be nulled out. Deleting a scoped account cascades rules that are
  not referenced; accounts with mail cannot be deleted anyway.
- **approvals, email_classifications, classification_feedback:** retain for audit/tuning;
  deleting a message cascades its classifications/feedback. Do not delete runs or approvals
  as part of routine cleanup.
- **messages:** deleting a message is restricted by notification references; for storage
  reduction, a later job should tombstone `raw_text` (e.g. replace with a marker / null it via
  migration adding nullable retention) while keeping metadata + clean text, rather than
  deleting rows.
- **notification_outbox:** sent/expired rows older than the chosen window may be deleted;
  `classification_feedback.notification_id` becomes null and the label survives on the
  classification. Approval requests should not be deleted until the approval is resolved.
- **telegram_updates:** processed updates may be pruned by `received_at` (suggested 30 days).
- **telegram_messages:** retain for agent context; a later cap/policy can trim oldest turns.
- **account_credentials:** cascade with account deletion; disable (`accounts.status`) instead
  of deleting accounts while mail exists.
- **artifacts:** screenshots are deleted from disk after 14 days (proposed default) and the row
  is tombstoned with `deleted_at`; outbox/handoff payloads keep only the id and hash.
- **browser_tasks, browser_handoffs:** retain for audit like approvals; handoffs cascade only
  with a deliberately deleted task.
- No hard timestamps are fixed yet; the retention windows are a later configuration task.

## Later migrations (designed, not implemented)

### Accounts and mail extensions
- `email_drafts`: account/thread/in-reply message, body, model/prompt version, approval,
  status (`draft`, `approved`, `sent`, `discarded`), timestamps. Draft-only replies use this;
  sending always goes through an approval.
- Granted scopes already live on `accounts`; later phases update them after OAuth.

### Cold outreach
- `leads`: normalized unique email (`lower(email)`) for cross-inbox dedupe, chosen
  `sending_account_id → accounts`, status enum with exactly `found`, `researched`, `drafted`,
  `approved`, `sent`, `replied`, `follow_up`, `closed`, status timestamps/notes.
- `lead_status_events`: append-only from/to status + run id, for an auditable state machine.
- `suppression_list`: normalized unique email + reason (`manual`, `bounce`, `unsubscribe`,
  `complaint`), checked before every send.
- `outreach_inbox_settings`: per-account `daily_send_cap`, `enabled`; accounts table untouched.
- `email_sends`: lead, sending account, `approval_id unique not null`, provider message id,
  subject/body snapshot, sent_at, status; index `(account_id, sent_at)` for daily caps. Every
  send has a matching approved tool call.
- `lead_reply_matches`: unique inbound `message_id` mapped to a lead; drives `replied` status.
  Optionally add `messages.lead_id` later; the match table keeps V1 messages unchanged.
- Follow-ups use `leads.next_follow_up_at` and new approval-gated sends.

### News/market digest
- `news_sources`: kind, URL, active, polling state.
- `news_items`: unique `(source_id, external_id)`, canonical URL, content hash, published_at.
- `news_clusters` + `news_cluster_items`: story dedupe/clustering (embeddings optional).
- `digests`/`digest_items`: scheduled or breaking output, relevance score/rank.
- `news_deliveries`: unique `news_item_id` + kind (`digest` | `breaking`) is the never-resend
  guarantee; rows are inserted in the same transaction as outbox notifications.
- Outbox gains nullable `news_item_id`/`digest_id`; new kinds via enum migration; the
  kind-context check is replaced in that migration. Digest kinds default to
  `at_most_once` in the enqueue helper's kind → policy map (D021).

### Embeddings
- Single `embeddings` table: `owner_type` (e.g. `message`, `tone_sample`, `news_item`,
  `lead_research`), `owner_id uuid`, `model`, `content_hash`, `embedding vector(1536)` not
  null, `created_at`; unique `(owner_type, owner_id, model)`; HNSW cosine index. Avoids
  changing V1 tables; ownership is app-enforced. pgvector is already installed.

### Enum and constraint staging
When adding a value to an existing enum, put the `ALTER TYPE ... ADD VALUE` in its own
migration. A later migration may use the value in columns/defaults/checks. Any expanded
kind-context check belongs in that later migration.

## Migration policy

- `pnpm db:generate` creates SQL from `src/db/schema/index.ts`; inspect before applying.
- `pnpm db:migrate` applies to `app`; tests apply to `app_test` via global setup.
- Never edit an applied migration; fix forward with a new migration.
- Additive migrations only for V1 compatibility; no destructive changes without an explicit
  phase and data migration plan.
- Migration `0002` only adds `in_flight`/`unknown` to `llm_call_status`. Migration `0003` adds
  the mail-contract types/tables/columns and deliberately contains no DDL that references those
  newly added values, so a fresh database can apply both pending migrations in one transaction.
  The enum value additions and their first use are separated by a committed migration boundary
  in the deployed `app` database.
- Migration `0003` also backfills `should_notify` for existing classifier rows and seeds the
  singleton `user_settings` row only when absent. Migration `0004` makes rule provenance
  `restrict` so deleting a rule cannot silently null a past decision's reference; disable rules
  instead. Migration `0005` adds a partial `llm_calls(created_at)` index for unresolved attempts;
  its predicate uses only the pre-existing `succeeded`/`failed` enum values. Migration `0006`
  makes `email_classifications.category` nullable and tightens the decision-source check so only
  classifier rows carry an urgency category. Migration `0007` adds `messages.triage_next_attempt_at`
  for bounded classification backoff and `llm_calls.cache_write_tokens` for complete usage/cost
  auditing; it also extends the non-negative check. Migration `0008` only adds `run_kind`
`browser_task` and `tool_call_status` `unknown`. Migration `0009` creates the phase 05 enum types,
`browser_tasks`, `browser_handoffs`, `artifacts`, and `user_settings.agent_daily_limit_usd`; its
predicates use only values created by `CREATE TYPE` in the same migration, so a fresh database can
apply `0008` and `0009` in one transaction. No pg-boss table is modeled or migrated.

Migration `0010` (phase 05 increment 6) adds `user_settings.applicant_profile` with its
nonblank/8000-character check; no new tables or indexes. Pending application specs use
`composeNote: true` with empty fields, then persist the drafted note before browser fill (D051).


### Browser schedules (phase 05 increment 7)

Migration 0011 adds `browser_schedules`: UUID id; bounded cron/instruction; timezone fixed to
Asia/Kolkata; registry site/action; JSONB spec_template; enabled; timestamptz next_run_at,
last_run_at and created_at/updated_at; nullable created_from_message_id (set null on message delete).
The enabled partial next_run_at index supports the minutely due scan. A partial unique
created_from_message_id index makes activation idempotent. Lists are small and use creation order.
Browser tasks gain schedule_id and scheduled_for with a both-null/both-set check and unique
(schedule_id, scheduled_for) partial index for slot idempotency. Schedule deletion is restricted
while tasks reference it: disabling is the supported operation, preserving paired timestamps/history.
Retention uses the existing artifacts live-created index; re-storing bytes refreshes created_at.
Health counts task states/reasons without exposing task content. No new enum values or pg-boss DDL.

Schedule drafts use `notification_outbox.payload.browserScheduleDraft = {version:1,messageId}`
plus an expiry. The inbound message caches a `browserScheduleResolution` (saved/cancelled) under
its row lock. Task/schedule lists use outbound `telegram_messages.payload.browserTaskList` or
`browserScheduleList` with `{version:1,offset,ids,expiresAt}`; callbacks must match the stored ids.
The latest system heartbeat query filters `runs.input.job = heartbeat`, excluding operational ticks.
`status_reason = schedule_missed` reports a queued schedule slot that exceeded its 30-minute grace.

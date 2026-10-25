# Phase 03: Important email alerts across all inboxes

Status: done — closed at the user's request on 2026-10-23 (D040). Increments 1–7 implementation
and automated checks are complete. Live verification on 2026-10-22/23 confirmed Telegram heartbeat
delivery, real Gmail backfill/incremental sync, OpenAI classification, five canonical email alerts,
a noisy-alert correction, graceful worker
restart without duplicate ingestion or alerts, and 100% medium/high evaluation recall/precision on
the synthetic held-out set. The user deferred a live missed-important correction and a future rule
changing subsequent behavior to ongoing use; these follow-ups are not recorded as passed.
Approval: approved 2026-10-21 for increments 1–2, and 2026-10-22 for increments 3–7 at the user's
request. This document was requested as a proposal on 2026-10-21; implementation authorization now
covers all increments in this phase.
Closeout: on 2026-10-23 the user requested completion of phase 03 and said the remaining live
checks would be exercised over time. D040 records the acceptance adjustment and retained follow-ups.
Roadmap: this phase combines the existing phase 03 (accounts + mail sync) and core phase 04
(mail triage + notifications) into one outcome. As of 2026-10-21 the roadmap marks the combined
phase 03 as active and retires the old phase 04 row; later phase numbers are unchanged so existing
references stay stable. No historical phase outcome was rewritten.

## Goal

Connect the user's 4–5 Gmail/Google Workspace accounts, reliably ingest incoming mail,
identify important messages, deliver Telegram alerts, and let the user correct both noisy
alerts and missed important messages.

Deliver the phase in the reviewable increments below. Postgres remains the source of truth;
pg-boss provides orchestration, OpenAI classifies mail, and Telegram is the user interface.

## Agreed behavior

| Setting | Initial behavior |
| --- | --- |
| Providers | Gmail and Google Workspace; connect each account separately |
| Runtime | This computer; local account-connect command and browser sign-in |
| Initial history | Classify the preceding 7 days silently |
| Automatic alerts | Only mail arriving after the account's persisted connection boundary |
| Polling | Approximately every minute, independently per active account |
| Timing | Immediately when ready, all day; no quiet hours or batching in this phase |
| Model | `gpt-6-luna` through the Responses API |
| Reasoning | `medium` by default; configurable to `high` |
| Model budget | $1 per local day across all accounts, including backfill and retries |
| Timezone | `Asia/Kolkata`; budget resets at local midnight |
| Corrections | One-message feedback plus separately created explicit future rules |

New arrivals take priority over historical backfill. Reading or archiving mail in Gmail
does not make it unimportant or remove it from ingestion. Spam, Trash, drafts, and sent-only
mail are excluded. Attachment contents are not downloaded or classified; attachment metadata
may inform the classifier.

### What counts as important

| Mail | Notify | Usually ignore |
| --- | --- | --- |
| Banking | Debits, credits, refunds, payment failures, bills, security warnings | Promotions and product offers |
| Company | Direct requests, HR/payroll, access/security, deadlines, meaningful announcements affecting the user | Routine bulk mail without personal impact |
| Career | Interview invitations, assessments, scheduling, offers, rejections, application updates | Generic job advertisements and newsletters |
| Other | Meaningful personal requests, deadlines, consequential updates | Routine low-value mail |

Importance and urgency are separate. A successful bank transaction or a rejection can
deserve an alert without requiring a reply or being urgent. Do not blanket-ignore a sender
because its messages are automated, promotional-looking, or sent from a no-reply address.

### Telegram experience

An alert shows the receiving account, sender, subject, concise summary, short importance
reason, and Gmail link. Include **Useful**, **Not important**, and **Create rule** buttons.
Mask account/card identifiers and omit OTP values. Do not invent transaction details,
deadlines, or other facts missing from the email.

| Command | Purpose |
| --- | --- |
| `/mail ignored` | Paginated review of ignored mail, with correction buttons |
| `/mail search <text>` | Search stored mail, including ignored mail |
| `/mail rules` | Create, inspect, and disable notification rules |
| `/mail status` | Account sync health, pending/failed classification counts, daily spend |

Search/review results support **Mark important** and **Mark unimportant**, including mail
that never produced a notification. These are deterministic commands and callbacks; a
conversational agent/tool loop is outside this phase.

### Corrections and rules

- Feedback stays pinned to the classification originally shown; retain classification history.
- A one-message correction applies across stored copies with the same normalized RFC
  Message-ID. Without that header, it applies to the stored message only.
- Marking missed mail important creates an alert if it has not already been delivered,
  including when it belongs to the silent initial backfill.
- Marking mail unimportant cancels an unsent alert where possible. A send already in flight
  may still finish. Do not delete or rewrite a sent alert.
- A correction does not silently create a sender/domain rule. Future rules require a separate
  explicit user action.
- Rule actions are `notify` or `ignore`. Match an exact sender address or exact domain, with
  an optional subject-text condition and optional receiving-account scope.
- Conditions combine with AND and match case-insensitively. Domain rules do not implicitly
  include subdomains. Default scope is all connected accounts.
- If several rules match, the most recently edited active rule wins; use a stable ID
  tie-breaker for equal timestamps.
- Decision precedence is **message correction → explicit rule → classifier**. Rules apply
  to future processing; changing one does not trigger a historical alert burst.
- Relevant previous corrections supply a small, bounded set of classifier examples. No
  automatic broad rules, embeddings, or fine-tuning are included.

## Boundaries and prerequisites

Included: local OAuth connection, encrypted token storage/refresh, mail sync, cleaning,
classification, explicit rules, Telegram alerts/review, feedback, spend control, audit,
failure visibility, and verification.

Excluded: Outlook/other providers, Gmail mutations, email sending/replies, attachment-body
processing, quiet hours/batching, conversational agent, approvals/execution, digest/news,
outreach, embeddings, a dashboard, and remote hosting/public OAuth callbacks.

Real integration verification requires:

- A Google **Desktop OAuth client ID and secret**, with the Gmail API enabled and the
  intended accounts able to grant access.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and the existing encryption key-ring settings.
- `OPENAI_API_KEY` and access to the requested model.
- The user's company-domain configuration and optional known bank senders.

Credentials and private mail must never be copied into this document or other project docs.
Phase 02's live Telegram heartbeat and inbound callback checks were verified on 2026-10-23;
its dated evidence is preserved in the phase 02 record.

## TODOs

### Increment 1 — Contracts, schema, and configuration (implemented 2026-10-21)

- [x] Record implementation approval for this named phase before changing implementation.
- [x] Reconcile the roadmap with the combined phase; update the active-phase links and
      proposed architecture without rewriting historical phase outcomes.
- [x] Record decisions for the combined scope, rule precedence, importance versus urgency,
      spending, and the stable notification-dedupe fallback.
- [x] Add persisted rule preferences and company domains; use enums for closed vocabularies.
- [x] Persist the per-account connection boundary so backfill remains silent across restarts
      and reconnecting an existing account does not reset its notification history.
- [x] Extend classifications with topic (`banking/work/career/other`), `shouldNotify`, summary,
      and decision source; retain matched-rule provenance and actual model effort.
- [x] Represent rule decisions honestly rather than recording a fictitious model call;
      preserve the one-current-classification constraint and append-only history.
- [x] Extend LLM audit support for durable in-flight budget reservations and unknown outcomes.
- [x] Document every new query/index requirement in `docs/DATABASE.md`.
- [x] Generate and inspect additive Drizzle migrations, then apply them. Put additions to
      existing enums in their own migration; never modify applied migrations or pg-boss tables.
- [x] Add mail-enabled configuration validation, default model/effort, and bounded request
      limits. Retain the heartbeat-only worker path and API startup without unused secrets.
- [x] Set initial mail preferences to `Asia/Kolkata`, no quiet hours/batching, and $1/day.

### Increment 2 — Account connection and credential lifecycle (implemented 2026-10-21)

- [x] Add `pnpm gmail:connect --email <address>` using the existing Google libraries, Desktop
      OAuth, PKCE, one-use state, a bounded flow lifetime, and a loopback-only callback.
- [x] Request only `gmail.readonly` with offline access; verify the actual Gmail account and
      granted scopes before saving credentials.
- [x] Atomically upsert the account and encrypted credential envelopes using the existing
      encryption helpers. Never print or persist plaintext tokens outside encrypted storage.
- [x] Preserve an existing refresh token when Google omits a replacement; persist refreshed
      access tokens/expiry and any rotated refresh token securely.
- [x] Add local account list/pause/resume controls and company-domain/bank-sender configuration.
- [x] Handle revoked grants, missing scopes, and permanent authorization errors visibly;
      isolate the affected account rather than stopping other mailboxes.
- [x] Document Desktop-client setup, consent/test-user configuration, and Google's
      Testing-mode refresh-token expiry behavior.

### Increment 3 — Reliable ingestion and cleaning (implemented 2026-10-22)

- [x] Add a scheduled account-sync coordinator and per-account sync jobs, approximately every
      minute, respecting account status and persisted backoff.
- [x] Serialize sync per account; do not rely on pg-boss job deduplication for business
      idempotency or cursor correctness.
- [x] Capture a history checkpoint before the seven-day backfill, finish every page, and
      replay subsequent changes so arrivals during setup are not missed.
- [x] Implement paginated incremental history sync; do not advance beyond unprocessed pages.
- [x] Commit message ingestion and cursor advancement transactionally, using the existing
      unique `(account_id, provider_message_id)` constraint for replay safety.
- [x] Recover expired/invalid history cursors with a scan covering the period since the last
      successful sync, with overlap; do not limit outage recovery to seven days.
- [x] Handle label changes and messages removed before retrieval without blocking a mailbox
      or deleting retained application history.
- [x] Decode recursive MIME parts, headers, addresses, charsets, and base64url content; prefer
      plain text and use the installed HTML-to-text cleaner when needed.
- [x] Store raw and cleaned body text separately, with cleaner version and normalized RFC
      Message-ID. Only cleaned, bounded content and metadata may reach the model.
- [x] Sweep pending messages independently of enqueue success so a crash after ingestion
      cannot strand mail; recover abandoned in-progress classifications safely.
- [x] Persist poll/success/failure timestamps, bounded safe errors, and backoff per account.

### Increment 4 — Classification, feedback examples, and spending (implemented 2026-10-22)

- [x] Implement the rule-first decision path and structured Responses API classification
      using `gpt-6-luna`, default `reasoning.effort: medium`, and configurable `high`.
- [x] Validate topic, existing urgency category, `shouldNotify`, confidence, summary, and
      short reason. Keep confidence diagnostic; do not suppress a positive importance
      decision merely because its confidence is low.
- [x] Version prompts/classifier policy, encode the agreed banking/company/career behavior,
      and favor notifying when importance is genuinely ambiguous.
- [x] Delimit email and example text as untrusted data. Give classification no tools or
      ability to execute instructions, follow links, or initiate actions.
- [x] Retrieve a small, bounded set of relevant correction examples from cleaned content;
      avoid including the same message as its own example.
- [x] Prioritize live arrivals over silent backfill and prevent one inbox from monopolizing
      classification work.
- [x] Serialize model calls and durably reserve their bounded worst-case cost before each
      external attempt; pause when remaining daily budget cannot cover it.
- [x] Reconcile actual input/cache/output/reasoning usage and snapshotted rates without
      double-counting reasoning tokens; count uncertain outcomes conservatively.
- [x] Audit every paid attempt, including provider request ID, effort, latency, errors, and
      available usage. Prevent hidden retries from bypassing audit/budget accounting.
- [x] At budget exhaustion, keep syncing and applying deterministic rules, leave remaining
      model-dependent mail queued, and enqueue one budget notice per local day.
- [x] Resume queued classification at the next local midnight without classifying a paused
      item as ignored or discarding it.
- [x] Bound transient retries and backoff. Keep refusals, invalid output, and exhausted
      attempts visible as failures with an explicit recovery path.

### Increment 5 — Notification production and delivery

- [x] Commit classification/current-row changes, message status, and notification enqueue
      together; make helpers usable within the caller's DB transaction.
- [x] Enforce the silent-backfill boundary during automatic notification production; allow
      the explicit missed-important correction path to override it.
- [x] Use normalized RFC Message-ID for cross-inbox notification dedupe; use stable stored
      message identity when the header is missing so reclassification cannot notify twice.
- [x] Check canonical message corrections when deciding whether another inbox copy may
      notify. Different emails in the same thread remain independently eligible.
- [x] Reuse `enqueueNotification` and the existing `email_triage` at-least-once delivery
      policy, bounded retries, and restart recovery; do not bypass the outbox.
- [x] Render bounded plain-text alerts with source account, summary, reason, Gmail link,
      identifier masking, and no OTP values.
- [x] Extend the Telegram sender/outbox payload contract to support validated inline buttons
      while retaining existing delivery and logging guarantees.

### Increment 6 — Telegram review and correction controls

- [x] Implement the command set above, paginated ignored-mail review, local mail search,
      and important/unimportant buttons on review results.
- [x] Upsert feedback against the displayed classification and validate any notification
      link belongs to it; support feedback without a notification.
- [x] Apply message corrections across canonical copies, cancel eligible unsent alerts,
      and notify missed-important mail without duplicating an already delivered alert.
- [x] Provide explicit rule creation with action, sender/domain, optional subject condition,
      and account scope; show the rule being saved before its explicit create action.
- [x] Implement rule inspection/disable and deterministic conflict resolution. Preserve
      provenance for past rule decisions.
- [x] Validate callbacks against stored records and the configured Telegram chat; acknowledge
      callbacks and make repeated updates/actions idempotent.
- [x] Extend `/mail status`, token-protected health details, and the existing heartbeat with
      mail backlog/failure/budget visibility. Keep public health responses minimal.

### Increment 7 — Verification and closeout

- [x] Add meaningful integration tests for connection/refresh/revocation, per-account
      isolation, pagination, arrivals during backfill, and history-cursor expiry.
- [x] Test ingestion/cursor transactions, crash/replay windows, pending-work recovery,
      classification history, cross-inbox dedupe, and missing-Message-ID fallback.
- [x] Test silent initial backfill versus new arrivals, read/archived mail, MIME/HTML cleaning,
      malformed messages, and attachment-content exclusion.
- [x] Test positive banking/company/career examples and confusing negatives such as bank
      promotions, company bulk mail, and generic job advertisements.
- [x] Test rules, precedence/account scope, feedback examples, both correction directions,
      callbacks from unauthorized chats, stale callbacks, and replayed updates.
- [x] Test daily budget reservation/reconciliation, concurrent admission, unknown outcomes,
      midnight reset, backfill priority, provider throttling, and model-output failures.
- [x] Test that only cleaned mail enters prompts, email instructions cannot invoke actions,
      credentials remain ciphertext, and logs/errors do not reveal bodies or secrets.
- [x] Compare medium/high reasoning on the same labeled evaluation set, separating examples
      used in prompts from held-out evaluation cases. Record recall, precision, cost, and
      latency; keep medium as the initial default rather than silently changing it.
- [x] Run `pnpm test`, `pnpm lint`, `pnpm exec tsc --noEmit`, and `pnpm build`; use `app_test`
      for DB tests and never truncate or model pg-boss-owned tables.
- [x] With real credentials, complete phase 02 Telegram heartbeat/smoke verification and
      verify the two connected accounts. (Live heartbeat sent; Gmail profile/backfill/incremental
      sync verified. Additional inbox connections remain routine setup at closeout; D040.)
- [x] Verify Gmail → classification → outbox → Telegram and a noisy-alert correction live.
- [x] Record the user's closeout acceptance and deferral of the missed-important correction
      and future-rule live checks to ongoing use (2026-10-23, D040). These checks remain
      unverified live and are listed below as post-phase follow-ups.
- [x] Verify worker restart does not duplicate ingested mail or enqueue another canonical
      alert; document the existing at-least-once ambiguity where Telegram delivery may repeat.
- [x] Review changes for unrelated edits, update affected records, and record actual commands,
      results, limitations, and integration evidence before marking the phase done.

## Acceptance

Closeout adjustment (2026-10-23, D040): the user accepted phase completion with two connected
accounts and deferred the two remaining live checks to ongoing use. This supersedes those live
closeout gates only; the implemented behavior and automated coverage below remain required.
Additional inbox connections and preference tuning remain routine setup/use.

- All intended Google accounts connect independently; credentials remain encrypted, refresh
  works, and a broken/paused account does not stop the others.
- The initial seven days are searchable and classified without an automatic alert burst.
  Later important arrivals alert without batching or quiet-hour delays, subject to provider
  availability and the configured model budget.
- Banking transactions, relevant company mail, interviews, rejections, and application
  updates are handled as agreed. Held-out evaluation targets are at least **95% importance
  recall** and **85% precision**; record dataset composition and observed results.
- The same email in multiple inboxes produces one canonical outbox notification when it has
  an RFC Message-ID. Replays and reclassification do not create another automatic alert.
  Without RFC Message-ID, cross-inbox duplicate detection is not guaranteed.
- Both false positives and false negatives can be corrected from Telegram. Explicit rules
  control future matching mail without silently broadening a one-message correction.
- The application admits model calls only within its daily budget, accounts conservatively
  for unknown outcomes, retains queued mail on exhaustion, and resumes on the next local day.
- Provider/model failures are visible and recoverable; no processing error is treated as a
  successful ignore decision. Run, model-call, classification, notification, and feedback
  provenance remain traceable.
- Automated checks pass and the real integration checks are recorded. Missing credentials
  may defer those live checks but do not count as successful completion.

## Choices needing input

No product choices block closeout. Gmail/OpenAI/Telegram credentials were supplied for the recorded
live verification. Additional accounts, company-domain/bank-sender hints, and classification
preferences can be configured during ongoing use.

## Evidence and outcome

Status: done 2026-10-23 (increments 1–7 implemented; live heartbeat, Gmail sync, classification,
alerts, noisy-alert correction, restart, and evaluation verified; missed-important/rule live checks
deferred by the user under D040).

### Increment 1 — contracts, schema, configuration, and audit reservations (2026-10-21)

Changed:
- `docs/PLAN.md`: combined phase 03 row, retired the old phase 04 row without renumbering later
  phases, active-phase links, and mail constraints (precedence, boundary, budget).
- `docs/ARCHITECTURE.md`: phase status, implemented/increment-1 responsibilities, proposed mail
  flow (rules/boundary/budget/dedupe), and audit reservation behavior.
- `docs/DECISIONS.md`: D028 combined scope, D029 rule/correction precedence and honest
  provenance, D030 importance vs urgency, D031 durable daily budget reservations, D032 stable
  dedupe fallback, D033 first-connection boundary; D007/D009 marked superseded in part.
- `src/db/schema/enums.ts`: new `classification_topic`, `classification_decision_source`,
  `mail_rule_action`, `mail_rule_match_type`, and `reasoning_effort` enums;
  `llm_call_status` gained `in_flight` and `unknown`.
- `src/db/schema/rules.ts`: `mail_rules` (action/match/value, optional subject, optional account
  scope, active, edit-time precedence index) and `company_domains` (lowercase unique).
- `src/db/schema/mail.ts`: classification `topic`, `should_notify`, `summary`,
  `decision_source`, `applied_rule_id`, `reasoning_effort`; nullable category/model/prompt/
  classifier/confidence for non-classifier decisions; decision-source check; rule provenance
  index.
- `src/db/schema/accounts.ts`: `mailbox_sync_state.notification_boundary_at`.
- `src/db/schema/audit.ts`: `llm_calls.reasoning_effort`, `reserved_cost_usd`, updated
  non-negative check; reservation/unknown statuses documented.
- `src/db/schema/preferences.ts`: timezone default `Asia/Kolkata`, nullable batch window
  (null = disabled), $1.00 daily spend default; `views.ts` exposes the new classification fields
  and makes classifier-owned fields nullable.
- `src/audit/calls.ts`: `withLlmCall` requires a positive worst-case reservation, inserts
  `in_flight` before the request, finalizes actual usage, records `unknown` via
  `LlmCallOutcomeUnknownError`, and exposes `markLlmCallUnknown`/
  `recoverStaleInFlightLlmCalls`; a non-positive or failed reservation insert prevents the call.
  `src/worker.ts` marks stale in-flight reservations unknown at startup.
- `src/db/queries/audit.ts`: `getLlmBudgetUsageForRange` counts terminal actual cost plus
  in-flight/unknown reservations; `getLlmSpendForRange` remains recorded actual spend.
- `src/notifications/dedupe.ts`: RFC Message-ID normalization and stable email-triage dedupe key
  (`email_triage:message:<id>` fallback).
- `src/env.ts` / `src/config.ts`: optional `MAIL_ENABLED` path with `MAIL_MODEL` (default
  `gpt-6-luna`), `MAIL_REASONING_EFFORT` (`medium`, configurable `high`), and bounded input/
  output/timeout limits. Gmail + OpenAI are required only when mail is enabled; the heartbeat-only
  worker and API startup without mail secrets remain valid. `src/logger.ts` redacts the new
  `openaiApiKey`/`clientSecret` config fields.
- Migrations: `0002_solid_fixer.sql` (enum values only), `0003_large_turbo.sql` (new enums,
  tables, columns, indexes, view, backfill, singleton seed), `0004_cloudy_luke_cage.sql`
  (rule provenance FK is `restrict`, so a past rule decision cannot lose its rule reference),
  `0005_flimsy_white_queen.sql` (partial unresolved `llm_calls` index), and
  `0006_brainy_living_tribunal.sql` (nullable urgency category for honest non-classifier rows).
  All inspected and applied to `app`; `0000`/`0001` untouched; pg-boss tables untouched.
- Tests: `tests/db/mail-contracts.test.ts`, `tests/dedupe.test.ts`, config mail cases,
  audit reservation/unknown/recovery/refusal cases, budget-query coverage, and logging redaction
  for the new config secret fields.

Verification:
- `pnpm db:generate` → generated `0002_solid_fixer.sql`; applied so the new enum values are
  committed before later DDL. Generated `0003_large_turbo.sql`; inspected the 21-table schema,
  the enum/tables/columns/checks/indexes/view, and appended only the classifier backfill and
  `user_settings` seed. `pnpm db:migrate` applied `0002` and then `0003` to `app` (with
  `0004`–`0006` applied after their inspections). Verified
  `llm_call_status` includes `in_flight`/`unknown`, 21 public tables exist, and the seeded
  singleton has `Asia/Kolkata`, null quiet hours, null batch window, and `$1.00`.
- Re-ran `pnpm db:generate` after `0006` → "No schema changes, nothing to migrate".
- `pnpm test` → 23 files, 192 tests passed.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` → clean.
- No live Gmail/OpenAI/Telegram verification was performed; Increment 1 does not connect accounts
  or call the model. Phase 02's real Telegram exit test remains pending credentials.

### Increment 2 — account connection and credential lifecycle (2026-10-21)

Changed:
- `src/gmail/constants.ts`: single `gmail.readonly` scope, 127.0.0.1 callback path, and a
  five-minute OAuth flow bound.
- `src/gmail/oauth.ts`: Desktop OAuth URL construction with offline access, explicit consent,
  no incremental grants, PKCE S256, one-use state, loopback callback server, one-use enforcement,
  timeout, and scope validation. The callback binds only to `127.0.0.1` on a random port.
- `src/gmail/connect.ts`: `connectGmailAccount` exchanges the code, verifies the Gmail profile
  matches `--email`, verifies the granted scope set, and saves only after both checks succeed.
  `src/gmail/errors.ts` holds the typed connect error and case-insensitive account-match check.
- `src/gmail/auth.ts`: `getGmailAuthorization`/`createAuthorizedGmailClient` reuse a valid stored
  access token until shortly before expiry, refresh and persist access/expiry, re-encrypt a
  rotated refresh token, preserve an omitted refresh token, and classify `invalid_grant`/missing
  scopes/permanent failures into visible `revoked`/`error` statuses. Transient failures leave the
  account active for per-account retry.
- `src/db/queries/accounts.ts`: atomic account + encrypted credentials + first-connection
  boundary upsert; case-insensitive lookup; account summaries; status updates; bounded auth
  failure recording. Reconnect preserves boundary/sync history and reactivates the account.
- `src/db/queries/credentials.ts`: `readCredentialRecord` returns decrypted token + expiry;
  credential helpers accept a transaction session (`DbSession`) for atomic callers.
- `src/mail/normalize.ts`, `src/mail/accounts.ts`, `src/mail/config.ts`: email/domain
  normalization, pause/resume rules, company-domain add/list/disable, and bank-sender
  add/list/disable using `vip_senders`.
- `src/config.ts`: `requireGmailConnectConfig` requires Gmail OAuth + encryption only (not
  Telegram/OpenAI/`MAIL_ENABLED`); shared key-ring validation refactor.
- CLIs/scripts: `pnpm gmail:connect`, `pnpm mail:accounts list|pause|resume`, and
  `pnpm mail:config company-domains|bank-senders ...`. No command prints tokens.
- `docs/GMAIL-SETUP.md`: Desktop OAuth, consent/test-user setup, Testing-mode refresh-token
  expiry, account/config commands, security notes, and troubleshooting.
- Tests: `tests/gmail-oauth.test.ts` (PKCE/URL/scope/loopback/state/timeout),
  `tests/gmail-auth.test.ts` (cached token, refresh, rotation/preservation, revoked/missing
  scope/transient), `tests/db/accounts.test.ts` (atomic first connect, reconnect boundary and
  refresh preservation, pause/resume, revoked/missing scope), and
  `tests/db/mail-config.test.ts` (domains/senders normalization and disable flows), plus
  `requireGmailConnectConfig` cases.

Verification:
- `pnpm db:generate` → no schema changes (Increment 2 required no migration).
- `pnpm test` → 27 files, 224 tests passed.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` → clean.
- CLI smoke: `pnpm mail:accounts list`, both `pnpm mail:config ... list` commands, and
  `pnpm gmail:connect` without arguments (usage/exit 1) ran against the local app DB without
  printing secrets.
- No live Google OAuth flow was run: real Desktop OAuth credentials, consent-screen test users,
  and Gmail API enablement are still required. Automated coverage uses fake OAuth clients and a
  local loopback callback test; live account connection remains pending credentials.

### Increment 3 — reliable ingestion and cleaning (2026-10-22)

Changed:
- `src/mail/coordinator.ts`: active, non-backing-off account selection for the every-minute
  coordinator.
- `src/mail/sync-lock.ts`: per-account session advisory lock on a dedicated pool connection; a
  second sync returns without racing the cursor.
- `src/mail/sync-state.ts`: sync-state creation, poll/success/failure timestamps, bounded errors,
  consecutive failures, and exponential backoff (1m base, 1h cap).
- `src/mail/sync.ts`: initial checkpoint before the seven-day backfill, all-pages ingestion, replay
  from the checkpoint, page-atomic incremental cursors, label add/remove handling, 404-skip,
  expired-cursor recovery from `last_success_at - 1h` (not a fixed seven-day cap), and final
  success/failure state.
- `src/mail/mime.ts`: recursive Gmail payload decoding, RFC 2047 headers, address lists, charsets,
  base64url bodies, plain-text preference, `html-to-text` HTML cleaning, deterministic bounds,
  normalized Message-ID, excluded-label handling, and attachment metadata (filename/MIME/size only).
- `src/mail/ingestion.ts`: idempotent message upsert (replay preserves body/triage state and
  refreshes labels/thread), plus label load/update helpers.
- `src/mail/triage-state.ts`: pending/failed list, `FOR UPDATE SKIP LOCKED` claim, stale
  `in_progress` recovery, pending counts, and a recovery/count sweep. The classifier enqueue/
  consumer lands in increment 4; the DB sweep is already called by the coordinator.
- `src/jobs/mail-sync.ts`: coordinator and per-account job handlers with runs, account isolation,
  transient-auth backoff, and no message bodies in logs.
- `src/queue.ts` / `src/worker.ts`: mail coordinator + sync queues, per-account sync jobs, every-
  minute coordinator schedule when mail is enabled, and removal of a stale coordinator schedule
  when mail is disabled. The heartbeat-only worker path remains valid.
- `src/tools/mail-accounts.ts`: list now shows last poll, consecutive failures, and the rest of
  the sync health.
- Docs: this phase, DECISIONS D035, DATABASE sync/ingestion contract, ARCHITECTURE flow/status,
  PLAN/README/AGENTS/GMAIL-SETUP. No schema change was needed.
- Tests: MIME/header/address/charset/attachment/HTML coverage; idempotent ingestion and label
  updates; initial checkpoint/backfill/replay; incremental pagination with a failed page and
  replay; label changes/deletions; expired-cursor recovery older than seven days; failure/backoff
  and paused-account skips; sync lock; coordinator selection/enqueue; pending-triage recovery;
  queue/schedule changes.

Verification:
- `pnpm db:generate` → no schema changes (increment 3 required no migration).
- `pnpm test` → 33 files, 252 tests passed.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` → clean.
- No live Gmail sync was run: fake Gmail APIs cover the protocol/state machine, and a real
  credential-backed sync remains pending the setup inputs. No message bodies or tokens were
  logged by the new sync paths.

### Increment 4 — classification, feedback examples, and spending (2026-10-22)

Changed:
- `src/mail/pricing.ts`: snapshotted `gpt-6-luna` rates (input/cached/cache-write/output), cost
  computation that never adds reasoning twice, and the bounded classifier reservation.
- `src/mail/budget.ts`: `Asia/Kolkata` local-day ranges, settings/limit lookup (defaults when the
  singleton is absent), conservative `getLlmBudgetUsageForRange` admission, remaining spend, and
  the once-per-local-day `system:mail-budget:<day>` outbox notice.
- `src/mail/rules.ts` + `src/mail/triage-state.ts`: active-rule precedence/order, exact sender/domain
  and subject/account matching, budget-independent rule candidate join, per-account fair selection,
  live-before-backfill ordering, conditional `in_progress` claims with `FOR UPDATE SKIP LOCKED`,
  `triage_next_attempt_at` exponential retry (1m→1h), terminal failure markers, claim release, and
  explicit requeue helpers.
- `src/mail/examples.ts`: bounded feedback examples from `classifier_feedback_examples` (same
  sender/domain first, then recent), corrected decisions derived from `useful`/`not_useful`/
  `missed_important`, with the current message and same-RFC copies excluded.
- `src/mail/classifier-prompt.ts`: versioned policy/prompt (`mail-classifier-v1`,
  `mail-prompts-v1`), banking/work/career/other policy, ambiguity-favors-notify guidance, escaped
  untrusted-data delimiters, bounded metadata/attachment hints, and output validation/trimming.
- `src/mail/openai-classifier.ts`: Responses API structured classification with `gpt-6-luna`,
  configured `medium`/`high` effort, no tools, `store: false`, SDK retries disabled, usage/cost
  mapping, and refusal/invalid/uncertain error typing.
- `src/mail/classification.ts`: classifier and rule decision insertion, current-row supersession,
  message `classified` transition in one transaction, and clean-only triage message loading.
- `src/mail/triage.ts` + `src/jobs/mail-triage.ts`: rule-first pass, budget-admitted fair classifier
  batch, serialized reserved model calls, prompt/example assembly, transient/permanent failure
  handling, budget pause/release, and a cheap preflight that avoids idle audit runs. The coordinator
  enqueues the bounded triage job; the worker registers it with the shared shutdown signal.
- `src/queue.ts` / `src/worker.ts` / `src/jobs/mail-sync.ts`: `mail-triage` queue (policy refreshed
  on every start), coordinator runnable count/enqueue, worker wiring when mail is enabled, and
  immediate startup release of abandoned `in_progress` claims after the single-worker lock is held.
- `src/audit/calls.ts` + `src/db/schema/{audit,mail}.ts`: `cache_write_tokens`, known-failure usage
  via `LlmCallFailedError`, and `messages.triage_next_attempt_at`.
- `src/config.ts`: mail models now require a configured pricing snapshot; environment parsing still
  allows arbitrary strings for tests/base startup.
- `src/tools/mail-triage.ts` + package script: `pnpm mail:triage status|retry-failed` for backlog,
  failures, daily spend/reservation, and explicit terminal-failure recovery. No command prints mail
  bodies or secrets.
- Migration `0007_peaceful_moon_knight.sql`: adds `llm_calls.cache_write_tokens` (and extends the
  non-negative check) and `messages.triage_next_attempt_at`; inspected and applied to `app`.
  `0000`–`0006` and pg-boss tables were untouched.
- Docs: this phase, DECISIONS D036, DATABASE classification/spend and schema/state contracts,
  ARCHITECTURE status/flow/responsibilities, PLAN/AGENTS.
- Tests: pricing/local-day boundaries; rule matching/precedence; prompt delimiters/input bound and
  output validation; OpenAI usage/cost/refusal/invalid/uncertain handling; fair/live claims and
  backoff/requeue/release; classifier/rule provenance and supersession; feedback-example relevance
  and same-message/RFC exclusion; end-to-end fake-classifier triage with audit rows, rule bypass,
  budget pause/one notice/day, local-day reset, transient backoff, permanent refusals, and a rule
  match behind a large non-matching backlog; known-failure LLM audit usage.

Verification:
- `pnpm db:generate` → `0007_peaceful_moon_knight.sql`; inspected (two additive columns + check
  re-creation) and `pnpm db:migrate` applied it successfully. Re-running `db:generate` reported no
  further schema changes.
- `pnpm test` → 40 files, 289 tests passed.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` → clean.
- `pnpm mail:triage status` and `pnpm mail:triage retry-failed --all` ran against the local `app`
  database without printing mail content or secrets: 0 backlog, 0 failures, $0 spend, $0.0035
  reserved per call, $1.00 limit, 0 requeued. No live OpenAI call was made: automated coverage uses
  an injected fake classifier and fake Responses client, so real key/model access and a real
  classification remain pending setup inputs. No message bodies, prompts, or tokens were logged.

### Increment 5 — notification production and delivery (2026-10-22)

Changed:
- `src/mail/alerts.ts`: canonical `email_triage` production inside the decision transaction;
  latest-canonical-correction precedence (current correction rows, then newer feedback); silent
  boundary enforcement with an explicit `allowBeforeBoundary` path; RFC/stored-message dedupe;
  bounded plain-text rendering with account/sender/subject/summary/reason/Gmail link; card/account
  masking and OTP redaction; validated inline-button payload.
- `src/mail/classification.ts`: `insertCurrentClassification` now accepts `DbSession`; classifier
  and rule decisions produce their alert in the same transaction, with
  `recordClassifierDecisionInTransaction`/`recordRuleDecisionInTransaction` available to callers
  that own the transaction. The transaction-owning wrappers remain for the triage job.
- `src/notifications/outbox.ts`: `enqueueNotification` accepts a `DbSession`, so the existing
  at-least-once outbox path is reused inside the classification transaction.
- `src/notifications/dispatcher.ts`: reads and validates `payload.inlineButtons` and forwards them
  to the sender; malformed/oversized payload buttons are omitted without blocking the alert body.
- `src/telegram/buttons.ts`: shared inline-button types, Telegram limits, payload validation, and
  reply-markup conversion.
- `src/telegram/sender.ts`: optional validated buttons, `TelegramInvalidButtonsError`, and the
  existing 4096-character/timeout/logging behavior unchanged.
- `tests/db/fixtures.ts`: `createMailboxSyncState` for boundary/correction tests.
- Docs: this phase, DECISIONS D037, DATABASE alert production/payload contract and precedence,
  ARCHITECTURE status/flow/responsibilities/constraints, PLAN/AGENTS/README.
- Tests: OTP/identifier sanitization and bounded rendering; button validation and callback limits;
  sender reply markup and invalid-button rejection; dispatcher button forwarding/omission;
  transactional classification+status+outbox rollback; live versus silent boundary; unset boundary;
  cross-inbox RFC dedupe; missing-Message-ID stable fallback; correction-row and feedback
  suppression; positive correction boundary override; explicit missed-important override;
  same-thread independence; rule notification; and triage-level alert production.

Verification:
- `pnpm db:generate` → no schema changes (increment 5 required no migration).
- `pnpm test` → 42 files, 317 tests passed.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` → clean.
- No live Telegram delivery or real Gmail/OpenAI run was performed. Automated coverage uses fake
  senders and the test database; the Telegram and model integration checks remain pending the setup
  inputs. No alert bodies, mail content, or tokens are logged by the new paths.

### Increment 6 — Telegram review and correction controls (2026-10-22)

Changed:
- `src/mail/review.ts`: current ignored-mail pagination (five per page, newest first), local
  subject/clean-text FTS plus bounded sender search (includes ignored/unclassified mail), displayed
  classification/message/account lookup, and stored outbound-message lookup.
- `src/mail/corrections.ts`: feedback upsert pinned to the displayed classification, notification-link
  validation, canonical-copy locking, correction application across the same normalized RFC
  Message-ID (or the stored message only), unsent-alert cancellation, and idempotent repeated
  corrections.
- `src/mail/rules-admin.ts`: normalized rule input, identical-active-rule reuse, paged rule display
  with account scope, retrieval, and disable-without-delete.
- `src/mail/status.ts`: one mail status snapshot (account sync health, backlog/failures, local-day
  spend/reservation, outbox counts) shared by `/mail status`, health details, and the heartbeat.
- `src/mail/classification.ts`: correction decision insertion, message-row locking, and refusal to
  let a classifier/rule decision supersede a current correction (including an in-flight model call).
- `src/mail/alerts.ts`: explicit important corrections reactivate cancelled/undelivered (failed/
  expired) rows under the same dedupe key; sent/sending alerts remain untouched.
- `src/telegram/mail.ts`: deterministic `/mail ignored|search|rules|status` commands, paginated
  review/search edits, classification/rule callback parsing, alert/review/rule callback validation,
  feedback and correction invocation, rule preview/Save/Cancel/toggles, rule list/disable, and status
  rendering.
- `src/telegram/updates.ts` + `src/telegram/bot.ts`: callback query extraction, reply/edit/answer
  callbacks, outbound payload storage in `telegram_messages`, callback acknowledgement, and
  edit-message idempotency for unchanged pages.
- `src/health.ts` + `src/jobs/heartbeat.ts`: token-protected mail counts/spend/last-sync details and
  a compact heartbeat mail backlog/budget line; public health responses unchanged.
- Docs: this phase, DECISIONS D038, DATABASE review/correction/rule/telegram payload behavior,
  ARCHITECTURE status/flow/responsibilities/constraints, PLAN/AGENTS/README.
- Tests: review pagination/search and unclassified results; feedback upsert, notification link
  validation, idempotent repeated feedback; canonical important/unimportant corrections; silent
  boundary override; same-thread isolation; sent-alert preservation; cancelled-alert reactivation;
  stale/mismatched callbacks; rule preview/save/toggles/list/disable and command creation; callback
  acknowledgement/unauthorized-chat drops; `/mail status`; health details mail fields; heartbeat mail
  line; rule validation/management/pagination.

Verification:
- `pnpm db:generate` → no schema changes (increment 6 required no migration).
- `pnpm test` → 46 files, 344 tests passed.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` → clean.
- No live Telegram command/callback or real Gmail/OpenAI run was performed. Automated coverage uses
  fake Telegram transports and the test database; real Telegram interaction remains pending bot
  credentials, and the phase 02 live heartbeat check remains pending.

### Increment 7 — verification and closeout (2026-10-22)

Changed:
- Added `src/mail/evaluation.ts`, `src/tools/mail-evaluate.ts`, and the `pnpm mail:evaluate` script:
  a disjoint synthetic prompt-example/held-out dataset plus recall, precision, cost, and latency
  reporting for medium/high reasoning. Live execution requires `OPENAI_API_KEY`.
- Added `GMAIL_REQUEST_DELAY_MS` (default 350 ms, range 0–5000) to mail config and per-call pacing
  in `src/mail/sync.ts` (`getProfile`, `messages.list`, `messages.get`, `history.list`). This
  followed real quota failures during verification; see D039.
- Added tests for per-account coordinator isolation when one enqueue fails, serialized model-call
  admission/recovery, read/archived Gmail labels, and the evaluation dataset/metrics/error handling.
- Docs: this phase, DECISIONS D039, GMAIL-SETUP pacing/quota guidance,
  ARCHITECTURE sync constraint/flow, README/PLAN/AGENTS.
- No schema changes.

Real integration evidence:
- `pnpm mail:accounts list` showed two active accounts with `gmail.readonly`, persisted
  boundaries (`2026-10-22T08:29:31.060Z` and `2026-10-22T08:30:13.434Z`), and no prior sync.
- A real Gmail `getProfile` check for both accounts returned the matching address, a history id,
  `refreshed: false`, and only the readonly scope. Access tokens were valid without a refresh.
- The first unthrottled sync attempts failed twice with Google `Quota exceeded ... Total Query
  Cost`; the failures were recorded per account with backoff. A throttled verification sync then
  completed the initial silent backfill:
  - `vishesh.gubrani@gmail.com`: mode `initial`, fetched 220, ingested 220, history id `8267445`.
  - `visheshgubranii@gmail.com`: mode `initial`, fetched 190, ingested 190, history id `3080074`.
- A second sync through the production `GMAIL_REQUEST_DELAY_MS` path completed incrementally for
  both accounts with fetched 0 / ingested 0, proving replay did not duplicate stored mail.
- Stored-mail audit: 410 messages total (220 + 190), 410 `pending`, 0 classifications, 0 outbox
  rows. Both accounts are active with successful sync timestamps.
- `pnpm mail:triage status`: 410 pending/runnable, 0 failures, $0.0000 actual/held, $1.00 daily
  limit, $0.0035 per-call reservation.
- `getMailStatusSummary`/`formatMailStatus` against the real data reported both active accounts,
  a 410-message backlog, $0 spend, and 0 outbox rows.
- `pnpm mail:evaluate --effort both` was run after credentials were supplied:
  - medium: 13 cases, TP 9 / FP 0 / TN 4 / FN 0 / 0 errors, recall 100.0%, precision 100.0%,
    cost $0.0026, average latency 2,511 ms.
  - high: 13 cases, TP 9 / FP 0 / TN 4 / FN 0 / 0 errors, recall 100.0%, precision 100.0%,
    cost $0.0028, average latency 2,231 ms.
  Medium remains the configured default; the held-out set is synthetic and disjoint from prompt
  examples, so this is a harness/evaluation check rather than a production-mail accuracy estimate.
- Credentials were then supplied (`MAIL_ENABLED=true`, OpenAI, Telegram bot/chat, Gmail OAuth,
  encryption). The worker started, the bot logged `telegram bot polling started`, and the live
  checks below were performed.
- At-least-once ambiguity remains documented: a crash after Telegram accepts a send but before the
  `sent` finalize may repeat delivery; ingestion and canonical alert enqueue are idempotent.

Live worker, classification, alert, and restart evidence (2026-10-22/23):
- `pnpm smoke:heartbeat` queued a manual heartbeat and observed `outbox status: sent (attempts 1)`,
  `telegramMessageId: 3`, exit 0. The phase 02 live exit test is complete.
- The worker synchronized both accounts on its every-minute schedule. A snapshot after live
  processing showed 414 stored messages, 120 classified, 294 pending, 0 failed; 120 LLM attempts
  and $0.046844 actual spend (the daily limit is $1.00). Later batches continued.
- Five canonical `email_triage` outbox rows were created; all five reached `sent` with Telegram
  message ids, 0 failed. A current notify classification for silent backfill
  (`received_at` before the connection boundary) had no outbox row, confirming the boundary was
  enforced. Live current-notify counts were audited as 4 live / 23 silent at one snapshot, with
  the only live row lacking a direct outbox link being a correction row whose canonical alert was
  already delivered under the superseded classification.
- The user exercised the live alert buttons: two callback updates were processed with 0 errors.
  Feedback rows were `useful/other` and `not_useful/too_noisy`, both linked to sent notifications;
  correction classifications were `decision_source='correction'`; the sent alert for the
  not-important correction was preserved. This verifies the noisy-alert correction direction and
  live callback validation/acknowledgement.
- A graceful worker restart was performed: clean drain, restart, startup recovery, and resumed
  sync/triage. Before/after snapshots showed 413 messages and 4 email alerts both times (no
  duplicate ingestion or duplicate canonical alert); subsequent batches classified more pending
  mail without re-alerting the same canonical email.

Automated checks:
- `pnpm test` → 48 files, 353 tests passed.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` → clean.
- `pnpm db:generate` → no schema changes.

### Closeout verification and readiness fix (2026-10-23)

- A fresh `pnpm test` run reproduced four failures in health/worker-lock tests (349 passed).
  Querying `pg_locks` from `app_test` showed a matching worker lock held in `app`.
  The readiness helper matched the key across databases and incorrectly reported a test worker.
- Restricted the readiness lookup to the current database; worker lock acquisition and release
  are unchanged. Added a regression using a temporary second test database, removed afterward,
  to prove that a matching lock elsewhere does not satisfy readiness here. No migration was needed.
- Fresh verification after the fix: `pnpm test` → 48 files, 354 tests passed;
  `pnpm lint`, `pnpm exec tsc --noEmit`, and `pnpm build` → clean. The test suite ran against
  `app_test` with fake provider integrations; the live worker on `app` remained running.
- Updated the roadmap, architecture, AGENTS phase link, and D040 to record completion and the
  user-deferred checks. No further implementation phase was started.

### Post-phase follow-ups (user-deferred 2026-10-23)

- [ ] Mark an ignored message important from `/mail ignored` (missed-important correction) and confirm
  an alert is created without duplicating an already delivered alert.
- [ ] Create/save a rule from an alert or `/mail rules add`, then confirm it changes subsequent
  matching mail without a historical alert burst. `/mail rules` and `/mail status` can be used to
  inspect the result.
- Optional: send `/ping` and exercise `/mail status`, `/mail search`, and `/mail rules` commands
  live; automated tests cover them.
- If Gmail quota errors recur, raise `GMAIL_REQUEST_DELAY_MS` and let per-account backoff retry.

Phase 03 is closed at the user's explicit request (D040). The two follow-up checks remain
unverified live; automated tests cover both behaviors. The 13-case synthetic evaluation does not
establish real-inbox accuracy. Additional inbox connections and preference tuning can continue
during normal use. Phase 05 remains planned and has not been started.

## References

- [Project roadmap](../PLAN.md), [architecture](../ARCHITECTURE.md),
  [database contract](../DATABASE.md), and [decisions](../DECISIONS.md).
- [Gmail account setup](../GMAIL-SETUP.md).
- [Phase 02 runtime skeleton and verification record](02-runtime-skeleton.md).
- [GPT-6 Luna: model ID, supported reasoning settings, structured outputs, and pricing](https://developers.openai.com/api/docs/models/gpt-6-luna).
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
- [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
  [OAuth token lifecycle](https://developers.google.com/identity/protocols/oauth2), and
  [Gmail read-only scope](https://developers.google.com/workspace/gmail/api/auth/scopes).
- [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync) and
  [history pagination/cursor behavior](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).

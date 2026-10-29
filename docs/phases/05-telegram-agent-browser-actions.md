# Phase 05: Telegram agent, approvals, and browser actions

Status: in_progress — increment 0 done 2026-10-25. Increment 1 (contracts, schema,
configuration, browser host) implemented 2026-10-25; the live spike checks that need the user's
logins, Tailscale, or phone remain open, so increment 1 is not closed. Increment 2 (budgeted
model, driver, tool layer; library only) implemented 2026-10-25. Increment 3 (Reddit comment end
to end) implemented 2026-10-25; its two live checks wait on the Reddit login and a priced
`AGENT_MODEL`. Increment 4 (human handoff) implemented 2026-10-25; its live phone-login
check is blocked on agent/model/view configuration and the user login. Increment 5 (free-text
intake and Reddit post) implemented 2026-10-25; its live post check has the same setup blockers.
Increment 6 (profile-backed YC/Wellfound application notes) implemented 2026-10-25; real-site
phone approval/verification checks remain pending. Increment 7 (schedules/operations) is implemented;
credential-backed live checks are deferred to the next session at the user’s request.
Approval: approved 2026-10-25 for increment 0 ("implement the increment 0") and, separately,
increment 1 ("implement the increment 1 now"), increment 2 ("okay now implement increment
2"), increment 3 ("Implement the Increment 3 — Reddit comment end to end"), and increment 4
("Implement the increment 4"), and increment 5 ("Okay now implement the increment 5 now").
Increment 6 approved 2026-10-25 ("Implement the increment 6"). Increment 7 approved 2026-10-25 ("for now implement the increment 7"); automated implementation complete, live checks deferred.
Product choices recorded 2026-10-25 (from the user):

- self-hosted browser with a phone takeover link
- tap-to-approve on every submit
- first sites: Reddit, YC Work at a Startup, and Wellfound
- Playwright plus our own tools as the browser layer

Instagram moves to a later phase.

Roadmap: this is the planned phase 05 ("Telegram agent + approvals"). Browser actions are its first
send-tier tools. Free-form conversational chat is still deferred.

## Goal

From Telegram, ask the assistant to comment on or post to Reddit, or to apply to a YC Work at a
Startup or Wellfound job with a short note. Requests can be one-off ("comment this on <thread>") or
recurring ("every day at 9am do X"). An LLM agent drives a real browser to prepare the action. You
approve the exact submission with one tap. The app then submits it without the model and checks the
result.

If the agent meets a captcha, login, 2FA, or verification page, it never tries to solve or get
around it. It pauses and sends a Telegram message with the reason, a screenshot, and a link to the
live browser. You fix it from your phone, tap **Done**, and the task carries on.

The roadmap's phase 05 foundations ship here as well: the first agent tool loop, the approval
lifecycle and execution path, and the at-most-once send claim.

## Agreed behavior

| Setting | Initial behavior |
| --- | --- |
| Sites | Reddit (comment, post), YC Work at a Startup (application note), Wellfound (application note) |
| Deferred | Instagram (photo intake/upload, or the Graph API for a professional account) |
| Runtime | This computer. Headful Chromium in a Docker container with its own persistent profile |
| Takeover | noVNC view of that browser, reached privately over Tailscale; the link goes in Telegram |
| Logins | You log in by hand through the view. The app never stores, reads, or types passwords |
| Approval | Every submit. The preview card shows the exact field values and a screenshot |
| Scheduled runs | Each run still needs approval for its submit |
| Agent | AI SDK v7 `ToolLoopAgent`, text-only, reading bounded accessibility snapshots |
| Browser layer | `playwright-core` over CDP with our own guarded tools (no browser-agent framework) |
| Model | `AGENT_MODEL`, chosen in the increment 1 spike; it must have pricing configured |
| Budget | Agent sub-limit of $0.50 per local day inside the existing global limit, plus a per-task cap |
| Concurrency | One browser task at a time; new requests queue behind it |
| Timezone | `Asia/Kolkata` for schedules and budget days |
| Daily caps | Per site and action; proposed defaults in [Choices needing input](#choices-needing-input) |

Why the browser, not APIs: Reddit has required manual approval for new Data API OAuth tokens since
its November 2025 Responsible Builder Policy. Wellfound and YC Work at a Startup have no public
API. The browser layer sits behind an interface, so an API-backed tool can replace a site later
without changing the approval flow.

Why no browser-agent framework (confirmed 2026-10-25):

- **browser-use** is Python-only and runs its own model loop. Its calls would skip
  `llm_calls` budget reservation, and nothing in it stops a Submit click before approval.
- **Skyvern** is a heavy, AGPL, self-hosted platform with its own database.
- **Playwright MCP** offers generic tools that cannot limit typing to approved text or block commit
  clicks.
- **Stagehand v4** dropped `agent()`, and each `act()` makes a hidden model call. Its
  `act`/`observe` helpers stay available as a fallback behind `BrowserDriver` if plain Playwright
  struggles in the spike, most likely with Reddit's editor.

### Telegram experience

| Input | Purpose |
| --- | --- |
| `/comment <url>` then the text on the next line | Comment on a Reddit thread (increment 3) |
| Free text or a reply | Reddit comments/posts and inert schedule drafts (increment 5); applications and confirmed schedules supported in increments 6–7 |
| `/tasks` | Recent tasks and their status |
| `/stop` | Cancel the active task |
| `/schedules` | List schedules; disable one |

| Message | Content | Buttons |
| --- | --- | --- |
| Queued | `Task #abcd queued: Reddit comment on <thread>` | Stop |
| Approval | Screenshot; site, action, target; every field's exact value; agent-written fields marked "(drafted)" | Approve, Cancel |
| Handoff | Screenshot; reason (captcha/login/2FA/verification/other); page; view link | Open browser (URL), Done, Stop |
| Result | Link to the posted item or sent application, or "submitted, not verified" | — |
| Recovery | Task interrupted by a restart; outcome known or unknown | Retry, plus Open browser if unknown |
| Schedule draft | Instruction, cron, next three run times | Save, Cancel |

Clear one-off requests start right away, because the approval card already guards every submit. A
confirmation card comes first only for schedules, unclear requests, and replayed messages older
than 10 minutes.

### Approval and safety

- **The form is prepared before approval, and the submit runs without the model.**
  1. The agent prepares the page: it navigates, opens the composer, and fills in only the spec field
     values.
  2. It calls `request_submit_approval`. That reads every field back and checks it exactly equals
     the spec. It then checks the submit button against the site's commit pattern, takes a
     screenshot, and creates the approval.
  3. After you tap Approve, deterministic code checks the URL, the field values, and the submit
     element again, clicks once, and confirms the result. No model call runs after approval.
- **The approval payload is the contract (D008).** Execution reads its arguments only from
  `approvals.payload` and claims the approval once through `tool_calls(approval_id)`.
  - Any failure after approval ends that approval. A retry is a new task with a new approval linked
    by `retry_of_approval_id`.
  - If you edit the form over VNC while the approval is pending, the pre-click check fails and
    nothing is submitted.
- **The tool layer enforces deterministic guards before approval.**
  - Each site has an origin allowlist.
  - Clicks on commit-like names are refused (post, comment, reply, submit, send, share, publish,
    apply, confirm, delete, remove, follow, vote, report, block, logout, settings). The exception is
    elements the site registry marks as pre-commit openers, such as an "Apply" button that only
    opens a modal.
  - The agent cannot type free text, except bounded search queries into search boxes and combo
    boxes.
  - Ctrl/Meta+Enter is refused. There is no JavaScript-eval tool and no file-system tool.
- **Your own words are fixed before any web content is read.** A value marked "verbatim" must be an
  exact substring of your message; otherwise the bot asks you to clarify. Text the agent writes (job
  notes, scheduled content) is always labelled "(drafted)" in the approval.
- **Everything read from the web is untrusted data.** Snapshots and job excerpts are bounded,
  delimited, and marked untrusted. The agent never follows instructions found in page content.
- **No evasion.** No captcha-solving services, stealth plugins, fingerprint spoofing, or automation
  flag tricks. The browser uses your own home IP at a human pace, within per-site daily caps.

## Boundaries and prerequisites

Included:

- Browser host container and phone takeover view.
- Budgeted AI SDK model wrapper, Playwright driver, and guarded tool layer.
- Browser task lifecycle, approval creation, resolution, and execution.
- Human handoff.
- Telegram intake (command, then free text), approval/handoff/result cards, and photo messages for
  screenshots.
- Reddit comment and post.
- YC Work at a Startup and Wellfound application notes from a stored profile.
- Schedules, recovery, audit, spend visibility, and artifact retention.

Excluded:

- Instagram, inbound Telegram media, and image uploads.
- General conversational chat with history.
- Moving the mail classifier to the AI SDK.
- Open-web browsing outside the site registry.
- Multi-submit tasks ("comment on 5 threads"); these become one task per submit.
- Long-form forms, resume uploads, and reattaching to tabs after a worker restart.
- Hosted browsers, outreach, and digest work.

Real integration checks need:

- Docker; Tailscale on this computer and on your phone.
- A dedicated Chrome profile volume, with you logged in to Reddit, YC (Work at a Startup), and
  Wellfound through the view.
- `OPENAI_API_KEY` with access to the chosen `AGENT_MODEL`.
- The existing Telegram and encryption settings.
- A Reddit thread you own, or a test subreddit, for live posting checks.

Credentials, session cookies, screenshots of private pages, and profile text must never be copied
into this document or other project docs.

## Design

### Browser host

- **Compose service.** `docker-compose.browser.yml` and `docker/browser/`. Start the spike with
  `lscr.io/linuxserver/chromium`; KasmVNC works better on phones. Fall back to a custom
  Debian + Xvfb + x11vnc + noVNC + supervisord image.
- **Chrome flags and limits.** Use a dedicated `--user-data-dir` on a named volume, because Chrome
  136+ refuses remote debugging on the default profile. Set `shm_size: 1gb` and
  `TZ=Asia/Kolkata`. Add no automation or stealth flags.
- **CDP exposure.**
  - CDP is published only on host `127.0.0.1:9222`, through socat inside the container. Headful
    Chrome ignores `--remote-debugging-address`.
  - CDP is never exposed beyond loopback.
  - `ARTIFACT_DIR` is mounted read-only if the container ever needs it.
- **Phone view.** The view is served through Tailscale Serve (HTTPS `*.ts.net`) with VNC
  authentication. Its URL is `BROWSER_VIEW_URL`, used as a Telegram URL button.
- **Connection model.** The worker connects for each task with `connectOverCDP`, opens one new page,
  and disconnects at the end. It never closes the browser. Logins persist in the profile volume
  across container and worker restarts.

### Agent and tools

- **Agent.** `ToolLoopAgent` from `ai` v7 with `@ai-sdk/openai`, at exact pinned versions.
  - Options: `instructions` (not `system`), and `maxRetries: 0`.
  - `stopWhen` is any of `isStepCount(AGENT_MAX_STEPS)`, `hasToolCall('request_submit_approval')`,
    or `hasToolCall('report_result')`.
  - `prepareStep` drops all but the latest snapshot and sets `activeTools` for the phase.
  - The SDK's `toolApproval` is not used: approvals must survive restarts and run as a separate
    execution run.
- **Snapshots.** Bounded aria snapshots with element refs, marked untrusted. Each snapshot has a
  generation number, so refs from an older snapshot are rejected. The spike confirms the exact API
  in the installed Playwright (`locator.ariaSnapshot({ ref: true })` plus `aria-ref=` selectors).

| Tool | Tier | Notes |
| --- | --- | --- |
| `navigate(url)` | read | Site origin allowlist only |
| `snapshot()` | read | Bounded aria tree with refs, marked untrusted |
| `screenshot()` | read | Stored as an artifact for Telegram and evidence; never sent to the model |
| `click(ref)` | draft | Commit-name lexicon refused unless the site lists it as a pre-commit opener |
| `fill_field(ref, fieldKey)` | draft | Types the spec value for `fieldKey` exactly; no free-text argument |
| `type_search(ref, query)` | draft | Bounded; search box or combo box roles only |
| `press(key)` | draft | Allowlisted keys; Enter only in a search box or combo box |
| `scroll(direction)` / `wait(ms)` | read | Bounded |
| `request_human(reason, detail)` | notify | Starts a handoff and waits |
| `request_submit_approval(submitRef, fieldRefs)` | draft | Read-back check, commit-pattern check, screenshot, approval; waits for your answer |
| `report_result(summary)` | read | Ends read-only tasks; no approval needed |

- **Auditing.** Every tool call is wrapped in `withToolCall` (`src/audit/calls.ts`) under the task
  run, with the tier shown above. The submit itself is a `send` tool call made only by the executor.
- **Site registry (`src/browser/sites.ts`).** For each site it lists origins, actions, field keys
  and labels, commit patterns per action (for example Reddit comment `/^comment$/i`), pre-commit
  openers, verification hints, daily caps, and login/challenge URL patterns.
- **Detectors (`src/browser/detectors.ts`).** They recognise login redirects, reCAPTCHA, hCaptcha,
  Turnstile, and Arkose iframes, and challenge and 2FA pages. They run after navigation, after each
  click, and before approval.

### Task, approval, and execution flow

1. Intake creates a `browser_tasks` row with status `queued`. The spec holds fields
   `{key, value, provenance: user_verbatim|drafted}` and the target URL. Intake then enqueues a
   `browser-task` job and sends the Queued message.
2. The job opens a `browser_task` run and claims the single active slot through a unique partial
   index. It checks the daily cap, connects, and runs the agent (status `running`).
3. The agent prepares the form and calls `request_submit_approval`. In one transaction this writes:
   - an `approvals` row: `tool_name='browser.submit'`, `risk_tier='send'`, dedupe key
     `browser:approval:<taskId>`, and `expires_at` set to now plus
     `min(approval_ttl_minutes, BROWSER_APPROVAL_TIMEOUT_MINUTES)`;
   - an `approval_request` outbox row with the screenshot photo and buttons;
   - the task status `awaiting_approval`.

   It then calls `nudgeDispatch` and waits while holding the page.
4. Approve resolves the approval with
   `UPDATE … WHERE status='pending' AND expires_at > now() RETURNING`. The waiting job sees it.
5. Execution runs as a child run (`kind='approval_execution'`, `trigger='approval'`,
   `parent_run_id` = the task run):
   - Claim the approval with `withToolCall({ riskTier: 'send', approvalId, args: payload })`.
   - Check again that the URL, every field value, and the submit element's role, name, and enabled
     state match the payload.
   - Click once (status `executing`, then `submitted_at` is set).
   - Verify deterministically: the text appears outside the composer, or the URL matches the
     site's post-submit pattern.
   - Finish as `succeeded`, `unverified`, `outcome_unknown`, or `failed(precondition)`.
6. A result message is sent. Cancel, Stop, or expiry ends the task without a click.

Approval payload v1:

```json
{"version":1,"taskId":"…","site":"reddit","action":"reddit_comment","targetUrl":"…","pageUrl":"…",
 "fields":[{"key":"comment_text","label":"Comment","role":"textbox","name":"…","value":"<exact>",
            "provenance":"user_verbatim"}],
 "submit":{"role":"button","name":"Comment"},
 "screenshot":{"artifactId":"…","sha256":"…"},"preparedAt":"…"}
```

### Human handoff

- **Trigger.** `request_human`, or a detector hit, creates a `browser_handoffs` row (`waiting`, with
  `expires_at` set by `BROWSER_HANDOFF_TIMEOUT_MINUTES`). The task moves to `waiting_for_human`.
  A `system` outbox row is sent at-least-once with the screenshot, reason, link, and buttons.
- **Waiting.** The job polls the DB until one of these happens:
  - **Done:** resolved; the agent takes a new snapshot and the detectors run again.
  - **Stop:** the task is cancelled.
  - **Timeout:** the handoff is `timed_out` and the task fails.
  - **Shutdown:** the handoff is `interrupted`.
- **Limit.** At most three handoffs per task. If the page is still blocked after Done, a new handoff
  is requested.

### Intake

- **Increment 3, deterministic command.** `/comment <url>` with the text on the following lines.
  The URL must be on a Reddit origin. The text is stored verbatim.
- **Increment 5, free text and replies.**
  - One structured-output call (`agent_intake`) sees only your message.
  - It returns `kind` (one_off, schedule, unclear), plus `site`, `action`, `targetUrl`, field
    values with provenance, and an optional cron.
  - A `user_verbatim` value must be an exact substring of the message, or the bot asks for
    clarification.
- **Where intake runs.** Intake runs in an `agent-intake` job, not inside the Telegram handler.
  Grammy processes updates one at a time, so the handler only stores the message and enqueues the
  job. `HandleTelegramUpdateOptions` gains an injected `enqueue()`.
- **Replay (D023).** `drop_pending_updates: false` stays.
  - A request whose `message.date` is more than 10 minutes old gets a `browserTaskDraft` card with
    [Start] instead of starting on its own.
  - Unique `browser_tasks.request_message_id` makes intake idempotent.
  - Callbacks are checked against the stored outbox row, its status, and `expires_at`, so replayed
    Approve, Done, or Stop taps land on rows that are already resolved or expired and are
    acknowledged as stale.

Callback data (each at most 64 bytes):

- `bt:ap:<approvalId>`, `bt:no:<approvalId>`
- `bt:done:<handoffId>`, `bt:stop:<taskId>`, `bt:retry:<taskId>`, `bt:go:<taskId>`
- `bs:save`, `bs:cancel`, `bs:off:<scheduleId>`

### Queues and dispatch

| Queue | Policy | Retry | Expiry | Notes |
| --- | --- | --- | --- | --- |
| `agent-intake` | standard | 1 | 120 s | Parses requests; answers while a task holds the browser |
| `browser-task` | `singleton` | **0** | ~2 h | Never auto-retries side effects; local concurrency 1 |
| `browser-schedule-tick` | cron `* * * * *` | 1 | 60 s | Increment 7 |
| `artifact-retention` | daily cron | 1 | 300 s | Increment 7 |

- **Create-only queue fields.** `QueueDefinition` in `src/queue.ts` gains create-only fields such
  as `policy`, because `updateQueue` cannot change them.
- **Dispatch nudge.** `nudgeDispatch(boss)` sends a `notification-dispatch` job with
  `singletonKey: 'nudge'` and `singletonSeconds: 2`. It is called after each commit that creates an
  approval, handoff, or result row, so those cards go out within seconds instead of on the next
  minute tick. `claimNextDue` already uses SKIP LOCKED.

### Budget

- **Model wrapper.** `src/llm/budgeted-model.ts` wraps the AI SDK model with `wrapLanguageModel`
  middleware (`wrapGenerate`). For every provider attempt it:
  1. requires a bounded `maxOutputTokens` and rejects streaming;
  2. estimates the worst-case reservation with the mail rule (2 tokens per character for prompt and
     tool schemas, plus max output);
  3. checks the per-task cap (`AGENT_TASK_MAX_USD`);
  4. inside `withSerializedModelCall`, admits the call against both the global daily limit and
     `user_settings.agent_daily_limit_usd` (purposes prefixed `agent_`, on the `Asia/Kolkata` local
     day);
  5. runs the call inside `withLlmCall` with that reservation.
- **Failures and missing usage.** Missing usage records the reservation as the cost. SDK errors map
  through `classifyAiSdkError` to `LlmCallFailedError` or `LlmCallOutcomeUnknownError`.
- **Provider settings.** `providerOptions.openai = { store: false, reasoningEffort }`. The abort
  signal combines `AbortSignal.any([shutdown, taskCancel, AbortSignal.timeout(AGENT_STEP_TIMEOUT_MS)])`.
- **Purposes.** `agent_intake`, `agent_browser_step`, `agent_compose_text`.
- **When the budget runs out,** the task fails with `budget_exhausted` and a result message. It does
  not wait for the next day.

### State machines

```
task:      queued → running ⇄ waiting_for_human
           running → awaiting_approval → executing → succeeded | unverified | outcome_unknown | failed
           running → failed(already_applied, read-only report) | failed | cancelled
           awaiting_approval → cancelled | failed(approval_expired)
           any active → failed(interrupted) on shutdown or startup recovery
handoff:   waiting → resolved | cancelled | timed_out | interrupted
approval:  pending → approved | denied | expired (resolver system) | cancelled
```

`status_reason` is a text catalog: `interrupted`, `approval_expired`, `budget_exhausted`,
`daily_cap`, `precondition_failed`, `step_limit`, `login_required`, `handoff_timeout`,
`handoff_limit`, `cancelled_by_user`.

The approval-timeout path uses the same conditional update. If it loses the race, it re-reads the
row and executes anyway if the approval was approved.

### Recovery, drain, and replay

- **Startup recovery** (`src/agent/recovery.ts`) runs after `recoverStaleSending` and
  `recoverStaleInFlightLlmCalls`, and before `boss.work`. The worker lock guarantees no other
  worker is running.
  - `running`, `waiting_for_human`, and `awaiting_approval` tasks become `failed(interrupted)`.
    Their pending approvals become `expired` (resolver `system`) and waiting handoffs become
    `interrupted`.
  - For `executing` tasks:
    - a send tool call still `running` becomes `unknown`, and the task `outcome_unknown`;
    - a finished tool call passes its outcome to the task;
    - with no tool call, the task becomes `failed(interrupted)` and the approval stays consumed.
  - Each affected task gets one notice (`browser:task:<id>:recovered`) with [Retry], plus [Open
    browser] when the outcome is unknown. Browser tabs are left open.
- **Drain (D026, 30-second limit).**
  - `shutdownController.abort()` aborts the agent; an in-flight model step is recorded as unknown.
  - Approval and handoff waits stop. The job marks the task `failed(interrupted)`, expires the
    approval, and enqueues a notice, all as fast DB writes.
  - A submit click that has started is never aborted. Any click error other than an actionability
    timeout is recorded as `unknown`.

### Schema

Edit `src/db/schema/*.ts`, run `pnpm db:generate`, inspect, then `pnpm db:migrate`. Never
hand-edit an applied migration.

- **0008: enum values only (D002 staging).**
  - Adds `run_kind` value `browser_task` and `tool_call_status` value `unknown`.
  - Both are used only at runtime and never referenced by a later CHECK or index predicate.
- **0009: new enum types, new tables, and settings.**
  - **New enum types.** Values made by `CREATE TYPE` can be used in the same migration.
    - `browser_task_status`: queued, running, waiting_for_human, awaiting_approval, executing,
      succeeded, unverified, outcome_unknown, failed, cancelled
    - `browser_task_source`: telegram, schedule, retry
    - `browser_handoff_reason`: captcha, login, two_factor, verification, other
    - `browser_handoff_status`: waiting, resolved, cancelled, timed_out, interrupted
    - `artifact_kind`: screenshot (`inbound_media` is reserved for the Instagram phase)
  - **`browser_tasks` columns:**
    - `source`, `request_message_id` (→ `telegram_messages`, set null), `retry_of_task_id` (self,
      set null), `run_id` (→ `runs`, restrict)
    - `site` and `action` (text, validated by the registry), `target_url`, `instruction` (bounded)
    - `spec` jsonb (v1), `status`, `status_reason`, `approval_id` (→ `approvals`, restrict)
    - `cancel_requested_at`, `submitted_at`, `result` jsonb (bounded evidence URL and screenshot
      artifact id)
    - `cdp_target_id`, `boss_job_id`, `started_at`, `finished_at`, `created_at`, `updated_at`
  - **`browser_tasks` checks:**
    - `finished_at` is null exactly when the status is active (queued, running, waiting_for_human,
      awaiting_approval, executing);
    - `submitted_at` is not null when the status is succeeded, unverified, or outcome_unknown.
  - **`browser_tasks` indexes:**
    - unique `((true)) WHERE status IN (running, waiting_for_human, awaiting_approval, executing)`,
      so only one task is active;
    - unique `request_message_id` where not null;
    - partial `(status, created_at)` for queued and active rows (recovery);
    - `(created_at desc)` for `/tasks`;
    - partial `(site, action, submitted_at)` where submitted (daily caps);
    - partial `(approval_id)`.
  - **`browser_handoffs`:**
    - Columns: `task_id` (cascade), `run_id`, `reason`, `detail` (bounded), `page_url`,
      `screenshot_artifact_id` (set null), `notification_id` (→ outbox, set null), `status`,
      `requested_at`, `expires_at`, `resolved_at`, `resolver_ref` (`update:<id>`).
    - Checks: `resolved_at` is null exactly when the status is `waiting`; `expires_at` is after
      `requested_at`.
    - Indexes: unique `(task_id)` where waiting; `(task_id)`.
  - **`artifacts`:**
    - Columns: `kind`, `task_id` (set null), `sha256` (checked `^[0-9a-f]{64}$`), `mime`,
      `byte_size` (> 0), `storage_path` (relative to `ARTIFACT_DIR`), `created_at`, and
      `deleted_at` (retention tombstone).
    - Indexes: unique `(kind, sha256)`; partial `(created_at)` where not deleted; partial
      `(task_id)`.
  - **`user_settings.agent_daily_limit_usd`:** `numeric(10,2)`, nullable, default 0.50, check ≥ 0.
- **0010 (increment 6):** `user_settings.applicant_profile` (text, bounded by a length check).
- **0011 (increment 7):**
  - New table `browser_schedules`: `cron`, `timezone` (default `Asia/Kolkata`), `instruction`,
    `site`, `action`, `spec_template` jsonb, `enabled`, `next_run_at`, `last_run_at`,
    `created_from_message_id`, timestamps. Partial index `(next_run_at)` where enabled.
  - `browser_tasks` gains `schedule_id` (restrict deletion; disable schedules instead, D052) and `scheduled_for`. A check makes them both null
    or both set, and a unique index covers `(schedule_id, scheduled_for)` where not null.
- **No new `notification_kind`.** Approval cards use `approval_request`, which already requires
  `approval_id`. Handoff, result, and notice messages use `system`, and handoffs override to
  `at_least_once`.
  - Adding a kind would mean replacing the kind-context CHECK in a later migration, which runs in
    the same transaction as the enum addition on a fresh database (D002).
  - New tables link to outbox rows; the outbox never links to them.
- **Payload contracts.**
  - Outbox payload v1 gains an optional `photo: {artifactId, sha256}`, and buttons gain an https URL
    variant.
  - Increment 5 stores cached `browserIntake`/`browserIntakeRunId` and inert
    `browserScheduleDraft` in the inbound `telegram_messages.payload`; replay cards use
    `notification_outbox.payload.browserTaskDraft`. `browserTaskList` and `browserScheduleList` bind paginated operation cards to their stored ids/expiry (increment 7).
- **No credential columns.** Sessions live only in the browser profile volume.

### Module layout

| Path | Contents |
| --- | --- |
| `src/llm/` | `pricing.ts`, `serial.ts`, `budget.ts` moved from `src/mail/` (mail files re-export); `errors.ts` (`classifyAiSdkError`, from the private `modelCallError` in `src/mail/triage.ts`); `budgeted-model.ts`; `openai.ts` |
| `src/browser/` | `driver.ts` (`BrowserDriver` and `BrowserPage` interfaces, the test seam), `playwright-driver.ts`, `snapshot.ts`, `guards.ts`, `detectors.ts`, `sites.ts`, `artifacts.ts` (sha256 names, directory mode 0700) |
| `src/agent/` | `tasks.ts`, `approvals.ts`, `handoffs.ts` (conditional-update transitions and bounded waits), `browser-tools.ts`, `browser-agent.ts`, `executor.ts`, `intake.ts`, `intake-prompt.ts`, `notes.ts`, `schedules.ts`, `recovery.ts`, `caps.ts`, `render.ts` (bounded plain-text cards) |
| `src/jobs/` | `agent-intake.ts`, `browser-task.ts`, `browser-schedules.ts`, `artifact-retention.ts` |
| `src/telegram/` | `updates.ts` (free text and photos to intake, `bt:`/`bs:` callbacks, injected `enqueue`); new `browser.ts` (commands and callbacks, using the `TelegramResponder` and `storeOutboundMessage` pattern from `mail.ts`); `sender.ts` (`sendPhoto`); `buttons.ts` (URL buttons) |
| `src/notifications/dispatcher.ts` | Sends a photo with a caption when the payload has a valid artifact (sha256 matches), otherwise text; still one API call per row |
| `src/queue.ts`, `src/worker.ts` | New queues, `nudgeDispatch`, `ensureSchedules({ agentEnabled })`, recovery after the existing startup recoveries, and agent workers registered only when `config.agent` is set |
| `src/db/queries/audit.ts` | `getLlmBudgetUsageForRange(db, from, to, { purposePrefix })`, using the existing `llm_calls(created_at)` index |
| `src/tools/` | `browser-check.ts` (`pnpm browser:check [--snapshot <url>]`), `agent-profile.ts` (`pnpm agent:profile set --file`) |

Existing helpers to reuse:

- From `src/audit/`: `withRun`, `withLlmCall`, `withToolCall`, `recoverStaleInFlightLlmCalls`.
- From `src/notifications/outbox.ts`: `enqueueNotification` (accepts a transaction).
- From `src/telegram/buttons.ts`: `validateInlineButtons` and `toTelegramReplyMarkup`.
- From `src/errors.ts`: `errorMessage` and `errorDetails`.
- From `src/logger.ts`: `createLogger` and child loggers.
- From `src/mail/budget.ts`: `localDayRange` and `getMailBudgetSettings`, generalized.
- `cron-parser` (already installed through pg-boss) for schedule previews.

### Configuration

`src/env.ts` makes these optional; `src/config.ts` `requireWorkerConfig` enforces them under
`AGENT_ENABLED`, following the `MAIL_ENABLED` pattern. With the agent disabled, the heartbeat-only
and mail-only worker paths stay unchanged.

| Variable | Default | Notes |
| --- | --- | --- |
| `AGENT_ENABLED` | false | Builds `config.agent` |
| `AGENT_MODEL` | spike decision | Must have rates in `src/llm/pricing.ts` |
| `AGENT_REASONING_EFFORT` | medium | Uses the existing `reasoning_effort` enum values |
| `AGENT_MAX_STEPS` | 25 | Per agent run |
| `AGENT_MAX_OUTPUT_TOKENS` | bounded | Required for reservations |
| `AGENT_STEP_TIMEOUT_MS` | 90000 | Per model call |
| `AGENT_TASK_MAX_USD` | spike decision | Per-task cap |
| `BROWSER_CDP_URL` | `http://127.0.0.1:9222` | Loopback only |
| `BROWSER_VIEW_URL` | — | https `*.ts.net` URL; never contains credentials |
| `ARTIFACT_DIR` | — | Screenshots; directory mode 0700 |
| `BROWSER_HANDOFF_TIMEOUT_MINUTES` | 15 | |
| `BROWSER_APPROVAL_TIMEOUT_MINUTES` | 30 | Page-hold window |

`OPENAI_API_KEY` becomes required when the agent is enabled, even with mail off. Add any new
secret-like keys to `REDACT_KEYS` in `src/logger.ts`. Telegram `getFile` URLs contain the bot token
and must never be logged.

New dependencies, at exact pinned versions: `ai`, `@ai-sdk/openai`, `playwright-core`.

## TODOs

### Increment 0 — Proposal records and approval

- [x] Record your implementation approval for this phase (and which increments) before changing
      code. (2026-10-25: increment 0 only.)
- [x] Keep the uncommitted phase 03 closeout edits (AGENTS.md, docs, `src/worker-lock.ts`, and
      `tests/worker-lock.test.ts`) out of phase 05 commits; commit them separately first.
      (Committed as `236f632`.)
- [x] Update the phase 05 row and "Current phase" in `docs/PLAN.md`; add this document to the
      `AGENTS.md` doc list.
- [x] Record decisions in `docs/DECISIONS.md`:
  - [x] D041: self-hosted headful browser host, profile volume, loopback CDP, Tailscale view.
  - [x] D042: prepared-form approval, with a deterministic submit and no model after approval.
  - [x] D043: AI SDK v7 for the agent only; `playwright-core` plus our own tools (and why not
        browser-use, Skyvern, Playwright MCP, or Stagehand).
  - [x] D044: budgeted model middleware and the agent sub-limit.
  - [x] D045: no new outbox kinds; photo payload and URL buttons.
  - [x] D046: intake, verbatim pinning, and the replay gate (revisits D023).
  - [x] D047: human handoff with no captcha solving or evasion.
- [x] Update `docs/ARCHITECTURE.md`: status, responsibilities, and the "On-demand agent and
      approvals" flow.

### Increment 1 — Contracts, schema, configuration, and browser host

- [ ] Spike (partial; see evidence), and record the results in this document's evidence section:
  - [x] the Playwright aria-snapshot ref API in the installed version, and `aria-ref=` resolution;
        (1.64.1: `page.ariaSnapshot({ mode: 'ai' })` + `page.getByRef()`; see evidence)
  - [ ] `fill` and read-back in Reddit's shadow-DOM rich-text editor; if it is unreliable, try the
        Stagehand `act`/`observe` fallback behind `BrowserDriver`; (blocked: needs your Reddit
        login through the view; a logged-out profile hits a challenge page)
  - [x] whether `connectOverCDP` works through the container's socat with ws host rewrite;
        (works; no rewrite needed)
  - [ ] whether Telegram accepts the Tailscale `*.ts.net` URL as an inline URL button; (blocked:
        Tailscale is not installed on this computer)
  - [x] the AI SDK v7 `wrapLanguageModel` middleware shape, usage field names (input, cached,
        cache-write, output, reasoning), and the mock model export; (inspected in a scratch install)
  - [ ] which `AGENT_MODEL` can reliably drive the Reddit comment flow; add its rates and record
        the per-task cost; (blocked: needs the Reddit login and the increment 2 agent loop)
  - [ ] phone takeover usability with KasmVNC vs noVNC. (blocked: needs Tailscale and your phone;
        the linuxserver image now ships Selkies, not KasmVNC)
- [x] Add `docker-compose.browser.yml` and `docker/browser/`, plus `pnpm browser:up` and
      `pnpm browser:down`. Use a profile volume, loopback-only CDP, VNC auth, and no stealth flags.
- [x] Add `pnpm browser:check`: connect, open a page, take a bounded snapshot and a screenshot,
      disconnect.
- [x] Generate, inspect, and apply migrations 0008 (enum values) and 0009 (enum types, tables,
      `agent_daily_limit_usd`).
- [x] Add schema tests:
  - [x] the status and `finished_at`/`submitted_at` CHECKs;
  - [x] the one-active-task index and the request-message uniqueness;
  - [x] the handoff waiting uniqueness;
  - [x] the artifact sha256 check.
- [x] Add the agent env/config with issues collected into one `ConfigError`, and test that the
      agent-disabled worker paths are unchanged.
- [x] Move pricing, serial, and budget helpers to `src/llm/` with re-exports. Mail tests must pass
      unchanged.
- [x] Document tables, states, payload contracts, and the new query in `docs/DATABASE.md`.

### Increment 2 — Budgeted model, driver, and tool layer (library only)

- [x] Implement `src/llm/budgeted-model.ts` and `classifyAiSdkError`.
- [x] Test the budgeted model:
  - [x] the reservation exists before the request;
  - [x] a success finalizes with actual usage;
  - [x] a timeout or abort gives `unknown`;
  - [x] refusal at the daily, agent, and task caps;
  - [x] streaming is rejected;
  - [x] missing usage records the reservation;
  - [x] FIFO serialization with the mail classifier.
- [x] Implement the `BrowserDriver` interface and the Playwright driver (connect, new page, page
      targets, screenshots to artifacts).
- [x] Implement `snapshot.ts`: bounded output, refs with a generation number, stale refs rejected,
      and an untrusted wrapper.
- [x] Implement `guards.ts`, with tests: origin allowlist, commit-name lexicon, pre-commit
      openers, key allowlist, fill only spec keys, search-box-only free text.
- [x] Implement `detectors.ts`, with fixture tests for login redirects, each captcha-iframe family,
      and 2FA and challenge pages.
- [x] Add the `sites.ts` registry for Reddit (comment and post), validated at startup.
- [x] Implement `browser-tools.ts`, and test that every tool writes a `tool_calls` row with the
      correct tier and bounded args.
- [x] Add `tests/fakes/browser.ts` (`FakeBrowserDriver` with scripted page models) and a scripted
      AI SDK mock model.
- [x] Add optional real-Chromium tests against fixture HTML served by `node:http`, run only when
      `BROWSER_TEST_CDP_URL` is set.
- [x] Live check: `pnpm browser:check --snapshot <reddit thread>` prints a bounded snapshot.
      (It did; the logged-out profile got Reddit's network block page, see evidence.)

### Increment 3 — Reddit comment end to end

- [x] Add the `/comment <url>` command, a queued task, the Queued message, and [Stop].
- [x] Add the `agent-intake` and `browser-task` queues (create-only `policy`), `nudgeDispatch`, and
      worker registration under `config.agent`.
- [x] Implement the `browser-task` job: the `browser_task` run, the active-slot claim, the daily
      cap, connecting, the agent with draft tools, and disconnecting at the end.
- [x] Implement `request_submit_approval`: field read-back, commit-pattern check, screenshot
      artifact, and one transaction for approval, outbox row, and task status, then the bounded
      wait.
- [x] Add `sendPhoto` to the Telegram sender and the dispatcher photo path, with the outbox payload
      v1 `photo` contract and a text fallback.
- [x] Add `bt:` callbacks for Approve and Cancel, validated against the stored outbox row, status,
      and expiry, each acknowledged once. (Also [Stop] and [Retry], which the cards need.)
- [x] Implement the executor: child run, `withToolCall` send claim, pre-click checks, a single
      click, deterministic verification, the result message.
- [x] Implement recovery at startup and drain behavior; add the recovery notice with [Retry]
      (a new task; its approval links back through `retry_of_approval_id`).
- [x] Until increment 4, a detected login or captcha fails the task with "log in via the view,
      then Retry".
- [x] Tests:
  - [x] the full flow with fakes;
  - [x] a model clicking "Comment" is refused;
  - [x] the approval card text equals the payload;
  - [x] Approve that is stale, from the wrong message, expired, or tapped twice;
  - [x] a field changed before the click means no click and `failed(precondition)`;
  - [x] crashes in each window (before the claim, after the claim, after the click);
  - [x] shutdown during the approval wait;
  - [x] a second task queues behind the active one (pg-boss `singleton` policy, plus the
        one-active-task index);
  - [x] the daily cap.
- [ ] Live checks (blocked: need the Reddit login through the view and a priced `AGENT_MODEL`):
  - [ ] a comment on a thread you own or a test subreddit, approved from your phone and verified;
  - [ ] a worker restart during an approval wait gives `interrupted` plus Retry.

### Increment 4 — Human handoff

- [x] Implement `request_human` and automatic detector triggers, the handoff row, the task status
      `waiting_for_human`, and the handoff message (screenshot, reason, `BROWSER_VIEW_URL` as text
      and as a URL button, Done, Stop).
- [x] Implement the bounded wait with abort on shutdown and Stop. On Done, take a new snapshot and
      run the detectors again. Limit handoffs to three per task.
- [x] Tests:
  - [x] timeout;
  - [x] Done while still blocked asks again;
  - [x] the limit is reached;
  - [x] a replayed Done;
  - [x] Stop;
  - [x] shutdown during the wait;
  - [x] at-least-once handoff delivery.
- [ ] Live check (blocked: agent disabled; model and phone view URL are not configured): log out of Reddit, run a comment task, log in through the phone link, tap Done,
      and the task reaches approval and succeeds.

### Increment 5 — Free-text intake and Reddit post

- [x] Route free text and replies (the do-nothing branch in `src/telegram/updates.ts`) to the
      `agent-intake` job.
- [x] Implement the structured intake parse (`agent_intake` purpose). The prompt sees only your
      message. Results: one_off, schedule (stored as a draft until increment 7), or unclear.
- [x] Enforce exact-substring checks for `user_verbatim` values; otherwise ask for clarification.
      Label agent-drafted fields "(drafted)".
- [x] Add the stale-replay gate: messages older than 10 minutes get a `browserTaskDraft` card with
      [Start].
- [x] Add the Reddit post action (subreddit, title, body) with multi-field approvals.
- [x] Tests:
  - [x] a paraphrased "verbatim" value is rejected;
  - [x] an unclear request asks for clarification;
  - [x] replay handling;
  - [x] a multi-field read-back mismatch;
  - [x] intake idempotency on `request_message_id`.
- [ ] Live check (blocked on agent/model/view setup and user login): "post this on r/<test subreddit>" with a title and body, approved and verified.

### Increment 6 — Job applications (YC Work at a Startup and Wellfound)

- [x] Add migration 0010 (`applicant_profile`) and `pnpm agent:profile set --file` (bounded;
      never printed in full).
- [x] Implement `notes.ts`: one `agent_compose_text` call that sees the profile plus a bounded,
      untrusted job excerpt and writes a short note. The note is a drafted field.
- [x] Add registry entries for WaaS and Wellfound: origins, the "Apply" pre-commit openers, note
      field keys, the "Send" commit patterns, verification hints, and caps.
- [x] Tests:
  - [x] the note is labelled drafted;
  - [x] an injected job page cannot add claims that aren't in the profile, or change the target;
  - [x] commit-pattern guards per site;
  - [x] an already-applied job ends as a read-only report.
- [ ] Live check (pending profile/model/view setup and user logins): one real WaaS application and one Wellfound application, each approved from your
      phone and verified.

### Increment 7 — Schedules, operations, and closeout

- [x] Add migration 0011 (`browser_schedules`, `schedule_id`/`scheduled_for`).
- [x] Turn intake schedule results into a `browserScheduleDraft` card showing the next three run
      times (`cron-parser`, `Asia/Kolkata`) with [Save]/[Cancel]. The minimum interval is 1 hour.
- [x] Add the minutely `browser-schedule-tick`: idempotent inserts on
      `(schedule_id, scheduled_for)`; runs more than 30 minutes late are skipped with a notice.
      Scheduled tasks still need approval.
- [x] Add `/tasks`, `/stop`, and `/schedules` (list and disable).
- [x] Extend `/health/details` and the heartbeat: browser reachability, agent spend and
      reservations, and counts of tasks that are unknown, interrupted, or awaiting approval.
- [x] Add the artifact retention job (14 days): delete files, set the `deleted_at` tombstone.
- [x] Tests:
  - [x] Kolkata cron computation;
  - [x] a double tick;
  - [x] a disabled schedule;
  - [x] the missed-run policy;
  - [x] retention tombstones;
  - [x] health output stays secret-free.
- [ ] Live check (deferred by the user until credential setup): a schedule set two minutes ahead runs and is approved from your phone.
- [x] Run `pnpm test`, `pnpm lint`, `pnpm exec tsc --noEmit`, and `pnpm build`.
- [x] Review for unrelated edits; update PLAN.md, ARCHITECTURE.md, DATABASE.md, and AGENTS.md; and
      record commands, results, limits, and live evidence.

## Acceptance

- From Telegram, a Reddit comment, a Reddit post, a WaaS application, and a Wellfound application
  can each be requested, approved from your phone, submitted, and verified. Every submission
  equals the approved payload exactly.
- No submit happens without an approved, unexpired approval. No model call runs after approval. An
  approval executes at most once, and an uncertain submit is reported as `outcome_unknown`, never
  retried silently.
- A captcha, login, 2FA, or verification page always leads to a handoff with a working phone link.
  The app never solves or works around these challenges, and never stores or types passwords.
- Page content cannot cause clicks on commit-like controls before approval, cannot change approved
  text, and cannot take the browser outside the site's allowed origins.
- Every model call reserves budget before the request. Agent spend stays within its sub-limit and
  cannot starve mail triage. Unknown outcomes stay counted.
- Worker restarts and shutdowns never double-submit. Interrupted tasks are visible with Retry, and
  replayed Telegram updates and callbacks are harmless.
- Schedules fire once per slot in `Asia/Kolkata` time and still go through approval.
- Runs, tool calls, model calls, approvals, handoffs, notifications, and artifacts can be traced
  from `run_id` and task id. Logs contain no tokens, cookies, page bodies, or profile text.
- Automated checks pass and the live checks above are recorded. Missing credentials or logins may
  postpone the live checks, but that does not count as completion.

## Choices needing input

Decided 2026-10-25: self-hosted browser with a phone link; approval on every submit; Reddit, WaaS,
and Wellfound first; Playwright plus our own tools.

Still open; proposed defaults apply unless you change them:

| Choice | Proposed default |
| --- | --- |
| `AGENT_MODEL` and per-task cap | Decided in the increment 1 spike from measured reliability and cost |
| Agent daily sub-limit | $0.50 inside the existing $1.00 global limit; raise once real per-task costs are known |
| Daily caps | Reddit: 10 comments, 3 posts. WaaS: 10 applications. Wellfound: 10 applications |
| Approval page-hold window | 30 minutes (an expired approval offers Retry) |
| Handoff wait | 15 minutes, at most three handoffs per task |
| Screenshot retention | 14 days |
| Posted text limit | About 3,000 characters per field in v1 |

## Evidence and outcome

Status: in progress (increment 0 done; increments 1–7 implemented and automated checks complete.
Increment 1 live spike and increments 3–7 live checks remain open; the user requested credential
setup and real actions after increment 7 implementation).

### Increment 0 — proposal records and approval (2026-10-25)

- Approval recorded above: increment 0 only.
- Phase 03 closeout edits committed separately first as `236f632` ("Close phase 03 and scope
  worker readiness lock to current database").
- `docs/PLAN.md`: phase 05 row and "Current phase" updated. `AGENTS.md`: this document added to
  the doc list.
- `docs/DECISIONS.md`: D041 (browser host), D042 (prepared-form approval, model-free submit),
  D043 (AI SDK v7 + `playwright-core` with our own tools), D044 (budgeted middleware, agent
  sub-limit), D045 (no new outbox kinds; photo payload and URL buttons), D046 (intake, verbatim
  pinning, replay gate; revisits D023), D047 (human handoff, no solving or evasion).
- `docs/ARCHITECTURE.md`: status, planned browser host/agent responsibilities, planned phase 05
  queues, and the "On-demand agent and approvals" flow rewritten as the planned design.
- No code, schema, migration, dependency, or configuration changes. The open defaults in
  [Choices needing input](#choices-needing-input) still apply.

### Increment 1 — contracts, schema, configuration, and browser host (2026-10-25)

Implemented:

- **Schema.** Migration `0008_great_johnny_blaze` adds only `run_kind.browser_task` and
  `tool_call_status.unknown`. Migration `0009_jittery_aqueduct` adds the enum types
  `browser_task_status`, `browser_task_source`, `browser_handoff_reason`,
  `browser_handoff_status`, `artifact_kind`; tables `browser_tasks`, `browser_handoffs`,
  `artifacts` (`src/db/schema/browser.ts`); and `user_settings.agent_daily_limit_usd` (default
  0.50, check ≥ 0). Both were generated, inspected (predicates use only `CREATE TYPE` values), and
  applied to `app` and `app_test`; `pnpm db:generate` afterwards reports no changes. Beyond the
  proposal: length checks on instruction/URL/status reason/handoff detail, a no-self-retry check,
  and an `artifacts.storage_path` check rejecting absolute paths and `..` segments.
- **Contracts.** `src/agent/contracts.ts`: strict zod schemas for task spec v1, the
  `browser.submit` approval payload v1, and task result v1; the status-reason catalog; status
  groups matching the CHECKs; the `agent_*` purpose list.
- **Configuration.** `src/env.ts` adds the agent/browser variables (all optional, agent off by
  default). `src/config.ts` builds `config.agent` only under `AGENT_ENABLED=true`, collecting every
  issue into one `ConfigError` (OpenAI key, priced `AGENT_MODEL`, `AGENT_TASK_MAX_USD`, loopback
  `BROWSER_CDP_URL`, https `*.ts.net` `BROWSER_VIEW_URL` without credentials or secret-looking
  query/fragment, absolute `ARTIFACT_DIR`). `requireBrowserCheckConfig` needs only the CDP URL.
  `AGENT_MODEL` and `AGENT_TASK_MAX_USD` have no defaults until the model spike. No worker queue
  or handler is registered yet, so the heartbeat-only and mail-only paths are unchanged (tested).
  `cookie`, `cookies`, and `BROWSER_VIEW_PASSWORD` were added to logger redaction.
- **LLM helpers.** `src/llm/pricing.ts` (rates for every model, `estimateReservationUsd`),
  `src/llm/serial.ts` (moved with `git mv`), and `src/llm/budget.ts` (`localDayRange`,
  `getBudgetSettings` with the agent sub-limit). `src/mail/{pricing,serial,budget}.ts` re-export
  the old names; mail tests are unchanged and pass. `getLlmBudgetUsageForRange` gains
  `{ purposePrefix }` using `starts_with` (so `_` is literal).
- **Browser host.** `docker-compose.browser.yml` and `docker/browser/` build on
  `lscr.io/linuxserver/chromium:2dba585f-ls60` (pinned by digest). The image's launcher is
  replaced by a minimal one: dedicated profile `/config/agent-profile` on volume
  `agent_browser_profile`, `--remote-debugging-port=9223`, `--no-sandbox` (required in the
  container), and no `--test-type` or other automation/stealth flags. An s6 service runs socat
  (container 9222 → Chrome 9223); compose publishes CDP on `127.0.0.1:9222` and the web view on
  `127.0.0.1:3010` only, with required basic auth (`BROWSER_VIEW_USER`/`BROWSER_VIEW_PASSWORD`).
  `shm_size: 1gb`, `TZ=Asia/Kolkata`. Scripts: `pnpm browser:up`, `pnpm browser:down`.
- **`pnpm browser:check [--snapshot <url>] [--max-chars N]`** (`src/browser/check.ts`,
  `src/tools/browser-check.ts`): connects over CDP, reuses the persistent profile context, opens
  one page (a local page by default, no network), takes a bounded AI-mode aria snapshot, resolves
  a ref, takes a screenshot (stored content-addressed via `src/browser/artifacts.ts` when
  `ARTIFACT_DIR` is set), closes only its page, and disconnects. The snapshot text is printed only
  for an explicit `--snapshot` URL, delimited as untrusted.
- **Docs.** `docs/DATABASE.md` (enums, tables, payload contracts, states, index map, retention,
  migrations, the purpose-prefix query), `.env.example`, and `AGENTS.md`.

Spike results:

- **Aria snapshot API (playwright-core 1.64.1).** The ref form is `page.ariaSnapshot({ mode: 'ai' })`
  (refs like `[ref=e2]`, iframes included) with `page.getByRef('e2')` / `locator.getByRef`;
  refs resolve against the latest snapshot in that frame. The proposal's
  `locator.ariaSnapshot({ ref: true })` + `aria-ref=` form is not the public API in this version;
  increment 2's `snapshot.ts` should use `mode: 'ai'` + `getByRef` and still enforce our own
  snapshot generation numbers. Verified live: `browser:check` resolved a ref on the local page.
- **CDP through socat.** Works. Chrome builds `webSocketDebuggerUrl` from the request Host header
  (`ws://127.0.0.1:9222/...`), so no ws host rewrite is needed. `browser.close()` on the CDP
  connection only disconnects: the browser and its existing tab stayed up, and the check page was
  closed.
- **View.** The current linuxserver Chromium image is Selkies-based (WebRTC/websocket streaming
  behind nginx), not KasmVNC or noVNC. The web view on `127.0.0.1:3010` returns 401 without basic
  auth. Phone usability over Tailscale is still to be checked by you.
- **Reddit, logged out.** `browser:check --snapshot https://www.reddit.com/r/redditdev/` from the
  fresh profile returned Reddit's "Prove your humanity" challenge page instead of the subreddit.
  Nothing was attempted against it. The increment 2 detectors must recognise this page (a
  `verification`/`captcha` handoff), and the first live step is for you to log in through the
  view. The Reddit editor fill/read-back spike waits on that login.
- **AI SDK v7** (inspected in a scratch install of `ai@7.0.137` and `@ai-sdk/openai@4.0.91`,
  both released over two weeks earlier; not added to the project until increment 2):
  `wrapLanguageModel({ model, middleware })` with a `LanguageModelMiddleware`
  (`specificationVersion: 'v4'`) whose `wrapGenerate({ doGenerate, doStream, params, model })`
  sees `params.maxOutputTokens`. Usage is `inputTokens.{total, noCache, cacheRead, cacheWrite}`
  and `outputTokens.{total, text, reasoning}` (each possibly undefined). Mocks: `MockLanguageModelV4`
  from `ai/test`. Stop conditions `isStepCount` (alias `stepCountIs`) and `hasToolCall` exist;
  `ToolLoopAgent` takes `instructions`, `stopWhen`, `prepareStep`, `maxRetries`, and an optional
  `toolApproval` (not used, D042). `@ai-sdk/openai` provider options include `store` and
  `reasoningEffort`.
- **Still open (need you):** Telegram acceptance of a `*.ts.net` URL button (Tailscale is not
  installed here), Reddit editor fill/read-back (needs your login), `AGENT_MODEL` reliability and
  per-task cost (needs the login and the increment 2 loop), and phone takeover usability.

Design note: the `browser_tasks` submitted CHECK (from the proposal) requires `submitted_at` for
`succeeded`, which conflicts with the "running → succeeded (read-only report)" transition. All v1
site actions submit, so this does not block increments 2–6; a read-only action needs a decision
(for example a dedicated status or relaxing the check in a new migration) before it ships.

Automated checks (2026-10-25):

- Baseline before changes: `pnpm test` → 48 files, 354 tests passed.
- After: `pnpm test` → 51 files, 387 tests passed (new: `tests/db/browser.test.ts`,
  `tests/db/llm-budget.test.ts`, `tests/browser-foundations.test.ts`, and agent cases in
  `tests/config.test.ts`); `pnpm exec tsc --noEmit`, `pnpm lint`, and `pnpm build` clean;
  `pnpm db:generate` → no schema changes.
- Live: `pnpm browser:up` (built and healthy), `pnpm browser:check` → Chromium 155.0.8059.79,
  profile context reused, ref resolution ok; with `ARTIFACT_DIR` set the screenshot was stored
  with directory mode 0700 and file mode 0600.

### Increment 2 — budgeted model, driver, and tool layer (2026-10-25)

Library only: nothing is registered in the worker, Telegram, or the approval path yet.

Implemented:

- **Dependencies** (exact): `ai@7.0.137`, `@ai-sdk/openai@4.0.91`, `@ai-sdk/provider@4.0.26`
  (the version `ai` itself depends on, imported for types and `APICallError`). All were released
  more than two weeks before this increment.
- **`src/llm/budgeted-model.ts`.** `budgetMiddleware` / `createBudgetedModel` wrap any
  `LanguageModelV4` with `wrapLanguageModel`. Each `wrapGenerate` attempt:
  1. requires `maxOutputTokens` ≤ `AGENT_MAX_OUTPUT_TOKENS`, rejects streaming (`wrapStream`) and
     non-text prompt parts;
  2. reserves 2 tokens per prompt/tool-schema character + 1,024 overhead + max output at the
     uncached rate;
  3. inside `withSerializedModelCall` (FIFO with the mail classifier) checks the per-task cap
     (`getLlmBudgetUsageForRun`, new), the global daily limit, and the `agent_*` sub-limit;
  4. runs inside `withLlmCall`. Usage maps from `inputTokens.{total, cacheRead, cacheWrite}` /
     `outputTokens.{total, reasoning}`. Missing usage records the reservation as the cost, and the
     request id comes from `response.id`.

  Refusals throw `ModelBudgetRefusedError` (`isBudgetExhausted` covers `task_cap`, `daily_limit`,
  `agent_limit`) before any row or request. Purposes must start with `agent_`.
- **`src/llm/errors.ts` `classifyAiSdkError`.** Abort/timeout, 408, 5xx, and unknown failures become
  `LlmCallOutcomeUnknownError`. Definitive 4xx (including 429) and provable pre-send network
  failures become `LlmCallFailedError`, keeping `x-request-id`. This uses the same policy as the
  mail classifier's private `modelCallError`; `src/mail/triage.ts` was left unchanged.
- **`src/llm/openai.ts`.** `createAgentProviderModel` (Responses API), `agentProviderOptions`
  (`store: false`, `reasoningEffort`), and `agentStepSignal` (shutdown, task cancel, and step
  timeout via `AbortSignal.any`).
- **`src/browser/driver.ts` + `playwright-driver.ts`.** The `BrowserDriver`/`BrowserSession`/
  `BrowserPage` seam and the CDP driver: one new page in the profile context, `mode: 'ai'`
  snapshots, `getByRef` actions, driver-internal read-back (input value or contenteditable
  `innerText`), the CDP target id, PNG screenshots, and disconnect without closing the browser.
- **`src/browser/snapshot.ts`.** Snapshot parsing (role, name, flags, `/url`), a
  `SnapshotTracker` that rewrites refs as `<generation>:<ref>` and rejects refs from older or
  invalidated snapshots, bounding on line boundaries, and `wrapUntrusted`, which neutralises fake
  closing tags.
- **`src/browser/guards.ts`.** Exact https origin allowlist. Commit lexicon: the proposal's words
  plus `unfollow`, `upvote`, `downvote`, `log out`, `sign out`, `join`, `leave`, `subscribe`,
  `unsubscribe`, `award`, matched as whole words so "Comments (12)" is allowed. The action's
  commit control is always refused, except for registry pre-commit openers. Off-site links are
  refused. `fill_field` accepts only spec keys the action defines, into the allowed roles.
  Free text is allowed only in bounded single-line search/combo boxes. The key allowlist permits
  Enter only on a search/combo box ref and refuses all chords. Waits are bounded.
- **`src/browser/detectors.ts`.** Covers:
  - reCAPTCHA, hCaptcha, Turnstile, and Arkose frames;
  - bot-check text, including both Reddit pages seen live;
  - `js_challenge` and Cloudflare challenge query params;
  - 2FA text;
  - login paths on the site origin and login walls.

  Headings and dialogs always count. Body text nodes count only on small pages (≤ 40 lines), so a
  comment that mentions these phrases does not hand off.
- **`src/browser/sites.ts`.** Reddit `reddit_comment` and `reddit_post` (origins, target URL
  patterns, fields, commit controls, openers, daily caps 10/3). `validateSiteRegistry` runs inside
  `requireWorkerConfig` when `AGENT_ENABLED=true`.
- **`src/browser/artifacts.ts` `recordScreenshot`.** Content-addressed file plus an `artifacts`
  row (deduplicated by hash, and revived if tombstoned).
- **`src/agent/browser-tools.ts`.** `BrowserToolbox` with every tool from the design table, each
  a `tool_calls` row under the task run with its tier. Args are bounded and id-like (refs, field
  keys, a bounded URL or search query, never field values). Results are audit-only (snapshot
  generation and truncation, outcomes), never page text. Further behaviour:
  - Navigation, clicks, and keys invalidate refs, undo any off-site navigation, re-snapshot, and
    run the detectors. A hit calls the `requestHuman` hook and re-checks after Done.
  - `request_submit_approval` re-checks the origin, the commit control and its enabled state,
    exact read-back of every spec field, and the detectors. It then screenshots, builds the strict
    v1 payload, and calls the `requestSubmitApproval` hook once; it never clicks.
  - `createBrowserAgentTools` exposes the toolbox as AI SDK tools with bounded zod inputs and
    text results (refusals read `refused: …`). The approval/handoff hooks are where increments 3
    and 4 attach DB rows and Telegram cards.
- **Audit fix.** `withToolCall` (first runtime consumer) gains `auditResult`. `finished_at` now
  uses `greatest(clock_timestamp(), started_at)`: with the app clock, fast calls tripped
  `tool_calls_finished_after_started_check` through app/DB clock skew.
- **Test fakes.** `tests/fakes/browser.ts` (`FakeBrowserDriver`/`FakeBrowserPage` with scripted
  page models: thread, composer, challenge) and `tests/fakes/model.ts` (a scripted
  `MockLanguageModelV4`, usage and tool-call results).

Live evidence (2026-10-25):

- Real Chromium (`tests/browser-playwright.test.ts` with `BROWSER_TEST_CDP_URL`, fixture HTML via
  `node:http` reached as `host.docker.internal`; compose gained `extra_hosts` for this): AI-mode
  refs parsed, textarea and contenteditable fill + exact read-back (including quotes, emoji, and
  a newline), disabled state, click, Tab, scroll, PNG screenshot, iframe URLs, and CDP target id
  all work. After disconnect the browser kept its original three targets.
- `pnpm browser:check --snapshot https://www.reddit.com/r/redditdev/comments/1oug31u/…` printed
  a bounded snapshot. From the logged-out profile Reddit redirected with `js_challenge=1` and
  showed "You've been blocked by network security". Nothing was attempted against it; the
  detectors now recognise both this page and the earlier "Prove your humanity" page. Logging in
  through the view (still pending) is the next live step.

Automated checks (2026-10-25):

- `pnpm test` → 55 files, 424 passed, 1 skipped (the real-Chromium file without
  `BROWSER_TEST_CDP_URL`); with it set → 425 passed. New: `tests/db/budgeted-model.test.ts`
  (reservation before request, actual usage, missing usage, abort/timeout unknown, 4xx/5xx,
  task/daily/agent refusals, mail spend excluded from the sub-limit, maxOutputTokens bounds,
  streaming, non-text, FIFO behind a mail call), `tests/browser-layer.test.ts` (snapshot,
  guards, detector fixtures, registry), `tests/db/browser-tools.test.ts` (one row per tool
  with tier and bounded args, no page text or values stored, refusals, off-site undo,
  exact-payload approval, read-back mismatch, detector handoff, and a scripted AI SDK loop
  through the budgeted model that a page-injected "click Comment" cannot turn into a submit).
- `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm build` clean; `pnpm db:generate` → no changes.

### Increment 3 — Reddit comment end to end (2026-10-25)

Implemented (D042–D048; schema unchanged — no migration was needed):

- **Queues and dispatch.** `src/queue.ts` gains the `agent-intake` queue (retry 1, 120 s) and the
  `browser-task` queue (`policy: 'singleton'`, retry 0, 2 h), a create-only `policy` field
  (`updateQueue` cannot change it), `ensureQueues(..., { agentEnabled })` so the heartbeat/mail-only
  worker creates none of the agent queues, and `nudgeDispatch` (`singletonKey: 'nudge'`,
  `singletonSeconds: 2`). `src/worker.ts` registers both workers only under `config.agent`, passes
  the dispatch nudge and `boss.send` into the bot, gives the dispatcher an artifact loader, and runs
  `recoverBrowserTasks` after the existing startup recoveries.
- **Intake.** `src/agent/intake.ts` parses `/comment <url>` plus the following lines
  deterministically (the URL is normalized to the canonical `www.reddit.com` origin), pins the text
  verbatim in the task spec, and (re)uses `browser_tasks.request_message_id` for idempotency.
  `src/jobs/agent-intake.ts` runs under an `agent_chat` run, inserts the queued task, enqueues the
  `browser-task` job, and queues the Queued card. `src/telegram/updates.ts` stores the inbound
  message, injects `enqueue`/`nudgeDispatch`, and routes `/comment` and `bt:` data.
- **Task and approval lifecycle.** `src/agent/tasks.ts`: idempotent creation, transactionally
  guarded active-slot claim (the partial unique index is the hard guard, `boss_job_id` recorded),
  conditional `finishBrowserTask`, Stop handling (queued/awaiting end immediately; a running agent
  is asked to stop; a started submit is never aborted), and retry as a new task linked by
  `retry_of_task_id`. `src/agent/approvals.ts`: one transaction writes the `browser.submit`
  approval (`risk_tier='send'`, dedupe key `browser:approval:<taskId>`, payload v1, expiry), the
  task's `awaiting_approval` status, and the `approval_request` outbox card; Approve/Deny/Expire/
  Cancel are conditional updates, and `waitForApproval` is the bounded page hold. A retry approval
  links to the original through `retry_of_approval_id`.
- **Agent loop and job.** `src/agent/browser-agent.ts` uses `ToolLoopAgent` with instructions that
  never include field values, `maxRetries: 0`, `stopWhen` on step count/approval/report,
  `prepareStep` that replaces every older snapshot result and withholds `request_submit_approval`
  until every spec field is filled, and the SDK's per-step `timeout: { stepMs }` (the abort signal
  carries shutdown and task cancellation). `src/jobs/browser-task.ts`: claim, per-site daily cap,
  CDP connect, agent, approval wait, execution, disconnect, result card, and the drain path. A
  detected login/captcha/2FA/verification page fails the task with `login_required` and a "log in
  through the view, then Retry" card until increment 4.
- **Executor.** `src/agent/executor.ts`: `approval_execution` child run, `withToolCall` send claim
  (unique `tool_calls.approval_id`), URL/origin/field/commit-control/detector re-checks from the
  immutable payload, `awaiting_approval → executing`, one click, `submitted_at`, deterministic
  verification (post-submit URL, or the values outside a cleared composer; otherwise
  `unverified`), and evidence screenshot. An actionability timeout is `failed(precondition)`; any
  other click error is `outcome_unknown` via the new `ToolCallOutcomeUnknownError`.
- **Cards and Telegram.** `src/agent/render.ts` (bounded queued/approval/result/recovery cards;
  approval values are exact, `drafted` is labelled), `src/telegram/browser.ts` (`/comment`, the
  `bt:ap|no|stop|retry` callbacks validated against the stored outbox row, `sent` status, and
  expiry), `src/telegram/sender.ts` `sendPhoto` with a 1024-character caption guard, URL buttons
  in `src/telegram/buttons.ts`, and the dispatcher photo path with a sha256-checked artifact load
  and a text fallback.
- **Recovery.** `src/agent/recovery.ts` fails `running`/`waiting_for_human`/`awaiting_approval`
  tasks as `interrupted`, expires their pending approvals, interrupts waiting handoffs, and sends
  one `browser:task:<id>:recovered` notice with [Retry] (plus [Open browser] for an unknown
  outcome). `executing` tasks follow the send tool call: `running` → tool call `unknown` and task
  `outcome_unknown`; `succeeded` → task `unverified`; `unknown` → `outcome_unknown`; `failed` or no
  call → `failed(interrupted)`. Notices never duplicate across restarts.

Choices recorded in D048: the SDK per-step timeout instead of a fixed abort deadline, the
recovery outcome mapping above, the approval hold using `BROWSER_APPROVAL_TIMEOUT_MINUTES`
(there is no separate approval TTL setting in v1), and result-card buttons
([Retry] for recoverable failures, [Open browser] for unknown/unverified/login-blocked).

Automated checks (2026-10-25):

- Baseline before increment 3 changes: `pnpm test` → 55 files, 424 passed, 1 skipped.
- After: `pnpm test` → 60 files, 483 passed, 1 skipped (the real-Chromium file without
  `BROWSER_TEST_CDP_URL`). New: `tests/agent-cards.test.ts` (command parsing, card text equals
  the payload values, callback parsing, URL buttons, snapshot trimming), `tests/browser-telegram.test.ts`
  (`/comment` intake enqueue and usage replies; Approve/Deny stale, wrong-message, expired,
  double-tap, wrong-approval and undelivered cases; Stop and Retry including already-retried and
  no-agent paths), `tests/db/browser-job.test.ts` (intake idempotency, full flow through a real
  Telegram Approve callback, one click, budgeted model calls, send tool-call claim, result card and
  photo delivery, refused commit click, tampered field, daily cap, busy slot, shutdown during the
  approval wait), `tests/db/browser-recovery.test.ts` (each crash window, handoff interruption,
  idempotent recovery), and `tests/db/browser-approvals.test.ts` (approval transaction, retry link,
  wait decisions, expiry, cancel semantics). `tests/telegram-sender.test.ts`,
  `tests/dispatcher.test.ts`, and `tests/queue.test.ts` gained photo, caption-limit, fallback,
  agent-queue policy, and nudge-throttle cases.
- `pnpm exec tsc --noEmit`, `pnpm lint`, and `pnpm build` clean; `pnpm db:generate` → no schema
  changes.

Live checks (not run; blocked): the user's Reddit login through the phone view and a priced
`AGENT_MODEL` are still missing, so no real comment has been posted and the worker-restart check
during a real approval wait is also pending. Increment 3 is therefore not closed.

### Increment 4 — human handoff (2026-10-25)

Status: implementation and automated verification complete; live check blocked, so the
increment remains open. Approved by the user's "Implement the increment 4" request.

- `src/agent/handoffs.ts` creates the handoff, task pause, and linked at-least-once system
  outbox card in one transaction. The card includes the screenshot, reason, page URL,
  `BROWSER_VIEW_URL` in text and as a button, Done, and Stop. No schema or dependency changes.
- `bt:done:<handoff id>` is checked against the delivered card, waiting status, and expiry;
  replayed, wrong-message, wrong-id, expired, or undelivered callbacks do nothing. Stop from
  the current handoff card cancels both task and handoff; an old card cannot stop a later handoff.
- The job holds its browser session during a bounded, shutdown-aware wait. Done resumes the
  task and re-snapshots through the detectors. A still-blocked page asks again; a fourth
  request ends with `handoff_limit`. Timeout records `handoff_timeout`; shutdown interrupts
  the handoff and leaves a pending result notice. Terminal handoffs stop further model calls.
- `request_human` and automatic detections share the same flow, including detection just
  before approval. Refs and filled-field tracking are invalidated after human intervention.
  Browser tools serialize so a parallel tool batch cannot act while the user has control.
- D049 revises D048's timeout choice: the installed SDK's step deadline covers tools too.
  A wrapper now gives each model request its own `AGENT_STEP_TIMEOUT_MS` deadline, leaving
  human and approval waits governed by their separate configured deadlines.

Automated checks (2026-10-25):

- `tests/db/browser-handoffs.test.ts`: pause/card transaction, screenshot delivery, recovery
  and redelivery under the at-least-once policy, stale/expired/replayed Done, timeout,
  long-wait resume through approval and one verified click, still-blocked Done and the
  three-handoff limit, explicit `request_human`, old-card Stop, Stop, shutdown, and timeout notices.
- `tests/db/browser-tools.test.ts`: fresh refs after human intervention, detector triggering
  before editor reads at approval, and serialized tool batches across terminal handoffs.
- `pnpm test` → 60 files passed, 1 file skipped; 494 tests passed, 1 skipped. The skipped
  test is the optional real-Chromium check without `BROWSER_TEST_CDP_URL`.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build`, and `git diff --check` passed.
  Database tests ran against the isolated local `app_test` database; the initial sandboxed
  attempt could not connect to loopback, and the approved test run succeeded.

Live check (not run; blocked): a secret-free environment check found `AGENT_ENABLED` is not
true and both `AGENT_MODEL` and `BROWSER_VIEW_URL` are unset. Configure the priced model and
private phone view, then run a comment task while logged out, fix login through the phone
view, tap Done, and approve the comment on an owned/test thread. The user must perform the
login and approve the exact submit. No real comment was posted by this implementation run.

### Increment 5 — free-text intake and Reddit posts (2026-10-25)

Status: implementation and automated verification complete; live post check blocked, so the
increment remains open. Approved by "Okay now implement the increment 5 now".

- Free text and replies enqueue `agent-intake`; the Telegram handler keeps deterministic
  commands and chat/update dedupe. Reply ids are retained, but the structured `agent_intake`
  call sees only the bounded current message plus static parsing instructions. It uses the
  budgeted model, no tools, no provider storage, no SDK retries, and a request deadline.
- Intake validates the supported action, an explicit Reddit target, all required field keys,
  exact-substring `user_verbatim` values, and title/card bounds. Drafted values retain provenance.
  An unclear/invalid/failed parse produces a bounded notice with no task. Successful and
  non-actionable decisions are cached under the inbound message row lock; concurrent attempts
  and retries do not reparse or create another task. The intake run is linked for budget
  admission, so parsing and browser preparation share the per-task cap (D050).
- Schedule results are saved as `browserScheduleDraft` metadata with no active schedule,
  browser task, or Save action. Active scheduling remains increment 7.
- Old requests (>10 minutes by Telegram send time), including `/comment`, and requests missing
  a send timestamp create a gated queued task and a 30-minute Start/Stop draft card. Start
  validates the delivered card, task id, status and expiry, enqueues under the task lock, and
  clears `confirmation_required`. Queue failure keeps the gate intact. Consumers lock before
  checking the gate, so a fast consumer cannot discard a job before Start commits. Replayed,
  wrong-message, wrong-task and expired callbacks cannot start a task.
- Reddit text posts pin the subreddit in `/r/<sub>/submit` and require title/body. Guards check
  the named, distinct fields, exact read-back, and composer community; approval shows the
  subreddit and every exact value with drafted labels. Changed fields prevent clicking. The
  executor still runs without the model, clicks Post once, and requires the expected community
  when verifying a result URL. Approval text is refused if it would be clipped.
- No schema, migration, configuration, or dependency changes. Decision D050 records the storage,
  replay and text-bound choices.

Automated verification (2026-10-25):

- New `tests/agent-intake.test.ts`, `tests/db/agent-intake.test.ts`, and
  `tests/db/reddit-post.test.ts` cover provenance, supported/explicit targets, unclear replies,
  inert schedule drafts, prompt isolation, pre-request budget reservation, input/output bounds,
  intake retry/concurrency idempotency, agent-budget refusal, stale/missing timestamps, Start/Stop/expiry/replay/queue
  failure and fast-consumer races, full post approval/submit, changed-field read-back, wrong
  communities, exact approval values, and refused model Post clicks.
- The budgeted-model tests cover counting the intake run's unknown reservation against the
  browser task cap and excluding echoed provider request text from audit errors. A direct
  synthetic-error reproduction failed before the error redaction change and passed afterward.
  Existing browser, Telegram and mail regressions remain included.
- `pnpm test` → 63 files passed, 1 file skipped; 533 tests passed, 1 skipped. The skip
  is the optional real-Chromium test without `BROWSER_TEST_CDP_URL`. Database tests used
  the isolated local `app_test` database.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build`, and `git diff --check` passed.
- Final audit/intake subset: 28 passed. The synthetic private-error-text reproduction also
  passes with the sanitized AI SDK error classifications.

Live post check (not run; blocked): `AGENT_ENABLED` is false and `AGENT_MODEL` and
`BROWSER_VIEW_URL` are unset. Configure the priced model and private phone view, log in to
Reddit through the view, then request a title/body post to an owned/test subreddit and approve
it from Telegram. No real post was submitted during this implementation run. Increments 6–7
were unapproved and unimplemented at this checkpoint; increment 6 was subsequently approved and implemented below.

### Increment 6 — YC Work at a Startup and Wellfound applications (2026-10-25)

Status: implementation and automated verification complete; real application checks remain
pending, so this increment stays open. Approved by "Implement the increment 6". Decision D051.

- Generated migration `0010_bumpy_dagger.sql` adds nullable `applicant_profile` to singleton
  settings with a nonblank/8000-character check. It was inspected and applied to local `app`;
  test setup also migrates `app_test`. No other settings change when the profile is saved.
- `pnpm agent:profile set --file <UTF-8 file>` bounds the file before decoding, validates complete
  first-person facts (one per line, at most 1000 characters per line), and prints only a saved
  character count. No real profile is created or printed by this implementation run.
- Free-text intake accepts explicit `www.workatastartup.com/jobs/<id>` and
  `wellfound.com/jobs/<id>-<slug>` targets. Supplied exact notes remain verbatim; generated
  application text from intake is discarded in favor of the profile-backed composer.
- A pending application spec has `composeNote: true` and no fields. On the first unblocked
  observation of that exact job, `notes.ts` makes one budgeted `agent_compose_text` call with
  profile facts and at most 6000 characters of untrusted job excerpt. The model selects up to
  three whole facts; a fixed introduction/closing makes the note (maximum 1500 characters).
  Unsupported indexes, extra claims/targets, duplicate facts, and oversize notes fail closed.
  Whole-line selection preserves negations; note text is labelled drafted. The prepared spec
  is persisted before any fill; profile text is never given to the browser agent or tool audit.
- Compose calls share the browser run's task cap and count the earlier intake run. SDK retries
  are disabled; failures terminate note preparation without another compose attempt. Errors
  and tool audits omit profile/job text. A missing profile produces a setup/retry notice.
- Each adapter allows only its exact origin, known Apply openers before an editor is visible,
  one application-note field, Send commit patterns, and ten submits per Kolkata day. Target job
  identity is checked before approval and again by the model-free executor. Send is refused
  to the model. Exact field read-back, immutable approval, and one-click claims are reused.
- Exact named applied controls/statuses end as `failed(already_applied)` with a fixed read-only
  report, no form changes, compose call, approval, or Retry button. This uses the existing task
  state vocabulary without adding a submitted timestamp. Execution rechecks applied state.
  Verification requires the same job, a cleared/absent editor and an exact success status;
  description prose or a status on another job is insufficient and yields `unverified`.
- Wellfound's documented Apply → note pop-up → Send Application flow was checked against its
  [official help](https://help.wellfound.com/article/707-how-to-start-applying-to-jobs).
  Registry selectors/status hints remain conservative until logged-in live checks confirm them.
  Additional form steps, uploads, or unrecognized controls stop safely rather than expanding scope.

Verification:

- Focused new application/profile tests plus intake, Reddit post and browser-tool regressions:
  5 files, 61 tests passed.
- `pnpm test` → 65 files passed, 1 skipped; 562 tests passed, 1 skipped. The skip is
  the optional real-Chromium test without `BROWSER_TEST_CDP_URL`. Database tests used `app_test`.
  The first full run exposed a registry-order assumption; restoring Reddit as the first entry
  fixed it, and the complete rerun passed.
- The real profile CLI was exercised against `app_test`, asserting that it prints only a saved
  count. Composition tests also verify excerpt bounds and inclusion of earlier intake reservations
  in the task cap.
- Final browser/approval subset after reusing one approval snapshot for status detection:
  4 files, 42 tests passed.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build`, and `git diff --check` passed.

Live check (not run): inspected local configuration shows `AGENT_ENABLED=false`, with
`AGENT_MODEL` and `BROWSER_VIEW_URL` unset. Configure the priced agent model and private view, save your
profile locally, log in to each site through the view, then request one specific job per site
and approve each complete note from Telegram. No real application was submitted in this run.
At this checkpoint increment 7 was unapproved and unimplemented; its later implementation is recorded below.

### Increment 7 — Schedules, operations, and closeout (2026-10-25)

Status: implementation and automated verification complete. The user explicitly requested
credential setup and real-site checks after this increment, so those checks remain deferred;
phase 05 is still in progress. Approved by "for now implement the increment 7". Decision D052.

- Generated, inspected and applied `0011_red_gamora.sql` to local `app`; test global setup
  migrates `app_test`. It adds schedules and paired schedule-id/slot-time task columns, with
  unique activation/slot keys and a due-scan index. Schedule deletion restricts existing task
  references so the paired-column check stays valid; disabling preserves the history.
- Promoted installed `cron-parser` 5.10.2 to a pinned direct dependency. Schedule previews
  compute three upcoming times in Asia/Kolkata. One resolved minute per hour guarantees the
  minimum one-hour interval, including across month/day gaps. Invalid or faster requests ask
  for clarification instead of creating a schedule.
- Intake sends a 30-minute Save/Cancel card. It is inert until Save; callbacks validate the
  delivered card, source message and expiry, then lock the inbound message. Source uniqueness
  and a persisted resolution prevent double activation and save-after-cancel/replay. Save
  computes a new future cursor from the time of the tap, rather than replaying the preview.
- `browser-schedule-tick` runs every minute only when the agent is enabled. Under schedule row
  locks, a task insert, pg-boss enqueue through public `fromDrizzle`, Queued card, and cursor
  advance commit together. Concurrent/double ticks create one task/job per slot. Queue failures
  roll everything back; transaction errors are fixed text so SQL parameters cannot leak into logs.
- Downtime backlog is skipped with one deduplicated notice per missed range. If the latest due
  occurrence is within 30 minutes, only that occurrence is issued; otherwise all overdue slots
  are skipped and the cursor moves forward. A scheduled task delayed in the queue is checked
  again before opening the browser, ending `failed(schedule_missed)` after the same grace window.
  Each issued task uses the existing exact-text approval and model-free single-click executor.
  Startup re-enqueues ungated queued tasks; duplicate queue jobs still cannot reclaim a task.
- `/tasks` and `/schedules` show five records per page, with callback ids bound to an unexpired
  stored outbound card. Task lists offer Stop; schedule lists offer Disable. `/stop` cancels the
  active queued preparation/approval/handoff path through the existing transition helper; an
  already executing submit is allowed to finish. Disabling affects future slots; existing tasks
  remain visible and separately cancellable. Pagination, Stop and Disable reject stale/mismatched cards.
- `/health/details` and heartbeat add counts-only browser reachability, task-state/problem counts,
  actual/reserved agent spend, in-flight/unknown model counts and global/sub-limit totals. Disabled
  agents cause no browser probe; active probes are loopback-only, bounded to two seconds, and
  return no URL, response body or raw errors. Public health stays minimal. Last heartbeat time
  now filters `system` runs by job name so schedule/retention runs do not masquerade as heartbeats.
- `artifact-retention` runs daily at 03:00 Kolkata when enabled. Files older than 14 days are
  deleted before tombstoning; missing files still tombstone, other filesystem failures are counted
  and retried on the next sweep. A per-hash transaction lock also protects screenshot storage.
  Re-storing bytes refreshes retention time and revives the row; concurrent storage/deletion
  leaves fresh bytes readable. Shutdown stops the sweep before claiming another file.
- No credentials were added, worker started, live schedule activated, or real submission made.
  Previously existing worktree changes were preserved.

Verification:

- Existing affected intake, Telegram, health, heartbeat and queue subset: 5 files, 56 tests passed.
- New schedule computation/activation/real-pg-boss transaction subset: initially 2 files, 21 tests
  passed; subsequent tests add scheduled approval execution and queue-delay skipping.
- `pnpm test` → 69 files passed, 1 skipped; 597 tests passed, 1 skipped. The skip is the
  optional real-Chromium test without `BROWSER_TEST_CDP_URL`. Tests use isolated `app_test`.
- Final schedule/operations/retention subset after the retention backlog/shutdown check: 4 files,
  36 tests passed. It also verifies 501 expired artifacts are processed without leaving a batch cap.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build`, and `git diff --check` passed.

Next live session (pending): add the agent/model/private-view configuration and applicant profile,
log in manually through the view, then verify Reddit comment/post, phone login/captcha handoff,
YC/Wellfound applications and a saved hourly schedule whose first run is two minutes ahead.
Every real submit still requires its exact approval. Also confirm real per-task cost, restart/drain
behavior and public/Tailscale reachability before closing phase 05. Do not put credentials,
profile text, private screenshots or real job details in project docs.

### Live fix 1 — Background CAPTCHA frames (2026-10-25)

Status: done (implementation and automated checks) — approved by "Okkay go ahead and fix the bug" on 2026-10-25. Live Reddit retry remains part of the open phase verification. Goal: ordinary logged-in pages must not
pause solely because they load a background CAPTCHA widget; visible challenges still require
manual handoff. This is a detector correction within D047, with no solving or evasion.

Evidence:

- User reports a reCAPTCHA handoff while the attached screenshot shows an ordinary Reddit
  thread/composer and no challenge. No screenshot, private page text or target URL is copied here.
- Read-only task audit confirms `browser.snapshot` is waiting inside automatic detection; it
  is not the model's `request_human` tool. No approval or submit was requested by this check.
- `detectHandoff` currently treats any matching frame URL as a CAPTCHA, without inspecting
  visibility or whether the frame is an invisible/background anchor.
- `node --import tsx /tmp/captcha-repro.ts` reproduces the failure with a synthetic normal thread
  and `https://www.google.com/recaptcha/api2/anchor?size=invisible`: expected no handoff, actual
  `captcha/reCAPTCHA challenge` (assertion failed).

Implemented correction:

- [x] Expose bounded frame visibility metadata through the existing BrowserPage driver seam.
      Inspect only CAPTCHA-frame presentation/state, without reading passwords or page bodies.
- [x] Use that metadata in automatic handoff and the pre-submit check. Background/invisible
      anchors and hidden widgets alone are insufficient evidence of an active challenge.
      Visible challenge UI, verification pages, login and 2FA still stop for human handling.
      Unknown observation failures remain conservative.
- [x] Add unit/guard tests for the reproduced false positive and genuine visible challenges,
      plus real-Chromium fixtures for hidden/visible iframe presentation.
- [x] Run affected browser/handoff/executor checks, lint, typecheck and build; record evidence.

Exclusions: no CAPTCHA interaction/solving, no changes to submit approval, no automatic live
submission, no model/pricing/schema/dependency changes. The user will restart the worker and
retry the prepare/Cancel test after the correction. Decision D053 is accepted.

Implementation/verification details:

- BrowserPage now returns at most 64 frame presentation observations. The driver checks iframe
  geometry and CSS visibility/opacity through embedding ancestors (including shadow hosts),
  with an action-timeout fallback to unknown. It reads no frame bodies, password values or
  CAPTCHA response tokens. Frame URLs not covered by observations remain conservative.
- Invisible api2/enterprise reCAPTCHA anchors are background widgets; visible bframe challenges
  are separate and still stop, even when their URL also contains size=invisible. Only the known
  anchor checkbox’s aria-checked state can indicate completion; checked image-selection tiles
  never count as a solved challenge. A hidden duplicate cannot mask a visible frame.
- Both BrowserToolbox observation and the deterministic executor use this metadata. A challenge
  appearing after approval prevents the click. Normal hidden/background widgets allow the
  existing exact-text approval and at-most-once executor path. Login/2FA/verification checks stay.
- The original synthetic reproduction now passes. Focused run with real Chromium: 5 files,
  57 tests passed, including fixture-only hidden/visible/transparent/tiny/nested frame checks,
  manual handoff/resume, normal approval execution and post-approval CAPTCHA refusal. The test
  creates/closes its own fixture tab; it does not interact with a real CAPTCHA or Reddit.
- `BROWSER_TEST_CDP_URL=http://127.0.0.1:9222 pnpm test` → 70 files and 610 tests passed,
  including both real-Chromium fixture tests; no skips. Database tests used isolated `app_test`.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build`, and `git diff --check` passed.

Live checkpoint (2026-10-25): the user confirmed local API, Telegram ping/heartbeat, browser
check and phone Tailscale viewer access. The manual heartbeat was also verified sent through
read-only DB inspection. Chromium’s local check resolved snapshot refs and produced a PNG.
The Reddit prepare/Cancel check remains pending after this correction; no real submission was
performed during the fix, and no production worker was restarted by the agent.

### Live fix 2 — Composer past the snapshot bound (2026-10-25)

Status: done (implementation and automated checks) — approved by "Go ahead and fix the bug" on
2026-10-25. The live Reddit prepare/Cancel retry remains part of the open phase verification.
Goal: the agent must be able to reach a comment composer that sits below a long page, instead of
scrolling until the step limit. Decision D054 is accepted.

Evidence:

- Task c623 (Reddit comment) ended `failed/step_limit` with "Nothing was submitted". Its audit rows
  (read-only) show 25 tool calls: the same composer ref clicked six times, 17 scrolls and one End
  key, and no `fill_field`. No comment text or page content is copied here.
- A read-only reproduction against the same thread in the agent browser (opening the composer
  only, never typing) measured a ~198–215k-character aria snapshot. The unnamed
  "Join the conversation" textbox sat at ~12.8–16.2k characters depending on ads; once opened, the
  active editor and the Comment button sat at ~13.7–13.9k, past the 12,000-character bound.
- The bound is applied in DOM order from the top of the page. After a 600 px wheel scroll the
  first 12,000 characters were byte-identical, so scrolling could never reveal the composer. Refs
  past the bound already resolved against the full snapshot; the model just never saw them.

Implemented correction:

- [x] When a snapshot is cut, append a notice (outside the untrusted block) that snapshots start at
      the top and scrolling does not move the cut.
- [x] List this task's controls found past the cut — field inputs, the commit control and
      pre-commit openers from the site registry (`isTaskControl`) — in a second untrusted block,
      at most 20 elements with names cut to 120 characters, qualified by the same generation.
- [x] Say the same in the scroll tool description and the agent rules.
- [x] Tests: tracker listing/bounds/neutralised closing tags, and a toolbox run over a long thread
      fake that opens, fills and requests exact-text approval with no scroll.

Exclusions: no change to guards, the commit refusal, exact read-back, approval or the
deterministic executor; no schema, dependency, model or pricing change.

Verification:

- The real tracker against the live thread (composer opened, Escape, no typing) listed
  `textbox [ref=1:e264]` before the click and `textbox [active]` plus `button "Comment"` after it.
- `BROWSER_TEST_CDP_URL=http://127.0.0.1:9222 pnpm test` → 70 files and 612 tests passed.
  `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` and `git diff --check` passed.
- The user's live Reddit prepare/Cancel retry, after a worker restart, is still pending; the agent
  restarted no worker and submitted nothing.


## References

- [Project roadmap](../PLAN.md), [architecture](../ARCHITECTURE.md),
  [database contract](../DATABASE.md), and [decisions](../DECISIONS.md) (D002, D008, D023, D026).
- [Phase 03 record](03-important-email-alerts.md) for the budget, outbox, and Telegram patterns
  reused here.
- [AI SDK 6 announcement (agents, tool approval)](https://vercel.com/blog/ai-sdk-6) and
  [AI SDK 6 → 7 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0).
- [Playwright `connectOverCDP`](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
  and [aria snapshots](https://playwright.dev/docs/aria-snapshots).
- [Playwright MCP](https://github.com/microsoft/playwright-mcp),
  [Stagehand v4](https://browserbase.com/blog/stagehand-v4/), and
  [Stagehand browser configuration](https://docs.stagehand.dev/v4/configuration/browser), the
  alternatives considered.
- [Chrome remote-debugging switch changes (Chrome 136)](https://developer.chrome.com/blog/remote-debugging-port).
- [linuxserver Chromium image](https://docs.linuxserver.io/images/docker-chromium/) and
  [Tailscale Serve](https://tailscale.com/kb/1312/serve).
- [Telegram Bot API `sendPhoto`](https://core.telegram.org/bots/api#sendphoto).
- [Reddit Responsible Builder Policy announcement (r/redditdev, November 2025)](https://www.reddit.com/r/redditdev/comments/1oug31u/introducing_the_responsible_builder_policy_new/).


## Increment 8 — Thread-aware Reddit comment drafting (2026-10-26)

Status: in_progress — implementation and automated verification complete; live Telegram acceptance pending. Approved by the user's “PLEASE IMPLEMENT THIS PLAN” on 2026-10-26.
Goal: `/comment <thread-url> [thoughts]` reads the primary post, drafts a short casual
comment, and retains exact-text Approve/Cancel before submission. One optional question
can be answered by replying directly in Telegram; waiting releases the browser slot.

- [x] Optional same-line/multiline thoughts and backward-compatible prepared specs.
- [x] Bounded primary-post read and budgeted, tool-free composition (800-character cap).
- [x] Durable advice pause/reply, idempotency, stale-answer gate and cumulative task budget.
- [x] Thread identity and top-level composer checks through deterministic execution.
- [x] Focused regressions, full tests, lint, typecheck and build.
- [ ] Live Telegram draft/tone review and owned/test-thread submission through Approve.

Exclusions: nested comment replies, image/video interpretation, automatic submission,
Reddit API integration, general conversation history and database migrations. Existing
prepared/verbatim tasks remain unchanged. Advice waits until answered or cancelled.

Verification and outcome:

- `BROWSER_TEST_CDP_URL=http://127.0.0.1:9222 pnpm test`: 73 files, 640 tests passed.
  An initial full run found an over-broad fill check affecting Reddit posts; scoping the
  new earlier fill check to Reddit comments restored the existing post flow and regression.
- Final affected tests after card/task-list rendering: 39 passed. Final real-Chromium Reddit
  fixtures after adding the observed `multi_media` type: 3 passed. Existing Chromium driver
  fixtures also passed in the full run. All fixture requests are local; no real submit occurs.
- `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build`, and `git diff --check` passed.
- Read-only live DOM checks confirmed the primary title/body slots and `post-id` on
  `comment-composer-host`, including a text announcement with a `shreddit-post-text-body`.
  No page bodies, passwords, tokens or raw post text were printed or stored by those checks.
- The idle worker was gracefully reloaded to pick up the new command. No browser task was
  active at shutdown; every real submit still needs its Telegram approval.
- Still open: send `/comment <owned/test-thread-url>` and the thoughts variant in Telegram,
  review the real model’s tone, try Cancel, then approve one real comment and verify it.
  No real comment was submitted by this implementation run.

## Increment 9 — Rule-based fast path before the model loop (2026-10-28)

Status: in_progress — implementation and automated verification complete; the live baseline and
rules comparison are pending. Approved by the user on 2026-10-28 ("Rule-based fast path first")
after research into TypeSafe's Jev (D056).
Goal: reach the approval card for the common cases without step-model calls, keeping every
guard, the exact-text approval and the model-free executor. Opt-in with `AGENT_STEP_POLICY=rules`;
the default `llm` path is unchanged.

- [x] `AGENT_STEP_POLICY` (`llm` | `rules`) in env, `AgentConfig` and `.env.example`.
- [x] Pure rules (`src/agent/fast-path-rules.ts`): fill on one match, open once, approve from a
      fresh snapshot, and hand off on ambiguity or no progress.
- [x] Runner (`src/agent/fast-path.ts`) through `BrowserToolbox` only, plus a read-only,
      audited `composer_check` for Reddit comment candidates. Value-free trail and reason codes.
- [x] One-way handoff to `runBrowserAgent` with a resume prompt on the same page and toolbox.
- [x] Tests: pure rules, DB-backed runner and fallback, the rules policy end to end for Reddit
      comments and both application sites, and a gated real-Chromium composer fixture.
- [ ] Baseline: re-measure the current `llm` path. Run 1–2 live prepare/Cancel tasks each for
      `reddit_comment`, `waas_apply` and `wellfound_apply`, recording steps, summed
      `agent_browser_step` latency, run start to approval, and whether approval was reached.
      `reddit_comment` done on 2026-10-29 (D058); `waas_apply` and `wellfound_apply` pending.
- [ ] The same tasks with `AGENT_STEP_POLICY=rules`, comparing handoff reasons. Keep the option
      only with zero wrong-target approvals and an approval rate no worse than `llm`.
      `reddit_comment` done on 2026-10-29: 2/2 approvals under each policy, none wrong-target,
      and `rules` needed no browser-model calls (D058). The application sites are pending.

Exclusions: Jev or any other decision model, a default change, splitting `browser-task.ts`,
search/navigation/key presses in the fast path, schema, dependency, budget, approval and executor
changes.

Verification and outcome:

- `pnpm exec tsc --noEmit` and `pnpm build` passed.
- `pnpm test`: 73 files and 665 tests passed. 6 tests were skipped, including the new gated
  real-Chromium fixture, because no CDP browser was running. Rerun it with
  `BROWSER_TEST_CDP_URL`.
- `pnpm lint`: application code is clean. Its only errors are the 5 existing ones under the
  untracked `.scratch/watermarks-remover`.
- See D056 for the research, the invalid 2026-10-25 baseline, and the criteria for revisiting Jev.

## Increment 10 — OpenAI Decisions browser controller (2026-10-28)

Status: removed 2026-10-29 (D059) — the paid evaluation failed its gate, and the user approved
removal. The task-state/session extraction and the rules fast path in `browser-controller.ts`
remain. Originally approved by the user on 2026-10-28
("implement P05-T01..P05-T07", continue on top of increment-9 work).
Goal: use fast typed Decisions calls where rules cannot choose, retaining Responses for drafting
and difficult cases. Opt-in with `AGENT_STEP_POLICY=decisions`; defaults stay `llm`.

- [x] Shared task-state/session extraction (`browser-task-state`, `browser-task-session`).
- [x] Budgeted Decisions access (direct `decisionModel('gpt-6-luna')`, `api: 'decisions'`
      pricing, shared admission/serialization, `agent_browser_decision` audit).
- [x] Pure operation choices with 64-choice/32k bounds and 0.90/0.20 acceptance gate.
- [x] Shared preparation core (rules → Decisions → one Responses fallback, shared step
      budget, stale/refusal recovery) with `maxSteps` override for the fallback.
- [x] Opt-in wiring; `fast-path.ts` runner moved into the controller and deleted.
- [x] Fixed synthetic evaluation (`pnpm agent:decisions:evaluate`) with mocked harness tests.
- [x] Paid evaluation (`pnpm agent:decisions:evaluate` with real key/DB/budgets), run on
      2026-10-29. It failed: 1/9 ok, and all 8 model calls fell below the 0.90 gate (top
      choice 0.35–0.72). There were no incorrect acceptances. Cost $0.000418 (D058).
- [x] ~~Matched live prepare/Cancel trials per action under `llm`, `rules`, and `decisions`~~
      Not needed: Decisions was removed (D059). `rules` vs `llm` Reddit trials are in D058.

Exclusions: new websites, screenshots to models, generated search text, drafting changes,
Gateway, dependencies, migrations, submit authorization changes, and a default change.

Verification and outcome (automated only):

- `pnpm exec tsc --noEmit` and `pnpm build` passed.
- `pnpm test` passed with credential/CDP-dependent skips reported accurately.
- `pnpm exec biome check src tests package.json` passed for application code and fixtures.
- Live comparison and promotion gate remain open; see D057 and the 05-10 plan.

## Live fix 3 — Reddit composer hydration; `rules` becomes the default (2026-10-29)

Status: done — approved by the user on 2026-10-29 ("rules → Responses as the architecture").
See D058 for the cause and the measurements.

- [x] Clicking a snapshot element that is no longer visible fails within 1.5 s with
      `StaleRefError`, and the toolbox drops the snapshot. Previously it waited out the 10 s
      action timeout.
- [x] Reddit-comment navigation on the target thread waits up to 5 s for a visible editor in
      the top-level composer (`waitForRedditCommentComposer`, sharing `composer_check`'s
      in-page ownership test) before the first snapshot. The navigate audit records
      `composerReady`.
- [x] `AGENT_STEP_POLICY` defaults to `rules`; `llm` and `decisions` stay selectable.
- [x] Tests: the toolbox stale-click and hydration cases, the rules policy on a hydrating
      thread with no model call, and real-Chromium fixtures for the hidden click, a delayed
      composer, and the nested, wrong-post and hidden cases.
- [x] Live: composer focus with `rules` took 5.2 s with no model calls; drafted prepare to
      approval then Cancel took 11.0 s under `rules` and 27.7 s under `llm`.
- [x] Decisions removed on 2026-10-29 with the user's approval (D059).

# Phase 05, increment 10: OpenAI Decisions browser controller

Kind: feature
Approved: 2026-10-28 (implemented). Removed 2026-10-29: the paid evaluation failed its gate; see
D058 and D059. Kept as the historical plan.
Created: 2026-10-28
Depends on: the implemented phase 05 browser, approval, drafting and rule-path foundations

This file records the complete implementation plan. The user requested documentation only;
implementation, live API evaluation and changing the active browser policy are not approved.
All tasks below remain unchecked. Record execution later in
`docs/logs/05-10-openai-decisions-browser-controller.md`; do not create an execution log now.

Parent: [Phase 05](05-telegram-agent-browser-actions.md).
Roadmap: [PLAN.md](../PLAN.md). Existing increment-9 live acceptance remains pending.

## Goal

Use fast, typed OpenAI Decisions calls to choose browser operations when deterministic rules
cannot choose. Retain Responses for drafting and for difficult browser cases. Reach the existing
exact-content approval through the same guarded Playwright tools and submit with the existing
model-free executor.

The new, opt-in preparation policy is:

**Rules → OpenAI Decisions → Responses fallback → exact approval → deterministic submission**

Decisions selects an operation; application code executes it. Faster inference does not establish
faster complete browser tasks until measured.

In: Reddit comments, Reddit posts, YC Work at a Startup applications and Wellfound applications;
text accessibility snapshots; shared budget/audit support; evaluation and an opt-in rollout.

Out: new websites, general-purpose browsing, screenshot input to models, generated search text
from Decisions, drafting changes, a Vercel Gateway account, new dependencies, database migrations,
changes to submit authorization, and a default-policy change.

## Current implementation and builder context

Read first:

- `src/jobs/browser-task.ts`: claims tasks, prepares the connected page, waits for approval and
  executes the approved payload. Extract its touched responsibilities before adding behavior.
- `src/agent/fast-path.ts` and `src/agent/fast-path-rules.ts`: deterministic preparation and
  one-way handoff to the browser model.
- `src/agent/browser-agent.ts`: the Responses tool loop, resume prompt and outcomes.
- `src/llm/budgeted-model.ts`: serialized budget admission, reservation and generation middleware.

Reuse the existing owners:

| Concern | Existing implementation |
| --- | --- |
| Provider construction and cancellation | `createAgentProviderModel`, `agentRunSignal` in `src/llm/openai.ts` |
| Pricing and reservation | `getModelRates`, `computeUsageCostUsd`, `estimateReservationUsd` in `src/llm/pricing.ts` |
| Admission and provider failures | `createBudgetedModel`, `isBudgetExhausted` in `src/llm/budgeted-model.ts`; `classifyAiSdkError` in `src/llm/errors.ts` |
| Serialization and durable audit | `withSerializedModelCall` in `src/llm/serial.ts`; `withLlmCall` in `src/audit/calls.ts` |
| Budget queries and local days | `getLlmBudgetUsageForRun`, `getLlmBudgetUsageForRange` in `src/db/queries/audit.ts`; `getBudgetSettings`, `localDayRange` in `src/llm/budget.ts` |
| Browser actions | `BrowserToolbox` in `src/agent/browser-tools.ts` |
| Candidate rules | `nextFastAction`, `fieldCandidates`, `commitCandidates`, `siteCheckRefs`, `elementSignature`, `progressSignature` in `src/agent/fast-path-rules.ts` |
| Guards and matching | `assertClickAllowed`, `assertKeyAllowed`, `matchesElement`, `isActionTargetPage` in `src/browser/guards.ts` |
| Snapshot refs and bounds | `SnapshotTracker`, `AgentSnapshot`, `StaleRefError` in `src/browser/snapshot.ts` |
| Site/action definitions | `getSiteAction`, `Site`, `SiteAction` in `src/browser/sites.ts` |
| Existing fallback | `runBrowserAgent`, `BrowserAgentOutcome`, `BrowserAgentResume` in `src/agent/browser-agent.ts` |

Rules that apply:

- Agent model calls go only through `createBudgetedModel`; extend that boundary for Decisions.
- Browser actions go only through `BrowserToolbox`. Only `src/agent/executor.ts` clicks submit.
- Every submit needs approval of its exact immutable payload and runs without a model.
- Page content is untrusted. Never store it in `tool_calls`, application logs or execution notes.
- Reserve worst-case cost before each provider attempt. Unknown outcomes retain their reservation.
- Use the same task cap, shared model-call serialization, global daily limit, agent daily limit
  and `Asia/Kolkata` budget day. Include intake and earlier preparation runs in task spend.
- Preserve cancellation, worker shutdown, human handoff, advice waits, provenance, target identity,
  read-back checks and at-most-once execution.
- CDP stays on loopback. Never read/type passwords or solve/bypass CAPTCHA and verification.
- Preserve the current uncommitted increment-9 work. Do not reset, stash or commit it as part of
  this documentation request. Reconcile its ownership before beginning implementation later.

## Spec

### C1. Policy and provider

Extend `AgentStepPolicy` to `'llm' | 'rules' | 'decisions'` and accept the new value in env/config.
`AGENT_STEP_POLICY=decisions` enables this controller. The default remains `llm`; existing `llm`
and `rules` policies retain their behavior and remain available for comparison and rollback.

Add `createAgentDecisionProviderModel(config)` in `src/llm/openai.ts`, returning the installed
provider's `decisionModel('gpt-6-luna')` with `config.openaiApiKey`. Use an explicit provider model
instance with `experimental_decide`; do not use a bare model string that resolves through Gateway.
Use the already installed SDK versions. No new API key, base-URL option or model env variable.
`AGENT_MODEL` continues selecting the Responses model for drafting and fallback.

### C2. Shared preparation controller

Replace the old fast-path runner with `runBrowserPreparation` in
`src/agent/browser-controller.ts`. It returns `BrowserAgentOutcome` and accepts the existing
browser-agent inputs plus an optional, already budgeted decision model. The job supplies that
model only for the `decisions` policy. Keep a test seam for its factory alongside `modelFactory`.

Use one guarded preparation core for `rules` and `decisions`, retaining the existing pure rules.
Do not copy the runner into a second loop with separate action, observation or stop handling.
For `llm`, invoke the existing Responses browser loop directly.

For the new policy, navigate to the task target, let existing detectors/composition hooks run,
and observe the current page. At each iteration, run the deterministic rules first. When they
produce a usable operation, execute it without a decision call. Otherwise build the available
operations and ask Decisions which operation to take next. Re-evaluate rules after the result
of each operation; opening a form can therefore make later filling and approval deterministic.

### C3. Available operations

Represent operations as a discriminated union owned by `src/agent/browser-decision-actions.ts`:

```ts
type BrowserOperation =
  | { op: 'navigate_target' }
  | { op: 'click'; ref: string }
  | { op: 'fill_field'; ref: string; fieldKey: string }
  | { op: 'press'; key: string; ref?: string }
  | { op: 'scroll'; direction: 'up' | 'down' }
  | { op: 'wait'; ms: 500 }
  | { op: 'request_submit_approval'; submitRef: string; fieldRefs: Record<string, string> }
  | { op: 'fallback' }
```

Code assembles every operation and its complete arguments. Decisions can select only its opaque
choice ID. The returned choice cannot introduce selectors, URLs, query text, field values, keys,
wait durations or executable commands.

- Generate clicks for enabled interactive controls represented in the supplied observation;
  filter them with the existing click guard. Preserve the application-opener and target checks
  enforced again by `BrowserToolbox` at execution.
- Generate fills only for pinned task field keys and compatible enabled controls, retaining
  existing Reddit top-level-composer exclusions. Call `fillField(ref, fieldKey)`; the toolbox
  obtains the exact prepared value. Never let Decisions generate or edit that value.
- Navigation resolves to `spec.targetUrl` in code. Other page navigation uses guarded link clicks.
- Key choices use the existing navigation-key allowlist. Offer Enter only with an eligible
  searchbox/combobox ref, as required by the current guard. Do not offer submission shortcuts.
- Offer up/down scroll and one 500 ms wait per unchanged observation. A scroll does not move
  the existing snapshot cut; repeated unchanged scrolling must fall back.
- Generate approval operations only after composition finishes and all fields are filled.
  Each operation contains a complete distinct-field/ref mapping and an enabled submit ref.
  Ambiguous forms may have multiple complete mappings, subject to the choice cap below.
- Include `fallback`. There is no submit-click operation and no generated-text operation.

Candidate construction is pure. Site-specific DOM checks and all actual operations remain at
the toolbox boundary. Preserve rule-only use of the full parsed element map; Decisions candidates
must be described in the bounded observation or its existing task-controls appendix.

### C4. Decision request and trust boundary

Ask one named `choice` question, `next_operation`. Its alternatives are opaque IDs mapped in
memory to C3 operations. Put page-derived descriptions in untrusted shared state; trusted
instructions describe how to choose and when to fall back.

State contains the action, target, field keys, filled-field state, newest bounded accessibility
snapshot, operation descriptions and a short value-free operation trail. Do not explicitly add
draft values, applicant profiles or raw Telegram instructions. Existing snapshots can contain
visible page text; do not claim that they are fully redacted. Screenshots remain for Telegram
cards and evidence, not model input.

Bound the complete serialized state plus questions to 32,000 characters and 64 choices including
fallback. Bound operation names/accessible descriptions using existing snapshot limits. If all
relevant operations or the required context cannot fit, fall back before a provider call; never
silently drop candidates or trim away the context needed to distinguish them.

Use generation-qualified refs. Before executing an answer, require the captured observation to
remain current. Discard stale selections, take a fresh observation and rebuild; stale-ref guard
failures also count toward the refusal limit. Never reuse an old choice-to-operation map.

### C5. Acceptance, limits and fallback

Accept a selected operation only if its probability is at least 0.90 and at least 0.20 greater
than the next option. Use the selected option's probability distribution, not the provider's
separate confidence statistic. Missing distributions or an unknown selection cause fallback.
These initial thresholds need the fixed evaluation cases; they are not correctness guarantees.

Hand off once to Responses on fallback selection, low probability, refusal, malformed output,
missing context/candidates, overflow, provider failure, a repeated operation without progress,
two consecutive guard refusals or a non-guard action failure. Observe the current page before
fallback. Supply current filled keys and the fixed value-free trail on the same page, toolbox,
spec, signals and run IDs. Never return from Responses to Decisions during that task.

For the new policy only, share `AGENT_MAX_STEPS` across rule operations, Decisions attempts and
Responses fallback steps. Initial navigation consumes one step. A Decisions attempt plus its
selected operation consumes one step together, including an attempt that chooses fallback.
Automatic observation refreshes do not consume steps and cannot form a retry-only loop. Pass
only the remaining step allowance to Responses; with none left, return `step_limit` directly.
Keep legacy `rules` action-cap/fallback semantics and legacy `llm` semantics unchanged.

Disable SDK retries. Bound each Decisions request by the smaller of `agent.stepTimeoutMs` and
10,000 ms, combined with shutdown/task cancellation signals. The provider deadline covers the
request only, not toolbox execution or a human wait.

Cancellation, shutdown, exhausted budgets, advice waits, unresolved human handoffs, drafting
errors, already-applied state and any approval request stop preparation immediately. These are
not reasons to start another model. A provider timeout may trigger fallback only after retaining
its unknown reservation and passing budget admission for the next call.

### C6. Budgeting and audit

Extend `createBudgetedModel` with an overload for the installed decision-model interface and
options with `api: 'decisions'`. Keep the current generation-model interface compatible. Factor
shared admission/reservation logic once within its existing owner; do not create a second set of
task/day/agent-limit checks or a separate serialization lock.

Extend `getModelRates(model, api?)` with `api` defaulting to `'responses'`. Fail closed for unknown
model/API combinations. The Decisions rate snapshot for `gpt-6-luna` is USD per million tokens:

| Input | Cached input | Default cache write | Output |
| --- | --- | --- | --- |
| 0.10 | 0.01 | 0.125 | 0 |

Reserve for the complete request, including alternatives/instructions and existing framing
overhead, using the existing conservative input-token estimate and the highest applicable input
rate. Update `estimateReservationUsd` so cache-write pricing cannot exceed its supposed worst
case; this can conservatively increase existing generation reservations without changing actual
generation costs. Decisions reserves no output/reasoning spend.

Record attempts as `agent_browser_decision` with the real model ID and no reasoning effort.
Read actual token and cache details from the direct OpenAI provider metadata; do not bill cached
input twice or use Responses output pricing. Missing/inconsistent usage retains the reservation.
Use existing known-failure versus unknown-outcome classification and safe request-ID handling.
All intake, drafting, decision, fallback and earlier preparation runs count against the same cap.

Do not pass Responses-only `reasoningEffort`, `store` or output-token options to Decisions.
Disable request/response telemetry that could record page content. Logs and DB audit contain only
existing safe fields and bounded operation/reason codes, never snapshots, candidate descriptions,
drafts, probability maps keyed by page text or raw provider bodies/errors.

### C7. Preservation and observability

Keep existing composition hooks, immutable approval payloads, field read-back, fresh target checks,
phone takeover and deterministic execution. There is no model call after approval is requested.
Record rule/decision/fallback step counts and a fixed fallback reason in bounded completion logs.
Use `llm_calls` purpose, latency and cost fields for model metrics; no new DB columns or indexes.
Measure preparation only up to approval creation, excluding approval/human/advice waiting time.

### Choices

| Question | Decision | Reason |
| --- | --- | --- |
| Main controller | Rules, then Decisions, with one-way Responses fallback | Immediate obvious operations plus typed selection where needed |
| Provider | Direct OpenAI with the installed AI SDK provider | Existing key/account, no hosted Gateway dependency |
| Decision model | Fixed `gpt-6-luna` | Supported native Decisions model; separate from Responses configuration |
| Input | Existing text snapshots and refs | Reuses the guarded driver and avoids image budgeting |
| Output | One choice over complete operations | Prevents generated browser commands or content |
| Uncertainty | Probability >= 0.90 and margin >= 0.20, otherwise fallback | Conservative starting acceptance rule, evaluated before live use |
| Scope | Four registered browser actions | Existing target and approval contracts remain applicable |
| Rollout | New opt-in value; default stays `llm` | Compare complete tasks before promotion |
| Existing policies | Keep `llm` and `rules` | Required baselines and rollback, not unused replacement loops |
| Storage/services | No migration, new package or external account | Existing owners and audit schema cover this change |

## Tasks

- [x] P05-T01 Extract task outcome handling
- [x] P05-T02 Extract connected preparation
- [x] P05-T03 Add budgeted Decisions access
- [x] P05-T04 Build operation choices
- [x] P05-T05 Add the preparation controller
- [x] P05-T06 Wire the opt-in policy
- [x] P05-T07 Evaluate and document the controller

### P05-T01 Extract task outcome handling

Implements: behavior-preserving preparation for C2 and C7.

Files:
- `src/jobs/browser-task.ts`
- `src/jobs/browser-task-state.ts` (new)

Do:
1. Move `BrowserTaskOutcomeError`, notification/finish helpers, `requestApproval`, `loadApproval`
   and their supporting context/state types into the new task-state owner.
2. Move the shared task-run context type there so the later session module has no runtime import
   back into its caller. Keep the public job entry point and its context in the job module.
3. Update imports directly. Export only symbols used by the job or forthcoming session boundary;
   retain no re-export shims and make no behavior changes.

Test: existing `tests/db/browser-job.test.ts`, `tests/db/job-applications.test.ts` and
`tests/db/browser-approvals.test.ts`.
- Approved/cancelled/expired/interrupted preparation → existing task and approval outcomes.
- Mutated approved fields or wrong target → existing precondition failure without a submit.

Check: `pnpm exec vitest run tests/db/browser-job.test.ts tests/db/job-applications.test.ts tests/db/browser-approvals.test.ts`

### P05-T02 Extract connected preparation

Implements: behavior-preserving preparation for C2 and C7.

Files:
- `src/jobs/browser-task.ts`
- `src/jobs/browser-task-state.ts`
- `src/jobs/browser-task-session.ts` (new)

Do:
1. Move `runConnectedTask` and its cancellation watcher into the session module, importing shared
   state/approval operations from task-state. Keep helpers small and avoid a runtime import cycle.
2. Leave queue entry, task claiming/caps, connection ownership and final disconnect in the job.
3. Preserve composition, human/approval hooks and execution ordering exactly. Do not add decision
   logic to the job or expand the existing oversized toolbox.

Test: existing `tests/db/browser-job.test.ts`, `tests/db/job-applications.test.ts` and
`tests/db/browser-handoffs.test.ts`.
- Human takeover and direct advice waits → existing stop/resume behavior.
- Cancellation/shutdown → no later model/action and session disconnect still occurs.

Check: `pnpm exec vitest run tests/db/browser-job.test.ts tests/db/job-applications.test.ts tests/db/browser-handoffs.test.ts`

### P05-T03 Add budgeted Decisions access

Implements: C1 and C6.

Files:
- `src/llm/openai.ts`
- `src/llm/pricing.ts`
- `src/llm/budgeted-model.ts`

Do:
1. Add the direct decision-provider factory and API-specific pricing lookup.
2. Add the typed `createBudgetedModel` overload, sharing admission/reservation and safe error
   classification with generation. Preserve current generation callers.
3. Count complete decision requests and cache-write rates in reservation; map actual usage and
   request headers from provider metadata without retaining raw bodies.
4. Add one shared scripted decision fake for subsequent unit/integration/evaluation tests.

Test: `tests/fakes/decision-model.ts` (new), `tests/db/budgeted-decisions.test.ts` (new),
`tests/decision-provider.test.ts` (new), `tests/db/budgeted-model.test.ts`,
`tests/mail-pricing.test.ts`.
- Request → direct `/v1/decisions`, no Gateway resolution or Responses-only options.
- Attempt → durable in-flight reservation before provider I/O, then actual cost or retained reserve.
- Cached input/cache writes → correct actual cost; highest input rate → sufficient reservation.
- Concurrent generation/decision calls → one shared admission section.
- Intake/earlier-run spend or exhausted local-day caps → provider not called.
- Timeout/missing usage/private provider errors → conservative accounting and safe persisted text.

Check: `pnpm exec vitest run tests/decision-provider.test.ts tests/db/budgeted-decisions.test.ts tests/db/budgeted-model.test.ts tests/mail-pricing.test.ts`

### P05-T04 Build operation choices

Implements: C3, C4 and the probability gate in C5.

Files:
- `src/agent/browser-decision-actions.ts` (new)

Do:
1. Add the operation union, pure candidate builder and complete bounded request builder.
2. Map opaque IDs to generation-qualified operations; keep untrusted descriptions in shared state.
3. Build complete approval mappings without duplicated refs. If combinations/context overflow,
   return a fixed fallback reason instead of truncating candidates.
4. Add selection validation using the selected probability and runner-up margin.

Test: `tests/browser-decision-actions.test.ts` (new),
`tests/fixtures/browser-decisions.ts` (new, synthetic only).
- Each registered action → applicable clicks/fills/approval mappings, using prepared field keys.
- Wrong-composer/disabled/commit-like/off-origin controls → absent from available clicks.
- Task control past a cut → usable only with supplied appendix context.
- 64-choice/32,000-character boundaries and overflow → explicit, deterministic outcomes.
- Unknown choice, missing distribution, probability/margin boundary → accept or fallback exactly.
- Malicious page text → no new operation, argument or submit capability.

Check: `pnpm exec vitest run tests/browser-decision-actions.test.ts tests/fast-path-rules.test.ts`

### P05-T05 Add the preparation controller

Implements: C2–C7.

Files:
- `src/agent/browser-controller.ts` (new)
- `src/agent/browser-agent.ts`

Do:
1. Generalize the current fast-path execution into `runBrowserPreparation`, sharing rule action,
   observation, stop and handoff handling. Keep the old entry point temporarily until T06 wiring.
2. Add one named decision choice request with retries disabled, combined cancellation/deadline
   signals, bounded inputs and fixed failure reasons.
3. Refresh invalidated snapshots, reject stale selections and run rules again after each action.
4. Enforce the shared new-policy step budget; resume Responses once with the remaining steps and
   current page/spec/filled keys. Leave legacy policy step accounting unchanged.

Test: `tests/db/browser-decisions.test.ts` (new), using existing browser fakes and the T03 fake.
- Rule-only form → approval with no step-model requests.
- Ambiguous opener/field → accepted decision operation, then deterministic continuation.
- Refusal/low probability/provider failure/no progress → one Responses fallback, no restart.
- Stale refs/guard refusals → bounded recovery; no unguarded action.
- Cancellation, shutdown, exhausted budget, advice or approval → immediate terminal behavior.
- Remaining step budget zero → `step_limit`, without a fallback call.

Check: `pnpm exec vitest run tests/db/browser-decisions.test.ts tests/db/browser-tools.test.ts`

### P05-T06 Wire the opt-in policy

Implements: C1, C2 and C7.

Files:
- `src/env.ts`
- `src/config.ts`
- `.env.example`
- `src/jobs/browser-task.ts`
- `src/jobs/browser-task-session.ts`
- `src/agent/fast-path.ts` (delete after callers are migrated)

Do:
1. Accept `decisions` while preserving the `llm` default and existing configuration semantics.
2. Add `decisionModelFactory?: (runId: string) => Experimental_DecisionModelV4` to the job test
   seam. Construct the default via the provider factory plus `createBudgetedModel`, with the same
   task cap, run ID and additional intake/preparation run IDs as Responses.
3. Route preparation through the shared controller; do not construct/call a decision model for
   existing policies. Keep composition models and submit execution unchanged.
4. Migrate old fast-path callers/tests and delete its replaced runner. Preserve coverage of
   existing rules rather than deleting tests with the old file.

Test: `tests/config.test.ts`, `tests/env.test.ts`, `tests/db/fast-path.test.ts`,
`tests/db/browser-job.test.ts`, `tests/db/job-applications.test.ts`,
`tests/browser-reddit-playwright.test.ts`.
- Missing policy → `llm`; `rules` → existing behavior; `decisions` → new controller.
- All four actions → correct prepared text, target and approval payload.
- Advice/handoff/changed approved form → existing lifecycle and submit checks.
- Real-Chromium synthetic composer fixture → refs and editor interactions remain valid.

Check: `pnpm exec vitest run tests/config.test.ts tests/env.test.ts tests/db/fast-path.test.ts tests/db/browser-job.test.ts tests/db/job-applications.test.ts tests/browser-reddit-playwright.test.ts`

### P05-T07 Evaluate and document the controller

Implements: C4–C7 and the acceptance/rollout below.

Files:
- `src/tools/browser-decisions-evaluate.ts` (new)
- `package.json`
- `tests/fixtures/browser-decisions.ts`
- `docs/ARCHITECTURE.md`
- `docs/DECISIONS.md`
- `docs/PLAN.md`
- `docs/phases/05-telegram-agent-browser-actions.md`
- `AGENTS.md`
- this plan (checkboxes only) and its future execution log

Do:
1. Add `pnpm agent:decisions:evaluate` for an explicitly invoked, budgeted run over the fixed
   synthetic fixtures. Use the existing validated configuration and run/audit helpers; do not
   start the worker, send Telegram messages or execute real browser actions.
2. Expected operations/fallbacks are fixed before evaluation. Report case IDs, correctness,
   probability, latency, call count and cost only. Exit nonzero on any incorrect accepted action
   or on a fixture requiring abstention that does not fall back. Rerun after prompt changes.
3. Update as-built docs with the direct provider boundary, the shared budget overload and opt-in
   policy. Record a new decision superseding only D056's future-provider/controller choice;
   preserve D056 and its original evidence. Keep pending live work visibly pending.
4. Record automated results and the live comparison separately. Do not mark the default promoted
   or live checks passed without the evidence required below.

Test: `tests/browser-decisions-evaluate.test.ts` (new), plus the full suite.
- Correct synthetic selections → pass; invalid acceptance or required abstention ignored → fail.
- Mocked provider and output capture → no page text, draft or provider body in output/logs.
- Budget unavailable → no paid call and explicit failure, without overriding caps.

Check: `pnpm exec vitest run tests/browser-decisions-evaluate.test.ts tests/browser-decision-actions.test.ts tests/db/browser-decisions.test.ts tests/db/budgeted-decisions.test.ts`

Avoid throughout: schema changes, new packages, new browser origins, field values supplied by a
decision, automatic submits, hiding baseline failures, and a documentation-layout migration.

## Acceptance

### Automated

- `pnpm exec tsc --noEmit` → pass.
- `pnpm build` → pass.
- `pnpm test` → pass, with credential/CDP-dependent skips reported accurately.
- `pnpm exec biome check src tests package.json` → pass for application code and test fixtures.
- `pnpm lint` → run and record any remaining pre-existing `.scratch` failures separately.
- `git diff --check` → pass.
- `BROWSER_TEST_CDP_URL=http://127.0.0.1:9222 pnpm exec vitest run tests/browser-playwright.test.ts tests/browser-reddit-playwright.test.ts`
  → pass when the existing browser container is available; record as unrun otherwise.
- `pnpm agent:decisions:evaluate` → zero incorrect accepted operations; ambiguous/unsafe fixtures
  fall back. This makes paid calls and needs the configured key, database and available budgets;
  invoke it only during later approved implementation/evaluation, not while saving this plan.

Coverage must include all four actions, rule-only completion with zero step-model calls,
decision-driven controls, missing/unknown choices, refusal, unsafe page content, stale refs,
ambiguous approval mappings, exactly one fallback, shared budgets, cancellation/shutdown,
advice and phone handoffs, already-applied jobs and mutation after approval. Every paid attempt
must be traceable through existing audit records. No model can submit.

### Manual comparison and promotion gate

1. Obtain a current baseline rather than reusing the invalid pre-D054 scrolling runs. With the
   existing logged-in browser and worker, run at least two matched prepare/Cancel trials per
   action under each of `llm`, `rules` and `decisions`. Spread across days where daily caps require
   it; do not raise caps or budgets to make the comparison fit. Do not submit real content.
2. Record preparation start-to-approval time, model latency, cost, call counts, fallback reasons,
   correct target/fields and whether approval was reached. Exclude human/approval/advice waits.
   Use fixed case/run IDs in evidence; never paste private page or draft content into logs.
3. Verify that cancellation and phone handoff still work with the new policy. Check prepared
   content and target on the approval card, then Cancel.
4. Keep Decisions opt-in until there are zero wrong-target approvals, completion is no worse than
   the existing controller, rule-only cases remain model-free and median preparation time is
   lower than `llm`. Report the small sample size and separate decision-call latency from total
   task latency. Record unmet criteria as follow-up work.
5. Promote the default only in a subsequent rollout change after reviewing that evidence. A fast
   API response alone does not satisfy the gate. This increment does not change the default.

## Baseline and execution instructions

Read-only planning checks on 2026-10-28 found:

- Typechecking passed.
- Seven selected test files passed: 110 tests covering config, pricing, budgeted generation,
  rules, browser jobs and applications. The sandbox initially blocked loopback access; the
  test-database retry passed. This is existing-code evidence, not verification of this feature.
- Repository lint reports five pre-existing errors under `.scratch/watermarks-remover`.
- The worktree already contains uncommitted increment-9 changes. No implementation was performed
  for this plan, and that work must not be reverted or swept into unrelated commits.

At implementation time, recheck the worktree and installed contracts, establish a fresh baseline,
then implement approved tasks in order. Every task must leave existing behavior/tests green.
Append results to the separate execution log and tick only tasks actually completed. Retain
unmet live checks as pending. The plan's `Approved:` line stays pending until explicit later
implementation approval.

Future builder prompt, after approval:

> Use $clean-dev to implement P05-T01 through P05-T07 from
> docs/phases/05-10-openai-decisions-browser-controller.md. Follow its contracts and task order;
> keep the policy opt-in and record execution separately.

## References

Research checked 2026-10-28; recheck pricing/support before later implementation if it has changed.

- [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions): typed
  choices, probabilities, supported model, caching and Decisions-specific pricing.
- [Create a decision](https://developers.openai.com/api/reference/resources/decisions/methods/create):
  request/answer and usage contracts.
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data): standard abuse
  monitoring retention and approved Zero Data Retention eligibility. Do not infer ZDR from using
  the same provider or from disabling Responses storage.
- [D056](../DECISIONS.md#d056-rule-based-fast-path-before-the-browser-model-loop-jev-deferred):
  original rule-path rationale, privacy/context limits and baseline limitations.

## Changes

- none

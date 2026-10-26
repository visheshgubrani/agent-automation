import { pgEnum } from 'drizzle-orm/pg-core'

export const accountProvider = pgEnum('account_provider', ['gmail'])
export const accountStatus = pgEnum('account_status', ['active', 'paused', 'revoked', 'error'])
export const credentialKind = pgEnum('credential_kind', [
  'oauth_refresh_token',
  'oauth_access_token',
])

export const triageCategory = pgEnum('triage_category', ['urgent', 'needs_reply', 'fyi', 'ignore'])
export const triageStatus = pgEnum('triage_status', [
  'pending',
  'in_progress',
  'classified',
  'failed',
  'skipped',
])

/** Classifier topic, independent of urgency and of the notification decision. */
export const classificationTopic = pgEnum('classification_topic', [
  'banking',
  'work',
  'career',
  'other',
])

/** How the current decision was produced; rule/correction rows carry no fictitious model call. */
export const classificationDecisionSource = pgEnum('classification_decision_source', [
  'classifier',
  'rule',
  'correction',
])

export const mailRuleAction = pgEnum('mail_rule_action', ['notify', 'ignore'])
export const mailRuleMatchType = pgEnum('mail_rule_match_type', ['sender', 'domain'])

/** Reasoning effort snapshotted on paid model attempts and classifier decisions. */
export const reasoningEffort = pgEnum('reasoning_effort', ['medium', 'high'])

export const notificationKind = pgEnum('notification_kind', [
  'email_triage',
  'approval_request',
  'system',
])
export const notificationChannel = pgEnum('notification_channel', ['telegram'])
/** Snapshot of the per-kind delivery policy (D021); the dispatcher reads the row, not the kind. */
export const notificationDeliveryPolicy = pgEnum('notification_delivery_policy', [
  'at_most_once',
  'at_least_once',
])
export const notificationStatus = pgEnum('notification_status', [
  'pending',
  'batched',
  'sending',
  'sent',
  'failed',
  'expired',
  'cancelled',
  'suppressed',
  'quarantined',
])

export const feedbackRating = pgEnum('feedback_rating', ['useful', 'not_useful'])
export const feedbackReason = pgEnum('feedback_reason', [
  'missed_important',
  'wrong_category',
  'too_noisy',
  'other',
])

export const riskTier = pgEnum('risk_tier', ['read', 'notify', 'draft', 'send'])
export const approvalStatus = pgEnum('approval_status', [
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
])
export const approvalResolver = pgEnum('approval_resolver', ['telegram', 'api', 'system'])

export const runKind = pgEnum('run_kind', [
  'mail_sync',
  'mail_triage',
  'notification_dispatch',
  'agent_chat',
  'approval_execution',
  'system',
  // Added in its own migration (D002): one browser task attempt (phase 05).
  'browser_task',
])
export const runTrigger = pgEnum('run_trigger', [
  'schedule',
  'webhook',
  'manual',
  'telegram',
  'retry',
  'approval',
])
export const runStatus = pgEnum('run_status', ['running', 'succeeded', 'failed', 'cancelled'])
export const llmCallStatus = pgEnum('llm_call_status', [
  'succeeded',
  'failed',
  // Durable reservation inserted before the external model attempt.
  'in_flight',
  // The process died or the provider outcome could not be determined; budget stays reserved.
  'unknown',
])
export const toolCallStatus = pgEnum('tool_call_status', [
  'running',
  'succeeded',
  'failed',
  // A send whose outcome could not be determined (crash or ambiguous click); never retried.
  'unknown',
])

export const telegramDirection = pgEnum('telegram_direction', ['inbound', 'outbound'])
export const telegramUpdateKind = pgEnum('telegram_update_kind', [
  'message',
  'edited_message',
  'callback_query',
  'other',
])

export const watchlistKind = pgEnum('watchlist_kind', ['ticker', 'company', 'topic', 'person'])
export const toneSampleSource = pgEnum('tone_sample_source', [
  'manual',
  'approved_draft',
  'feedback',
])

/** Browser task lifecycle (phase 05, D042). Active states are guarded by one partial index. */
export const browserTaskStatus = pgEnum('browser_task_status', [
  'queued',
  'running',
  'waiting_for_human',
  'awaiting_approval',
  'executing',
  'succeeded',
  'unverified',
  'outcome_unknown',
  'failed',
  'cancelled',
])
export const browserTaskSource = pgEnum('browser_task_source', ['telegram', 'schedule', 'retry'])
export const browserHandoffReason = pgEnum('browser_handoff_reason', [
  'captcha',
  'login',
  'two_factor',
  'verification',
  'other',
])
export const browserHandoffStatus = pgEnum('browser_handoff_status', [
  'waiting',
  'resolved',
  'cancelled',
  'timed_out',
  'interrupted',
])
/** `inbound_media` is reserved for the later Instagram phase; add it in its own migration. */
export const artifactKind = pgEnum('artifact_kind', ['screenshot'])

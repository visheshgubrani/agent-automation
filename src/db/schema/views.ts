import { eq, sql } from 'drizzle-orm'
import { pgView } from 'drizzle-orm/pg-core'
import { emailClassifications, messages } from './mail.js'
import { classificationFeedback, notificationOutbox } from './notifications.js'

/**
 * Labeled examples for classifier tuning. Includes feedback on un-notified emails
 * (notification_id null), which is how a missed-but-important email becomes a label.
 * raw_text is intentionally excluded.
 *
 * Every selected expression is explicitly aliased: the view query builder does not add
 * aliases by itself, and the view has several source `id` columns.
 */
export const classifierFeedbackExamples = pgView('classifier_feedback_examples').as((qb) =>
  qb
    .select({
      feedback_id: sql<string>`${classificationFeedback.id}`.as('feedback_id'),
      rating: sql<string>`${classificationFeedback.rating}`.as('rating'),
      reason: sql<string | null>`${classificationFeedback.reason}`.as('reason'),
      note: sql<string | null>`${classificationFeedback.note}`.as('note'),
      labeled_at: sql<Date>`${classificationFeedback.updatedAt}`
        .mapWith((value: string) => new Date(value))
        .as('labeled_at'),
      classification_id: sql<string>`${emailClassifications.id}`.as('classification_id'),
      category: sql<string | null>`${emailClassifications.category}`.as('category'),
      topic: sql<string>`${emailClassifications.topic}`.as('topic'),
      should_notify: sql<boolean>`${emailClassifications.shouldNotify}`.as('should_notify'),
      confidence: sql<string | null>`${emailClassifications.confidence}`.as('confidence'),
      summary: sql<string | null>`${emailClassifications.summary}`.as('summary'),
      model: sql<string | null>`${emailClassifications.model}`.as('model'),
      prompt_version: sql<string | null>`${emailClassifications.promptVersion}`.as(
        'prompt_version',
      ),
      classifier_version: sql<string | null>`${emailClassifications.classifierVersion}`.as(
        'classifier_version',
      ),
      decision_source: sql<string>`${emailClassifications.decisionSource}`.as('decision_source'),
      applied_rule_id: sql<string | null>`${emailClassifications.appliedRuleId}`.as(
        'applied_rule_id',
      ),
      reasoning_effort: sql<string | null>`${emailClassifications.reasoningEffort}`.as(
        'reasoning_effort',
      ),
      message_id: sql<string>`${messages.id}`.as('message_id'),
      account_id: sql<string>`${messages.accountId}`.as('account_id'),
      rfc_message_id: sql<string | null>`${messages.rfcMessageId}`.as('rfc_message_id'),
      from_email: sql<string>`${messages.fromEmail}`.as('from_email'),
      subject: sql<string>`${messages.subject}`.as('subject'),
      clean_text: sql<string>`${messages.cleanText}`.as('clean_text'),
      received_at: sql<Date>`${messages.receivedAt}`
        .mapWith((value: string) => new Date(value))
        .as('received_at'),
      notification_id: sql<string | null>`${notificationOutbox.id}`.as('notification_id'),
      notification_sent_at: sql<Date | null>`${notificationOutbox.sentAt}`
        .mapWith((value: string | null) => (value === null ? null : new Date(value)))
        .as('notification_sent_at'),
    })
    .from(classificationFeedback)
    .innerJoin(
      emailClassifications,
      eq(emailClassifications.id, classificationFeedback.classificationId),
    )
    .innerJoin(messages, eq(messages.id, emailClassifications.messageId))
    .leftJoin(notificationOutbox, eq(notificationOutbox.id, classificationFeedback.notificationId)),
)

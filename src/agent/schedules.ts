import { CronExpressionParser } from 'cron-parser'
import { and, eq } from 'drizzle-orm'
import { isAllowedOrigin } from '../browser/guards.js'
import { getSiteAction } from '../browser/sites.js'
import type { Db } from '../db/index.js'
import { browserSchedules, telegramMessages } from '../db/schema/index.js'
import { browserTaskSpecV1 } from './contracts.js'
import { intakePlanV1 } from './intake.js'

export const SCHEDULE_TIMEZONE = 'Asia/Kolkata'
export const SCHEDULE_DRAFT_TTL_MS = 30 * 60_000
export const SCHEDULE_MISSED_AFTER_MS = 30 * 60_000

/** India has no DST: one resolved minute per hour guarantees a minimum one-hour interval. */
export function scheduleCron(cron: string, now: Date) {
  if (
    cron.length > 120 ||
    cron.trim().split(/\s+/).length !== 5 ||
    !cron
      .trim()
      .split(/\s+/)
      .every((field) => /^[0-9*,/-]+$/.test(field))
  )
    throw new Error('Use a valid five-field numeric cron in Asia/Kolkata.')
  const expression = CronExpressionParser.parse(cron, { currentDate: now, tz: SCHEDULE_TIMEZONE })
  if (expression.fields.minute.values.length !== 1)
    throw new Error('Schedules must be at least one hour apart; choose one minute per hour.')
  return expression
}

export function nextScheduleTimes(cron: string, now: Date): Date[] {
  return scheduleCron(cron, now)
    .take(3)
    .map((date) => date.toDate())
}

/** Revalidate cached templates before activation or issuing a scheduled browser task. */
export function validateScheduleTemplate(site: string, action: string, value: unknown) {
  const found = getSiteAction(site, action)
  const spec = browserTaskSpecV1.parse(value)
  if (
    !found ||
    !isAllowedOrigin(found.site, spec.targetUrl) ||
    !found.action.targetUrlPattern.test(spec.targetUrl)
  )
    throw new Error('Unsupported schedule target.')
  if (
    spec.composeNote
      ? !found.action.application
      : spec.fields.length !== found.action.fields.length ||
        found.action.fields.some(
          (field) => !spec.fields.some((candidate) => candidate.key === field.key),
        )
  )
    throw new Error('Invalid schedule fields.')
  return spec
}

interface ResolvedScheduleDraft {
  outcome: ScheduleResolution
  scheduleId?: string
  nextRunAt?: Date
}

export type ScheduleResolution = 'saved' | 'cancelled' | 'stale'

/** Called only after the delivered draft card and its expiry have been validated. */
export async function resolveScheduleDraft(
  db: Db,
  options: {
    messageId: string
    save: boolean
    expiresAt: Date
    now?: Date
  },
): Promise<ResolvedScheduleDraft> {
  return db
    .transaction<ResolvedScheduleDraft>(async (tx) => {
      const [message] = await tx
        .select()
        .from(telegramMessages)
        .where(eq(telegramMessages.id, options.messageId))
        .for('update')
        .limit(1)
      const now = options.now ?? new Date()
      if (
        message?.direction !== 'inbound' ||
        message.payload.browserScheduleResolution ||
        options.expiresAt <= now
      )
        return { outcome: 'stale' }
      const parsed = intakePlanV1.safeParse(message.payload.browserIntake)
      if (!parsed.success || parsed.data.kind !== 'schedule') return { outcome: 'stale' }
      let saved: { id: string; nextRunAt: Date } | undefined
      if (options.save) {
        const plan = parsed.data
        const spec = validateScheduleTemplate(plan.site, plan.action, plan.spec)
        const [nextRunAt] = nextScheduleTimes(plan.cron, now)
        if (!nextRunAt) throw new Error('Schedule has no next occurrence.')
        const [created] = await tx
          .insert(browserSchedules)
          .values({
            cron: plan.cron,
            timezone: SCHEDULE_TIMEZONE,
            instruction: message.text,
            site: plan.site,
            action: plan.action,
            specTemplate: spec,
            nextRunAt,
            createdFromMessageId: message.id,
          })
          .returning({ id: browserSchedules.id, nextRunAt: browserSchedules.nextRunAt })
        saved = created
      }
      const outcome = options.save ? 'saved' : 'cancelled'
      await tx
        .update(telegramMessages)
        .set({ payload: { ...message.payload, browserScheduleResolution: outcome } })
        .where(eq(telegramMessages.id, message.id))
      return { outcome, ...(saved ? { scheduleId: saved.id, nextRunAt: saved.nextRunAt } : {}) }
    })
    .catch(() => {
      throw new Error('Could not update the browser schedule draft.')
    })
}

export async function disableBrowserSchedule(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(browserSchedules)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(browserSchedules.id, id), eq(browserSchedules.enabled, true)))
    .returning({ id: browserSchedules.id })
  return rows.length > 0
}

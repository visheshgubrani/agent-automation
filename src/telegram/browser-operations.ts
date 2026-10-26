/** Read-only lists and explicit schedule/task controls. List callbacks bind to stored cards. */
import { and, desc, eq, inArray } from 'drizzle-orm'
import { BROWSER_TASK_HOLDING_STATUSES, BROWSER_TASK_OPEN_STATUSES } from '../agent/contracts.js'
import { formatScheduleTime, shortTaskId, taskLabels } from '../agent/render.js'
import { disableBrowserSchedule, resolveScheduleDraft } from '../agent/schedules.js'
import {
  enqueueResultNotice,
  findOutboxRowForMessage,
  getBrowserTask,
  requestTaskCancel,
} from '../agent/tasks.js'
import { browserSchedules, browserTasks, telegramMessages } from '../db/schema/index.js'
import type { BrowserHandlerContext } from './browser.js'
import type { InlineButtonRows } from './buttons.js'

const PAGE_SIZE = 5
const LIST_TTL_MS = 30 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
interface ListMeta {
  version: 1
  offset: number
  ids: string[]
  expiresAt: string
}

async function storedList(
  context: BrowserHandlerContext,
  messageId: number,
  key: string,
): Promise<ListMeta | undefined> {
  const [row] = await context.db
    .select({ payload: telegramMessages.payload })
    .from(telegramMessages)
    .where(
      and(
        eq(telegramMessages.chatId, context.chatDbId),
        eq(telegramMessages.direction, 'outbound'),
        eq(telegramMessages.telegramMessageId, messageId),
      ),
    )
    .limit(1)
  const value = row?.payload[key] as Partial<ListMeta> | undefined
  if (
    value?.version !== 1 ||
    !Number.isInteger(value.offset) ||
    !Array.isArray(value.ids) ||
    value.ids.length > PAGE_SIZE ||
    !value.ids.every((id) => typeof id === 'string' && UUID.test(id)) ||
    typeof value.expiresAt !== 'string' ||
    !(new Date(value.expiresAt).getTime() > Date.now())
  )
    return undefined
  return value as ListMeta
}

export async function isTaskListCard(
  context: BrowserHandlerContext,
  messageId: number,
  taskId: string,
): Promise<boolean> {
  return (await storedList(context, messageId, 'browserTaskList'))?.ids.includes(taskId) ?? false
}

function pagination(prefix: string, offset: number, more: boolean): InlineButtonRows {
  const row = []
  if (offset > 0)
    row.push({
      text: 'Previous',
      callbackData: `${prefix}:list:${Math.max(0, offset - PAGE_SIZE)}`,
    })
  if (more) row.push({ text: 'Next', callbackData: `${prefix}:list:${offset + PAGE_SIZE}` })
  return row.length ? [row] : []
}

export async function showBrowserList(
  context: BrowserHandlerContext,
  kind: 'tasks' | 'schedules',
  offset = 0,
  messageId?: number,
): Promise<void> {
  const rows =
    kind === 'tasks'
      ? await context.db
          .select()
          .from(browserTasks)
          .orderBy(desc(browserTasks.createdAt), desc(browserTasks.id))
          .limit(PAGE_SIZE + 1)
          .offset(offset)
      : await context.db
          .select()
          .from(browserSchedules)
          .orderBy(desc(browserSchedules.createdAt), desc(browserSchedules.id))
          .limit(PAGE_SIZE + 1)
          .offset(offset)
  const page = rows.slice(0, PAGE_SIZE)
  const lines = [kind === 'tasks' ? 'Recent browser tasks' : 'Browser schedules (Asia/Kolkata)']
  const buttons: InlineButtonRows = []
  for (const entry of page) {
    const label = taskLabels(entry.site, entry.action).actionLabel
    if ('status' in entry) {
      const state =
        entry.statusReason === 'advice_required'
          ? 'waiting for your thoughts'
          : `${entry.status}${entry.statusReason ? ` (${entry.statusReason})` : ''}`
      lines.push(`#${shortTaskId(entry.id)} — ${label}: ${state}`, entry.targetUrl.slice(0, 180))
      if (
        (BROWSER_TASK_OPEN_STATUSES as readonly string[]).includes(entry.status) &&
        entry.status !== 'executing'
      )
        buttons.push([
          { text: `Stop #${shortTaskId(entry.id)}`, callbackData: `bt:stop:${entry.id}` },
        ])
    } else {
      const target =
        typeof entry.specTemplate.targetUrl === 'string'
          ? entry.specTemplate.targetUrl.slice(0, 180)
          : ''
      lines.push(
        `#${shortTaskId(entry.id)} — ${label}: ${entry.enabled ? 'enabled' : 'disabled'}`,
        `${entry.cron}; next ${formatScheduleTime(entry.nextRunAt)}`,
        target,
      )
      if (entry.enabled)
        buttons.push([
          { text: `Disable #${shortTaskId(entry.id)}`, callbackData: `bs:off:${entry.id}` },
        ])
    }
  }
  if (!page.length) lines.push('None yet.')
  if (kind === 'schedules')
    lines.push(
      'Disabling stops future slots. Already queued tasks still need approval; use /tasks to stop them.',
    )
  buttons.push(...pagination(kind === 'tasks' ? 'bt' : 'bs', offset, rows.length > PAGE_SIZE))
  const payload = {
    [kind === 'tasks' ? 'browserTaskList' : 'browserScheduleList']: {
      version: 1,
      offset,
      ids: page.map((row) => row.id),
      expiresAt: new Date(Date.now() + LIST_TTL_MS).toISOString(),
    },
  }
  if (messageId === undefined) await context.responder.reply(lines.join('\n'), { buttons, payload })
  else await context.responder.editMessage(messageId, lines.join('\n'), { buttons, payload })
}

export async function handleBrowserOperationsCommand(
  command: string,
  context: BrowserHandlerContext,
): Promise<void> {
  if (command === 'tasks' || command === 'schedules') return showBrowserList(context, command)
  const [active] = await context.db
    .select()
    .from(browserTasks)
    .where(inArray(browserTasks.status, [...BROWSER_TASK_HOLDING_STATUSES]))
    .limit(1)
  if (!active) {
    await context.responder.reply('No active browser task. Use /tasks to stop a queued task.')
    return
  }
  if (active.status === 'executing') {
    await context.responder.reply(
      'The approved submission is already executing. It will finish without another click.',
    )
    return
  }
  const outcome = await requestTaskCancel(context.db, {
    taskId: active.id,
    resolverRef: `update:${context.updateId}`,
  })
  if (outcome === 'cancelled') {
    const task = await getBrowserTask(context.db, active.id)
    if (task) await enqueueResultNotice(context.db, { task, runId: context.runId })
  }
  await context.responder.reply(
    outcome === 'requested'
      ? 'Stopping the active task.'
      : outcome === 'cancelled'
        ? 'Cancelled the active task.'
        : 'The task already finished.',
  )
}

export async function handleBrowserOperationsCallback(
  data: string,
  messageId: number | undefined,
  context: BrowserHandlerContext,
): Promise<void> {
  if (messageId === undefined) {
    await context.responder.answerCallback('This action needs a message context.')
    return
  }
  if (data === 'bs:save' || data === 'bs:cancel') {
    const row = await findOutboxRowForMessage(context.db, messageId)
    const meta = row?.payload.browserScheduleDraft as
      | { version?: unknown; messageId?: unknown }
      | undefined
    if (
      row?.status !== 'sent' ||
      meta?.version !== 1 ||
      typeof meta.messageId !== 'string' ||
      !UUID.test(meta.messageId) ||
      row.dedupeKey !== `browser:intake:${meta.messageId}:schedule` ||
      !row.expiresAt ||
      row.expiresAt <= new Date()
    ) {
      await context.responder.answerCallback(
        'This schedule draft was already handled or has expired.',
      )
      return
    }
    if (data === 'bs:save' && !context.enqueue) {
      await context.responder.answerCallback('Browser tasks are not enabled on this worker.')
      return
    }
    const result = await resolveScheduleDraft(context.db, {
      messageId: meta.messageId,
      save: data === 'bs:save',
      expiresAt: row.expiresAt,
    })
    await context.responder.answerCallback(
      result.outcome === 'stale'
        ? 'This schedule draft was already handled or has expired.'
        : result.outcome === 'cancelled'
          ? 'Schedule draft cancelled.'
          : `Schedule saved. Next: ${formatScheduleTime(result.nextRunAt as Date)} (Asia/Kolkata). Every submit needs approval.`,
    )
    return
  }
  const list = /^(bt|bs):list:(\d{1,4})$/.exec(data)
  if (list) {
    const kind = list[1] === 'bt' ? 'tasks' : 'schedules'
    const meta = await storedList(
      context,
      messageId,
      kind === 'tasks' ? 'browserTaskList' : 'browserScheduleList',
    )
    const offset = Number(list[2])
    if (
      !meta ||
      offset > 1000 ||
      offset % PAGE_SIZE !== 0 ||
      Math.abs(offset - meta.offset) !== PAGE_SIZE
    ) {
      await context.responder.answerCallback('This list is stale. Open it again.')
      return
    }
    await showBrowserList(context, kind, offset, messageId)
    await context.responder.answerCallback()
    return
  }
  const off = /^bs:off:(.+)$/.exec(data)
  if (off && UUID.test(off[1] ?? '')) {
    const id = off[1] as string
    const meta = await storedList(context, messageId, 'browserScheduleList')
    if (!meta?.ids.includes(id)) {
      await context.responder.answerCallback('This schedule list is stale. Open /schedules again.')
      return
    }
    const disabled = await disableBrowserSchedule(context.db, id)
    await context.responder.answerCallback(
      disabled
        ? 'Disabled future runs. Use /tasks to stop already queued tasks.'
        : 'This schedule is already disabled.',
    )
    await showBrowserList(context, 'schedules', meta.offset, messageId)
    return
  }
  await context.responder.answerCallback('Unknown browser action.')
}

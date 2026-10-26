/** Counts-only agent health. No task text, target URL, profile or raw probe error is returned. */
import { sql } from 'drizzle-orm'
import { requireBrowserCheckConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { getLlmBudgetUsageForRange } from '../db/queries/audit.js'
import { browserTasks } from '../db/schema/index.js'
import { env } from '../env.js'
import { AGENT_PURPOSE_PREFIX, getBudgetSettings, localDayRange } from '../llm/budget.js'

export async function probeBrowserReachability(cdpUrl: string): Promise<boolean> {
  try {
    const url = new URL(cdpUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password)
      return false
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
      return await new Promise<boolean>((resolve) => {
        const socket = new WebSocket(url)
        const settle = (reachable: boolean) => {
          clearTimeout(timer)
          try {
            socket.close()
          } catch {}
          resolve(reachable)
        }
        const timer = setTimeout(() => settle(false), 2_000)
        socket.addEventListener('open', () => settle(true), { once: true })
        socket.addEventListener('error', () => settle(false), { once: true })
      })
    }
    if (!['http:', 'https:'].includes(url.protocol)) return false
    const response = await fetch(new URL('/json/version', url), {
      signal: AbortSignal.timeout(2_000),
      redirect: 'error',
    })
    try {
      return response.ok
    } finally {
      await response.body?.cancel()
    }
  } catch {
    return false
  }
}

export interface AgentHealthView {
  enabled: boolean
  browserReachable: boolean | null
  tasks: {
    queued: number
    running: number
    waitingForHuman: number
    awaitingApproval: number
    outcomeUnknown: number
    interrupted: number
  }
  spend: {
    dayKey: string
    timezone: string
    actualUsd: number
    reservedUsd: number
    totalUsd: number
    inFlight: number
    unknown: number
    agentDailyLimitUsd: number | null
    globalDailyLimitUsd: number | null
    globalTotalUsd: number
  }
}

export function emptyAgentHealth(enabled = env.AGENT_ENABLED): AgentHealthView {
  return {
    enabled,
    browserReachable: null,
    tasks: {
      queued: 0,
      running: 0,
      waitingForHuman: 0,
      awaitingApproval: 0,
      outcomeUnknown: 0,
      interrupted: 0,
    },
    spend: {
      dayKey: '',
      timezone: 'Asia/Kolkata',
      actualUsd: 0,
      reservedUsd: 0,
      totalUsd: 0,
      inFlight: 0,
      unknown: 0,
      agentDailyLimitUsd: null,
      globalDailyLimitUsd: null,
      globalTotalUsd: 0,
    },
  }
}

export async function getAgentStatus(
  db: Db,
  options: { now?: Date; enabled?: boolean; probe?: () => Promise<boolean> } = {},
): Promise<AgentHealthView> {
  const now = options.now ?? new Date()
  const enabled = options.enabled ?? env.AGENT_ENABLED
  const settings = await getBudgetSettings(db)
  const range = localDayRange(now, settings.timezone)
  const probe =
    options.probe ??
    (() => {
      try {
        return probeBrowserReachability(requireBrowserCheckConfig(env).cdpUrl)
      } catch {
        return Promise.resolve(false)
      }
    })
  const [rows, usage, global, browserReachable] = await Promise.all([
    db
      .select({
        queued: sql<number>`count(*) filter (where ${browserTasks.status} = 'queued')::int`,
        running: sql<number>`count(*) filter (where ${browserTasks.status} in ('running', 'executing'))::int`,
        waitingForHuman: sql<number>`count(*) filter (where ${browserTasks.status} = 'waiting_for_human')::int`,
        awaitingApproval: sql<number>`count(*) filter (where ${browserTasks.status} = 'awaiting_approval')::int`,
        outcomeUnknown: sql<number>`count(*) filter (where ${browserTasks.status} = 'outcome_unknown')::int`,
        interrupted: sql<number>`count(*) filter (where ${browserTasks.statusReason} = 'interrupted')::int`,
      })
      .from(browserTasks),
    getLlmBudgetUsageForRange(db, range.start, range.end, { purposePrefix: AGENT_PURPOSE_PREFIX }),
    getLlmBudgetUsageForRange(db, range.start, range.end),
    enabled ? probe().catch(() => false) : Promise.resolve(null),
  ])
  return {
    enabled,
    browserReachable,
    tasks: rows[0] ?? emptyAgentHealth().tasks,
    spend: {
      dayKey: range.dayKey,
      timezone: settings.timezone,
      actualUsd: usage.actualUsd,
      reservedUsd: usage.reservedUsd,
      totalUsd: usage.totalUsd,
      inFlight: usage.inFlight,
      unknown: usage.unknown,
      agentDailyLimitUsd: settings.agentDailyLimitUsd,
      globalDailyLimitUsd: settings.dailyLimitUsd,
      globalTotalUsd: global.totalUsd,
    },
  }
}

export function agentHeartbeatLine(status: AgentHealthView): string | null {
  const tasks = status.tasks
  if (!status.enabled && !Object.values(tasks).some(Boolean) && status.spend.totalUsd === 0)
    return null
  return `agent: browser ${status.enabled ? (status.browserReachable ? 'reachable' : 'unreachable') : 'disabled'}; ${tasks.awaitingApproval} awaiting approval, ${tasks.outcomeUnknown} unknown, ${tasks.interrupted} interrupted; $${status.spend.actualUsd.toFixed(2)} spent + $${status.spend.reservedUsd.toFixed(2)} reserved / ${status.spend.agentDailyLimitUsd === null ? 'no sub-limit' : `$${status.spend.agentDailyLimitUsd.toFixed(2)}`} today`
}

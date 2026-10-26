import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { latestSnapshotOnly } from '../src/agent/browser-agent.js'
import type { BrowserSubmitApprovalPayloadV1 } from '../src/agent/contracts.js'
import { normalizeRedditThreadUrl, parseCommentCommand } from '../src/agent/intake.js'
import {
  renderApprovalCard,
  renderIntakeUsage,
  renderQueuedCard,
  renderRecoveryNotice,
  renderResultCard,
  resultButtons,
  shortTaskId,
} from '../src/agent/render.js'
import type { BrowserTaskRow } from '../src/db/schema/browser.js'
import { parseBrowserCallback } from '../src/telegram/browser.js'
import { toTelegramReplyMarkup, validateInlineButtons } from '../src/telegram/buttons.js'
import { THREAD_URL } from './fakes/browser.js'

const TASK_ID = 'abcd1234-1111-4111-8111-111111111111'
const APPROVAL_ID = 'beef1234-2222-4222-8222-222222222222'
const COMMENT = 'Exact words, with "quotes", an emoji 🙂 and a newline\nsecond line.'

function taskRow(overrides: Partial<BrowserTaskRow> = {}): BrowserTaskRow {
  return {
    id: TASK_ID,
    source: 'telegram',
    requestMessageId: null,
    retryOfTaskId: null,
    runId: null,
    site: 'reddit',
    action: 'reddit_comment',
    targetUrl: THREAD_URL,
    instruction: `Comment on ${THREAD_URL}`,
    spec: {},
    status: 'queued',
    statusReason: null,
    approvalId: null,
    cancelRequestedAt: null,
    submittedAt: null,
    result: null,
    cdpTargetId: null,
    bossJobId: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date('2026-10-25T10:00:00Z'),
    updatedAt: new Date('2026-10-25T10:00:00Z'),
    ...overrides,
  }
}

function approvalPayload(
  overrides: Partial<BrowserSubmitApprovalPayloadV1> = {},
): BrowserSubmitApprovalPayloadV1 {
  return {
    version: 1,
    taskId: TASK_ID,
    site: 'reddit',
    action: 'reddit_comment',
    targetUrl: THREAD_URL,
    pageUrl: THREAD_URL,
    fields: [
      {
        key: 'comment_text',
        label: 'Comment',
        role: 'textbox',
        name: 'Comment',
        value: COMMENT,
        provenance: 'user_verbatim',
      },
    ],
    submit: { role: 'button', name: 'Comment' },
    screenshot: { artifactId: 'c0ffee00-3333-4333-8333-333333333333', sha256: 'a'.repeat(64) },
    preparedAt: '2026-10-25T10:00:00.000Z',
    ...overrides,
  }
}

describe('parseCommentCommand', () => {
  const text = (body: string) => `/comment ${THREAD_URL}\n${body}`

  it('parses the thread URL and optional thoughts', () => {
    const command = parseCommentCommand(text(COMMENT))
    expect(command).toEqual({ targetUrl: THREAD_URL, thoughts: COMMENT })
  })

  it('accepts same-line thoughts', () => {
    expect(parseCommentCommand(`/comment ${THREAD_URL} imo start small`)).toEqual({
      targetUrl: THREAD_URL,
      thoughts: 'imo start small',
    })
  })

  it('normalizes old and bare reddit hosts to the canonical origin', () => {
    expect(
      normalizeRedditThreadUrl('https://old.reddit.com/r/test/comments/abc123/a_thread/?sort=top'),
    ).toBe('https://www.reddit.com/r/test/comments/abc123/a_thread/?sort=top')
    expect(normalizeRedditThreadUrl('https://reddit.com/r/test/comments/abc123')).toBe(
      'https://www.reddit.com/r/test/comments/abc123',
    )
  })

  it('accepts a bot-name command suffix and trims surrounding whitespace', () => {
    const command = parseCommentCommand(`/comment@my_bot ${THREAD_URL}\n\n  hello  \n`)
    expect(command).toEqual({ targetUrl: THREAD_URL, thoughts: 'hello' })
  })

  it('rejects a non-reddit URL, plain http, a missing thread path, and a missing thread', () => {
    expect(parseCommentCommand(`/comment https://evil.example/\ntext`)).toBeUndefined()
    expect(
      parseCommentCommand(`/comment http://www.reddit.com/r/test/comments/abc123/\ntext`),
    ).toBeUndefined()
    expect(parseCommentCommand('/comment https://www.reddit.com/r/test/\ntext')).toBeUndefined()
    expect(parseCommentCommand(`/comment ${THREAD_URL}`)).toEqual({
      targetUrl: THREAD_URL,
      thoughts: '',
    })
    expect(parseCommentCommand(`/comment ${THREAD_URL}\n   \n`)).toEqual({
      targetUrl: THREAD_URL,
      thoughts: '',
    })
  })

  it('rejects text beyond the v1 field bound', () => {
    expect(parseCommentCommand(text('x'.repeat(3_001)))).toBeUndefined()
    expect(parseCommentCommand(text('x'.repeat(3_000)))?.thoughts).toHaveLength(3_000)
  })

  it('explains the command shape', () => {
    expect(renderIntakeUsage()).toContain('/comment <reddit thread url>')
  })
})

describe('approval and result cards', () => {
  it('prints every field value exactly and marks drafted text', () => {
    const expiresAt = new Date('2026-10-25T10:30:00Z')
    const text = renderApprovalCard(approvalPayload(), { expiresAt })
    expect(text).toContain(`Comment (verbatim):\n${COMMENT}`)
    expect(text).toContain(`Target: ${THREAD_URL}`)
    expect(text).toContain('Submit button: button "Comment"')
    expect(text).toContain('Expires 2026-10-25 10:30 UTC')
    expect(text).not.toContain('drafted')

    const drafted = renderApprovalCard(
      approvalPayload({
        fields: [
          {
            key: 'comment_text',
            label: 'Comment',
            role: 'textbox',
            name: 'Comment',
            value: 'Agent-written note',
            provenance: 'drafted',
          },
        ],
      }),
      { expiresAt },
    )
    expect(drafted).toContain('Comment (drafted):\nAgent-written note')
  })

  it('shows the page when it differs from the target', () => {
    const text = renderApprovalCard(approvalPayload({ pageUrl: `${THREAD_URL}?sort=new` }), {
      expiresAt: new Date(),
    })
    expect(text).toContain(`Page: ${THREAD_URL}?sort=new`)
  })

  it('renders a short queued card with the task id', () => {
    const text = renderQueuedCard(taskRow())
    expect(shortTaskId(TASK_ID)).toBe('abcd')
    expect(text).toContain('Task #abcd queued: Reddit comment on')
    expect(text).toContain('Tap Stop to cancel')
  })

  it('renders each terminal status and its retry/open-browser buttons', () => {
    const viewUrl = 'https://box.tail1234.ts.net/'
    const failed = taskRow({ status: 'failed', statusReason: 'login_required' })
    expect(renderResultCard(failed)).toContain('Log in through the browser view')
    expect(resultButtons(failed, { viewUrl })).toEqual([
      [{ text: 'Open browser', url: viewUrl }],
      [{ text: 'Retry', callbackData: `bt:retry:${TASK_ID}` }],
    ])

    const unknown = taskRow({ status: 'outcome_unknown', submittedAt: new Date() })
    expect(renderResultCard(unknown)).toContain('outcome is unknown')
    expect(resultButtons(unknown, { viewUrl })[0]).toEqual([{ text: 'Open browser', url: viewUrl }])

    const unverified = taskRow({ status: 'unverified', submittedAt: new Date() })
    expect(renderResultCard(unverified)).toContain('Submitted, not verified')

    const succeeded = taskRow({ status: 'succeeded', submittedAt: new Date() })
    expect(resultButtons(succeeded, { viewUrl })).toEqual([])

    const cancelled = taskRow({ status: 'cancelled', statusReason: 'cancelled_by_user' })
    expect(renderResultCard(cancelled)).toContain('Cancelled. Nothing was submitted.')
    expect(resultButtons(cancelled, { viewUrl })).toEqual([])
  })

  it('renders each failure reason and the recovery notice', () => {
    for (const [reason, expected] of [
      ['daily_cap', 'Daily cap reached'],
      ['approval_expired', 'approval expired'],
      ['budget_exhausted', 'budget is used up'],
      ['step_limit', 'step limit'],
      ['interrupted', 'worker restarted'],
    ] as const) {
      expect(renderResultCard(taskRow({ status: 'failed', statusReason: reason }))).toContain(
        expected,
      )
    }
    expect(renderRecoveryNotice(taskRow({ status: 'outcome_unknown' }))).toContain(
      'outcome is unknown',
    )
    expect(renderRecoveryNotice(taskRow({ status: 'failed' }))).toContain('Nothing was submitted')
  })
})

describe('callback parsing and buttons', () => {
  it('parses the four bt: callbacks and rejects anything malformed', () => {
    expect(parseBrowserCallback(`bt:ap:${APPROVAL_ID}`)).toEqual({
      kind: 'approve',
      id: APPROVAL_ID,
    })
    expect(parseBrowserCallback(`bt:no:${APPROVAL_ID}`)).toEqual({ kind: 'deny', id: APPROVAL_ID })
    expect(parseBrowserCallback(`bt:stop:${TASK_ID}`)).toEqual({ kind: 'stop', id: TASK_ID })
    expect(parseBrowserCallback(`bt:retry:${TASK_ID}`)).toEqual({ kind: 'retry', id: TASK_ID })
    expect(parseBrowserCallback('bt:ap:not-a-uuid')).toBeUndefined()
    expect(parseBrowserCallback(`mail:useful:${APPROVAL_ID}`)).toBeUndefined()
    expect(parseBrowserCallback(`bt:go:${TASK_ID}`)).toEqual({ kind: 'start', id: TASK_ID })
  })

  it('accepts https URL buttons and rejects unsafe or mixed buttons', () => {
    expect(
      validateInlineButtons([[{ text: 'Open browser', url: 'https://box.tail1234.ts.net/' }]]),
    ).toEqual([[{ text: 'Open browser', url: 'https://box.tail1234.ts.net/' }]])
    expect(validateInlineButtons([[{ text: 'x', url: 'http://box.ts.net/' }]])).toBeUndefined()
    expect(
      validateInlineButtons([[{ text: 'x', url: 'https://user:pass@box.ts.net/' }]]),
    ).toBeUndefined()
    expect(
      validateInlineButtons([[{ text: 'x', callbackData: 'bt:stop:a', url: 'https://a.ts.net' }]]),
    ).toBeUndefined()
    expect(validateInlineButtons([[{ text: 'x' }]])).toBeUndefined()

    expect(
      toTelegramReplyMarkup([[{ text: 'Open', url: 'https://box.tail1234.ts.net/' }]]),
    ).toEqual({ inline_keyboard: [[{ text: 'Open', url: 'https://box.tail1234.ts.net/' }]] })
  })
})

describe('latestSnapshotOnly', () => {
  it('replaces every older snapshot result and keeps the newest', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Comment on the thread.' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'snapshot', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'snapshot',
            output: { type: 'text', value: 'OLD SNAPSHOT' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c2', toolName: 'fill_field', input: { ref: '1:e1' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c2',
            toolName: 'fill_field',
            output: { type: 'text', value: 'filled comment_text' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c3', toolName: 'snapshot', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c3',
            toolName: 'snapshot',
            output: { type: 'text', value: 'NEW SNAPSHOT' },
          },
        ],
      },
    ]

    const bounded = latestSnapshotOnly(messages)
    const text = (index: number): string => {
      const message = bounded[index]
      if (message?.role !== 'tool') throw new Error(`message ${index} is not a tool message`)
      const part = message.content[0]
      if (part?.type !== 'tool-result' || part.output.type !== 'text') {
        throw new Error('expected a text tool result')
      }
      return part.output.value
    }
    expect(text(2)).toBe('[superseded by a newer snapshot]')
    expect(text(4)).toBe('filled comment_text')
    expect(text(6)).toBe('NEW SNAPSHOT')
  })
})

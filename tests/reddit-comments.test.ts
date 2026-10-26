import { describe, expect, it } from 'vitest'
import { validateCommentComposition } from '../src/agent/comments.js'
import { browserTaskSpecV1 } from '../src/agent/contracts.js'
import { buildCommentSpec, parseCommentCommand, validateIntakeOutput } from '../src/agent/intake.js'
import { isActionTargetPage } from '../src/browser/guards.js'
import { getSiteAction } from '../src/browser/sites.js'
import { THREAD_URL } from './fakes/browser.js'

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing test fixture.')
  return value
}

describe('thread-aware comment contracts', () => {
  it.each(['', ' imo start small', '\nfirst thought\nsecond thought'])(
    'defers composition until the thread is read (%s)',
    (suffix) => {
      const command = parseCommentCommand(`/comment ${THREAD_URL}${suffix}`)
      expect(command).toEqual({ targetUrl: THREAD_URL, thoughts: suffix.trim() })
      expect(buildCommentSpec(required(command))).toEqual({
        version: 1,
        targetUrl: THREAD_URL,
        fields: [],
        composeComment: { thoughts: suffix.trim(), priorRunIds: [] },
      })
    },
  )
  it('keeps existing prepared fields and rejects pending-plus-prepared or dual composers', () => {
    const prepared = {
      version: 1,
      targetUrl: THREAD_URL,
      fields: [{ key: 'comment_text', value: 'Exact words.', provenance: 'user_verbatim' }],
    }
    expect(browserTaskSpecV1.parse(prepared)).toEqual(prepared)
    expect(browserTaskSpecV1.safeParse({ ...prepared, composeComment: {} }).success).toBe(false)
    expect(
      browserTaskSpecV1.safeParse({
        ...prepared,
        fields: [],
        composeComment: {},
        composeNote: true,
      }).success,
    ).toBe(false)
    const plan = validateIntakeOutput(
      {
        kind: 'one_off',
        site: 'reddit',
        action: 'reddit_comment',
        targetUrl: THREAD_URL,
        fields: prepared.fields,
        cron: null,
        question: null,
      },
      `Comment on ${THREAD_URL}\nExact words.`,
    )
    expect(plan).toMatchObject({ spec: prepared })
  })
  it('pins the post ID while allowing slug/query changes within that thread', () => {
    const action = required(getSiteAction('reddit', 'reddit_comment')).action
    expect(
      isActionTargetPage(action, THREAD_URL, THREAD_URL.replace('a_thread/', 'updated/?sort=top')),
    ).toBe(true)
    for (const target of [
      THREAD_URL.replace('abc123', 'abc124'),
      THREAD_URL.replace('www.reddit.com', 'evil.example'),
    ])
      expect(isActionTargetPage(action, THREAD_URL, target)).toBe(false)
  })
})

describe('comment composition validation', () => {
  it('accepts casual drafts and one question, and enforces the complete output contract', () => {
    const text = 'imo i’d start small and see how it goes'
    expect(validateCommentComposition({ kind: 'draft', text, question: null }, false)).toEqual({
      kind: 'draft',
      text,
    })
    expect(
      validateCommentComposition(
        { kind: 'needs_input', text: null, question: 'what was your experience?' },
        false,
      ),
    ).toEqual({ kind: 'needs_input', question: 'what was your experience?' })
    for (const value of [
      { kind: 'draft', text: 'a'.repeat(801), question: null },
      { kind: 'draft', text: ' ', question: null },
      { kind: 'draft', text: 'hello', question: 'also a question?' },
      { kind: 'needs_input', text: null, question: 'a'.repeat(301) },
      { kind: 'draft', text, question: null, targetUrl: 'https://evil.example' },
      { kind: 'unable', text: null, question: null },
    ])
      expect(() => validateCommentComposition(value, false)).toThrow()
    expect(() =>
      validateCommentComposition({ kind: 'needs_input', text: null, question: 'again?' }, true),
    ).toThrow()
  })
})

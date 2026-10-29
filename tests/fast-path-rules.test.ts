import { describe, expect, it } from 'vitest'
import {
  type FastAction,
  type FastPathState,
  nextFastAction,
  progressSignature,
  siteCheckRefs,
} from '../src/agent/fast-path-rules.js'
import { matchesElement } from '../src/browser/guards.js'
import { getSiteAction, type SiteAction } from '../src/browser/sites.js'
import { parseSnapshotElements } from '../src/browser/snapshot.js'
import {
  redditComposer,
  redditLongComposer,
  redditLongThread,
  redditPostComposer,
  redditThread,
} from './fakes/browser.js'

function action(site: string, key: string): SiteAction {
  const found = getSiteAction(site, key)
  if (!found) throw new Error(`${key} must be registered`)
  return found.action
}

const comment = action('reddit', 'reddit_comment')
const post = action('reddit', 'reddit_post')
const waas = action('waas', 'waas_apply')

function state(
  forAction: SiteAction,
  snapshot: string,
  overrides: Partial<Omit<FastPathState, 'action' | 'elements'>> = {},
): FastPathState {
  return {
    action: forAction,
    generation: 3,
    elements: parseSnapshotElements(snapshot),
    specKeys: new Set(forAction.fields.map((field) => field.key)),
    filled: new Set(),
    opened: new Set(),
    ...overrides,
  }
}

const lines = (...rows: string[]) => ['- main [ref=e1]:', ...rows].join('\n')

describe('fast path rules: Reddit comments', () => {
  it('opens the composer, fills the one editor, then approves from the current snapshot', () => {
    expect(nextFastAction(state(comment, redditThread().snapshot))).toEqual({
      op: 'click_opener',
      ref: '3:e8',
    })
    expect(nextFastAction(state(comment, redditComposer().snapshot))).toEqual({
      op: 'fill_field',
      ref: '3:e20',
      fieldKey: 'comment_text',
    })
    expect(
      nextFastAction(
        state(comment, redditComposer().snapshot, { filled: new Set(['comment_text']) }),
      ),
    ).toEqual({ op: 'approve', submitRef: '3:e22', fieldRefs: { comment_text: '3:e20' } })
  })

  it('clicks a collapsed composer past the cut once, then fills the opened editor', () => {
    expect(nextFastAction(state(comment, redditLongThread().snapshot))).toEqual({
      op: 'click_opener',
      ref: '3:e8',
    })
    // The same collapsed box after a click that opened nothing: no second click.
    expect(
      nextFastAction(
        state(comment, redditLongThread().snapshot, { opened: new Set(['textbox|']) }),
      ),
    ).toEqual({ op: 'hand_off', reason: 'no_form' })
    expect(nextFastAction(state(comment, redditLongComposer().snapshot))).toEqual({
      op: 'fill_field',
      ref: '3:e20',
      fieldKey: 'comment_text',
    })
  })

  it('hands off two possible editors unless exactly one is focused or a site check rules one out', () => {
    const two = lines(
      '  - textbox "Comment" [ref=e20]',
      '  - textbox "Reply" [ref=e30]',
      '  - button "Comment" [ref=e22]',
    )
    expect(nextFastAction(state(comment, two))).toEqual({
      op: 'hand_off',
      reason: 'ambiguous_field',
    })
    expect(nextFastAction(state(comment, two, { excluded: new Set(['e30']) }))).toMatchObject({
      op: 'fill_field',
      ref: '3:e20',
    })
    const focused = two.replace('"Reply" [ref=e30]', '"Reply" [active] [ref=e30]')
    expect(nextFastAction(state(comment, focused))).toMatchObject({
      op: 'fill_field',
      ref: '3:e30',
    })
  })

  it('never offers a disabled editor and approves only an enabled commit control', () => {
    const disabledField = lines(
      '  - textbox "Comment" [disabled] [ref=e20]',
      '  - button "Comment" [ref=e22]',
    )
    expect(nextFastAction(state(comment, disabledField))).toEqual({
      op: 'hand_off',
      reason: 'no_form',
    })
    const disabledCommit = lines(
      '  - textbox "Comment" [ref=e20]',
      '  - button "Comment" [disabled] [ref=e22]',
    )
    // A disabled commit control still marks the form as open.
    expect(nextFastAction(state(comment, disabledCommit))).toMatchObject({ op: 'fill_field' })
    expect(
      nextFastAction(state(comment, disabledCommit, { filled: new Set(['comment_text']) })),
    ).toEqual({ op: 'hand_off', reason: 'ambiguous_approval' })
  })

  it('checks only Reddit comment editors and commit controls against the site', () => {
    const elements = parseSnapshotElements(redditComposer().snapshot)
    expect(siteCheckRefs(comment, elements)).toEqual(['e20', 'e22'])
    expect(siteCheckRefs(post, parseSnapshotElements(redditPostComposer().snapshot))).toEqual([])
  })
})

describe('fast path rules: posts and applications', () => {
  it('fills a multi-field post in registry order, then approves with distinct refs', () => {
    const snapshot = redditPostComposer().snapshot
    expect(nextFastAction(state(post, snapshot))).toEqual({
      op: 'fill_field',
      ref: '3:e20',
      fieldKey: 'post_title',
    })
    expect(nextFastAction(state(post, snapshot, { filled: new Set(['post_title']) }))).toEqual({
      op: 'fill_field',
      ref: '3:e21',
      fieldKey: 'post_body',
    })
    expect(
      nextFastAction(state(post, snapshot, { filled: new Set(['post_title', 'post_body']) })),
    ).toEqual({
      op: 'approve',
      submitRef: '3:e22',
      fieldRefs: { post_title: '3:e20', post_body: '3:e21' },
    })
  })

  it('opens a missing body with the Text tab, and hands off when it stays missing', () => {
    const noBody = lines(
      '  - tab "Text" [ref=e3]',
      '  - textbox "Title" [ref=e20]',
      '  - button "Post" [ref=e22]',
    )
    const titled = { filled: new Set(['post_title']) }
    expect(nextFastAction(state(post, noBody, titled))).toEqual({
      op: 'click_opener',
      ref: '3:e3',
    })
    expect(
      nextFastAction(state(post, noBody, { ...titled, opened: new Set(['tab|Text']) })),
    ).toEqual({ op: 'hand_off', reason: 'no_form' })
  })

  it('refuses to approve when one element would carry two fields', () => {
    const shared: SiteAction = {
      ...post,
      fields: post.fields.map(({ name: _name, ...field }) => field),
    }
    const snapshot = lines('  - textbox "Anything" [ref=e20]', '  - button "Post" [ref=e22]')
    expect(
      nextFastAction(state(shared, snapshot, { filled: new Set(['post_title', 'post_body']) })),
    ).toEqual({ op: 'hand_off', reason: 'ambiguous_approval' })
  })

  it('clicks Apply once, treating duplicate Apply buttons as one control', () => {
    const job = lines('  - heading "Engineer" [ref=e2]', '  - button "Apply" [ref=e8]')
    expect(nextFastAction(state(waas, job))).toEqual({ op: 'click_opener', ref: '3:e8' })
    const twice = lines('  - button "Apply" [ref=e8]', '  - button "Apply" [ref=e9]')
    expect(nextFastAction(state(waas, twice))).toEqual({ op: 'click_opener', ref: '3:e8' })
    const different = lines('  - button "Apply" [ref=e8]', '  - button "Apply now" [ref=e9]')
    expect(nextFastAction(state(waas, different))).toEqual({
      op: 'hand_off',
      reason: 'ambiguous_opener',
    })
    expect(nextFastAction(state(waas, job, { opened: new Set(['button|Apply']) }))).toEqual({
      op: 'hand_off',
      reason: 'no_form',
    })
  })

  it('hands off when the spec lacks a field the approval needs', () => {
    expect(
      nextFastAction(
        state(post, redditPostComposer().snapshot, { specKeys: new Set(['post_title']) }),
      ),
    ).toEqual({ op: 'hand_off', reason: 'missing_field' })
  })
})

describe('fast path rules: invariants', () => {
  it('never targets a commit control before approval', () => {
    const fixtures: [SiteAction, string][] = [
      [comment, redditThread().snapshot],
      [comment, redditComposer().snapshot],
      [comment, redditLongThread().snapshot],
      [comment, redditLongComposer().snapshot],
      [post, redditPostComposer().snapshot],
      [waas, lines('  - button "Send" [ref=e22]', '  - button "Apply" [ref=e8]')],
      [waas, lines('  - textbox "Application note" [ref=e20]', '  - button "Send" [ref=e22]')],
    ]
    for (const [forAction, snapshot] of fixtures) {
      const current = state(forAction, snapshot)
      const decision: FastAction = nextFastAction(current)
      if (decision.op !== 'fill_field' && decision.op !== 'click_opener') continue
      const element = current.elements.get(decision.ref.split(':')[1] ?? '')
      expect(element && matchesElement(forAction.commit, element)).toBe(false)
    }
  })

  it('ignores refs and generations in the progress signature', () => {
    const first = state(comment, redditComposer().snapshot)
    const renumbered = state(comment, redditComposer().snapshot.replaceAll('ref=e2', 'ref=e9'), {
      generation: 7,
    })
    expect(progressSignature(renumbered)).toBe(progressSignature(first))
    expect(
      progressSignature(state(comment, redditComposer().snapshot, { filled: new Set(['x']) })),
    ).not.toBe(progressSignature(first))
  })
})

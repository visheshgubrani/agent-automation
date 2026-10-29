import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type FastPathState, nextFastAction, siteCheckRefs } from '../src/agent/fast-path-rules.js'
import { PlaywrightPage } from '../src/browser/playwright-driver.js'
import { REDDIT_POST_BODY_MAX_CHARS } from '../src/browser/reddit.js'
import { getSiteAction } from '../src/browser/sites.js'
import { parseSnapshotElements } from '../src/browser/snapshot.js'
import { THREAD_URL } from './fakes/browser.js'

const cdpUrl = process.env.BROWSER_TEST_CDP_URL
const BODY = 'primary post text. '.repeat(800)
function fixture(body = BODY) {
  return `<!doctype html><main>
    <shreddit-post id="t3_abc123" post-type="text"><h1 slot="title">primary title</h1><div slot="text-body">${body}</div></shreddit-post>
    <shreddit-post id="t3_other"><h1 slot="title">different post</h1><div slot="text-body">do not include other posts</div></shreddit-post>
    <comment-composer-host post-id="t3_abc123"><shreddit-composer data-label="Top"></shreddit-composer></comment-composer-host>
    <shreddit-comment thing-id="t1_nested"><comment-composer-host post-id="t3_abc123" parent-id="t1_nested"><shreddit-composer data-label="Nested"></shreddit-composer></comment-composer-host></shreddit-comment>
    <comment-composer-host post-id="t3_wrong"><shreddit-composer data-label="Wrong"></shreddit-composer></comment-composer-host>
    <div contenteditable="true" role="textbox" aria-label="Unowned"></div>
  </main><script>
    for (const node of document.querySelectorAll('shreddit-composer')) {
      const root = node.attachShadow({mode:'open'});
      root.innerHTML = '<div contenteditable="true" role="textbox" aria-label="'+node.dataset.label+'"></div><button>'+node.dataset.label+' submit</button>';
    }
  </script>`
}

describe.skipIf(!cdpUrl)('Reddit extraction and composer scope in real Chromium fixtures', () => {
  let browser: Browser
  let rawPage: Page
  let page: PlaywrightPage
  let html = fixture()
  beforeAll(async () => {
    browser = await chromium.connectOverCDP(cdpUrl ?? '')
    rawPage = await browser.contexts()[0].newPage()
    // Every request from this fixture tab is fulfilled locally; no live Reddit requests.
    await rawPage.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: html }))
    page = new PlaywrightPage(rawPage, { action: 5_000, navigation: 5_000 })
  })
  afterAll(async () => {
    await rawPage?.close()
    await browser?.close()
  })
  it('extracts only the requested primary post, separately bounded from the rest of the thread', async () => {
    await page.goto(THREAD_URL)
    expect(await page.readRedditPost(THREAD_URL)).toEqual({
      title: 'primary title',
      body: BODY.trim().slice(0, REDDIT_POST_BODY_MAX_CHARS),
      truncated: true,
      unavailable: false,
      media: false,
    })
    expect((await page.readRedditPost(THREAD_URL.replace('abc123', 'other'))).unavailable).toBe(
      true,
    )
  })
  it('accepts the top-level field and submit across shadow roots, and rejects nested, wrong-post and unowned elements', async () => {
    await page.goto(THREAD_URL)
    const elements = [...parseSnapshotElements(await page.ariaSnapshot()).values()]
    for (const [name, allowed] of [
      ['Top', true],
      ['Top submit', true],
      ['Nested', false],
      ['Nested submit', false],
      ['Wrong', false],
      ['Unowned', false],
    ] as const) {
      const element = elements.find((e) => e.name === name)
      if (!element) throw new Error('Missing fixture control.')
      expect(await page.isRedditCommentComposer(element.ref, THREAD_URL)).toBe(allowed)
    }
  })
  it('reports removed posts and missing primary roots without reading surrounding content', async () => {
    html = fixture('visible text').replace('post-type="text"', 'post-type="multi_media"')
    await page.goto(THREAD_URL)
    expect((await page.readRedditPost(THREAD_URL)).media).toBe(true)
    html = fixture('[removed]')
    await page.goto(THREAD_URL)
    expect((await page.readRedditPost(THREAD_URL)).unavailable).toBe(true)
    html = '<main><h1>unrelated heading</h1><p>not the primary post</p></main>'
    await page.goto(THREAD_URL)
    expect(await page.readRedditPost(THREAD_URL)).toEqual({
      title: '',
      body: '',
      truncated: false,
      unavailable: true,
      media: false,
    })
  })
  it('waits for a top-level composer that hydrates after load, ignoring the placeholder', async () => {
    // Like live Reddit: a visible placeholder outside any host, then the real composer later.
    html = `<!doctype html><main>
      <label>Join <textarea id="innerTextArea" placeholder="Join the conversation"></textarea></label>
    </main><script>
      setTimeout(() => {
        document.getElementById('innerTextArea').closest('label').hidden = true
        const host = document.createElement('comment-composer-host')
        host.setAttribute('post-id', 't3_abc123')
        host.attachShadow({mode:'open'}).innerHTML = '<textarea placeholder="Join the conversation"></textarea>'
        document.querySelector('main').append(host)
      }, 800)
    </script>`
    await page.goto(THREAD_URL)
    const started = performance.now()
    expect(await page.waitForRedditCommentComposer(THREAD_URL, 5_000)).toBe(true)
    expect(performance.now() - started).toBeGreaterThan(500)
    const box = [...parseSnapshotElements(await page.ariaSnapshot()).values()].find(
      (element) => element.role === 'textbox',
    )
    if (!box) throw new Error('missing hydrated composer')
    expect(await page.isRedditCommentComposer(box.ref, THREAD_URL)).toBe(true)
  })
  it('times out false when only reply, wrong-post or hidden composers exist, or off the thread', async () => {
    html = fixture().replace(
      '<comment-composer-host post-id="t3_abc123"><shreddit-composer data-label="Top"></shreddit-composer></comment-composer-host>',
      '<comment-composer-host post-id="t3_abc123" hidden><shreddit-composer data-label="Top"></shreddit-composer></comment-composer-host>',
    )
    await page.goto(THREAD_URL)
    expect(await page.waitForRedditCommentComposer(THREAD_URL, 600)).toBe(false)
    html = fixture()
    await page.goto(THREAD_URL)
    expect(await page.waitForRedditCommentComposer(THREAD_URL, 600)).toBe(true)
    expect(
      await page.waitForRedditCommentComposer(THREAD_URL.replace('abc123', 'other'), 600),
    ).toBe(false)
  })
})

/** A top-level composer and a reply composer, both with a "Comment" editor and button. */
const TWO_COMPOSERS = `<!doctype html><main>
  <comment-composer-host post-id="t3_abc123"><shreddit-composer data-label="Comment"></shreddit-composer></comment-composer-host>
  <shreddit-comment thing-id="t1_nested"><comment-composer-host post-id="t3_abc123" parent-id="t1_nested"><shreddit-composer data-label="Reply"></shreddit-composer></comment-composer-host></shreddit-comment>
</main><script>
  for (const node of document.querySelectorAll('shreddit-composer')) {
    const root = node.attachShadow({mode:'open'});
    root.innerHTML = '<div contenteditable="true" role="textbox" aria-label="'+node.dataset.label+'"></div><button>Comment</button>';
  }
</script>`

describe.skipIf(!cdpUrl)('fast path rules over a real Reddit composer fixture', () => {
  const found = getSiteAction('reddit', 'reddit_comment')
  if (!found) throw new Error('reddit_comment must be registered')
  const SENTINEL = 'SENTINEL-FAST-PATH text'
  let browser: Browser
  let rawPage: Page
  let page: PlaywrightPage
  beforeAll(async () => {
    browser = await chromium.connectOverCDP(cdpUrl ?? '')
    rawPage = await browser.contexts()[0].newPage()
    await rawPage.route('**/*', (route) =>
      route.fulfill({ contentType: 'text/html', body: TWO_COMPOSERS }),
    )
    page = new PlaywrightPage(rawPage, { action: 5_000, navigation: 5_000 })
  })
  afterAll(async () => {
    await rawPage?.close()
    await browser?.close()
  })

  async function observe(filled: ReadonlySet<string>, check: boolean): Promise<FastPathState> {
    const elements = parseSnapshotElements(await page.ariaSnapshot())
    const excluded = new Set<string>()
    if (check)
      for (const ref of siteCheckRefs(found.action, elements))
        if (!(await page.isRedditCommentComposer(ref, THREAD_URL))) excluded.add(ref)
    return {
      action: found.action,
      generation: 1,
      elements,
      specKeys: new Set(['comment_text']),
      filled,
      opened: new Set(),
      excluded,
    }
  }
  const raw = (agentRef: string) => agentRef.slice(agentRef.indexOf(':') + 1)

  it('fills and approves only the top-level composer, with refs and no values in decisions', async () => {
    await page.goto(THREAD_URL)
    // Without the site check, the reply composer makes the editor ambiguous.
    expect(nextFastAction(await observe(new Set(), false))).toEqual({
      op: 'hand_off',
      reason: 'ambiguous_field',
    })

    const before = await observe(new Set(), true)
    const fill = nextFastAction(before)
    if (fill.op !== 'fill_field') throw new Error(`expected a fill, got ${fill.op}`)
    expect(before.elements.get(raw(fill.ref))?.name).toBe('Comment')
    await page.fill(raw(fill.ref), SENTINEL)
    expect(await page.readValue(raw(fill.ref))).toBe(SENTINEL)

    const after = await observe(new Set(['comment_text']), true)
    const approve = nextFastAction(after)
    if (approve.op !== 'approve') throw new Error(`expected approval, got ${approve.op}`)
    expect(await page.isRedditCommentComposer(raw(approve.submitRef), THREAD_URL)).toBe(true)
    const field = approve.fieldRefs.comment_text
    if (!field) throw new Error('approval has no comment field')
    expect(await page.readValue(raw(field))).toBe(SENTINEL)
    expect(JSON.stringify([fill, approve])).not.toContain('SENTINEL')
  })
})

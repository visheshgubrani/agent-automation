import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightPage } from '../src/browser/playwright-driver.js'
import { REDDIT_POST_BODY_MAX_CHARS } from '../src/browser/reddit.js'
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
})

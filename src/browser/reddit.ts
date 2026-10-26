/** Reddit identity is derived from the URL, never inferred by a model. */
export function redditThreadId(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.origin !== 'https://www.reddit.com' || url.username || url.password) return undefined
    return /^\/r\/[A-Za-z0-9_]{2,21}\/comments\/([a-z0-9]{1,12})(?:\/|$)/.exec(url.pathname)?.[1]
  } catch {
    return undefined
  }
}

export const REDDIT_POST_BODY_MAX_CHARS = 12_000
export const REDDIT_POST_TITLE_MAX_CHARS = 1_000
export interface RedditPostContent {
  title: string
  body: string
  truncated: boolean
  unavailable: boolean
  media: boolean
}

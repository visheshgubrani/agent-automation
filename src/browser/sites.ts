/**
 * Site registry (phase 05). The single source of truth for where the agent may go, which
 * fields it may fill, and which controls commit an action. Validated at worker startup when
 * the agent is enabled (`requireWorkerConfig`).
 */

export interface ElementMatcher {
  role: string
  /** Matched against the element's accessible name. */
  name: RegExp
}

export interface SiteField {
  key: string
  /** Shown on the approval card. */
  label: string
  /** Roles the field's element may have (`fill_field` refuses any other role). */
  roles: readonly string[]
  /** Optional accessible-name constraint for multi-field forms. */
  name?: RegExp
}

export interface SiteAction {
  key: string
  /** Shown on cards: "Reddit comment". */
  label: string
  /** Where tasks for this action may start. */
  targetUrlPattern: RegExp
  fields: readonly SiteField[]
  /** The control `request_submit_approval` must target; checked again before the click. */
  commit: ElementMatcher
  /** Controls whose names look commit-like but only open a composer or modal. */
  preCommitOpeners: readonly ElementMatcher[]
  /** Post-submit URL that proves success, when the site navigates after submitting. */
  postSubmitUrlPattern?: RegExp
  /** Per local day (`Asia/Kolkata`); proposed defaults until changed. */
  dailyCap: number
  /** Application adapters use exact accessible status names, never arbitrary page prose. */
  application?: {
    alreadyApplied: RegExp
    success: RegExp
  }
}

export interface Site {
  key: string
  label: string
  /** Exact https origins the browser may visit for this site. */
  origins: readonly string[]
  /** URL path patterns that mean "not logged in". */
  loginPathPatterns: readonly RegExp[]
  actions: readonly SiteAction[]
}

export const SITES: readonly Site[] = [
  {
    key: 'reddit',
    label: 'Reddit',
    origins: ['https://www.reddit.com'],
    loginPathPatterns: [/^\/login\b/i, /^\/account\/login\b/i, /^\/register\b/i],
    actions: [
      {
        key: 'reddit_comment',
        label: 'Reddit comment',
        targetUrlPattern:
          /^https:\/\/www\.reddit\.com\/r\/[A-Za-z0-9_]{2,21}\/comments\/[a-z0-9]{1,12}(\/|$)/,
        fields: [{ key: 'comment_text', label: 'Comment', roles: ['textbox'] }],
        commit: { role: 'button', name: /^comment$/i },
        preCommitOpeners: [
          { role: 'button', name: /^(add a comment|join the conversation)$/i },
          { role: 'textbox', name: /^(add a comment|join the conversation)$/i },
        ],
        dailyCap: 10,
      },
      {
        key: 'reddit_post',
        label: 'Reddit post',
        targetUrlPattern: /^https:\/\/www\.reddit\.com\/r\/[A-Za-z0-9_]{2,21}\/submit(\/|\?|$)/,
        fields: [
          {
            key: 'post_title',
            label: 'Title',
            roles: ['textbox'],
            name: /^title(?:\s*\(required\))?$/i,
          },
          {
            key: 'post_body',
            label: 'Body',
            roles: ['textbox'],
            name: /^(body(?: text)?|text)(?:\s*\(optional\))?$/i,
          },
        ],
        commit: { role: 'button', name: /^post$/i },
        preCommitOpeners: [{ role: 'tab', name: /^(text|post)$/i }],
        postSubmitUrlPattern:
          /^https:\/\/www\.reddit\.com\/r\/[A-Za-z0-9_]{2,21}\/comments\/[a-z0-9]{1,12}\//,
        dailyCap: 3,
      },
    ],
  },
  {
    key: 'waas',
    label: 'YC Work at a Startup',
    origins: ['https://www.workatastartup.com'],
    loginPathPatterns: [/^\/users\/(sign_in|sign_up)\b/i, /^\/login\b/i],
    actions: [
      {
        key: 'waas_apply',
        label: 'YC application',
        targetUrlPattern:
          /^https:\/\/www\.workatastartup\.com\/jobs\/[0-9]+(?:-[A-Za-z0-9-]+)?\/?$/,
        fields: [
          {
            key: 'application_note',
            label: 'Application note',
            roles: ['textbox'],
            name: /^(message|note|application note|why.*|introduce yourself.*|tell us.*)$/i,
          },
        ],
        commit: { role: 'button', name: /^(send|send application|send message)$/i },
        preCommitOpeners: [{ role: 'button', name: /^(apply|apply now|apply to this job)$/i }],
        application: {
          alreadyApplied: /^(already applied|applied|application sent)$/i,
          success: /^(application sent|application submitted|message sent|applied)$/i,
        },
        dailyCap: 10,
      },
    ],
  },
  {
    key: 'wellfound',
    label: 'Wellfound',
    origins: ['https://wellfound.com'],
    loginPathPatterns: [/^\/login\b/i, /^\/signup\b/i],
    actions: [
      {
        key: 'wellfound_apply',
        label: 'Wellfound application',
        targetUrlPattern: /^https:\/\/wellfound\.com\/jobs\/[0-9]+(?:-[A-Za-z0-9-]+)?\/?$/,
        fields: [
          {
            key: 'application_note',
            label: 'Application note',
            roles: ['textbox'],
            name: /^(message|note|application note|why.*|what interests you.*|tell us.*)$/i,
          },
        ],
        commit: { role: 'button', name: /^(send application|send)$/i },
        preCommitOpeners: [{ role: 'button', name: /^(apply|apply now)$/i }],
        application: {
          alreadyApplied: /^(already applied|applied|application sent)$/i,
          success: /^(application sent|application submitted|applied)$/i,
        },
        dailyCap: 10,
      },
    ],
  },
]

export function getSite(key: string): Site | undefined {
  return SITES.find((site) => site.key === key)
}

export function getSiteAction(
  siteKey: string,
  actionKey: string,
): { site: Site; action: SiteAction } | undefined {
  const site = getSite(siteKey)
  const action = site?.actions.find((candidate) => candidate.key === actionKey)
  return site && action ? { site, action } : undefined
}

const KEY = /^[a-z][a-z0-9_]{0,47}$/

/** Startup check: every registry entry is internally consistent. Returns issues, never throws. */
export function validateSiteRegistry(sites: readonly Site[] = SITES): string[] {
  const issues: string[] = []
  const siteKeys = new Set<string>()
  const actionKeys = new Set<string>()

  for (const site of sites) {
    if (!KEY.test(site.key)) issues.push(`site "${site.key}": invalid key`)
    if (siteKeys.has(site.key)) issues.push(`site "${site.key}": duplicate key`)
    siteKeys.add(site.key)
    if (site.origins.length === 0) issues.push(`site "${site.key}": no origins`)
    for (const origin of site.origins) {
      let parsed: URL | undefined
      try {
        parsed = new URL(origin)
      } catch {
        // reported below
      }
      if (parsed?.protocol !== 'https:' || parsed?.origin !== origin) {
        issues.push(`site "${site.key}": origin "${origin}" must be an exact https origin`)
      }
    }
    if (site.actions.length === 0) issues.push(`site "${site.key}": no actions`)

    for (const action of site.actions) {
      const where = `site "${site.key}" action "${action.key}"`
      if (!KEY.test(action.key)) issues.push(`${where}: invalid key`)
      if (actionKeys.has(action.key)) issues.push(`${where}: duplicate action key`)
      actionKeys.add(action.key)
      if (action.fields.length === 0) issues.push(`${where}: no fields`)
      const fieldKeys = new Set<string>()
      for (const field of action.fields) {
        if (!KEY.test(field.key)) issues.push(`${where}: invalid field key "${field.key}"`)
        if (fieldKeys.has(field.key)) issues.push(`${where}: duplicate field "${field.key}"`)
        fieldKeys.add(field.key)
        if (field.roles.length === 0) issues.push(`${where}: field "${field.key}" has no roles`)
      }
      if (!Number.isInteger(action.dailyCap) || action.dailyCap < 1) {
        issues.push(`${where}: daily cap must be a positive integer`)
      }
      if (!action.targetUrlPattern.source.startsWith('^https:\\/\\/')) {
        issues.push(`${where}: target URL pattern must be anchored to https`)
      }
      for (const opener of action.preCommitOpeners) {
        if (
          opener.role === action.commit.role &&
          opener.name.source === action.commit.name.source
        ) {
          issues.push(`${where}: a pre-commit opener equals the commit control`)
        }
      }
    }
  }
  return issues
}

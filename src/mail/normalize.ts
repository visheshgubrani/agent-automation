const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Normalize an address for storage/lookup. Accounts and bank senders are case-insensitive. */
export function normalizeEmailAddress(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new Error(`invalid email address: ${value.trim() || '(empty)'}`)
  }
  return normalized
}

/**
 * Normalize a company domain. Domains are stored lowercase and matched exactly; subdomains
 * are separate values rather than implied by a parent domain.
 */
export function normalizeDomain(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0 || normalized.includes('@') || normalized.includes(' ')) {
    throw new Error(`invalid domain: ${value.trim() || '(empty)'}`)
  }

  const labels = normalized.split('.')
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) {
    throw new Error(`invalid domain: ${normalized}`)
  }
  return normalized
}

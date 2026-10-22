/** The only Google scope requested by the mail connector. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

/** A connect flow must finish within this window; the local callback server then closes. */
export const OAUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000

export const OAUTH_CALLBACK_PATH = '/oauth2callback'
export const OAUTH_LOOPBACK_HOST = '127.0.0.1'

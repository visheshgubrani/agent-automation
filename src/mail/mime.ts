import { TextDecoder } from 'node:util'
import type { gmail_v1 } from '@googleapis/gmail'
import { htmlToText } from 'html-to-text'
import { normalizeRfcMessageId } from '../notifications/dedupe.js'
import { normalizeEmailAddress } from './normalize.js'

export const MESSAGE_CLEANER_VERSION = 1
export const MAX_RAW_TEXT_CHARS = 200_000
export const MAX_CLEAN_TEXT_CHARS = 100_000
export const MAX_SUBJECT_CHARS = 2_000
export const MAX_HEADER_VALUE_CHARS = 4_000
export const MAX_STORED_HEADERS = 80
export const MAX_DUPLICATE_HEADER_VALUES = 20
export const MAX_ATTACHMENTS = 50
export const MAX_MIME_DEPTH = 20

const EMAIL_CANDIDATE = /[^\s<>@,;]+@[^\s<>@,;]+/
const ENCODED_WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g
const EXCLUDED_LABELS = new Set(['SPAM', 'TRASH', 'DRAFT', 'SENT'])

export type HeaderValue = string | string[]

export interface ParsedAddress {
  name: string | null
  email: string
}

export interface AttachmentMetadata {
  filename: string
  mimeType: string | null
  size: number | null
}

export interface ParsedGmailMessage {
  providerMessageId: string
  providerThreadId: string | null
  rfcMessageId: string | null
  fromEmail: string
  fromName: string | null
  toEmails: string[]
  ccEmails: string[]
  subject: string
  receivedAt: Date
  providerLabels: string[]
  rawText: string
  rawContentType: string
  cleanText: string
  cleanerVersion: number
  headers: Record<string, unknown>
}

function decodeBytes(bytes: Buffer, charset: string | null | undefined): string {
  try {
    return new TextDecoder(charset ?? 'utf-8', { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

function decodeQuotedPrintableWord(value: string): Buffer {
  const input = value.replaceAll('_', ' ')
  const bytes: number[] = []
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (char === '=' && index + 2 < input.length) {
      const hex = input.slice(index + 1, index + 3)
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        index += 2
        continue
      }
    }
    bytes.push(input.charCodeAt(index) & 0xff)
  }
  return Buffer.from(bytes)
}

/** Decode RFC 2047 encoded words (B/Q) using their declared charset. */
export function decodeMimeWords(value: string): string {
  if (!value.includes('=?')) return value
  return value.replace(ENCODED_WORD, (match, charset: string, encoding: string, text: string) => {
    try {
      const bytes =
        encoding.toLowerCase() === 'b'
          ? Buffer.from(text, 'base64')
          : decodeQuotedPrintableWord(text)
      return decodeBytes(bytes, charset)
    } catch {
      return match
    }
  })
}

export function parseContentType(value: string | null | undefined): {
  mimeType: string
  charset: string | null
} {
  const raw = value ?? ''
  const mimeType = raw.split(';')[0]?.trim().toLowerCase() || 'text/plain'
  const charsetMatch = /charset\s*=\s*"?([^";]+)"?/i.exec(raw)
  return { mimeType, charset: charsetMatch?.[1]?.trim().toLowerCase() ?? null }
}

export function decodeBase64Url(data: string, charset?: string | null): string {
  try {
    return decodeBytes(Buffer.from(data, 'base64url'), charset)
  } catch {
    return ''
  }
}

function stripComments(value: string): string {
  let result = ''
  let depth = 0
  for (const char of value) {
    if (char === '(') {
      depth += 1
      continue
    }
    if (char === ')' && depth > 0) {
      depth -= 1
      continue
    }
    if (depth === 0) result += char
  }
  return result
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed
  return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1')
}

function splitAddresses(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let angleDepth = 0
  let commentDepth = 0
  let escaped = false

  for (const char of value) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\') {
      current += char
      escaped = true
      continue
    }
    if (char === '"' && angleDepth === 0) {
      quoted = !quoted
      current += char
      continue
    }
    if (char === '(' && !quoted) {
      commentDepth += 1
      current += char
      continue
    }
    if (char === ')' && !quoted && commentDepth > 0) {
      commentDepth -= 1
      current += char
      continue
    }
    if (char === '<' && !quoted) {
      angleDepth += 1
      current += char
      continue
    }
    if (char === '>' && !quoted && angleDepth > 0) {
      angleDepth -= 1
      current += char
      continue
    }
    if (char === ',' && !quoted && angleDepth === 0 && commentDepth === 0) {
      if (current.trim().length > 0) parts.push(current)
      current = ''
      continue
    }
    current += char
  }

  if (current.trim().length > 0) parts.push(current)
  return parts
}

function parseAddressToken(token: string): ParsedAddress | null {
  const text = stripComments(token).trim()
  if (text.length === 0) return null

  const angle = /<([^<>]+)>/.exec(text)
  let email = angle?.[1]?.trim() ?? text
  const name = angle ? text.slice(0, angle.index).trim() : ''

  email = email.replace(/^mailto:/i, '').trim()
  try {
    email = normalizeEmailAddress(email)
  } catch {
    const candidate = EMAIL_CANDIDATE.exec(text)?.[0]
    if (!candidate) return null
    try {
      email = normalizeEmailAddress(candidate)
    } catch {
      return null
    }
  }

  return {
    name: unquote(name).replace(/\s+/g, ' ').trim() || null,
    email,
  }
}

/** Parse comma-separated address headers, including quoted names and angle brackets. */
export function parseAddressList(value: string | null | undefined): ParsedAddress[] {
  if (!value) return []
  const addresses: ParsedAddress[] = []
  const seen = new Set<string>()
  for (const token of splitAddresses(decodeMimeWords(value))) {
    const address = parseAddressToken(token)
    if (!address || seen.has(address.email)) continue
    seen.add(address.email)
    addresses.push(address)
  }
  return addresses
}

function buildHeaderMap(
  headers: gmail_v1.Schema$MessagePartHeader[] | null | undefined,
): Record<string, HeaderValue> {
  const map: Record<string, HeaderValue> = {}
  for (const header of headers ?? []) {
    const name = header.name?.trim().toLowerCase()
    if (!name) continue
    if (Object.keys(map).length >= MAX_STORED_HEADERS && !(name in map)) continue
    const value = decodeMimeWords(header.value ?? '')
      .trim()
      .slice(0, MAX_HEADER_VALUE_CHARS)
    if (value.length === 0) continue
    const existing = map[name]
    if (existing === undefined) {
      map[name] = value
    } else if (Array.isArray(existing)) {
      if (existing.length < MAX_DUPLICATE_HEADER_VALUES) existing.push(value)
    } else {
      map[name] = [existing, value]
    }
  }
  return map
}

function headerValue(headers: Record<string, HeaderValue>, name: string): string | null {
  const value = headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)
  if (!match?.[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

interface BodyPart {
  mimeType: string
  text: string
}

function collectBodies(
  part: gmail_v1.Schema$MessagePart,
  attachments: AttachmentMetadata[],
  depth = 0,
): BodyPart[] {
  if (depth > MAX_MIME_DEPTH) return []

  const headers = buildHeaderMap(part.headers)
  const disposition = headerValue(headers, 'content-disposition')
  const filename = part.filename?.trim() || filenameFromDisposition(disposition)
  const isAttachment = Boolean(filename) || disposition?.toLowerCase().startsWith('attachment')

  if (isAttachment) {
    if (filename && attachments.length < MAX_ATTACHMENTS) {
      attachments.push({
        filename: decodeMimeWords(filename),
        mimeType: part.mimeType ?? null,
        size: part.body?.size ?? null,
      })
    }
    return []
  }

  const { mimeType, charset } = parseContentType(
    headerValue(headers, 'content-type') ?? part.mimeType,
  )

  if ((mimeType === 'text/plain' || mimeType === 'text/html') && part.body?.data) {
    return [{ mimeType, text: decodeBase64Url(part.body.data, charset) }]
  }

  if (part.parts?.length) {
    return part.parts.flatMap((child) => collectBodies(child, attachments, depth + 1))
  }

  return []
}

function normalizeCleanedText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replaceAll('\u0000', '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Clean the chosen body: prefer plain text, otherwise convert HTML to bounded text. */
export function cleanMessageText(rawText: string, mimeType: string): string {
  let text = rawText
  if (mimeType.toLowerCase() === 'text/html') {
    try {
      text = htmlToText(rawText, {
        wordwrap: false,
        selectors: [
          { selector: 'a', options: { ignoreHref: true } },
          { selector: 'img', format: 'skip' },
        ],
      })
    } catch {
      text = rawText.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    }
  }
  return normalizeCleanedText(text).slice(0, MAX_CLEAN_TEXT_CHARS)
}

export function isExcludedMessage(labels: readonly string[]): boolean {
  return labels.some((label) => EXCLUDED_LABELS.has(label))
}

/**
 * Convert a Gmail `messages.get(format=full)` response into the row shape used by
 * `messages`. Raw and cleaned text stay separate; only clean text is prompt-facing.
 * Returns null when Gmail omitted the immutable message id.
 */
export function parseGmailMessage(
  message: gmail_v1.Schema$Message,
  now: Date = new Date(),
): ParsedGmailMessage | null {
  if (!message.id) return null

  const payload = message.payload
  const headers = buildHeaderMap(payload?.headers)
  const attachments: AttachmentMetadata[] = []
  const bodies = payload ? collectBodies(payload, attachments) : []
  const chosen =
    bodies.find((body) => body.mimeType === 'text/plain' && body.text.trim().length > 0) ??
    bodies.find((body) => body.mimeType === 'text/html' && body.text.trim().length > 0) ??
    null

  const rawText = (chosen?.text ?? '').slice(0, MAX_RAW_TEXT_CHARS)
  const rawContentType = chosen?.mimeType ?? 'text/plain'
  const from = parseAddressList(headerValue(headers, 'from'))[0]
  const toEmails = parseAddressList(headerValue(headers, 'to')).map((address) => address.email)
  const ccEmails = parseAddressList(headerValue(headers, 'cc')).map((address) => address.email)
  const subject = decodeMimeWords(headerValue(headers, 'subject') ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_SUBJECT_CHARS)

  const internalDate = message.internalDate ? Number(message.internalDate) : Number.NaN
  const dateHeader = headerValue(headers, 'date')
  const parsedHeaderDate = dateHeader ? new Date(dateHeader) : null
  const receivedAt = Number.isFinite(internalDate)
    ? new Date(internalDate)
    : parsedHeaderDate && !Number.isNaN(parsedHeaderDate.getTime())
      ? parsedHeaderDate
      : now

  const labels = [
    ...new Set((message.labelIds ?? []).filter((label): label is string => Boolean(label))),
  ]

  return {
    providerMessageId: message.id,
    providerThreadId: message.threadId ?? null,
    rfcMessageId: normalizeRfcMessageId(headerValue(headers, 'message-id')),
    fromEmail: from?.email ?? '',
    fromName: from?.name ?? null,
    toEmails: [...new Set(toEmails)],
    ccEmails: [...new Set(ccEmails)],
    subject,
    receivedAt,
    providerLabels: labels,
    rawText,
    rawContentType,
    cleanText: cleanMessageText(rawText, rawContentType),
    cleanerVersion: MESSAGE_CLEANER_VERSION,
    headers: {
      ...headers,
      ...(attachments.length > 0 ? { __attachments: attachments } : {}),
    },
  }
}

/**
 * A credential carrier contains only a short-lived Host request code and display label.
 * Secret values are never serialized into the composer draft or a DSH message.
 */
export interface CredentialCarrier {
  readonly version: 1
  readonly requestCode: string
  readonly label: string
}

export interface ParsedCredentialCarriers {
  readonly carriers: readonly CredentialCarrier[]
  readonly text: string
  readonly errors: readonly string[]
  readonly found: boolean
}

const FORMATTED_PATTERN = /@\[([^\]\n]*)\]\(codingns-credential:([^\)\s]+)\)/gu
const LEGACY_PATTERN = /@([^<\n]+)<!--codingns:credential:v1:([^:>]+):([^>]+)-->/gu
const MALFORMED_PATTERN = /(?:@\[?[^\n>]*codingns-credential:[^>\n]*\)?|<!--codingns:credential:[^>]*-->)/gu

export function encodeCredentialCarrier(requestCode: string, label: string): string {
  const code = requestCode.trim()
  const display = label.trim() || code
  if (code === '') throw new Error('The credential request code cannot be empty.')
  return `@[${encodeURIComponent(display)}](codingns-credential:${encodeURIComponent(code)})`
}

export function insertCredentialCarrier(draft: string, requestCode: string, label: string): string {
  const parsed = parseCredentialCarriers(draft)
  if (parsed.carriers.some((item) => item.requestCode === requestCode.trim())) return draft
  const carrier = encodeCredentialCarrier(requestCode, label)
  const trimmed = draft.trimEnd()
  return trimmed === '' ? carrier : `${trimmed} ${carrier}`
}

export function parseCredentialCarriers(input: string): ParsedCredentialCarriers {
  const text = typeof input === 'string' ? input : ''
  const carriers: CredentialCarrier[] = []
  const errors: string[] = []
  const ranges: Array<readonly [number, number]> = []
  const replacements = new Map<string, string>()
  let found = false

  for (const match of text.matchAll(FORMATTED_PATTERN)) {
    found = true
    const index = match.index ?? -1
    if (index < 0) continue
    const label = decodeCarrierPart(match[1], errors)
    const requestCode = decodeCarrierPart(match[2], errors)
    addCarrier(carriers, errors, requestCode, label)
    ranges.push([index, index + match[0].length])
    replacements.set(`${index}:${index + match[0].length}`, label === '' ? '' : `@${label}`)
  }

  for (const match of text.matchAll(LEGACY_PATTERN)) {
    const index = match.index ?? -1
    if (index < 0) continue
    found = true
    const label = match[1]?.trim() ?? ''
    const requestCode = decodeCarrierPart(match[2], errors)
    const encodedLabel = decodeCarrierPart(match[3], errors)
    addCarrier(carriers, errors, requestCode, label || encodedLabel)
    ranges.push([index, index + match[0].length])
    replacements.set(`${index}:${index + match[0].length}`, label === '' ? '' : `@${label}`)
  }

  for (const match of text.matchAll(MALFORMED_PATTERN)) {
    const index = match.index ?? -1
    if (index < 0 || ranges.some(([start, end]) => index >= start && index < end)) continue
    found = true
    errors.push('CREDENTIAL_CARRIER_INVALID: carrier format is not supported')
    ranges.push([index, index + match[0].length])
  }
  if (ranges.length === 0) return { carriers, text, errors, found }
  ranges.sort((left, right) => left[0] - right[0])
  let clean = ''
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start < cursor) continue
    clean += text.slice(cursor, start) + (replacements.get(`${start}:${end}`) ?? '')
    cursor = end
  }
  clean += text.slice(cursor)
  return { carriers, text: clean.replace(/[ \t]{2,}/gu, ' ').trim(), errors, found }
}

function decodeCarrierPart(value: string | undefined, errors: string[]): string {
  if (value === undefined) return ''
  try {
    return decodeURIComponent(value).trim()
  } catch {
    errors.push('CREDENTIAL_CARRIER_INVALID: carrier encoding is corrupted')
    return ''
  }
}

function addCarrier(carriers: CredentialCarrier[], errors: string[], requestCode: string, label: string): void {
  if (requestCode === '' || label === '') {
    errors.push('CREDENTIAL_CARRIER_INVALID: carrier is missing a credential request code')
    return
  }
  if (!carriers.some((item) => item.requestCode === requestCode)) carriers.push({ version: 1, requestCode, label })
}

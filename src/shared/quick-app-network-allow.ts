/** Exceptions to the public-only egress policy. An empty list denies every non-public target. */
const RANGE_TEXT = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
] as const

interface ParsedIp { readonly family: 4 | 6; readonly bytes: Uint8Array }
const RANGES = RANGE_TEXT.map(([text, prefix]) => {
  const ip = parseIp(text)
  if (!ip) throw new Error(`Invalid egress range ${text}.`)
  return { family: ip.family, bytes: ip.bytes, prefix }
})

export function parseQuickAppNetworkAllow(value: unknown): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 16) throw invalid()
  const allow: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') throw invalid()
    const text = item.trim().toLowerCase()
    if (!text) continue
    const canonical = canonicalEntry(text)
    if (!canonical) throw invalid()
    if (seen.has(canonical)) continue
    seen.add(canonical)
    allow.push(canonical)
  }
  return allow
}

export function quickAppAddressBlocked(address: string, family: 4 | 6): boolean {
  const ip = canonicalIp(address)
  if (!ip || ip.family !== family) return true
  return blockedRange(ip, family === 4 ? 32 : 128)
}

/** Clash, Surge, and sing-box map public names onto 198.18.0.0/15. Literal addresses stay blocked. */
export function quickAppFakeIpAddress(address: string, family: 4 | 6): boolean {
  const ip = canonicalIp(address)
  const range = RANGES.find(item => item.family === 4 && item.prefix === 15)
  return ip?.family === family && ip.family === 4 && range !== undefined && samePrefix(range.bytes, ip.bytes, range.prefix)
}

export function quickAppAllowMatchesName(allow: readonly string[], hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '')
  return allow.some(entry => entry === host && !entry.includes('/') && parseIp(entry) === null)
}

/** True when this saved entry explicitly permits the hostname or the resolved address. */
export function quickAppAllowMatches(allow: readonly string[], hostname: string, address: string, family: 4 | 6): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '')
  const target = parseIp(address)
  if (!target || target.family !== family) return false
  return allow.some(entry => {
    const slash = entry.lastIndexOf('/')
    const base = parseIp(slash === -1 ? entry : entry.slice(0, slash))
    if (!base) return entry === host
    if (base.family !== family) return false
    const prefix = slash === -1 ? (family === 4 ? 32 : 128) : Number(entry.slice(slash + 1))
    return samePrefix(base.bytes, target.bytes, prefix)
  })
}

function canonicalEntry(text: string): string | null {
  if (text.length > 253) return null
  const slash = text.lastIndexOf('/')
  if (slash > 0) {
    const prefix = Number(text.slice(slash + 1))
    const ip = canonicalIp(text.slice(0, slash))
    const max = ip?.family === 4 ? 32 : 128
    if (!ip || !/^\d{1,3}$/u.test(text.slice(slash + 1)) || prefix < 1 || prefix > max || !blockedRange(ip, prefix)) return null
    const network = mask(ip.bytes, prefix)
    const formatted = formatIp({ family: ip.family, bytes: network })
    return prefix === max ? formatted : `${formatted}/${prefix}`
  }
  const ip = canonicalIp(text)
  if (ip) return blockedRange(ip, ip.family === 4 ? 32 : 128) ? formatIp(ip) : null
  const host = text.endsWith('.') ? text.slice(0, -1) : text
  if (!host || host.endsWith('.') || /^\d+$/u.test(host) || parseIp(host)) return null
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(host) ? host : null
}

function blockedRange(ip: ParsedIp, prefix: number): boolean {
  return RANGES.some(range => range.family === ip.family && range.prefix <= prefix && samePrefix(range.bytes, ip.bytes, range.prefix))
}

function canonicalIp(text: string): ParsedIp | null {
  const parsed = parseIp(text)
  if (!parsed) return null
  if (parsed.family === 6 && parsed.bytes.subarray(0, 10).every(byte => byte === 0) && parsed.bytes[10] === 255 && parsed.bytes[11] === 255) {
    return { family: 4, bytes: parsed.bytes.subarray(12) }
  }
  return parsed
}

function parseIp(text: string): ParsedIp | null {
  if (text.includes('%') || text.includes('/')) return null
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/u.test(text)) {
    const bytes = text.split('.').map(part => Number(part))
    if (bytes.every(part => part <= 255)) return { family: 4, bytes: Uint8Array.from(bytes) }
    return null
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const side = (value: string): number[] | null => {
    if (value === '') return []
    const parts = value.split(':')
    const groups: number[] = []
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? ''
      if (index === parts.length - 1 && part.includes('.')) {
        const tail = parseIp(part)
        if (tail?.family !== 4) return null
        groups.push((tail.bytes[0]! << 8) | tail.bytes[1]!, (tail.bytes[2]! << 8) | tail.bytes[3]!)
      } else if (!/^[0-9a-f]{1,4}$/u.test(part)) return null
      else groups.push(Number.parseInt(part, 16))
    }
    return groups
  }
  const left = side(halves[0] ?? '')
  const right = halves.length === 2 ? side(halves[1] ?? '') : []
  if (!left || !right || (halves.length === 1 && left.length !== 8) || (halves.length === 2 && left.length + right.length >= 8)) return null
  const groups = halves.length === 1 ? left : [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right]
  const bytes = new Uint8Array(16)
  groups.forEach((group, index) => { bytes[index * 2] = group >> 8; bytes[index * 2 + 1] = group & 255 })
  return { family: 6, bytes }
}

function formatIp(ip: ParsedIp): string {
  if (ip.family === 4) return [...ip.bytes].join('.')
  const groups = Array.from({ length: 8 }, (_, index) => (ip.bytes[index * 2]! << 8) | ip.bytes[index * 2 + 1]!)
  let start = -1
  let length = 0
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) { index += 1; continue }
    let end = index
    while (end < groups.length && groups[end] === 0) end += 1
    if (end - index > length) { start = index; length = end - index }
    index = end
  }
  const hex = groups.map(group => group.toString(16))
  if (length < 2) return hex.join(':')
  return `${hex.slice(0, start).join(':')}::${hex.slice(start + length).join(':')}`
}

function mask(bytes: Uint8Array, prefix: number): Uint8Array {
  const out = bytes.slice()
  const whole = Math.floor(prefix / 8)
  const bits = prefix % 8
  if (bits) out[whole] = (out[whole] ?? 0) & (0xff << (8 - bits))
  for (let index = whole + (bits ? 1 : 0); index < out.length; index += 1) out[index] = 0
  return out
}

function samePrefix(left: Uint8Array, right: Uint8Array, prefix: number): boolean {
  const whole = Math.floor(prefix / 8)
  for (let index = 0; index < whole; index += 1) if (left[index] !== right[index]) return false
  const bits = prefix % 8
  if (!bits) return true
  const select = 0xff << (8 - bits) & 0xff
  return ((left[whole] ?? 0) & select) === ((right[whole] ?? 0) & select)
}

function invalid(): Error { return new Error('Invalid local network allow list.') }

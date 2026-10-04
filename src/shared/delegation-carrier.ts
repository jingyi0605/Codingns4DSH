/**
 * 委派目标在草稿中的稳定载体。
 *
 * 载体同时保留用户可见的 `@Agent` 文本和稳定 adapterId。HTML 注释部分在
 * DSH 的富文本渲染中不可见，但仍会随普通草稿序列化，Host 提交时会完整消费。
 */
export interface DelegationCarrier {
  readonly version: 1 | 2
  readonly adapterId: string
  readonly label: string
  /** 用户明确选择的目标模型；v1 carrier 没有该字段。 */
  readonly modelId?: string
}

const CARRIER_PREFIX = '<!--codingns:delegate:v1:'
const CARRIER_V2_PREFIX = '<!--codingns:delegate:v2:'
const CARRIER_V1_PATTERN = /<!--codingns:delegate:v1:([^:>]+):([^>]+)-->/gu
const CARRIER_V2_PATTERN = /<!--codingns:delegate:v2:([^:>]+):([^:>]+):([^>]+)-->/gu
const MALFORMED_CARRIER_PATTERN = /<!--codingns:delegate:[^>]*-->/gu

export interface ParsedDelegationCarriers {
  readonly carriers: readonly DelegationCarrier[]
  readonly text: string
  readonly errors: readonly string[]
  readonly found: boolean
}

export function encodeDelegationCarrier(adapterId: string, label: string, modelId?: string): string {
  const normalizedId = adapterId.trim()
  const normalizedLabel = label.trim() || normalizedId
  const normalizedModel = modelId?.trim() || ''
  if (normalizedId === '') throw new Error('委派 carrier 的 adapterId 不能为空')
  if (normalizedModel !== '') {
    return `@${normalizedLabel}${CARRIER_V2_PREFIX}${encodeURIComponent(normalizedId)}:${encodeURIComponent(normalizedModel)}:${encodeURIComponent(normalizedLabel)}-->`
  }
  return `@${normalizedLabel}${CARRIER_PREFIX}${encodeURIComponent(normalizedId)}:${encodeURIComponent(normalizedLabel)}-->`
}

export function insertDelegationCarrier(draft: string, adapterId: string, label: string, modelId?: string): string {
  const parsed = parseDelegationCarriers(draft)
  if (parsed.carriers.some((item) => item.adapterId === adapterId.trim())) return draft
  const carrier = encodeDelegationCarrier(adapterId, label, modelId)
  const trimmed = draft.trimEnd()
  return trimmed === '' ? carrier : `${trimmed} ${carrier}`
}

/** 解析并移除草稿中的全部委派 carrier；不依据显示名称猜测目标。 */
export function parseDelegationCarriers(input: string): ParsedDelegationCarriers {
  const text = typeof input === 'string' ? input : ''
  const carriers: DelegationCarrier[] = []
  const errors: string[] = []
  const ranges: Array<readonly [number, number]> = []
  let found = false

  for (const match of text.matchAll(CARRIER_V2_PATTERN)) {
    found = true
    const rawId = match[1] ?? ''
    const rawModel = match[2] ?? ''
    const rawLabel = match[3] ?? ''
    const index = match.index ?? -1
    if (index < 0) continue
    let adapterId = ''
    let modelId = ''
    let label = ''
    try {
      adapterId = decodeURIComponent(rawId).trim()
      modelId = decodeURIComponent(rawModel).trim()
      label = decodeURIComponent(rawLabel).trim()
    } catch {
      errors.push('DELEGATE_CARRIER_INVALID: carrier 编码损坏')
    }
    if (adapterId === '' || modelId === '' || label === '') errors.push('DELEGATE_CARRIER_INVALID: carrier 缺少目标标识')
    const mention = label === '' ? '' : `@${label}`
    const start = mention !== '' && text.slice(Math.max(0, index - mention.length), index) === mention
      ? index - mention.length
      : index
    ranges.push([start, index + match[0].length])
    if (adapterId !== '' && modelId !== '' && label !== '' && !carriers.some((item) => item.adapterId === adapterId)) {
      carriers.push({ version: 2, adapterId, label, modelId })
    }
  }

  for (const match of text.matchAll(CARRIER_V1_PATTERN)) {
    found = true
    const rawId = match[1] ?? ''
    const rawLabel = match[2] ?? ''
    const index = match.index ?? -1
    if (index < 0) continue
    let adapterId = ''
    let label = ''
    try {
      adapterId = decodeURIComponent(rawId).trim()
      label = decodeURIComponent(rawLabel).trim()
    } catch {
      errors.push('DELEGATE_CARRIER_INVALID: carrier 编码损坏')
    }
    if (adapterId === '' || label === '') errors.push('DELEGATE_CARRIER_INVALID: carrier 缺少目标标识')
    const mention = label === '' ? '' : `@${label}`
    const start = mention !== '' && text.slice(Math.max(0, index - mention.length), index) === mention
      ? index - mention.length
      : index
    ranges.push([start, index + match[0].length])
    if (adapterId !== '' && label !== '' && !carriers.some((item) => item.adapterId === adapterId)) {
      carriers.push({ version: 1, adapterId, label })
    }
  }

  for (const match of text.matchAll(MALFORMED_CARRIER_PATTERN)) {
    const index = match.index ?? -1
    if (index < 0 || /^<!--codingns:delegate:v1:[^:>]+:[^>]+-->$/u.test(match[0]) || /^<!--codingns:delegate:v2:[^:>]+:[^:>]+:[^>]+-->$/u.test(match[0])) continue
    found = true
    errors.push('DELEGATE_CARRIER_INVALID: carrier 格式不受支持')
    ranges.push([index, index + match[0].length])
  }

  if (ranges.length === 0) return { carriers: [], text, errors, found }
  ranges.sort((a, b) => a[0] - b[0])
  let clean = ''
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start < cursor) continue
    clean += text.slice(cursor, start)
    cursor = end
  }
  clean += text.slice(cursor)
  return { carriers, text: clean.replace(/[ \t]{2,}/gu, ' ').trim(), errors, found }
}

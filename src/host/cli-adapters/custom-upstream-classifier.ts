import { createHash } from 'node:crypto'
import type { CliSubscriptionUsage } from '../../shared/contracts/subscription.js'

/** 能力读取器最终确认的自定义上游协议。 */
export type CustomUpstreamKind = 'new-api' | 'new-api-billing-compatible' | 'sub2api' | 'ambiguous' | 'unknown'

/** 自定义上游来源；API Key 只用于 Host 内部请求和内存缓存指纹。 */
export interface CustomUpstreamSource {
  readonly baseUrl: string
  readonly apiKey: string
}

/** Host 侧统一保存的自定义上游分类结果。不会保存原始 API Key。 */
export interface CustomUpstreamClassification {
  readonly kind: CustomUpstreamKind
  readonly reader: 'new-api' | 'sub2api' | null
  readonly confidence: 'strong' | 'weak' | 'ambiguous' | 'unknown'
  readonly sourceUrl: string
  readonly sourceKey: string
  readonly detectedAt: string
  readonly expiresAt: string
}

export interface CustomUpstreamCandidate {
  readonly source: CustomUpstreamSource
  readonly newApi: boolean
  readonly sub2api: boolean
}

export interface CustomUpstreamReadResult {
  readonly usage: CliSubscriptionUsage | null
  readonly classification: CustomUpstreamClassification
}

export interface CustomUpstreamClassifierOptions {
  /** 正分类结果的缓存时间；默认 10 分钟。 */
  readonly positiveTtlMs?: number
  /** unknown/失败结果的缓存时间；默认 60 秒。 */
  readonly negativeTtlMs?: number
}

export interface CustomUpstreamReaders {
  readonly newApi?: (source: CustomUpstreamSource) => Promise<{ readonly usage: CliSubscriptionUsage | null; readonly kind: 'new-api' | 'new-api-billing-compatible' } | null>
  readonly sub2api?: (source: CustomUpstreamSource) => Promise<{ readonly usage: CliSubscriptionUsage | null; readonly kind: 'sub2api' } | null>
}

interface CacheEntry {
  readonly classification: CustomUpstreamClassification
  readonly expiresAtMs: number
}

/**
 * 统一判定自定义上游类型并缓存结果。
 *
 * 首次探测会同时询问候选读取器；只有一侧命中才选择对应协议。
 * 已分类来源临时失败时不会切换到另一读取器，避免 UI 在 New-API/Sub2API
 * 之间跳变。双协议同时命中则标记 ambiguous，不自动选择任一读取器。
 */
export class CustomUpstreamClassifier {
  private readonly positiveTtlMs: number
  private readonly negativeTtlMs: number
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<CustomUpstreamReadResult>>()

  constructor(options: CustomUpstreamClassifierOptions = {}) {
    this.positiveTtlMs = options.positiveTtlMs ?? 10 * 60_000
    this.negativeTtlMs = options.negativeTtlMs ?? 60_000
  }

  async read(
    adapterId: string,
    providerId: string | undefined,
    candidates: readonly CustomUpstreamCandidate[],
    readers: CustomUpstreamReaders,
  ): Promise<CustomUpstreamReadResult | null> {
    const scope = `${adapterId}\0${providerId ?? ''}`
    let last: CustomUpstreamReadResult | null = null
    for (const candidate of candidates) {
      const key = sourceKey(candidate.source, scope)
      const cached = this.getCached(key)
      if (cached !== null) {
        const result = await this.readCached(candidate, cached.classification, readers)
        last = result
        if (result.usage !== null || cached.classification.kind === 'ambiguous') return result
        continue
      }

      const pending = this.inflight.get(key) ?? this.probe(candidate, key, readers)
      this.inflight.set(key, pending)
      let result: CustomUpstreamReadResult
      try {
        result = await pending
      } finally {
        if (this.inflight.get(key) === pending) this.inflight.delete(key)
      }
      last = result
      if (result.usage !== null || result.classification.kind === 'ambiguous') return result
    }
    return last
  }

  /** 读取缓存中的分类，供诊断和测试使用；不会触发网络请求。 */
  get(source: CustomUpstreamSource, adapterId = '', providerId?: string): CustomUpstreamClassification | null {
    const entry = this.getCached(sourceKey(source, `${adapterId}\0${providerId ?? ''}`))
    return entry?.classification ?? null
  }

  clear(): void {
    this.cache.clear()
    this.inflight.clear()
  }

  private async readCached(
    candidate: CustomUpstreamCandidate,
    classification: CustomUpstreamClassification,
    readers: CustomUpstreamReaders,
  ): Promise<CustomUpstreamReadResult> {
    if (classification.kind === 'new-api' || classification.kind === 'new-api-billing-compatible') {
      if (!candidate.newApi || readers.newApi === undefined) return { usage: null, classification }
      const result = await safeRead(readers.newApi, candidate.source)
      return { usage: result?.usage ?? null, classification }
    }
    if (classification.kind === 'sub2api') {
      if (!candidate.sub2api || readers.sub2api === undefined) return { usage: null, classification }
      const result = await safeRead(readers.sub2api, candidate.source)
      return { usage: result?.usage ?? null, classification }
    }
    return { usage: null, classification }
  }

  private async probe(
    candidate: CustomUpstreamCandidate,
    key: string,
    readers: CustomUpstreamReaders,
  ): Promise<CustomUpstreamReadResult> {
    const [newApiResult, sub2apiResult] = await Promise.all([
      candidate.newApi && readers.newApi !== undefined ? safeRead(readers.newApi, candidate.source) : Promise.resolve(null),
      candidate.sub2api && readers.sub2api !== undefined ? safeRead(readers.sub2api, candidate.source) : Promise.resolve(null),
    ])
    const now = new Date()
    let kind: CustomUpstreamKind = 'unknown'
    let confidence: CustomUpstreamClassification['confidence'] = 'unknown'
    let usage: CliSubscriptionUsage | null = null

    if (newApiResult !== null && sub2apiResult !== null) {
      kind = 'ambiguous'
      confidence = 'ambiguous'
    } else if (newApiResult !== null) {
      kind = newApiResult.kind
      confidence = newApiResult.kind === 'new-api' ? 'strong' : 'weak'
      usage = newApiResult.usage
    } else if (sub2apiResult !== null) {
      kind = 'sub2api'
      confidence = 'strong'
      usage = sub2apiResult.usage
    }

    const detectedAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + (confidence === 'strong' || confidence === 'weak' ? this.positiveTtlMs : this.negativeTtlMs)).toISOString()
    const classification: CustomUpstreamClassification = {
      kind,
      reader: kind === 'new-api' || kind === 'new-api-billing-compatible' ? 'new-api' : kind === 'sub2api' ? 'sub2api' : null,
      confidence,
      sourceUrl: sanitizeSourceUrl(candidate.source.baseUrl),
      sourceKey: key,
      detectedAt,
      expiresAt,
    }
    this.cache.set(key, { classification, expiresAtMs: Date.parse(expiresAt) })
    return { usage, classification }
  }

  private getCached(key: string): CacheEntry | null {
    const entry = this.cache.get(key)
    if (entry === undefined) return null
    if (entry.expiresAtMs <= Date.now()) {
      this.cache.delete(key)
      return null
    }
    return entry
  }
}

/** 读取器属于网络边界；单侧异常只能表示该侧本次不可用，不能让分类器抛出或切换已缓存协议。 */
async function safeRead<T extends (source: CustomUpstreamSource) => Promise<unknown>>(
  reader: T,
  source: CustomUpstreamSource,
): Promise<Awaited<ReturnType<T>> | null> {
  try {
    return await reader(source) as Awaited<ReturnType<T>>
  } catch {
    return null
  }
}

/** 合并两个读取器发现的来源；同一 URL + Key 只保留一个候选。 */
export function mergeCustomUpstreamCandidates(
  newApiSources: readonly CustomUpstreamSource[],
  sub2apiSources: readonly CustomUpstreamSource[],
): CustomUpstreamCandidate[] {
  const merged = new Map<string, CustomUpstreamCandidate>()
  for (const source of newApiSources) {
    const key = sourceKey(source)
    const previous = merged.get(key)
    merged.set(key, { source, newApi: true, sub2api: previous?.sub2api ?? false })
  }
  for (const source of sub2apiSources) {
    const key = sourceKey(source)
    const previous = merged.get(key)
    merged.set(key, { source: previous?.source ?? source, newApi: previous?.newApi ?? false, sub2api: true })
  }
  return [...merged.values()]
}

function sourceKey(source: CustomUpstreamSource, scope = ''): string {
  const apiKey = source.apiKey.trim().replace(/^Bearer\s+/iu, '')
  const digest = createHash('sha256').update(apiKey).digest('hex')
  return `${scope}\0${sanitizeSourceUrl(source.baseUrl)}\0${digest}`
}

function sanitizeSourceUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname.replace(/\/v1\/?$/u, '').replace(/\/+$/u, '') || '/'
    return url.toString().replace(/\/$/u, '')
  } catch {
    return value.trim().replace(/\/v1\/?$/u, '').replace(/\/+$/u, '')
  }
}

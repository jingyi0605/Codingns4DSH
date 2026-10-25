import {
  CODINGNS_NPM_REGISTRY, CODINGNS_PACKAGE_NAME, compareSemver, evaluateDshCompatibility, isSemver, updateError,
  validatePluginUpdateChannel, type PluginCompatibility, type PluginUpdateChannel, type PluginUpdateTarget,
} from '../../shared/contracts/plugin-update.js'
import { date, readUpdateJson, record, sha, type UpdateFetch } from './http.js'
import { readPluginRelease } from './release-notes.js'

export class PluginUpdateMetadata {
  private readonly pending = new Map<string, Promise<PluginUpdateTarget>>()
  private readonly lifetime = new AbortController()

  constructor(private readonly dshVersion: string | null, private readonly request: UpdateFetch = globalThis.fetch) {}

  read(channel: PluginUpdateChannel): Promise<PluginUpdateTarget> {
    const selection = validatePluginUpdateChannel(channel)
    const key = selection.kind === 'exact' ? selection.version! : selection.kind
    const existing = this.pending.get(key)
    if (existing) return existing
    this.lifetime.signal.throwIfAborted()
    const pending = this.load(selection, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(20_000)]))
      .finally(() => this.pending.delete(key))
    this.pending.set(key, pending)
    return pending
  }

  dispose(): void { this.lifetime.abort(); this.pending.clear() }

  private async load(channel: PluginUpdateChannel, signal: AbortSignal): Promise<PluginUpdateTarget> {
    const metadata = record(await readUpdateJson(`${CODINGNS_NPM_REGISTRY}/${encodeURIComponent(CODINGNS_PACKAGE_NAME)}`, this.request, signal))
    if (metadata?.name !== CODINGNS_PACKAGE_NAME) throw updateError('UPDATE_METADATA_INVALID')
    const tags = record(metadata['dist-tags'])
    const version = channel.kind === 'exact' ? channel.version : tags?.[channel.kind]
    if (typeof version !== 'string' || !isSemver(version)) throw updateError('UPDATE_CHANNEL_UNAVAILABLE')
    const manifest = record(record(metadata.versions)?.[version])
    if (manifest?.version !== version || manifest.name !== CODINGNS_PACKAGE_NAME) throw updateError('UPDATE_METADATA_INVALID')
    const requirements: string[] = []
    let invalidRequirement = false
    const engines = record(manifest.engines)
    const peers = record(manifest.peerDependencies)
    for (const value of [engines?.dsh, ...Object.entries(peers ?? {}).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')).map(([, range]) => range)]) {
      if (value === undefined) continue
      if (typeof value !== 'string' || value.length > 512) { invalidRequirement = true; continue }
      requirements.push(value)
    }
    const checks = requirements.map(range => evaluateDshCompatibility(range, this.dshVersion))
    const compatibility: PluginCompatibility = checks.find(check => check.state === 'incompatible')
      ?? (invalidRequirement || checks.length === 0 || checks.some(check => check.state === 'unknown')
        ? { state: 'unknown', dshVersion: this.dshVersion, reason: 'UPDATE_COMPATIBILITY_UNKNOWN' }
        : { state: 'compatible', dshVersion: this.dshVersion, required: [...new Set(requirements)].join('; ').slice(0, 1024) })
    const gitHead = sha(manifest.gitHead)
    return {
      version, compatibility, gitHead, publishedAt: date(record(metadata.time)?.[version]),
      distTags: ['latest', 'next'].filter(tag => tags?.[tag] === version),
      release: await readPluginRelease(version, gitHead, this.request, signal),
    }
  }
}

export function pluginUpdateCheckState(target: PluginUpdateTarget, versions: readonly (string | null)[]) {
  if (target.compatibility.state === 'incompatible') return 'incompatible' as const
  if (target.compatibility.state === 'unknown') return 'compatibility-unknown' as const
  const known = versions.filter((version): version is string => version !== null && isSemver(version))
  if (known.length === 0) return 'unsupported' as const
  const newest = known.reduce((left, right) => compareSemver(left, right) >= 0 ? left : right)
  const comparison = compareSemver(target.version, newest)
  return comparison > 0 ? 'update-available' as const : comparison === 0 ? 'up-to-date' as const : 'no-newer-version' as const
}

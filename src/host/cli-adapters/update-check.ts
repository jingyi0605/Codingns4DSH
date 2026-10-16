import type { CodingNsCliAdapterDescriptor } from '../../shared/contracts/cli-adapter.js'
import { AGENT_MANAGEMENT_DEFINITIONS, managementNpmPackage } from './management-methods.js'
import { codexStandaloneDirectory, resolveManagementInstallation } from './management-installation.js'

type Update = NonNullable<CodingNsCliAdapterDescriptor['update']>
interface ReleaseSource {
  readonly url: string
  readonly read: (text: string) => unknown
  readonly manualUpdate?: boolean
}
interface Check {
  readonly adapter: CodingNsCliAdapterDescriptor
  source: ReleaseSource | undefined
  update: Update
}

class ReleaseCheckError extends Error {
  constructor(readonly failure: 'http' | 'invalid-response', readonly httpStatus?: number) { super(failure) }
}

function unchecked(adapter: CodingNsCliAdapterDescriptor): Update {
  const sourceUrl = AGENT_MANAGEMENT_DEFINITIONS[adapter.id]?.sourceUrl
  return { state: 'unchecked', ...(sourceUrl === undefined ? {} : { sourceUrl }) }
}

const jsonVersion = (text: string): unknown => JSON.parse(text).version
const jsonLatest = (text: string): unknown => JSON.parse(text).latest
const npmSource = (name: string): ReleaseSource => ({ url: `https://registry.npmjs.org/${name}/latest`, read: jsonVersion })

/** Only publisher feeds verified against their official installers or package guides. */
export function agentReleaseSource(adapter: CodingNsCliAdapterDescriptor, platform: NodeJS.Platform, arch: string): ReleaseSource | undefined {
  const definition = AGENT_MANAGEMENT_DEFINITIONS[adapter.id]
  if (adapter.id === 'zcode') {
    if (!/[\\/]resources[\\/]glm[\\/]zcode\.cjs$/iu.test(adapter.command ?? '') || !['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) return undefined
    const os = platform === 'win32' ? 'windows' : platform
    const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64'
    return { url: `https://zcode.z.ai/api/v1/releases/electron/manifest?platform=${os}-${cpu}&channel=1`,
      read: text => text.match(/^version:\s*["']?(\d+\.\d+\.\d+(?:-[\w.-]+)?)["']?\s*$/mu)?.[1], manualUpdate: true }
  }
  if (!definition || definition.manual) return undefined
  const brew = (adapter.command ?? '').replaceAll('\\', '/').match(/\/(Cellar|Caskroom)\/([^/]+)\//u)
  if (brew && (definition.brew?.at(-1) === brew[2] || (adapter.id === 'claude-code' && brew[2] === 'claude-code@latest'))) {
    const cask = definition.brew!.includes('--cask')
    return { url: `https://formulae.brew.sh/api/${cask ? 'cask' : 'formula'}/${brew[2]}.json`,
      read: cask ? jsonVersion : text => JSON.parse(text).versions.stable }
  }
  if (adapter.id === 'codex' && codexStandaloneDirectory(adapter.command ?? '', platform)) {
    return { url: 'https://releases.openai.com/codex/channels/latest', read: text => {
      const tag: unknown = JSON.parse(text).tag_name
      return typeof tag === 'string' && tag.startsWith('rust-v') ? tag.slice(6) : undefined
    } }
  }
  // These major versions identify separate distributions; do not advertise a migration as an update.
  if (adapter.id === 'kimi' && !/^v?2\./u.test(adapter.version ?? '')) return undefined
  if (adapter.id === 'opencode') return npmSource(/^v?2\./u.test(adapter.version ?? '') ? '@opencode/cli' : 'opencode-ai')
  if (adapter.id === 'pi') return npmSource(managementNpmPackage(adapter)!)
  if (adapter.id === 'codebuddy' && /[\\/]\.codebuddy[\\/](?:bin|versions)[\\/]/iu.test(adapter.command ?? '')) {
    return { url: 'https://acc-1258344699.cos.accelerate.myqcloud.com/@tencent-ai/codebuddy-code/releases/latest', read: text => text.trim() }
  }
  if (definition.npm) return npmSource(definition.npm)
  switch (adapter.id) {
    case 'grok': return { url: 'https://x.ai/cli/stable', read: text => text.trim() }
    case 'kiro-cli': return { url: 'https://prod.download.cli.kiro.dev/stable/latest/manifest.json', read: jsonVersion }
    case 'qoder': return { url: 'https://qoder-ide.oss-accelerate.aliyuncs.com/qodercli/channels/manifest.json', read: jsonLatest }
    case 'qoder-cn': return { url: 'https://static.qoder.com.cn/qoder-cli-cn/channels/manifest.json', read: jsonLatest }
    case 'cursor-cli': return {
      url: platform === 'win32' ? 'https://cursor.com/install?win32=true' : 'https://cursor.com/install',
      // Read the pinned download path as data. Never evaluate the installer.
      read: text => text.match(/https:\/\/downloads\.cursor\.com\/lab\/(\d{4}\.\d{2}\.\d{2}-[a-z\d]+)\//u)?.[1],
    }
    case 'antigravity': {
      const os = platform === 'win32' ? 'windows' : platform
      const cpu = arch === 'x64' ? 'amd64' : arch
      if (!['windows', 'darwin', 'linux'].includes(os) || !['amd64', 'arm64'].includes(cpu)) return undefined
      return { url: `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${os}_${cpu}.json`, read: jsonVersion }
    }
    default: return undefined
  }
}

interface Version { readonly core: readonly number[]; readonly pre: readonly string[] }
function parseVersion(value: string): Version | undefined {
  if (value.length > 128) return undefined
  const match = value.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/u)
  if (!match) return undefined
  const core = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
  const pre = match[4]?.split('.') ?? []
  if (core.some(part => !Number.isSafeInteger(part)) || pre.some(part => /^0\d+$/u.test(part))) return undefined
  return { core, pre }
}

/** Undefined means the versions cannot safely be ordered; build hashes are not release order. */
export function isNewerAgentVersion(current: string, latest: string, adapterId = ''): boolean | undefined {
  if (adapterId === 'cursor-cli') {
    const pattern = /^(\d{4}\.\d{2}\.\d{2})(?:-([a-z\d]+))?$/u
    const a = current.match(pattern), b = latest.match(pattern)
    if (!a || !b) return undefined
    if (a[1] !== b[1]) return b[1]! > a[1]!
    return a[2] && b[2] && a[2] !== b[2] ? undefined : false
  }
  const a = parseVersion(current), b = parseVersion(latest)
  if (!a || !b || (a.pre.length === 0 && b.pre.length > 0)) return undefined
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return b.core[index]! > a.core[index]!
  }
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length > 0 && b.pre.length === 0
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const left = a.pre[index], right = b.pre[index]
    if (left === right) continue
    if (left === undefined || right === undefined) return left === undefined
    const leftNumeric = /^\d+$/u.test(left), rightNumeric = /^\d+$/u.test(right)
    if (leftNumeric !== rightNumeric) return leftNumeric
    if (leftNumeric && left.length !== right.length) return right.length > left.length
    return right > left
  }
  return false
}

export interface CliUpdateCheckOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly timeoutMs?: number
  readonly resolveCommand?: (command: string, packageName?: string) => Promise<string | null>
}

/** Refresh schedules bounded HTTP work; ordinary catalog reads only attach in-memory snapshots. */
export class CliUpdateCheckService {
  private readonly checks = new Map<string, Check>()
  private readonly queue: Check[] = []
  private readonly lifetime = new AbortController()
  private active = 0
  private readonly fetch: typeof globalThis.fetch
  constructor(private readonly options: CliUpdateCheckOptions = {}) { this.fetch = options.fetch ?? globalThis.fetch }

  catalog(catalog: readonly CodingNsCliAdapterDescriptor[]): readonly CodingNsCliAdapterDescriptor[] {
    return catalog.map(adapter => {
      const check = this.checks.get(adapter.id)
      if (!eligible(adapter)) return adapter
      return { ...adapter, update: check && sameInstallation(adapter, check.adapter) ? { ...check.update } : unchecked(adapter) }
    })
  }

  refresh(catalog: readonly CodingNsCliAdapterDescriptor[], adapterId?: string): readonly CodingNsCliAdapterDescriptor[] {
    if (this.lifetime.signal.aborted) return catalog
    for (const adapter of catalog) {
      if (adapterId !== undefined && adapter.id !== adapterId) continue
      const previous = this.checks.get(adapter.id)
      if (previous?.update.state === 'checking' && sameInstallation(adapter, previous.adapter)) continue
      this.checks.delete(adapter.id)
      if (!eligible(adapter)) continue
      const comparable = adapter.version !== null && isNewerAgentVersion(adapter.version, adapter.version, adapter.id) !== undefined
      const source = comparable ? agentReleaseSource(adapter, this.options.platform ?? process.platform, this.options.arch ?? process.arch) : undefined
      const sourceUrl = AGENT_MANAGEMENT_DEFINITIONS[adapter.id]?.sourceUrl
      const check: Check = { adapter, source, update: {
        state: source ? 'checking' : 'unavailable',
        ...(!source ? { reason: unavailableReason(adapter, comparable) } : {}),
        ...(sourceUrl === undefined ? {} : { sourceUrl }),
      } }
      this.checks.set(adapter.id, check)
      if (source) this.queue.push(check)
    }
    this.pump()
    return this.catalog(catalog)
  }

  dispose(): void { this.lifetime.abort(); this.queue.length = 0; this.checks.clear() }

  private pump(): void {
    while (!this.lifetime.signal.aborted && this.active < 3 && this.queue.length > 0) {
      const check = this.queue.shift()!
      if (this.checks.get(check.adapter.id) !== check) continue
      this.active++
      void this.run(check).finally(() => { this.active--; this.pump() })
    }
  }

  private async run(check: Check): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8_000)
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    try {
      // Resolve package identity inside the bounded background queue, never in catalog RPCs.
      if (['pi', 'codebuddy', 'claude-code', 'codex', 'gemini'].includes(check.adapter.id) && check.adapter.command) {
        const command = await (this.options.resolveCommand ?? resolveManagementInstallation)(check.adapter.command, managementNpmPackage(check.adapter))
        signal.throwIfAborted()
        if (command || check.adapter.id === 'codex') check.source = agentReleaseSource({ ...check.adapter, command }, this.options.platform ?? process.platform, this.options.arch ?? process.arch)
      }
      if (!check.source) {
        check.update = { ...check.update, state: 'unavailable', reason: 'no-release-source', checkedAt: new Date().toISOString() }
        return
      }
      const body = await readRelease(this.fetch, check.source!.url, signal)
      let latest: unknown
      try { latest = check.source!.read(body) } catch { throw new ReleaseCheckError('invalid-response') }
      if (typeof latest !== 'string' || isNewerAgentVersion(latest, latest, check.adapter.id) === undefined) throw new ReleaseCheckError('invalid-response')
      const newer = typeof latest === 'string' ? isNewerAgentVersion(check.adapter.version!, latest, check.adapter.id) : undefined
      check.update = { ...check.update, state: newer === undefined ? 'unavailable' : newer ? 'available' : 'current',
        ...(newer === undefined ? { reason: 'incomparable-version' as const } : {}),
        ...(check.source.manualUpdate ? { manualUpdate: true } : {}),
        ...(newer === undefined ? {} : { latestVersion: latest as string }), checkedAt: new Date().toISOString() }
    } catch (error) {
      const failure = signal.aborted ? 'timeout' : error instanceof ReleaseCheckError ? error.failure : 'network'
      check.update = { ...check.update, state: 'error', failure, checkedAt: new Date().toISOString(),
        ...(error instanceof ReleaseCheckError && error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}) }
    } finally { clearTimeout(timer) }
  }
}

function unavailableReason(adapter: CodingNsCliAdapterDescriptor, comparable: boolean): NonNullable<Update['reason']> {
  if (['workbuddy', 'doubao'].includes(adapter.id)) return 'application-managed'
  if (!comparable) return 'unknown-version'
  if (adapter.id === 'kimi' && !/^v?2\./u.test(adapter.version ?? '')) return 'legacy-distribution'
  return 'no-release-source'
}

function eligible(adapter: CodingNsCliAdapterDescriptor): boolean {
  return adapter.installed && !adapter.detectionFailure
    && (adapter.detectionState === undefined || adapter.detectionState === 'ready')
}
function sameInstallation(a: CodingNsCliAdapterDescriptor, b: CodingNsCliAdapterDescriptor): boolean {
  return a.version === b.version && a.command === b.command && a.installed === b.installed
}

async function readRelease(fetch: typeof globalThis.fetch, url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json, text/plain', 'User-Agent': 'CodingNS-update-check' }, credentials: 'omit' })
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new ReleaseCheckError('http', response.status) }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0, text = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) return text + decoder.decode()
      bytes += part.value.byteLength
      if (bytes > 512 * 1024) throw new ReleaseCheckError('invalid-response')
      text += decoder.decode(part.value, { stream: true })
    }
  } finally { await reader.cancel(); reader.releaseLock() }
}

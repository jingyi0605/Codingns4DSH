import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 自定义 Provider 的凭据来源；原始密钥只在 Host 内使用。 */
export interface DshProviderSource {
  readonly baseUrl: string
  readonly apiKey: string
}

/**
 * 读取当前 DSH 配置中的 Provider 来源。
 *
 * DSH 0.1.x 会把配置导入 `settings.yaml.imported`，而较新的 Profile
 * 把插件配置放在 `profiles/<name>/cordis.patch.yml`。订阅读取不能只看
 * 前者，否则活动 Profile 的自定义 Provider 会被误判成官方默认 Provider。
 */
export function readDshProviderSource(providerId: string | undefined): DshProviderSource | null {
  const normalized = providerId?.trim()
  if (normalized === undefined || normalized === '') return null
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  for (const path of dshConfigPaths()) {
    const source = readProviderBlock(readText(path), escaped)
    if (source !== null) return source
  }
  return null
}

/** 读取当前 Profile 的 agent-default-model Provider。 */
export function readDshDefaultProvider(): string | undefined {
  for (const path of dshConfigPaths()) {
    const text = readText(path)
    if (text === null) continue
    const provider = readDefaultProvider(text)
    if (provider !== undefined) return provider
  }
  return undefined
}

function dshConfigPaths(): string[] {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const result: string[] = []
  const add = (path: string): void => {
    if (!result.includes(path)) result.push(path)
  }
  // Desktop Host 的工作目录就是当前 Profile 根目录；优先读取它，避免在
  // 未透传 Profile 环境变量时把另一个 Profile 的 Provider 当成当前配置。
  add(join(process.cwd(), 'cordis.patch.yml'))
  add(join(process.cwd(), 'cordis.yml'))
  const profileNames = configuredProfileNames(home)
  // 活动 Profile 优先；旧导入配置只作为兼容回退。
  for (const profile of profileNames) {
    add(join(home, 'profiles', profile, 'cordis.patch.yml'))
    add(join(home, 'profiles', profile, 'cordis.yml'))
  }
  add(join(home, 'settings.yaml'))
  add(join(home, 'settings.yaml.imported'))
  return result
}

function configuredProfileNames(home: string): string[] {
  const explicit = [
    process.env.CODINGNS4DSH_PROFILE_NAME,
    process.env.DSH_PROFILE,
    process.env.DSH_PROFILE_NAME,
  ].find((value) => typeof value === 'string' && value.trim() !== '')
  if (explicit !== undefined) return [explicit.trim()]

  // 发布版 Web Profile 是没有自定义环境变量时最可靠的活动配置位置。
  // 同时保留 Stage0/其它非 Desktop Profile，方便开发启动器和测试环境。
  const names = ['web', 'stage0', 'codingns', 'codingns017', 'headless']
  const profilesRoot = join(home, 'profiles')
  try {
    for (const name of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!name.isDirectory() || name.name === 'desktop' || names.includes(name.name)) continue
      names.push(name.name)
    }
  } catch {
    // 没有 Profile 目录时继续读取 settings.yaml。
  }
  return names
}

function readProviderBlock(text: string | null, providerId: string): DshProviderSource | null {
  if (text === null) return null
  const match = new RegExp(`^([ \\t]+)(?:${providerId}):[ \\t]*$`, 'mu').exec(text)
  if (match === null) return null
  const indent = match[1]?.length ?? 0
  if (indent === 0) return null
  const rest = text.slice(match.index)
  const boundary = new RegExp(`^[ \\t]{0,${Math.max(0, indent - 1)}}\\S[^\\n]*$`, 'mu').exec(rest.slice(match[0].length))
  const block = boundary === null ? rest : rest.slice(0, match[0].length + boundary.index)
  const baseUrl = yamlScalar(block.match(/^[ \t]+baseURL:[ \t]*(.+)$/mu)?.[1])
  const keyRef = yamlScalar(block.match(/^[ \t]+apiKeyEnv:[ \t]*(.+)$/mu)?.[1])
  const apiKey = keyRef === null ? null : readDshCredential(keyRef)
  return baseUrl === null || apiKey === null ? null : { baseUrl, apiKey }
}

function readDefaultProvider(text: string): string | undefined {
  // Profile YAML：- id: agent-default-model + config.provider
  const plugin = /^- id:[ \t]*agent-default-model[ \t]*$/mu.exec(text)
  if (plugin !== null) {
    const rest = text.slice(plugin.index)
    const next = /^- id:/mu.exec(rest.slice(plugin[0].length))
    const block = next === null ? rest : rest.slice(0, plugin[0].length + next.index)
    const provider = yamlScalar(block.match(/^[ \t]+provider:[ \t]*(.+)$/mu)?.[1])
    if (provider !== null) return provider
  }
  // settings.yaml：agent-default-model: + provider
  const start = text.search(/^agent-default-model:\s*$/mu)
  if (start >= 0) {
    const rest = text.slice(start)
    const end = /^\S[^\n]*$/mu.exec(rest.slice(1))
    const block = end === null ? rest : rest.slice(0, end.index + 1)
    const provider = yamlScalar(block.match(/^[ \t]+provider:[ \t]*(.+)$/mu)?.[1])
    if (provider !== null) return provider
  }
  return undefined
}

function readDshCredential(name: string): string | null {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const paths = [join(home, '.credentials.yaml'), join(home, '.env'), join(process.cwd(), '.env')]
  const escapedName = name.replace(/[.*+?^${}()|[\[\]\\]/gu, '\\$&')
  const yamlPattern = new RegExp(`^\\s*${escapedName}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([^#\\s]+))`, 'mu')
  const envPattern = new RegExp(`^\\s*${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^#\\s]+))`, 'mu')
  for (const path of paths) {
    const text = readText(path)
    if (text === null) continue
    const match = path.endsWith('.env') ? envPattern.exec(text) : yamlPattern.exec(text)
    const value = match?.[1] ?? match?.[2] ?? match?.[3]
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return null
}

function yamlScalar(value: string | undefined): string | null {
  if (value === undefined) return null
  const normalized = value.trim().replace(/^(['"])(.*)\1$/u, '$2')
  return normalized === '' ? null : normalized
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null
  try { return readFileSync(path, 'utf8') } catch { return null }
}

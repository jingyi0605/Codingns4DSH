import type { CodingNsTerminalShell, CodingNsTerminalRuntimeType } from './terminal.js'

/** Workspace 级 Spec003 配置文件。 */
export interface DebugConfig {
  readonly version: 1
  readonly profiles: readonly DebugProfile[]
}

/** 一条按配置启动的终端命令。 */
export interface DebugProfile {
  readonly id: string
  readonly name: string
  readonly cwdRelative: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly shell: DebugShell
  readonly runtimeType: DebugRuntimeType
  readonly port: number | null
  readonly proxy: DebugProxyConfig
}

export type DebugRuntimeType = CodingNsTerminalRuntimeType

export type DebugShell = CodingNsTerminalShell

export interface DebugProxyConfig {
  readonly enabled: boolean
}

export const EMPTY_DEBUG_CONFIG: DebugConfig = { version: 1, profiles: [] }

/** 解析并校验 Workspace 配置；不接受绝对路径、越界路径和秘密环境变量。 */
export function parseDebugConfig(value: unknown): DebugConfig {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles)) {
    throw new TypeError('Spec003 配置必须是 version=1 的对象')
  }
  const profiles = value.profiles.map(parseDebugProfile)
  const ids = new Set<string>()
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new TypeError(`Spec003 配置项 ID 重复: ${profile.id}`)
    ids.add(profile.id)
  }
  return { version: 1, profiles }
}

function parseDebugProfile(value: unknown): DebugProfile {
  if (!isRecord(value)) throw new TypeError('Spec003 配置项必须是对象')
  const id = stringField(value.id, 'id')
  const name = stringField(value.name, 'name')
  const cwdRelative = stringField(value.cwdRelative, 'cwdRelative')
  if (!isRelativePath(cwdRelative)) throw new TypeError('cwdRelative 必须是 Workspace 内相对路径')
  const command = stringField(value.command, 'command')
  const args = stringArray(value.args ?? [], 'args')
  const env = recordOfStrings(value.env ?? {}, 'env')
  if (Object.keys(env).some((key) => /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/iu.test(key))) {
    throw new TypeError('配置不能持久化秘密环境变量')
  }
  if (!isRecord(value.shell)) throw new TypeError('shell 必须是对象')
  const profileId = stringField(value.shell.profileId, 'shell.profileId')
  if (profileId !== 'zsh' && profileId !== 'bash' && profileId !== 'powershell' && profileId !== 'cmd' && profileId !== 'git-bash') throw new TypeError('shell.profileId 无效')
  const shell: DebugShell = {
    profileId,
    path: stringField(value.shell.path, 'shell.path'),
    args: stringArray(value.shell.args ?? [], 'shell.args'),
    name: stringField(value.shell.name, 'shell.name'),
  }
  const runtimeType = value.runtimeType
  if (runtimeType !== 'local-pty' && runtimeType !== 'tmux' && runtimeType !== 'conpty-powershell' && runtimeType !== 'conpty-cmd' && runtimeType !== 'conpty-git-bash') {
    throw new TypeError('runtimeType 无效')
  }
  const port = value.port === undefined || value.port === null ? null : portValue(value.port)
  const proxyValue = value.proxy === undefined ? {} : value.proxy
  if (!isRecord(proxyValue)) throw new TypeError('proxy 必须是对象')
  const enabled = proxyValue.enabled === undefined ? false : proxyValue.enabled
  if (typeof enabled !== 'boolean') throw new TypeError('proxy.enabled 必须是布尔值')
  return { id, name, cwdRelative, command, args, env, shell, runtimeType, port, proxy: { enabled } }
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0') || value.length > 512) throw new TypeError(`${field} 必须是非空字符串`)
  return value.trim()
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.includes('\0') || item.length > 4096)) throw new TypeError(`${field} 必须是字符串数组`)
  return [...value]
}

function recordOfStrings(value: unknown, field: string): Readonly<Record<string, string>> {
  if (!isRecord(value) || Object.entries(value).some(([key, item]) => key.trim() === '' || typeof item !== 'string')) throw new TypeError(`${field} 必须是字符串对象`)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item as string]))
}

function portValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 65535) throw new TypeError('port 必须是 1 到 65535 的整数')
  return value
}

function isRelativePath(value: string): boolean {
  return value === '.' || (value !== '' && !value.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(value) && value !== '..' && !value.startsWith('../') && !value.startsWith('..\\') && !value.includes('/../') && !value.includes('\\..'))
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodingNsCliSessionRecord } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliAdapterPreference } from '../../shared/contracts/config.js'

/** DSH 旧版设置导入文件的默认位置。 */
export function defaultLegacySettingsPath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'settings.yaml.imported')
}

/**
 * 读取旧版 `codingns.cliSessions` 索引。
 *
 * DSH 没有向插件暴露旧设置文档的结构化读取接口，这里只解析稳定的
 * `cliSessions` 子集，避免引入 YAML 解析器或把旧设置的其它字段带入运行时。
 */
export function readLegacyImportedSessionRecords(path = defaultLegacySettingsPath()): readonly CodingNsCliSessionRecord[] {
  const text = readLegacySettingsText(path)
  if (text === undefined) return []
  return parseLegacyImportedSessionRecords(text)
}

/**
 * 读取旧版 `codingns.agentAdapterPreferences` 偏好。
 *
 * DSH 0.1.7 会把旧 `settings.yaml` 重命名为 `settings.yaml.imported`，但
 * ConfigForms 只按新的 scoped entry id 导入。模型和思考强度因此不能依赖
 * DSH 自己的导入器，必须在 Host 启动时从旧文档补回。
 */
export function readLegacyImportedAdapterPreferences(
  path = defaultLegacySettingsPath(),
): Readonly<Record<string, CodingNsCliAdapterPreference>> {
  const text = readLegacySettingsText(path)
  if (text === undefined) return {}
  return parseLegacyImportedAdapterPreferences(text)
}

function readLegacySettingsText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    // ConfigForms 的异步迁移尚未完成时，旧文件仍可能保持原名。
    if (!path.endsWith('.imported')) return undefined
    try {
      return readFileSync(path.slice(0, -'.imported'.length), 'utf8')
    } catch {
      return undefined
    }
  }
}

/** 解析旧版设置文本，单独导出以便用固定 fixture 验证迁移规则。 */
export function parseLegacyImportedSessionRecords(text: string): readonly CodingNsCliSessionRecord[] {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const records: CodingNsCliSessionRecord[] = []
  let inSessions = false
  let current: Record<string, unknown> | undefined

  const flush = (): void => {
    if (current !== undefined && isSessionRecord(current)) records.push(current)
    current = undefined
  }

  for (const line of lines) {
    if (/^  cliSessions:\s*$/u.test(line)) {
      flush()
      inSessions = true
      continue
    }
    if (inSessions && /^  [A-Za-z][\w-]*:\s*/u.test(line)) {
      flush()
      inSessions = false
    }
    if (!inSessions) continue

    const item = /^    - dshSessionId:\s*(.*)$/u.exec(line)
    if (item !== null) {
      flush()
      current = { dshSessionId: parseScalar(item[1]!) }
      continue
    }
    const field = /^      ([A-Za-z][\w-]*):\s*(.*)$/u.exec(line)
    if (field !== null && current !== undefined) current[field[1]!] = parseScalar(field[2]!)
  }
  flush()
  return records
}

/** 解析旧设置中按适配器分组的最近模型与思考强度。 */
export function parseLegacyImportedAdapterPreferences(
  text: string,
): Readonly<Record<string, CodingNsCliAdapterPreference>> {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const preferences: Record<string, CodingNsCliAdapterPreference> = {}
  let inPreferences = false
  let adapterId: string | undefined
  let current: { modelId?: string; effortId?: string; translationEnabled?: boolean } | undefined

  const flush = (): void => {
    if (adapterId === undefined || current === undefined) return
    if (current.modelId === undefined && current.effortId === undefined && current.translationEnabled === undefined) return
    preferences[adapterId] = { ...current }
  }

  for (const line of lines) {
    if (/^  agentAdapterPreferences:\s*$/u.test(line)) {
      flush()
      inPreferences = true
      adapterId = undefined
      current = undefined
      continue
    }
    if (inPreferences && /^  [A-Za-z][\w-]*:\s*/u.test(line)) {
      flush()
      inPreferences = false
      adapterId = undefined
      current = undefined
    }
    if (!inPreferences) continue

    const adapter = /^    ([A-Za-z][\w-]*):\s*$/u.exec(line)
    if (adapter !== null) {
      flush()
      adapterId = adapter[1]
      current = {}
      continue
    }
    if (adapterId === undefined || current === undefined) continue
    const field = /^      (modelId|effortId|translationEnabled):\s*(.*)$/u.exec(line)
    if (field === null) continue
    const value = parseScalar(field[2]!)
    if (field[1] === 'translationEnabled') {
      if (typeof value === 'boolean') current.translationEnabled = value
      continue
    }
    if (typeof value !== 'string' || value.trim() === '') continue
    current[field[1] as 'modelId' | 'effortId'] = value.trim()
  }
  flush()
  return preferences
}

function isSessionRecord(value: Record<string, unknown>): value is Record<string, unknown> & CodingNsCliSessionRecord {
  return typeof value.dshSessionId === 'string'
    && value.dshSessionId.trim() !== ''
    && typeof value.adapterId === 'string'
    && value.adapterId.trim() !== ''
    && isStatus(value.status)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
}

function isStatus(value: unknown): value is CodingNsCliSessionRecord['status'] {
  return value === 'active' || value === 'idle' || value === 'error' || value === 'archived'
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') return undefined
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed)
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

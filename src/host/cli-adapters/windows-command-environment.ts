import { win32 } from 'node:path'

type Environment = Readonly<Record<string, string | undefined>>

/** 注册表快照仅用于补充 PATH；绝不覆盖 Host 的登录票据或应用专用变量。 */
export interface WindowsEnvironmentSnapshot {
  readonly machine: Environment
  readonly user: Environment
}

export function environmentValue(environment: Environment, name: string): string | undefined {
  return Object.entries(environment).reverse().find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}

/** 保持调用方 PATH 的优先级，补上注册表新增目录，并统一 Windows 大小写别名。 */
export function windowsCommandEnvironment(base: Environment, snapshot?: WindowsEnvironmentSnapshot, directory?: string): Record<string, string | undefined> {
  const variables = new Map<string, string>()
  for (const source of [snapshot?.machine, snapshot?.user, base]) {
    for (const [key, value] of Object.entries(source ?? {})) if (value !== undefined) variables.set(key.toLowerCase(), value)
  }
  const expand = (value: string): string => {
    // 环境变量可以引用其他变量；有环或未知变量时保留原值，避免无限展开。
    for (let count = 0; count < 10; count++) {
      const next = value.replace(/%([^%]+)%/gu, (match, key: string) => variables.get(key.toLowerCase()) ?? match)
      if (next === value) break
      value = next
    }
    return value
  }
  const paths = [environmentValue(base, 'PATH'), environmentValue(snapshot?.machine ?? {}, 'PATH'), environmentValue(snapshot?.user ?? {}, 'PATH')]
  const entries = paths.flatMap((path) => expand(path ?? '').split(';')).map((path) => path.trim().replace(/^"(.*)"$/u, '$1')).filter(Boolean)
  const identity = (path: string): string => win32.normalize(path).replace(/[\\/]+$/u, '').toLowerCase()
  if (directory !== undefined && !entries.some((entry) => identity(entry) === identity(directory))) entries.unshift(directory)
  const seen = new Set<string>()
  const unique = entries.filter((entry) => {
    const key = identity(entry)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const environment = Object.fromEntries(Object.entries(base).filter(([key]) => key.toLowerCase() !== 'path'))
  return { ...environment, PATH: unique.join(';') }
}

export function parseWindowsEnvironmentSnapshot(text: string): WindowsEnvironmentSnapshot | undefined {
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/u, '').trim())
    if (value === null || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    const read = (input: unknown): Record<string, string> => input !== null && typeof input === 'object'
      ? Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
    return { machine: read(record.machine), user: read(record.user) }
  } catch { return undefined }
}

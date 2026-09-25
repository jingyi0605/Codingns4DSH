/** 当前经过完整验证的 DSH 版本；源文件由根目录 version.json 同步。 */
export const DSH_VERSION = '0.1.6-alpha.2' as const

/** DSH 测试版本别名，供新代码表达语义，保留 DSH_VERSION 兼容旧调用方。 */
export const DSH_TESTED_VERSION = DSH_VERSION

/** 插件支持的 DSH 版本范围；插件版本与宿主版本独立发布。 */
export const DSH_COMPATIBILITY = '>=0.1.6-alpha.2 <0.1.7' as const

/** DSH Envelope/Tunnel 协议主版本。 */
export const DSH_PROTOCOL_VERSION = 1 as const

/** Host 注入到浏览器页面的真实 DSH 版本全局字段。 */
export const CODINGNS_DSH_VERSION_GLOBAL = '__CODINGNS_DSH_VERSION__' as const

/** CodingNS 插件自身的 npm 版本。 */
export const CODINGNS_VERSION = '0.1.0' as const

interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly (number | string)[]
}

/** 判断宿主版本是否落在当前插件声明的 DSH 兼容范围内。 */
export function isDshVersionCompatible(version: string): boolean {
  const match = /^>=([^ ]+) <([^ ]+)$/u.exec(DSH_COMPATIBILITY)
  const actual = parseVersion(version)
  const minimum = parseVersion(match?.[1] ?? '')
  const maximum = parseVersion(match?.[2] ?? '')
  if (!actual || !minimum || !maximum) return version === DSH_VERSION
  if (actual.major === maximum.major && actual.minor === maximum.minor && actual.patch === maximum.patch && actual.prerelease.length > 0) return false
  return compareVersions(actual, minimum) >= 0 && compareVersions(actual, maximum) < 0
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value)
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.').map((part) => /^\d+$/u.test(part) ? Number(part) : part),
  }
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1
  if (left.prerelease.length > 0 && right.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    if (typeof leftPart === 'number' && typeof rightPart === 'string') return -1
    if (typeof leftPart === 'string' && typeof rightPart === 'number') return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

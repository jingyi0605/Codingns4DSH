/** DSH verification target, synchronized with the root version.json. */
export const DSH_VERSION = '0.2.1-rc.3' as const

/** DSH 测试版本别名，供新代码表达语义，保留 DSH_VERSION 兼容旧调用方。 */
export const DSH_TESTED_VERSION = DSH_VERSION

/**
 * Only the minimum version blocks installation and activation.
 * Hosts newer than DSH_TESTED_VERSION receive an advisory warning.
 */
export const DSH_COMPATIBILITY = '>=0.2.0-rc.2' as const

/**
 * 兼容范围下界，即插件仍然接受的最低 DSH 版本。
 *
 * 供“宿主没有注入真实版本、但已确认处于现代世代”的保守回退使用：回退值取自
 * 范围本身，因此永远落在兼容范围内。写死某个历史版本会在范围收紧后变成
 * “不支持的 DSH 版本”，把仅仅缺少启动页注入的页面误判为宿主不兼容。
 */
export function minimumSupportedDshVersion(): string {
  const match = /^>=([^ ]+)/u.exec(DSH_COMPATIBILITY)
  return match?.[1] ?? DSH_VERSION
}

/** DSH Envelope/Tunnel 协议主版本。 */
export const DSH_PROTOCOL_VERSION = 1 as const

/** Host 注入到浏览器页面的真实 DSH 版本全局字段。 */
export const CODINGNS_DSH_VERSION_GLOBAL = '__CODINGNS_DSH_VERSION__' as const

/** 识别没有 alpha2 Sidebar 扩展 API 的 DSH 旧版运行时。 */
export function isLegacyDshVersion(version: string): boolean {
  return /^0\.1\.5(?:-|$)/u.test(version)
}

/** Codingns4DSH 插件自身的 npm 版本。 */
export const CODINGNS_VERSION = '0.2.1-rc.6' as const

interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
}

/** Accept any valid host version at or above the supported minimum. */
export function isDshVersionCompatible(version: string): boolean {
  return isDshVersionAtLeast(version, minimumSupportedDshVersion())
}

/** Newer hosts stay enabled; this predicate controls advisory notices only. */
export function isDshVersionNewerThanTested(version: string): boolean {
  const actual = parseVersion(version)
  const tested = parseVersion(DSH_TESTED_VERSION)
  return actual !== undefined && tested !== undefined && compareVersions(actual, tested) > 0
}

/** 判断 DSH 版本是否达到某个功能模块要求的最低版本。 */
export function isDshVersionAtLeast(version: string, minimum: string): boolean {
  return isVersionAtLeast(version, minimum)
}

/** 按语义版本比较大小；预发布标识参与排序，构建元数据不影响优先级，非法版本不放行。 */
export function isVersionAtLeast(version: string, minimum: string): boolean {
  const actual = parseVersion(version)
  const required = parseVersion(minimum)
  if (!actual || !required) return false
  return compareVersions(actual, required) >= 0
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value)
  if (!match) return undefined
  const core = match.slice(1, 4).map(Number)
  if (!core.every(Number.isSafeInteger)) return undefined
  const prerelease = match[4]?.split('.') ?? []
  // 数字预发布标识不能有前导零；超大数字保留字符串，用长度比较避免精度丢失。
  if (prerelease.some((part) => /^0\d+$/u.test(part))) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
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
    const leftNumeric = /^\d+$/u.test(leftPart)
    const rightNumeric = /^\d+$/u.test(rightPart)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    if (leftNumeric && leftPart.length !== rightPart.length) return leftPart.length - rightPart.length
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

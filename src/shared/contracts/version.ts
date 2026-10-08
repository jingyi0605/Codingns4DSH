/** 当前经过完整验证的 DSH 版本；源文件由根目录 version.json 同步。 */
export const DSH_VERSION = '0.2.1-alpha.1' as const

/** DSH 测试版本别名，供新代码表达语义，保留 DSH_VERSION 兼容旧调用方。 */
export const DSH_TESTED_VERSION = DSH_VERSION

/**
 * 插件正式验证的 DSH 版本范围，覆盖 rc.2 到当前验证的 alpha.1。
 *
 * 0.2.0-rc.2 与 0.2.1-alpha.1 属于同一 API 世代：插件消费的 7 个宿主包接口面
 * 未变（仅 dsh-client-ui-primitives 新增 InlineEditor），会话格式仍为 v4。因此
 * 这里保留明确上界，是为了让 npm/DSH 安装期也能识别 0.2.1-alpha.1 这个跨 patch
 * 预发布版本；出现新的 API 世代或结构变化时，应重新验证并更新范围与能力路由。
 */
export const DSH_COMPATIBILITY = '>=0.2.0-rc.2 <=0.2.1-alpha.1' as const

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
export const CODINGNS_VERSION = '0.2.1-beta.4' as const

interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly (number | string)[]
}

/** 判断宿主版本是否落在当前插件声明的 DSH 兼容范围内；范围省略上界时不校验上限。 */
export function isDshVersionCompatible(version: string): boolean {
  const match = /^>=([^ ]+)(?: <=([^ ]+))?$/u.exec(DSH_COMPATIBILITY)
  const actual = parseVersion(version)
  const minimum = parseVersion(match?.[1] ?? '')
  if (match === null || !actual || !minimum) return version === DSH_VERSION
  if (match[2] === undefined) return compareVersions(actual, minimum) >= 0
  const maximum = parseVersion(match[2])
  if (maximum === undefined) return version === DSH_VERSION
  return compareVersions(actual, minimum) >= 0 && compareVersions(actual, maximum) <= 0
}

/** 判断 DSH 版本是否达到某个功能模块要求的最低版本。 */
export function isDshVersionAtLeast(version: string, minimum: string): boolean {
  const actual = parseVersion(version)
  const required = parseVersion(minimum)
  if (!actual || !required) return false
  return compareVersions(actual, required) >= 0
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

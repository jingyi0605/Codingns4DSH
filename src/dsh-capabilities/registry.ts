import {
  createCapabilityProfile,
  type DshCapabilityDiagnostic,
  type DshCapabilityId,
  type DshCapabilityProfile,
  type DshCapabilityResolution,
  type DshCapabilityRoute,
  type DshCapabilityRuntime,
} from './types.js'

export type DshCapabilityRegistryErrorCode =
  | 'CAPABILITY_INVALID_ROUTE'
  | 'CAPABILITY_VERSION_UNSUPPORTED'
  | 'CAPABILITY_DETECT_FAILED'
  | 'CAPABILITY_ROUTE_CONFLICT'
  | 'CAPABILITY_UNAVAILABLE'

export class DshCapabilityRegistryError extends Error {
  readonly code: DshCapabilityRegistryErrorCode
  readonly capability: DshCapabilityId | null

  constructor(code: DshCapabilityRegistryErrorCode, message: string, capability: DshCapabilityId | null = null, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DshCapabilityRegistryError'
    this.code = code
    this.capability = capability
  }
}

/** 集中解析 DSH 能力路由；Profile 生成后不可变，避免运行期替换半初始化服务。 */
export class DshCapabilityRegistry {
  private readonly routes = new Map<DshCapabilityId, DshCapabilityRoute<unknown>[]>()
  private profile: DshCapabilityProfile | undefined

  constructor(
    readonly dshVersion: string,
    readonly runtime: DshCapabilityRuntime,
  ) {}

  register<T>(route: DshCapabilityRoute<T>): void {
    validateRoute(route)
    if (route.runtime !== this.runtime) return
    const list = this.routes.get(route.capability) ?? []
    if (list.some((entry) => entry.id === route.id)) {
      throw new DshCapabilityRegistryError('CAPABILITY_INVALID_ROUTE', `重复的能力路由: ${route.id}`, route.capability)
    }
    list.push(route as DshCapabilityRoute<unknown>)
    this.routes.set(route.capability, list)
    this.profile = undefined
  }

  registerMany(routes: readonly DshCapabilityRoute<unknown>[]): void {
    for (const route of routes) this.register(route)
  }

  resolve(context: unknown): DshCapabilityProfile {
    if (this.profile !== undefined) return this.profile
    const resolutions = new Map<DshCapabilityId, DshCapabilityResolution>()
    const diagnostics: DshCapabilityDiagnostic[] = []
    for (const [capability, routes] of this.routes) {
      const candidates = routes
        .filter((route) => isVersionInRange(this.dshVersion, route.supportedDsh))
        .sort((left, right) => routeRank(right) - routeRank(left))
      if (candidates.length === 0) {
        const reason = `DSH ${this.dshVersion} 没有能力 ${capability} 的适配路由`
        resolutions.set(capability, unavailable(capability, this.dshVersion, reason))
        diagnostics.push({ code: 'CAPABILITY_VERSION_UNSUPPORTED', capability, dshVersion: this.dshVersion, message: reason })
        continue
      }
      const topPriority = routeRank(candidates[0]!)
      const top = candidates.filter((route) => routeRank(route) === topPriority)
      if (top.length > 1) {
        throw new DshCapabilityRegistryError(
          'CAPABILITY_ROUTE_CONFLICT',
          `能力 ${capability} 存在同优先级路由: ${top.map((route) => route.id).join(', ')}`,
          capability,
        )
      }
      let selected: DshCapabilityRoute<unknown> | undefined
      for (const route of candidates) {
        try {
          if (route.detect(context)) {
            selected = route
            break
          }
        } catch (error) {
          diagnostics.push({
            code: 'CAPABILITY_DETECT_FAILED',
            capability,
            routeId: route.id,
            dshVersion: this.dshVersion,
            message: `${route.id} 探测失败: ${errorMessage(error)}`,
            ...(route.replacement === undefined ? {} : { replacement: route.replacement }),
          })
        }
      }
      if (selected === undefined) {
        const reason = `DSH ${this.dshVersion} 的能力 ${capability} 没有可用运行时实现`
        resolutions.set(capability, unavailable(capability, this.dshVersion, reason))
        diagnostics.push({ code: 'CAPABILITY_UNAVAILABLE', capability, dshVersion: this.dshVersion, message: reason })
        continue
      }
      try {
        const value = selected.create(context)
        const resolution = {
          capability,
          routeId: selected.id,
          dshVersion: this.dshVersion,
          status: selected.status === 'deprecated' ? 'degraded' : 'ready',
          value,
          ...(selected.replacement === undefined ? {} : { replacement: selected.replacement }),
        } satisfies DshCapabilityResolution
        resolutions.set(capability, resolution)
        if (selected.status === 'deprecated') {
          diagnostics.push({
            code: 'CAPABILITY_DEPRECATED',
            capability,
            routeId: selected.id,
            dshVersion: this.dshVersion,
            message: `能力 ${capability} 使用已弃用路由 ${selected.id}`,
            ...(selected.replacement === undefined ? {} : { replacement: selected.replacement }),
          })
        }
      } catch (error) {
        const reason = `${selected.id} 创建失败: ${errorMessage(error)}`
        resolutions.set(capability, unavailable(capability, this.dshVersion, reason))
        diagnostics.push({ code: 'CAPABILITY_CREATE_FAILED', capability, routeId: selected.id, dshVersion: this.dshVersion, message: reason })
      }
    }
    this.profile = createCapabilityProfile(this.dshVersion, this.runtime, resolutions, diagnostics)
    return this.profile
  }

  getProfile(context: unknown): DshCapabilityProfile {
    return this.resolve(context)
  }

  require<T>(profile: DshCapabilityProfile, capability: DshCapabilityId): T {
    const resolution = profile.capabilities.get(capability)
    if (resolution?.value === undefined || resolution.status === 'unavailable') {
      throw new DshCapabilityRegistryError('CAPABILITY_UNAVAILABLE', resolution?.reason ?? `能力不可用: ${capability}`, capability)
    }
    return resolution.value as T
  }

  explain(profile: DshCapabilityProfile, capability?: DshCapabilityId): readonly DshCapabilityDiagnostic[] {
    if (capability === undefined) return profile.diagnostics
    return profile.diagnostics.filter((item) => item.capability === capability)
  }
}

function validateRoute(route: DshCapabilityRoute<unknown>): void {
  if (route.id.trim() === '' || route.capability === undefined || route.supportedDsh.trim() === '') {
    throw new DshCapabilityRegistryError('CAPABILITY_INVALID_ROUTE', '能力路由必须包含 id、capability 和 supportedDsh')
  }
  if (!Number.isFinite(route.priority)) throw new DshCapabilityRegistryError('CAPABILITY_INVALID_ROUTE', `能力路由优先级非法: ${route.id}`, route.capability)
  if (typeof route.detect !== 'function' || typeof route.create !== 'function') throw new DshCapabilityRegistryError('CAPABILITY_INVALID_ROUTE', `能力路由缺少探测或工厂: ${route.id}`, route.capability)
}

function routeRank(route: DshCapabilityRoute<unknown>): number {
  return route.priority + (route.status === 'supported' ? 1_000_000 : 0)
}

function unavailable(capability: DshCapabilityId, dshVersion: string, reason: string): DshCapabilityResolution {
  return { capability, dshVersion, status: 'unavailable', reason }
}

function isVersionInRange(version: string, range: string): boolean {
  const match = /^>=([^ ]+) <([^ ]+)$/u.exec(range)
  if (match === null) return false
  const actual = parseVersion(version)
  const minimum = parseVersion(match[1]!)
  const maximum = parseVersion(match[2]!)
  if (actual === undefined || minimum === undefined || maximum === undefined) return false
  return compareVersions(actual, minimum) >= 0 && compareVersions(actual, maximum) < 0
}

interface ParsedVersion { readonly major: number; readonly minor: number; readonly patch: number; readonly pre: readonly (number | string)[] }

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value)
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.').map((part) => /^\d+$/u.test(part) ? Number(part) : part),
  }
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  if (left.pre.length === 0 && right.pre.length > 0) return 1
  if (left.pre.length > 0 && right.pre.length === 0) return -1
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const a = left.pre[index]
    const b = right.pre[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    if (typeof a === 'number' && typeof b === 'string') return -1
    if (typeof a === 'string' && typeof b === 'number') return 1
    return a < b ? -1 : 1
  }
  return 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

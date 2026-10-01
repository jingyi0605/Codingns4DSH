import type { CodingNsCliAdapterRegistry } from './registry.js'

/** cliAdapters 功能模块的当前注册表；模块停用时必须清空。 */
let current: CodingNsCliAdapterRegistry | undefined

export function setAdapterRegistry(registry: CodingNsCliAdapterRegistry | undefined): void {
  current = registry
}

export function getAdapterRegistry(): CodingNsCliAdapterRegistry | undefined {
  return current
}

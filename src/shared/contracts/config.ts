import type { FeatureDescriptor } from './feature.js'

/** CodingNS 在 DSH 设置文档中持久化的用户选项。 */
export interface CodingNsSettings {
  /** Control API 地址不是秘密，可以由 Web 设置页保存到 Host 设置。 */
  controlBaseUrl: string
  /**
   * 功能模块启用意图：模块名 -> 是否启用。
   *
   * 缺省时回落到模块自己声明的 enabledByDefault，因此设置结构不随模块数量变化。
   */
  modules: Record<string, boolean>
}

export const CODINGNS_SETTINGS_NAMESPACE = 'codingns'
export const CODINGNS_CONTROL_BASE_URL_FIELD = 'controlBaseUrl'
export const CODINGNS_MODULES_FIELD = 'modules'
export const DEFAULT_CODINGNS_SETTINGS: CodingNsSettings = {
  controlBaseUrl: '',
  modules: {},
}

/**
 * 判定一个功能模块当前是否应当启用。
 *
 * 常驻模块（ui.alwaysEnabled）始终启用；其余模块读取设置里的用户意图，
 * 用户没有表达过意图时使用模块自己声明的 enabledByDefault。
 */
export function isFeatureEnabled(
  descriptor: FeatureDescriptor,
  settings: CodingNsSettings | undefined,
): boolean {
  if (descriptor.ui?.alwaysEnabled === true) return true
  return settings?.modules[descriptor.name] ?? descriptor.enabledByDefault
}

/** 汇总当前应当启用的模块名，交给 FeatureRegistry.reconcile 对齐状态。 */
export function enabledFeatureNames(
  descriptors: readonly FeatureDescriptor[],
  settings: CodingNsSettings | undefined,
): string[] {
  const names: string[] = []
  for (const descriptor of descriptors) {
    if (isFeatureEnabled(descriptor, settings)) names.push(descriptor.name)
  }
  return names
}

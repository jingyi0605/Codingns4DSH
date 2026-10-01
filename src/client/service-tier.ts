import type { CodingNsCliModel, CodingNsCliModelCatalog, CodingNsCliServiceTier } from '../shared/contracts/cli-adapter.js'

/**
 * 服务档位（例如 Codex 官方订阅的 Fast）的展示与选择规则。
 *
 * 这里只做纯计算，不碰 React 和 DOM，便于用固定目录夹具直接验证语义。
 */

/** Codex 协议里代表“标准速度”的档位取值；关闭加速档位时显式下发它。 */
export const STANDARD_SERVICE_TIER_ID = 'default'

/** 当前模型声明的服务档位；模型未声明时返回空数组。 */
export function modelServiceTiers(model: CodingNsCliModel | undefined): readonly CodingNsCliServiceTier[] {
  return model?.serviceTiers ?? []
}

/**
 * 判断是否应该展示档位切换。
 *
 * 两个条件缺一不可：Provider 确认官方订阅、当前模型声明了档位。第三方中转或纯
 * API key 接入时档位不会生效，此时宁可不展示，也不能给出一个切换后没有效果的
 * 开关——「可选但无效」正是本适配器此前被报告过的缺陷形态。
 */
export function canSelectServiceTier(
  catalog: CodingNsCliModelCatalog | null,
  model: CodingNsCliModel | undefined,
): boolean {
  return catalog?.officialSubscription === true && modelServiceTiers(model).length > 0
}

/**
 * 计算当前真正生效的档位。
 *
 * 用户显式选择优先；未选择时回落到 Provider 配置的默认档位——Codex 的
 * `service_tier` 会被 app-server 继承，忽略它会把实际运行的加速档显示成标准档。
 * 默认值必须取自目录顶层的 `defaultServiceTier`，而不是模型的同名目录字段：
 * 后者只是目录元数据，app-server 并不会自动应用。
 */
export function effectiveServiceTierId(
  catalog: CodingNsCliModelCatalog | null,
  selectedId: string | undefined,
): string {
  const selected = selectedId?.trim()
  if (selected !== undefined && selected !== '') return selected
  const configuredDefault = catalog?.defaultServiceTier?.trim()
  return configuredDefault === undefined || configuredDefault === '' ? STANDARD_SERVICE_TIER_ID : configuredDefault
}

/** 开关是否处于打开状态：只有标准速度算关闭。 */
export function isServiceTierEnabled(
  catalog: CodingNsCliModelCatalog | null,
  selectedId: string | undefined,
): boolean {
  return effectiveServiceTierId(catalog, selectedId) !== STANDARD_SERVICE_TIER_ID
}

/**
 * 计算切换开关后要写入的档位 id。
 *
 * 打开时使用模型声明的首个档位（Codex 目前只声明一个 `priority`）。目录声明了
 * 多个档位时仍取首个，避免把“开/关”语义偷偷变成“多选一”。
 */
export function toggledServiceTierId(model: CodingNsCliModel | undefined, enabled: boolean): string | undefined {
  if (!enabled) return STANDARD_SERVICE_TIER_ID
  const tier = modelServiceTiers(model)[0]
  return tier === undefined ? undefined : tier.id
}

/** 生效档位对应的目录条目；标准速度或未知档位返回 undefined。 */
export function activeServiceTier(
  catalog: CodingNsCliModelCatalog | null,
  model: CodingNsCliModel | undefined,
  selectedId: string | undefined,
): CodingNsCliServiceTier | undefined {
  const id = effectiveServiceTierId(catalog, selectedId)
  return modelServiceTiers(model).find((tier) => tier.id === id)
}

/**
 * 在“只改了其它字段”的部分更新里保留当前档位选择。
 *
 * 这是本功能最容易被写坏的地方：档位与模型/思考等级共用同一份会话配置，任何一次
 * 只带 modelId 或 effortId 的更新如果省略 `serviceTierId`，都会把档位悄悄丢掉，
 * 界面随即落回标准档——父仓库 CodingNS 就曾在“新建会话开了 Fast、建完又落回标准”
 * 上踩过这一类问题。
 *
 * 契约与 Host 的 `undefined=保持 / 显式=改写` 对齐：
 * - 当前没有档位 → 返回 undefined，不凭空引入一个档位；
 * - 新模型确实声明了同一档位 → 原样保留；
 * - 当前档位在新模型上不适用 → 返回 `default` 显式回落标准速度，而不是省略：
 *   省略会让 Host 保留旧档位，继续下发一个该模型并不支持的 serviceTier。
 */
export function carriedServiceTierId(
  model: CodingNsCliModel | undefined,
  currentId: string | undefined,
): string | undefined {
  const current = currentId?.trim()
  if (current === undefined || current === '') return undefined
  return modelServiceTiers(model).some((tier) => tier.id === current) ? current : STANDARD_SERVICE_TIER_ID
}

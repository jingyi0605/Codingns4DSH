import type { FeatureModule } from '../../shared/contracts/feature.js'
import { createAuthFeature } from './auth.js'
import { createLanAccessDshFeature } from './lan-access-dsh.js'
import { createCliAdaptersFeature } from '../cli-adapters/feature.js'
import type { CodingNsHostServices } from './types.js'

/** Host 侧功能模块清单：新增模块在这里登记一行，不需要改动入口或 RPC 分发。 */
export const HOST_FEATURES: readonly FeatureModule<CodingNsHostServices>[] = [
  createAuthFeature(),
  createLanAccessDshFeature(),
  createCliAdaptersFeature(),
]

export { createAuthFeature } from './auth.js'
export { createLanAccessDshFeature } from './lan-access-dsh.js'
export { createCliAdaptersFeature } from '../cli-adapters/feature.js'
export type { CodingNsHostServices } from './types.js'

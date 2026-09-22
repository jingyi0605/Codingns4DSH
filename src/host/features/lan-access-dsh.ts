import type { FeatureModule } from '../../shared/contracts/feature.js'
import { createLanAccessDshRpcHandler, LanAccessDshProxy, type LanAccessDshRuntime } from '../lan-access-dsh.js'
import type { CodingNsHostServices } from './types.js'

/** Host 侧“局域网访问 DSH”模块，只管理一条 DSH Web 监听映射。 */
export function createLanAccessDshFeature(options: { runtime?: LanAccessDshRuntime } = {}): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'lanAccessDsh',
      version: '0.2.0',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
    },
    start(context) {
      const proxy = new LanAccessDshProxy(options.runtime)
      context.resources.add(context.services.rpc.register('lanAccessDsh', createLanAccessDshRpcHandler(proxy)))
      context.resources.add(() => proxy.close())
    },
  }
}

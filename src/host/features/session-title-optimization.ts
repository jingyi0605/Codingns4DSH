import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CodingNsSettings } from '../../shared/contracts/config.js'
import { createSessionTitleOptimizationAdapter } from '../../dsh-capabilities/host/session-title-adapter.js'
import type { CodingNsHostServices } from './types.js'

/** Host 的处理由同一份工作区设置控制，不依赖浏览器是否打开设置页。 */
export function createSessionTitleOptimizationFeature(): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'sessionTitleOptimization', version: '0.1.0', enabledByDefault: true,
      dependencies: [], runtime: 'host',
      requires: [
        { capability: 'llm.text', required: false, fallback: 'disable' },
        { capability: 'session.title', required: false, fallback: 'disable' },
      ],
    },
    start(context) {
      const adapter = createSessionTitleOptimizationAdapter(context.services.dshContext, context.services.dshVersion ?? '')
      if (adapter === undefined) return
      const sync = (settings: CodingNsSettings | undefined): void => adapter.setEnabled(
        settings?.modules?.workspaceSessionEnhancement === true && settings.workspaceSessionEnhancement?.optimizeSessionTitles === true,
      )
      sync(context.services.settings?.get())
      context.resources.add(() => adapter.dispose())
      const unwatch = context.services.settings?.watch((next) => sync(next))
      if (unwatch !== undefined) context.resources.add(unwatch)
    },
  }
}

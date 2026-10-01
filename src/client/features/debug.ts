import type { CodingNsClientFeatureModule } from './types.js'
import { registerDebugUi } from '../debug/ui.js'

/** 工作区调试面板模块；开关关闭时同时移除 Sidebar 标签和注入内容。 */
export const debugFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'debug',
    version: '0.1.1',
    enabledByDefault: true,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: 'Workspace debugging',
      description: 'Launch terminals and check services',
      labelKey: 'feature.debug.label',
      descriptionKey: 'feature.debug.description',
      order: 35,
      defaultOpen: false,
    },
  },
  start(context) {
    const uiContext = context.services.uiContext
    if (uiContext === undefined) throw new Error('工作区调试模块缺少 DSH UI 上下文')
    context.resources.add(registerDebugUi(uiContext, context.services.rpc, context.services.remote, context.services.terminalRemote, context.services.locale))
  },
}

import type { CodingNsClientFeatureModule } from './types.js'
import { registerDebugUi } from '../debug/ui.js'

/** 工作区调试面板模块；开关关闭时同时移除 Sidebar 标签和注入内容。 */
export const debugFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'debug',
    version: '0.1.0',
    enabledByDefault: true,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: '工作区调试',
      description: '按 Workspace 配置启动终端、检查端口并访问指定服务。',
      order: 35,
      defaultOpen: true,
    },
  },
  start(context) {
    const uiContext = context.services.uiContext
    if (uiContext === undefined) throw new Error('工作区调试模块缺少 DSH UI 上下文')
    context.resources.add(registerDebugUi(uiContext, context.services.rpc, context.services.remote))
  },
}

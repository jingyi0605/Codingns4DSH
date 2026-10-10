import type { CodingNsClientFeatureModule } from './types.js'
import { createSubagentSessionsActions, registerCollapsedSubagentLineage } from '../subagent-collapsed-lineage.js'

/**
 * 子 Agent 列表的显示策略。
 *
 * 该模块只替换 DSH 子 Agent 的两个 Header Slot，不改 Host 目录、会话状态或
 * 归档语义。没有对应导航服务时保持 DSH 原生组件，确保旧版兼容。
 */
export const subagentCollapsedLineageFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'subagentCollapsedLineage',
    version: '0.1.0',
    enabledByDefault: true,
    dependencies: [],
    runtime: 'client',
    minimumDshVersion: '0.2.0-rc.2',
  },
  start(context) {
    // DSH 0.2.0 使用 Session Controller 的旧导航动作，0.2.1 将打开会话
    // 移到 uiWorkspace、投影刷新改名为 refreshProjections。统一在适配器
    // 中探测，避免因为版本差异直接回退到 DSH 原生列表。
    const sessions = createSubagentSessionsActions(
      context.services.sessions ?? context.services.uiContext?.get('sessions'),
      context.services.uiWorkspace ?? context.services.uiContext?.get('uiWorkspace'),
    )
    if (sessions === undefined) return
    const dispose = registerCollapsedSubagentLineage(context.services.slots, context.services.locale, sessions)
    context.resources.add(dispose)
  },
}

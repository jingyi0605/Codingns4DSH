import { normalizeMobileAccessSettings } from '../../shared/contracts/config.js'
import { debugWarn } from '../../shared/debug.js'
import {
  startMobileSidebarRailDom,
  type MobileSidebarRailDomController,
} from '../mobile-sidebar-rail-dom.js'
import { MobileAccessPanel } from './mobile-access-panel.js'
import type { CodingNsClientFeatureModule } from './types.js'

/**
 * 移动端访问增强。
 *
 * 只做一件事：窄屏下把 DSH 左侧边栏的 56px 图标轨道彻底收成 0 宽，并在左上角放一个
 * 插件自有的 logo 按钮作为再次唤起入口。按钮点击只调用 DSH 官方
 * `ctx.layout.toggleSidebar()`，插件不接管布局状态、不改 DSH 持久化设置。
 *
 * 依赖 `layout.columns`：该能力对应的正是 0.2.0 起的三栏布局世代，插件改写的
 * 内联网格与 `data-sidebar-collapsed` 都来自同一代实现；能力不可用时整块禁用。
 */
export const mobileAccessFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'mobileAccess',
    version: '0.1.0',
    enabledByDefault: true,
    dependencies: [],
    runtime: 'client',
    requires: [{ capability: 'layout.columns', required: false, fallback: 'disable' }],
    ui: {
      label: '移动端访问增强',
      description: '手机或窄屏访问时彻底隐藏左侧边栏，只在左上角保留 logo 作为再次唤起的入口。',
      labelKey: 'feature.mobileAccess.label',
      descriptionKey: 'feature.mobileAccess.description',
      order: 36,
      defaultOpen: false,
    },
  },
  start(context) {
    // 控制器每次同步都直接读取设置快照，因此这里只需要在设置变化时让它重算。
    const controller: MobileSidebarRailDomController = startMobileSidebarRailDom({
      settings: () => normalizeMobileAccessSettings(context.services.settings.getSnapshot().value?.mobileAccess),
      // 每次点击都重新取布局服务：宿主重建期间 services.layout 可能是后补的。
      toggleSidebar: () => { context.services.layout?.toggleSidebar() },
      onDiagnostic: (code) => debugWarn('codingns4dsh: 移动端侧栏隐藏不可用', { code }),
    })
    context.resources.add(context.services.settings.subscribe(() => { controller.refresh() }))
    context.resources.add(() => controller.dispose())
  },
  settingsPanel: MobileAccessPanel,
}

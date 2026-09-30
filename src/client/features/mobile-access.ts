import { normalizeMobileAccessSettings } from '../../shared/contracts/config.js'
import { debugWarn } from '../../shared/debug.js'
import {
  startMobileSidebarRailDom,
  type MobileSidebarRailDomController,
} from '../mobile-sidebar-rail-dom.js'
import { startMobileSidebarGestures, type MobileSidebarGestureController } from '../mobile-sidebar-gestures.js'
import { startMobileSettingsModalDom, type MobileSettingsModalController } from '../mobile-settings-modal-dom.js'
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
      description: '优化移动端访问布局',
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
    // 横滑属于移动端访问基础能力，不能依赖“工作区会话增强”模块是否开启。
    // 手势控制器自身会按窄屏与触摸能力门禁，桌面端不会注册监听。
    const gestures: MobileSidebarGestureController = startMobileSidebarGestures({
      ports: { layout: context.services.layout, sidebarRight: context.services.sidebarRight },
      // 手势需要区分“左栏尚未呼出”和“左栏已经展开”：默认映射下物理左滑
      // 在后一种状态应关闭左栏，而不是打开右栏。移动端侧栏 DOM 控制器在
      // 框架上留下稳定标记，缺少该节点时由手势控制器内部状态兜底。
      readLeftCollapsed: () => {
        if (typeof document === 'undefined') return undefined
        const frame = document.querySelector<HTMLElement>('[data-codingns-mobile-sidebar-frame]')
        return frame?.hasAttribute('data-sidebar-collapsed')
      },
      settings: () => normalizeMobileAccessSettings(
        context.services.settings.getSnapshot().value?.mobileAccess,
        context.services.settings.getSnapshot().value?.workspaceSessionEnhancement,
      ),
      onDiagnostic: (code) => debugWarn('codingns4dsh: 侧栏手势不可用', { code }),
    })
    const settingsModal: MobileSettingsModalController = startMobileSettingsModalDom({
      mobileViewportMaxPx: () => normalizeMobileAccessSettings(
        context.services.settings.getSnapshot().value?.mobileAccess,
      ).mobileViewportMaxPx,
    })
    context.resources.add(context.services.settings.subscribe(() => {
      controller.refresh()
      gestures.refresh()
      settingsModal.refresh()
    }))
    context.resources.add(() => {
      controller.dispose()
      gestures.dispose()
      settingsModal.dispose()
    })
  },
  settingsPanel: MobileAccessPanel,
}

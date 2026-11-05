import { normalizeMobileAccessSettings } from '../../shared/contracts/config.js'
import { debugWarn } from '../../shared/debug.js'
import { startMobileSidebarGestures, type MobileSidebarGestureController } from '../mobile-sidebar-gestures.js'
import { notifyMobileRightbarManualOpen, notifyMobileRightbarManualClose } from '../mobile-rightbar-visibility.js'
import { MobileAccessPanel } from './mobile-access-panel.js'
import type { CodingNsClientFeatureModule } from './types.js'
import { resolveCodingNsTranslator } from '../locale.js'

/** descriptor 的 label/description 只是词典缺失时的兜底，取内置中文词典。 */
const fallbackT = resolveCodingNsTranslator()

/**
 * 移动端访问增强。
 *
 * 保留移动端横滑手势，并把侧栏开合交给 DSH 原生布局服务。移动端布局、设置弹窗、右栏
 * 标签和团队面板都由当前 DSH 自己负责，插件不再改写宿主 DOM，避免与 0.2.2 的原生
 * 移动端布局冲突。
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
      label: fallbackT('feature.mobileAccess.label'),
      description: fallbackT('feature.mobileAccess.description'),
      labelKey: 'feature.mobileAccess.label',
      descriptionKey: 'feature.mobileAccess.description',
      order: 36,
      defaultOpen: false,
    },
  },
  start(context) {
    // 横滑属于移动端访问基础能力，不能依赖“工作区会话增强”模块是否开启。
    // 手势控制器自身会按窄屏与触摸能力门禁，桌面端不会注册监听；布局状态始终由 DSH
    // 原生服务与原生 DOM 提供，插件只读取它来判断当前左栏状态。
    const gestures: MobileSidebarGestureController = startMobileSidebarGestures({
      ports: { layout: context.services.layout, sidebarRight: context.services.sidebarRight },
      onRightbarOpen: () => notifyMobileRightbarManualOpen(typeof document === 'undefined' ? undefined : document),
      onRightbarClose: () => notifyMobileRightbarManualClose(typeof document === 'undefined' ? undefined : document),
      readLeftCollapsed: readNativeLeftCollapsed,
      settings: () => normalizeMobileAccessSettings(
        context.services.settings.getSnapshot().value?.mobileAccess,
        context.services.settings.getSnapshot().value?.workspaceSessionEnhancement,
      ),
      onDiagnostic: (code) => debugWarn('codingns4dsh: 侧栏手势不可用', { code }),
    })
    context.resources.add(context.services.settings.subscribe(() => {
      gestures.refresh()
    }))
    context.resources.add(() => {
      gestures.dispose()
    })
  },
  settingsPanel: MobileAccessPanel,
}

/** Read the host frame's native collapsed state without adding a plugin marker or style. */
function readNativeLeftCollapsed(): boolean | undefined {
  if (typeof document === 'undefined') return undefined
  const overlay = document.querySelector<HTMLElement>('[data-shell-overlay]')
  let current: HTMLElement | null = overlay
  for (let depth = 0; depth < 8 && current !== null; depth += 1, current = current.parentElement) {
    if (current.style.gridTemplateColumns !== '') return current.hasAttribute('data-sidebar-collapsed')
  }
  return undefined
}

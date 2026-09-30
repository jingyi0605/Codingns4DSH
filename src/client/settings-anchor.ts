/**
 * 设置区锚点解析。
 *
 * 账户入口（登录/注销、PeerHost 管理）是命令式挂到 DSH 侧栏底部的，必须先找到
 * 一个稳定的落点。历史上只认原生齿轮按钮 `button[aria-label="设置"]`，它在
 * DSH Desktop 下**根本不会渲染**：
 *
 * 1. Desktop 的 preload 无条件暴露 `dshDesktop`
 *    （`exposeInMainWorld("dshDesktop", …)`），
 * 2. `@deepseek-ai/dsh-client-ui-settings-account` 的 `apply` 见到该全局就注册
 *    `settings.launcher` 单槽位（账户菜单），
 * 3. `@deepseek-ai/dsh-client-ui-settings-general` 渲染
 *    `renderSlot("settings.launcher", …, { fallback: 齿轮按钮 })`，
 *    而单槽位一旦有条目就只渲染条目，fallback 不进入 DOM。
 *
 * 结果就是入口锚点为空、`scan()` 直接返回，左下角既没有账户图标也进不去
 * PeerHost 管理。这里把槽位出口 `[data-slot="settings.launcher"]` 作为兜底锚点：
 * 它由 DSH 槽位契约提供（`dsh-client-ui-renderer` 的 `SlotOutlet` 始终输出
 * `data-slot="<slotKey>"`，渲染 fallback 时也输出），与具体按钮实现无关，
 * 因此 Web 与 Desktop 都成立。
 */

/** 原生设置齿轮按钮；Web 浏览器下 `settings.launcher` 无条目，由它作为 fallback 渲染。 */
export const SETTINGS_BUTTON_SELECTOR = 'button[aria-label="设置"]'

/**
 * `settings.launcher` 槽位出口；Desktop 下由 DSH 账户菜单占位，齿轮 fallback 被替换。
 *
 * 出口节点是 `display: contents`，其父节点是 DSH 自己的 `triggerRow`。
 */
export const SETTINGS_LAUNCHER_SLOT_SELECTOR = '[data-slot="settings.launcher"]'

/** 锚点候选按优先级排列：原生齿轮优先，槽位出口兜底。 */
export const SETTINGS_ANCHOR_SELECTORS = [SETTINGS_BUTTON_SELECTOR, SETTINGS_LAUNCHER_SLOT_SELECTOR] as const

/**
 * 命中的锚点种类，决定调用方是否有权改写容器布局。
 *
 * - `settings-button`：命中槽位出口**内部**的 fallback 齿轮。容器是
 *   `display: contents` 的槽位出口，它没有自己的布局，调用方需要补全为一行。
 * - `launcher-slot`：命中槽位出口**本身**。容器是 DSH 的 `triggerRow`，
 *   已有完整布局，调用方只允许插入节点，不得覆盖方向、宽度与间距。
 */
export type SettingsAnchorKind = 'settings-button' | 'launcher-slot'

export interface SettingsAnchorMatch {
  readonly kind: SettingsAnchorKind
  readonly node: HTMLElement
}

/**
 * 按优先级挑选设置区锚点。
 *
 * 注入 `query` 而不是直接读 `document`：调用方各自持有 `Document`（测试替身、
 * iframe、远程页面），锚点规则必须共用同一份实现，避免两处选择器漂移。
 *
 * @param query - 单选择器查询；无匹配返回 `null`。
 * @returns 第一个命中的锚点及其种类，全部缺失时返回 `null`。
 */
export function resolveSettingsAnchor(query: (selector: string) => HTMLElement | null): SettingsAnchorMatch | null {
  for (const selector of SETTINGS_ANCHOR_SELECTORS) {
    const node = query(selector)
    if (node === null) continue
    return { kind: selector === SETTINGS_BUTTON_SELECTOR ? 'settings-button' : 'launcher-slot', node }
  }
  return null
}

/**
 * 锚点对应的「槽位出口」容器——插件自己的节点应当插进这里。
 *
 * - `settings-button`：命中的是出口内部的 fallback 齿轮，出口是它的父节点；
 * - `launcher-slot`：命中的就是出口本身（Desktop 下里面是 DSH 账户菜单）。
 *
 * 出口是 `display: contents`，插进去的子节点会直接参与 DSH `triggerRow` 的布局。
 *
 * @param match - {@link resolveSettingsAnchor} 的结果。
 * @returns 出口容器；齿轮没有父节点时返回 `null`。
 */
export function settingsAnchorContainer(match: SettingsAnchorMatch): HTMLElement | null {
  return match.kind === 'settings-button' ? match.node.parentElement : match.node
}

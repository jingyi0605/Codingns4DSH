/**
 * `/委派` 的界面增强（DOM 注入）。
 *
 * DSH 的 `/` 菜单把「添加」分类写死在 `sectionRows` 的名单里（file/goal/plan/feedback），
 * 客户端贡献项只能落到「指令」分类；popupSelect 的 `SelectOption` 契约也没有图标字段。
 * 这两点都无法通过公开 API 表达，因此这里按仓库既有的 DOM 注入惯例做两件事：
 *
 * 1. 把插件自己的委派行放进「添加」分类。真实行由 React 拥有，插件**只加属性隐藏它**，
 *    绝不搬动它；「添加」分类末尾放一个克隆行，交互事件转发回真实行。
 *    - 不用 CSS `order` 让真实行「看起来」在添加分类里：`order` 只改视觉位置，
 *      而菜单高亮由 store 的候选顺序（等于 DOM 顺序）驱动，两者会分叉——方向键
 *      走到委派时高亮会突然跳到上面去。克隆行则让视觉与键盘顺序保持一致。
 *    - 绝不移动 React 拥有的节点，否则下一次协调时 React 的 insertBefore 会抛
 *      NotFoundError 打断整个菜单。
 *    - 克隆行**不能继承**隐藏标记，否则真实行和克隆行都被隐藏，委派入口整个消失；
 *      隐藏规则本身也用 `:not()` 排除克隆行作为第二道保险。
 * 2. 给委派弹层里的适配器行补上 Provider 图标。
 *
 * 依赖的 DSH 0.2.0-rc.2 契约（任何一条不成立都只是不生效，不会误改宿主界面）：
 * - `/` 菜单行是 `button[role="option"]`，id 前缀 `dsh-slash-option-`，标题在
 *   `span[class*="itemName"]`；分类标题在 `div[class*="sectionTitle"]`，「添加」恒为首个；
 * - 委派弹层的搜索框 placeholder 由插件自己提供，行标题在 `span[class*="labelText"]`。
 */
import { providerIconUrl } from './provider-icons.js'
import type { DelegateAdapterOption } from './delegate-plan.js'

/** 被打在真实委派菜单行上的隐藏标记。 */
export const DELEGATE_MENU_ROW_ATTRIBUTE = 'data-codingns-delegate-row'
/** 插件在「添加」分类里创建的克隆行标记。 */
export const DELEGATE_MENU_PROXY_ATTRIBUTE = 'data-codingns-delegate-proxy'
/** 插件在委派弹层适配器行前插入的图标标记。 */
export const DELEGATE_POPUP_LOGO_ATTRIBUTE = 'data-codingns-delegate-logo'
/** 委派输入 chip 前插入的 Provider Logo 标记。 */
export const DELEGATE_CHIP_LOGO_ATTRIBUTE = 'data-codingns-delegate-chip-logo'
/** DSH 消息时间线中由插件投影的委派 Agent chip 标记。 */
export const DELEGATE_TIMELINE_CHIP_ATTRIBUTE = 'data-codingns-delegate-timeline-chip'
/** 时间线 chip 保存的原始 carrier，停用插件时用于恢复 React 之外的 DOM。 */
export const DELEGATE_TIMELINE_RAW_ATTRIBUTE = 'data-codingns-delegate-timeline-raw'
/** DSH 时间线中由 Host 改写消息投影的委派任务卡片标记。 */
export const DELEGATE_TIMELINE_CARD_ATTRIBUTE = 'data-codingns-delegation-card'
/** 委派卡片保存原始指令，停用插件时用于恢复 React 之外的 DOM。 */
export const DELEGATE_TIMELINE_CARD_RAW_ATTRIBUTE = 'data-codingns-delegation-card-raw'
/** DSH 空状态输入提示保存原始文案的标记。 */
export const DELEGATE_EMPTY_PLACEHOLDER_BASE_ATTRIBUTE = 'data-codingns-delegate-placeholder-base'
/** 插件样式标签的幂等键。 */
export const DELEGATE_UI_STYLE_ID = 'codingns4dsh-delegate-ui-style'

const MENU_OPTION_SELECTOR = '[role="option"]'
const MENU_LISTBOX_SELECTOR = '[role="listbox"]'
const MENU_OPTION_ID_PREFIX = 'dsh-slash-option-'
const ITEM_NAME_SELECTOR = '[class*="itemName"]'
const SECTION_TITLE_SELECTOR = '[class*="sectionTitle"]'
const LABEL_TEXT_SELECTOR = '[class*="labelText"]'
const DELEGATION_INSTRUCTION_MARKER = '[CodingNS 委派指令]'

// 隐藏规则排除克隆行：即使克隆意外带上了标记，也不会连克隆一起隐藏。
const DELEGATE_UI_STYLE_TEXT = `[${DELEGATE_MENU_ROW_ATTRIBUTE}]:not([${DELEGATE_MENU_PROXY_ATTRIBUTE}]){display:none!important}`
  + `[${DELEGATE_MENU_PROXY_ATTRIBUTE}][data-active="true"]{background:var(--dsw-alias-interactive-bg-hover)}`
  + `[${DELEGATE_POPUP_LOGO_ATTRIBUTE}]{width:16px;height:16px;flex:none;object-fit:contain;border-radius:3px;margin-right:2px}`
  + `[${DELEGATE_CHIP_LOGO_ATTRIBUTE}]{width:14px;height:14px;flex:none;align-self:center;object-fit:contain;border-radius:3px;margin-right:2px}`
  // ReferenceInsert 的 session 图标是通用 SVG；已有品牌 Logo 时隐藏它，避免出现双图标。
  + `[data-composer-chip="codingns-delegate"]:has([${DELEGATE_CHIP_LOGO_ATTRIBUTE}]) svg{display:none!important}`
  + `[${DELEGATE_TIMELINE_CHIP_ATTRIBUTE}]{display:inline-flex;align-items:center;vertical-align:baseline;gap:3px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);white-space:nowrap;font-size:.95em;line-height:1.45}`
  + `[${DELEGATE_TIMELINE_CHIP_ATTRIBUTE}] img{width:14px;height:14px;flex:none;object-fit:contain;border-radius:3px}`
  + `[${DELEGATE_TIMELINE_CARD_ATTRIBUTE}]{box-sizing:border-box;display:flex;flex-direction:column;align-self:stretch;width:100%;max-width:100%;min-width:0;gap:8px;margin:2px 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));line-height:1.5;overflow-wrap:anywhere}`
  + `[${DELEGATE_TIMELINE_CARD_ATTRIBUTE}] [data-codingns-delegation-card-title]{display:flex;align-items:center;min-width:0;gap:6px;font-weight:600;overflow-wrap:anywhere}`
  + `[${DELEGATE_TIMELINE_CARD_ATTRIBUTE}] [data-codingns-delegation-card-targets]{display:flex;flex-wrap:wrap;min-width:0;width:100%;max-width:100%;gap:5px}`
  + `[${DELEGATE_TIMELINE_CARD_ATTRIBUTE}] [data-codingns-delegation-card-target]{box-sizing:border-box;display:inline-flex;align-items:center;flex:0 1 auto;min-width:0;max-width:100%;gap:3px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);font-size:.9em;white-space:normal;overflow-wrap:anywhere;word-break:break-word}`
  + `[${DELEGATE_TIMELINE_CARD_ATTRIBUTE}] [data-codingns-delegation-card-target] img{flex:0 0 auto;width:14px;height:14px;object-fit:contain;border-radius:3px}`
  + `[${DELEGATE_TIMELINE_CARD_ATTRIBUTE}] [data-codingns-delegation-card-target] span{min-width:0;overflow-wrap:anywhere;word-break:break-word}`
  + `[${DELEGATE_TIMELINE_CARD_ATTRIBUTE}] [data-codingns-delegation-card-task]{box-sizing:border-box;width:100%;max-width:100%;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}`
  + `[${DELEGATE_TIMELINE_CARD_ATTRIBUTE}] [data-codingns-delegation-card-status]{min-width:0;color:var(--dsw-alias-label-secondary,GrayText);font-size:.88em;overflow-wrap:anywhere;word-break:break-word}`
  + `@media (max-width:768px){[${DELEGATE_TIMELINE_CARD_ATTRIBUTE}]{gap:6px;margin:2px 0;padding:8px 10px;border-radius:8px;font-size:.95em}[${DELEGATE_TIMELINE_CARD_ATTRIBUTE}] [data-codingns-delegation-card-targets]{gap:4px}[${DELEGATE_TIMELINE_CARD_ATTRIBUTE}] [data-codingns-delegation-card-target]{padding:2px 6px;font-size:.88em}}`

/** 克隆行 → 真实行；真实行被 React 重建时据此判定需要重建克隆。 */
const proxySources = new WeakMap<Element, Element>()

let popupOptions: readonly DelegateAdapterOption[] = []
let requestRefresh: (() => void) | undefined

/**
 * 登记当前委派弹层的适配器选项。
 *
 * `/委派` 的 `options()` 每次加载后调用；图标注入据此把行标题反查回适配器 id。
 * 行标题就是适配器显示名，因此这张表同时充当标题到 id 的映射。
 */
export function setDelegatePopupOptions(options: readonly DelegateAdapterOption[]): void {
  popupOptions = options
  requestRefresh?.()
}

export interface DelegateUiDomController {
  /** 显式触发一次重扫（选项加载完成、菜单重新打开等）。 */
  refresh(): void
  /** 断开观察器并移除插件节点。 */
  dispose(): void
}

export interface DelegateUiDomOptions {
  readonly document?: Document
  readonly MutationObserver?: typeof MutationObserver
  /** 委派命令行的本地化标题；用于在 `/` 菜单里定位插件自己的行。 */
  readonly menuLabel: () => string
  /** 委派弹层搜索框的本地化占位符；用于识别插件自己的弹层。 */
  readonly popupPlaceholder: () => string
  /** 适配器图标地址；缺省读取插件 Provider 图标表。 */
  readonly iconUrlForAdapter?: (adapterId: string) => string | undefined
  /** 时间线卡片标题；未提供时使用英文兼容回退。 */
  readonly cardTitle?: () => string
  /** 时间线卡片状态；未提供时使用英文兼容回退。 */
  readonly cardStatus?: () => string
  /** 时间线卡片目标标签；未提供时使用英文兼容回退。 */
  readonly cardTarget?: (value: { readonly label: string; readonly adapterId: string; readonly modelId?: string }) => string
  /** 空状态输入框追加的委派快捷键提示；未提供时不改写原生提示。 */
  readonly emptyStateHint?: () => string
}

/**
 * 安装 `/委派` 的界面增强。
 *
 * @param options - 注入点（document/观察器/本地化文案/图标表），便于单测替换。
 * @returns 控制器；`document` 缺失时退化为空操作。
 */
export function startDelegateUiDom(options: DelegateUiDomOptions): DelegateUiDomController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const Observer = options.MutationObserver
    ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  const iconUrl = options.iconUrlForAdapter ?? providerIconUrl
  let disposed = false
  let scanQueued = false
  let observer: MutationObserver | undefined

  const observe = (): void => {
    if (disposed || dom === undefined || observer === undefined) return
    observer.observe(dom.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-selected'],
    })
  }

  const runScan = (): void => {
    if (disposed || dom === undefined) return
    // 菜单只在存在 listbox 时扫描；输入 chip 则始终检查，因为它可能在菜单关闭后
    // 才完成 Decorator 渲染。观察器挂在 documentElement 且带 subtree，扫描必须保持幂等。
    const listboxes = [...dom.querySelectorAll(MENU_LISTBOX_SELECTOR)]
    if (listboxes.length > 0) {
      relocateMenuRow(listboxes, options.menuLabel())
      decoratePopupRows(listboxes, options.popupPlaceholder(), iconUrl)
    }
    decorateReferenceChips(dom, iconUrl)
    decorateTimelineMessages(dom, iconUrl, options)
    decorateEmptyStatePlaceholders(dom, options.emptyStateHint)
  }

  const scan = (): void => {
    if (disposed || dom === undefined) return
    // 本函数会写克隆行的 aria-selected（把真实行高亮镜像到「添加」分类），而观察器
    // 恰好盯这个属性：不摘掉观察器就会「写属性 → 触发观察器 → 再扫 → 再写」无限
    // 循环，鼠标移到菜单（首次出现 aria-selected="true"）时页面直接卡死。断开观察器
    // 还会丢弃已入队的记录，因此本次扫描自身的改动不会再触发自己。
    observer?.disconnect()
    try {
      runScan()
    } finally {
      observe()
    }
  }

  const scheduleScan = (): void => {
    if (disposed || scanQueued) return
    scanQueued = true
    queueMicrotask(() => {
      scanQueued = false
      scan()
    })
  }
  requestRefresh = scheduleScan

  if (dom !== undefined) installDelegateUiStyles(dom)
  // 菜单行只在悬停/方向键变化时改写 aria-selected（结构不变），因此必须观察属性才能
  // 把高亮同步到克隆行；扫描期间的自我触发由 scan() 里的断开-重连兜住。
  observer = dom === undefined || Observer === undefined ? undefined : new Observer(scheduleScan)
  observe()
  scan()

  return {
    refresh: scheduleScan,
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      if (requestRefresh === scheduleScan) requestRefresh = undefined
      if (dom !== undefined) removeDelegateNodes(dom)
    },
  }
}

/** 把插件自己的 `/` 菜单行搬进「添加」分类。 */
function relocateMenuRow(listboxes: readonly Element[], label: string): void {
  const listbox = findSlashMenuListbox(listboxes)
  if (listbox === undefined) return
  const row = findMenuRow(listbox, label)
  const section = findAddSectionTitle(listbox)
  // 只有「能造出克隆行」时才隐藏真实行：用户一旦在 `/` 后输入过滤词，DSH 会走
  // rankByName 而不产生分类标题，此时若已经隐藏真实行，委派入口就会凭空消失。
  if (row === undefined || section === undefined) {
    removeProxies(listbox)
    if (row !== undefined) row.removeAttribute(DELEGATE_MENU_ROW_ATTRIBUTE)
    return
  }
  const existing = listbox.querySelector(`[${DELEGATE_MENU_PROXY_ATTRIBUTE}]`)
  let proxy = existing !== null && proxySources.get(existing) === row ? existing : undefined
  if (proxy === undefined) {
    existing?.remove()
    proxy = buildProxyRow(row)
    insertAfterSectionOptions(section, proxy)
    proxySources.set(proxy, row)
  }
  // 克隆行没挂进文档就撤回隐藏，宁可留在原分类，也不能让委派入口两边都看不见。
  if (proxy.parentNode === null) row.removeAttribute(DELEGATE_MENU_ROW_ATTRIBUTE)
  else row.setAttribute(DELEGATE_MENU_ROW_ATTRIBUTE, '')
  syncProxyActive(row, proxy)
}

/** 克隆真实行：视觉、图标与文案与原生行完全一致，交互转发回真实行。 */
function buildProxyRow(row: Element): Element {
  const proxy = row.cloneNode(true) as Element
  // 克隆会把「隐藏真实行」的标记一起复制过来。不清掉的话克隆行会被插件自己的样式
  // 隐藏，于是真实行隐藏、克隆行也隐藏，委派入口整个从菜单里消失。
  proxy.removeAttribute(DELEGATE_MENU_ROW_ATTRIBUTE)
  proxy.removeAttribute('id')
  proxy.removeAttribute('aria-selected')
  // 克隆瞬间若真实行正被高亮，会把高亮类一起复制过来，导致克隆行永久高亮；
  // 高亮一律改由 data-active 驱动。
  stripActiveClass(proxy)
  proxy.setAttribute(DELEGATE_MENU_PROXY_ATTRIBUTE, '')
  proxy.setAttribute('data-active', 'false')
  // MenuView 用 onMouseMove 维护高亮、onMouseDown 触发选择，克隆行必须转发两者，
  // 否则「看得见的高亮」与「真正被选中的行」会分叉。
  forwardEvent(proxy, row, 'mousemove')
  forwardEvent(proxy, row, 'mousedown')
  proxy.addEventListener('click', (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  return proxy
}

function forwardEvent(proxy: Element, target: Element, type: string): void {
  proxy.addEventListener(type, (event: Event) => {
    event.preventDefault()
    dispatchLike(target, type)
  })
}

/** 在真实行上派发一次可冒泡事件，让 React 的合成事件把它当成真实交互。 */
function dispatchLike(target: Element, type: string): void {
  const view = (target.ownerDocument as (Document & { defaultView?: Window | null }) | null | undefined)?.defaultView
  const MouseEventCtor = view?.MouseEvent ?? (typeof MouseEvent === 'undefined' ? undefined : MouseEvent)
  const event = MouseEventCtor === undefined
    ? new Event(type, { bubbles: true, cancelable: true })
    : new MouseEventCtor(type, { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
}

/**
 * 去掉克隆行上的原生高亮类。
 *
 * 类名带 CSS Modules 哈希（如 `_3e4SsG_active`），不能硬编码；这里按「最后一个下划线
 * 片段等于 active」识别，同时兼容没有哈希的 `active`。
 */
function stripActiveClass(proxy: Element): void {
  const classes = proxy.getAttribute('class')
  if (classes === null || classes === '') return
  const kept = classes.split(/\s+/u).filter((name) => name !== 'active' && !name.endsWith('_active'))
  proxy.setAttribute('class', kept.join(' '))
}

/**
 * 真实行被方向键/悬停高亮时，克隆行同步高亮。
 *
 * 每次写入前都必须先比较现值：这里的属性正是观察器盯着的那个，多余的写会白白
 * 触发一轮重扫（真正的死循环由 scan() 的断开-重连兜住，这里只减少无谓触发）。
 */
function syncProxyActive(row: Element, proxy: Element): void {
  const active = row.getAttribute('aria-selected') === 'true'
  const next = String(active)
  if (proxy.getAttribute('data-active') !== next) proxy.setAttribute('data-active', next)
  const current = proxy.getAttribute('aria-selected')
  if (active) {
    if (current !== 'true') proxy.setAttribute('aria-selected', 'true')
    // 方向键移动时菜单会把真实行滚进视野，但用户看到的是克隆行，必须一并滚动。
    proxy.scrollIntoView?.({ block: 'nearest' })
  } else if (current !== null) {
    proxy.removeAttribute('aria-selected')
  }
}

function findSlashMenuListbox(listboxes: readonly Element[]): Element | undefined {
  for (const listbox of listboxes) {
    if (listbox.querySelector(`[id^="${MENU_OPTION_ID_PREFIX}"]`) !== null) return listbox
  }
  return undefined
}

/**
 * 定位插件自己的菜单行。
 *
 * 必须跳过克隆行：它与真实行同名，先命中克隆行会让后续判定全部错位。
 */
function findMenuRow(listbox: Element, label: string): Element | undefined {
  for (const row of listbox.querySelectorAll(MENU_OPTION_SELECTOR)) {
    if (row.hasAttribute(DELEGATE_MENU_PROXY_ATTRIBUTE)) continue
    if (row.getAttribute('id')?.startsWith(MENU_OPTION_ID_PREFIX) !== true) continue
    const name = row.querySelector(ITEM_NAME_SELECTOR)
    if (name !== null && (name.textContent ?? '').trim() === label) return row
  }
  // 类名缺失时的兜底：仍只接受插件菜单行的 id 前缀，避免命中弹层里的同名行。
  for (const row of listbox.querySelectorAll(MENU_OPTION_SELECTOR)) {
    if (row.hasAttribute(DELEGATE_MENU_PROXY_ATTRIBUTE)) continue
    if (row.getAttribute('id')?.startsWith(MENU_OPTION_ID_PREFIX) !== true) continue
    if ((row.textContent ?? '').includes(label)) return row
  }
  return undefined
}

/**
 * 「添加」分类标题。
 *
 * DSH 的 `sectionRows` 恒把添加分类排在指令分类之前，因此首个分类标题就是它；
 * 这里不硬编码「添加」字样，避免绑定语言。
 */
function findAddSectionTitle(listbox: Element): Element | undefined {
  return listbox.querySelectorAll(SECTION_TITLE_SELECTOR)[0]
}

/** 插入到该分类最后一行之后；分类为空时紧贴标题。 */
function insertAfterSectionOptions(section: Element, proxy: Element): void {
  let anchor: Element = section
  let sibling = section.nextElementSibling
  while (sibling !== null && sibling.matches(MENU_OPTION_SELECTOR)) {
    anchor = sibling
    sibling = sibling.nextElementSibling
  }
  const parent = anchor.parentNode
  if (parent === null) return
  parent.insertBefore(proxy, anchor.nextSibling)
}

/** 给委派弹层里的适配器行补图标。 */
function decoratePopupRows(listboxes: readonly Element[], placeholder: string, iconUrl: (adapterId: string) => string | undefined): void {
  const listbox = findDelegatePopupListbox(listboxes, placeholder)
  if (listbox === undefined) return
  for (const row of listbox.querySelectorAll(MENU_OPTION_SELECTOR)) {
    if (row.querySelector(`[${DELEGATE_POPUP_LOGO_ATTRIBUTE}]`) !== null) continue
    const adapterId = adapterIdForLabel(readPopupOptionLabel(row))
    if (adapterId === undefined) continue
    const url = iconUrl(adapterId)
    if (url === undefined) continue
    const image = listbox.ownerDocument.createElement('img')
    image.setAttribute('src', url)
    image.setAttribute('alt', '')
    image.setAttribute('aria-hidden', 'true')
    image.setAttribute(DELEGATE_POPUP_LOGO_ATTRIBUTE, adapterId)
    row.insertBefore(image, row.firstChild)
  }
}

/**
 * 给 DSH 原生 ReferenceChip 补上外部 Agent 的品牌图标。
 *
 * ReferenceInsert 的 appearance 只支持 session/file/folder，不能传入
 * Provider 资产。只扫描本插件自己的 chip，并按 chip 标题反查委派目录；
 * 目录尚未就绪时保留 DSH 的通用 session 图标，避免误标其它引用。
 */
function decorateReferenceChips(dom: Document, iconUrl: (adapterId: string) => string | undefined): void {
  for (const chip of dom.querySelectorAll('[data-composer-chip="codingns-delegate"]')) {
    const labelNode = chip.querySelector('[title]')
    const label = labelNode?.getAttribute('title')?.trim()
      || labelNode?.textContent?.trim()
      || chip.textContent?.trim()
      || ''
    const adapterId = adapterIdForLabel(label)
    if (adapterId === undefined) continue
    const src = iconUrl(adapterId)
    if (src === undefined || src === '') continue
    const existing = chip.querySelector(`[${DELEGATE_CHIP_LOGO_ATTRIBUTE}]`)
    if (existing !== null) {
      if (existing.getAttribute('src') !== src) existing.setAttribute('src', src)
      continue
    }
    const logo = dom.createElement('img')
    logo.setAttribute(DELEGATE_CHIP_LOGO_ATTRIBUTE, adapterId)
    logo.setAttribute('src', src)
    logo.setAttribute('alt', '')
    logo.setAttribute('aria-hidden', 'true')
    chip.insertBefore(logo, chip.firstChild)
  }
}

/**
 * 在 DSH 原生 Hero 空状态提示后补充委派快捷键说明。
 *
 * DSH 没有公开修改内置 placeholder 的接口；这里只处理带有
 * DSH Hero composer（祖先带有 CSS module 的 `_hero` class）中的空状态输入框，
 * 并保存原文，避免把已经开始的会话提示或 React 重绘后的文案重复拼接。
 */
function decorateEmptyStatePlaceholders(dom: Document, hintFactory?: () => string): void {
  const hint = hintFactory?.().trim()
  if (hint === undefined || hint === '') return
  for (const placeholder of dom.querySelectorAll('[data-composer-placeholder]')) {
    if (!isHeroComposerPlaceholder(placeholder)) continue
    const base = placeholder.getAttribute(DELEGATE_EMPTY_PLACEHOLDER_BASE_ATTRIBUTE)
      ?? placeholder.textContent?.trim()
      ?? ''
    if (base === '') continue
    if (!placeholder.hasAttribute(DELEGATE_EMPTY_PLACEHOLDER_BASE_ATTRIBUTE)) {
      placeholder.setAttribute(DELEGATE_EMPTY_PLACEHOLDER_BASE_ATTRIBUTE, base)
    }
    const decorated = `${base} · ${hint}`
    if (placeholder.textContent !== decorated) placeholder.textContent = decorated
  }
}

function isHeroComposerPlaceholder(placeholder: Element): boolean {
  let current: Node | null = placeholder.parentNode
  while (current !== null) {
    const element = current as Element
    if (typeof element.getAttribute === 'function' && element.getAttribute('data-phase') === 'hero') return true
    const className = typeof element.getAttribute === 'function' ? element.getAttribute('class') ?? '' : ''
    if (className.split(/\s+/u).some((name) => name.endsWith('_hero'))) return true
    current = current.parentNode
  }
  // 兼容早期 DSH fixture；正式 0.2.x 通过上面的 InputBar `_hero` class 判定。
  return (placeholder.parentNode as Element | null)?.querySelector('[data-composer-input][data-phase="hero"]') !== null
}

/**
 * 将已经提交到 DSH 时间线的 carrier 投影为可读的 Agent chip。
 *
 * DSH 的输入 codec 只有一个序列化结果：Host 需要的 carrier；因此 durable
 * `user/message` 也会携带这段传输文本。这里仅处理 DSH 的 userRow/bubble，
 * 不触碰 assistant、代码块和普通页面文本，避免把模型内容中的 carrier 改写。
 */
function decorateTimelineMessages(dom: Document, iconUrl: (adapterId: string) => string | undefined, options: DelegateUiDomOptions): void {
  const rows = [...dom.querySelectorAll('[class*="userRow"]')]
  // 发送尚未落成 durable user/message 时，DSH 的队列预览只有
  // data-submission-echo + preview 类名；也要同步清理，避免用户在短暂回显阶段看到 carrier。
  for (const row of dom.querySelectorAll('[data-submission-echo]')) {
    if (!rows.includes(row)) rows.push(row)
  }
  for (const row of rows) {
    const bubble = row.querySelector('[class*="bubble"]') ?? row.querySelector('[class*="preview"]')
    if (bubble === null) continue
    decorateTimelineNode(bubble, dom, iconUrl, options)
  }
}

function decorateTimelineNode(node: Node, dom: Document, iconUrl: (adapterId: string) => string | undefined, options: DelegateUiDomOptions): void {
  if (node.nodeType === 3) {
    const value = node.nodeValue ?? ''
    if (value.includes('<!--codingns:delegate:') || value.includes(DELEGATION_INSTRUCTION_MARKER)) replaceTimelineTextNode(node, value, dom, iconUrl, options)
    return
  }
  if (node.nodeType !== 1
    || (node as Element).hasAttribute(DELEGATE_TIMELINE_CHIP_ATTRIBUTE)
    || (node as Element).hasAttribute(DELEGATE_TIMELINE_CARD_ATTRIBUTE)) return
  for (const child of [...node.childNodes]) decorateTimelineNode(child, dom, iconUrl, options)
}

const TIMELINE_CARRIER_V1_PATTERN = /<!--codingns:delegate:v1:([^:>]+):([^>]+)-->/gu
const TIMELINE_CARRIER_V2_PATTERN = /<!--codingns:delegate:v2:([^:>]+):([^:>]+):([^>]+)-->/gu

export interface DelegationTimelineMention {
  readonly raw: string
  readonly adapterId: string
  readonly label: string
  readonly start: number
  readonly end: number
}

export interface DelegationTimelineTarget {
  readonly adapterId: string
  readonly label: string
  readonly modelId?: string
}

export interface DelegationTimelineCard {
  readonly raw: string
  readonly task: string
  readonly targets: readonly DelegationTimelineTarget[]
}

const DELEGATION_INSTRUCTION_PATTERN = /\[CodingNS 委派指令\]\s*\n任务：([\s\S]*?)\n允许使用的外部 Agent：\s*\n([\s\S]*?)(?=\n请先根据任务语义制定简短的角色和步骤计划：|\n然后调用已有 agent_subagent 工具执行委派。|$)/u
const DEFAULT_ADAPTER_MODEL_LABEL = String.fromCodePoint(0x9002, 0x914d, 0x5668, 0x9ed8, 0x8ba4)
const DELEGATION_TARGET_PATTERN = /^-\s*([^\s（(]+)\s*[（(]([^，,）)]+)(?:[，,]\s*模型：([^，,）)]*))?(?:[，,][^）)]*)?[）)]\s*$/gmu

/** 解析 Host 改写后的委派指令，提取用户真正关心的任务和目标 Agent。 */
export function parseDelegationTimelineCard(value: string): DelegationTimelineCard | undefined {
  const match = DELEGATION_INSTRUCTION_PATTERN.exec(value)
  if (match === null) return undefined
  // 旧版 slash 命令可能把命令本身序列化为 `/`，Host instruction 中会留下
  // `/ 任务`；它不是用户任务的一部分，必须在卡片里隐藏。
  const task = (match[1] ?? '').trim().replace(/^\/\s*/u, '').trim()
  if (task === '') return undefined
  const targets: DelegationTimelineTarget[] = []
  for (const target of (match[2] ?? '').matchAll(DELEGATION_TARGET_PATTERN)) {
    const adapterId = target[1]?.trim() ?? ''
    const label = target[2]?.trim() ?? ''
    const modelId = target[3]?.trim() ?? ''
    if (adapterId === '' || label === '' || targets.some((item) => item.adapterId === adapterId)) continue
    targets.push({ adapterId, label, ...(modelId !== '' && modelId !== DEFAULT_ADAPTER_MODEL_LABEL ? { modelId } : {}) })
  }
  if (targets.length === 0) return undefined
  return { raw: value, task, targets }
}

/** 解析时间线文本中的有效 carrier；无效编码原样保留，避免误删用户内容。 */
export function parseDelegationTimelineCarriers(value: string): readonly DelegationTimelineMention[] {
  const mentions: DelegationTimelineMention[] = []
  const collect = (pattern: RegExp, labelGroup: number): void => {
    for (const match of value.matchAll(pattern)) {
      const carrierStart = match.index ?? -1
      const carrier = match[0] ?? ''
      const adapterId = decodeCarrierPart(match[1])
      const label = decodeCarrierPart(match[labelGroup])
      if (carrierStart < 0 || carrier === '' || adapterId === undefined || label === undefined) continue
      const mention = `@${label}`
      const start = carrierStart >= mention.length && value.slice(carrierStart - mention.length, carrierStart) === mention
        ? carrierStart - mention.length
        : carrierStart
      const raw = value.slice(start, carrierStart + carrier.length)
      mentions.push({ raw, adapterId, label, start, end: start + raw.length })
    }
  }
  collect(TIMELINE_CARRIER_V1_PATTERN, 2)
  collect(TIMELINE_CARRIER_V2_PATTERN, 3)
  return mentions.sort((a, b) => a.start - b.start)
}

function replaceTimelineTextNode(node: Node, value: string, dom: Document, iconUrl: (adapterId: string) => string | undefined, options: DelegateUiDomOptions): void {
  const card = parseDelegationTimelineCard(value)
  if (card !== undefined && node.parentNode !== null) {
    node.parentNode.replaceChild(buildTimelineCard(dom, card, iconUrl, options.cardTitle, options.cardStatus, options.cardTarget), node)
    return
  }
  const matches = parseDelegationTimelineCarriers(value)
  if (matches.length === 0 || node.parentNode === null) return
  const fragment = dom.createDocumentFragment()
  let cursor = 0
  for (const match of matches) {
    if (match.start < cursor) continue
    if (match.start > cursor) fragment.append(dom.createTextNode(value.slice(cursor, match.start)))
    fragment.append(buildTimelineChip(dom, match.raw, match.adapterId, match.label, iconUrl(match.adapterId)))
    cursor = match.end
  }
  if (cursor === 0) return
  if (cursor < value.length) fragment.append(dom.createTextNode(value.slice(cursor)))
  node.parentNode.replaceChild(fragment, node)
}

function buildTimelineCard(
  dom: Document,
  card: DelegationTimelineCard,
  iconUrl: (adapterId: string) => string | undefined,
  cardTitle: () => string = () => 'Delegation task',
  cardStatus: () => string = () => 'Delegating',
  cardTarget: (value: { readonly label: string; readonly adapterId: string; readonly modelId?: string }) => string = ({ label, adapterId, modelId }) => `${label} (${adapterId}${modelId === undefined ? '' : ` · ${modelId}`})`,
): HTMLElement {
  const root = dom.createElement('div')
  root.setAttribute(DELEGATE_TIMELINE_CARD_ATTRIBUTE, '')
  root.setAttribute(DELEGATE_TIMELINE_CARD_RAW_ATTRIBUTE, card.raw)

  const title = dom.createElement('div')
  title.setAttribute('data-codingns-delegation-card-title', '')
  title.textContent = cardTitle()

  const targets = dom.createElement('div')
  targets.setAttribute('data-codingns-delegation-card-targets', '')
  for (const target of card.targets) {
    const badge = dom.createElement('span')
    badge.setAttribute('data-codingns-delegation-card-target', target.adapterId)
    const logoUrl = iconUrl(target.adapterId)
    if (logoUrl !== undefined && logoUrl !== '') {
      const logo = dom.createElement('img')
      logo.src = logoUrl
      logo.alt = ''
      logo.setAttribute('aria-hidden', 'true')
      badge.append(logo)
    }
    const label = dom.createElement('span')
    label.textContent = cardTarget(target)
    badge.append(label)
    targets.append(badge)
  }

  const task = dom.createElement('div')
  task.setAttribute('data-codingns-delegation-card-task', '')
  task.textContent = card.task
  const status = dom.createElement('div')
  status.setAttribute('data-codingns-delegation-card-status', '')
  status.textContent = cardStatus()
  root.append(title, targets, task, status)
  return root
}

function decodeCarrierPart(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  try {
    const decoded = decodeURIComponent(value).trim()
    return decoded === '' ? undefined : decoded
  } catch {
    return undefined
  }
}

function buildTimelineChip(
  dom: Document,
  raw: string,
  adapterId: string,
  label: string,
  iconUrl: string | undefined,
): HTMLElement {
  const chip = dom.createElement('span')
  chip.setAttribute(DELEGATE_TIMELINE_CHIP_ATTRIBUTE, adapterId)
  chip.setAttribute(DELEGATE_TIMELINE_RAW_ATTRIBUTE, raw)
  chip.setAttribute('title', `@${label}`)
  if (iconUrl !== undefined && iconUrl !== '') {
    const logo = dom.createElement('img')
    logo.setAttribute('src', iconUrl)
    logo.setAttribute('alt', '')
    logo.setAttribute('aria-hidden', 'true')
    chip.append(logo)
  }
  const text = dom.createElement('span')
  text.textContent = `@${label}`
  chip.append(text)
  return chip
}

/** 通过插件自己的搜索占位符识别委派弹层，避免影响其它 popupSelect 命令。 */
function findDelegatePopupListbox(listboxes: readonly Element[], placeholder: string): Element | undefined {
  for (const listbox of listboxes) {
    if (listbox.querySelector(`[id^="${MENU_OPTION_ID_PREFIX}"]`) !== null) continue
    const card = listbox.parentNode
    const input = card?.querySelector?.('input') ?? null
    if (input?.getAttribute('placeholder') === placeholder) return listbox
  }
  return undefined
}

function readPopupOptionLabel(row: Element): string {
  const text = row.querySelector(LABEL_TEXT_SELECTOR)?.textContent ?? row.textContent ?? ''
  return text.trim()
}

function adapterIdForLabel(label: string): string | undefined {
  if (label === '') return undefined
  return popupOptions.find((option) => option.label === label)?.id
}

function removeProxies(scope: Element): void {
  for (const proxy of scope.querySelectorAll(`[${DELEGATE_MENU_PROXY_ATTRIBUTE}]`)) proxy.remove()
}

function removeDelegateNodes(dom: Document): void {
  for (const proxy of dom.querySelectorAll(`[${DELEGATE_MENU_PROXY_ATTRIBUTE}]`)) proxy.remove()
  for (const logo of dom.querySelectorAll(`[${DELEGATE_POPUP_LOGO_ATTRIBUTE}]`)) logo.remove()
  for (const logo of dom.querySelectorAll(`[${DELEGATE_CHIP_LOGO_ATTRIBUTE}]`)) logo.remove()
  for (const chip of dom.querySelectorAll(`[${DELEGATE_TIMELINE_CHIP_ATTRIBUTE}]`)) {
    const raw = chip.getAttribute(DELEGATE_TIMELINE_RAW_ATTRIBUTE)
    const parent = chip.parentNode
    if (raw !== null && parent !== null) parent.replaceChild(dom.createTextNode(raw), chip)
  }
  for (const card of dom.querySelectorAll(`[${DELEGATE_TIMELINE_CARD_ATTRIBUTE}]`)) {
    const raw = card.getAttribute(DELEGATE_TIMELINE_CARD_RAW_ATTRIBUTE)
    const parent = card.parentNode
    if (raw !== null && parent !== null) parent.replaceChild(dom.createTextNode(raw), card)
  }
  for (const placeholder of dom.querySelectorAll(`[${DELEGATE_EMPTY_PLACEHOLDER_BASE_ATTRIBUTE}]`)) {
    const base = placeholder.getAttribute(DELEGATE_EMPTY_PLACEHOLDER_BASE_ATTRIBUTE)
    if (base !== null) placeholder.textContent = base
    placeholder.removeAttribute(DELEGATE_EMPTY_PLACEHOLDER_BASE_ATTRIBUTE)
  }
  for (const row of dom.querySelectorAll(`[${DELEGATE_MENU_ROW_ATTRIBUTE}]`)) row.removeAttribute(DELEGATE_MENU_ROW_ATTRIBUTE)
  // 隐藏规则是插件全局样式，停用时必须一并收回，避免残留选择器影响后续渲染。
  dom.querySelector(`style[data-plugin-css="${DELEGATE_UI_STYLE_ID}"]`)?.remove()
}

/** 样式只装一次；重复安装由 data-plugin-css 幂等键挡住。 */
function installDelegateUiStyles(dom: Document): void {
  if (dom.querySelector(`style[data-plugin-css="${DELEGATE_UI_STYLE_ID}"]`) !== null) return
  const style = dom.createElement('style')
  style.setAttribute('data-plugin', 'codingns4dsh')
  style.setAttribute('data-plugin-css', DELEGATE_UI_STYLE_ID)
  style.textContent = DELEGATE_UI_STYLE_TEXT
  dom.head.appendChild(style)
}

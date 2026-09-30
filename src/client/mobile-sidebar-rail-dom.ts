/**
 * 移动端左侧边栏彻底隐藏器。
 *
 * DSH 在窄屏（< 1024px）下把左侧边栏收起成 56px 的图标轨道，而不是 0 宽：
 * 轨道本身始终占用横向空间，手机上等于白扔一条竖直区域。DSH 没有公开“折叠宽度”
 * 配置（`collapsedWidth` 只在 macOS 桌面与 Windows 标题栏两种形态下为 0），因此这里
 * 在浏览器侧做三件事，且只改界面、不改 DSH 状态：
 *
 * 1. 把应用框架（`AppFrame`）内联的 `grid-template-columns` 第一条轨道改写成 `0px`，
 *    其余轨道原样保留；React 重绘后由 MutationObserver 立即补写，恢复时写回基线值。
 * 2. 把左侧栏列整列隐藏，避免它作为 0 宽列仍渲染子树。
 * 3. 在 `document.body` 上挂一个**插件自有**的固定定位 logo 按钮作为再次唤起入口，
 *    点击调用 DSH 官方 `ctx.layout.toggleSidebar()`。
 *
 * 第 3 点是踩坑后的结论。最初的实现复用 DSH 折叠态侧栏里那一行原生 logo 行，
 * 把它 `position:fixed` 浮起来；但那一行位于**已被收成 0 宽、且带
 * `overflow:hidden`** 的侧栏列内部，只要任意祖先形成固定定位包含块（transform /
 * filter / contain / will-change），`position:fixed` 就会被改写成相对该祖先定位，
 * 随即被裁掉——表现为“侧栏确实收起了，但看不到 logo”。自建按钮挂在 body 上，
 * 不再受侧栏列的裁剪与包含块影响；图形仍使用与上游完全相同的鲸鱼路径，外观一致。
 *
 * 依赖的 DSH 0.2.0-rc.1 DOM 契约（任何一条不成立都只是不生效，不会误改宿主界面）：
 * - 应用框架是文档里包含 `[data-shell-overlay]` 且带内联 `grid-template-columns` 的元素；
 * - 框架的第一个非遮罩层子元素是左侧栏列；
 * - 折叠状态由框架上的 `data-sidebar-collapsed` 表达。
 */

import { FISH_LOGO_PATH, FISH_LOGO_VIEWBOX } from './mobile-sidebar-logo.js'

/** 加在 `documentElement` 上的开关：`on` 表示移动端隐藏模式正在生效。 */
export const MOBILE_SIDEBAR_MODE_ATTRIBUTE = 'data-codingns-mobile-sidebar'
/** 加在应用框架元素上的标记。 */
export const MOBILE_SIDEBAR_FRAME_ATTRIBUTE = 'data-codingns-mobile-sidebar-frame'
/** 加在左侧栏列上的标记。 */
export const MOBILE_SIDEBAR_COLUMN_ATTRIBUTE = 'data-codingns-mobile-sidebar-column'
/** 加在插件自有唤起按钮上的标记。 */
export const MOBILE_SIDEBAR_BUTTON_ATTRIBUTE = 'data-codingns-mobile-sidebar-toggle'
/** 插件样式标签的幂等键。 */
export const MOBILE_SIDEBAR_STYLE_ID = 'codingns4dsh-mobile-sidebar-style'
/** 浮起的 logo 让给对话标题的预留宽度（像素）。 */
export const MOBILE_SIDEBAR_LEADING_CLEARANCE_PX = 72

/** 框架上承载“已应用隐藏”的标记，供样式与诊断读取。 */
export const MOBILE_SIDEBAR_GRID_STATE_ATTRIBUTE = 'data-codingns-mobile-sidebar-grid'

/** 唤起按钮的无障碍名称；与 DSH 原生折叠按钮的 `toggle.open` 文案一致。 */
export const MOBILE_SIDEBAR_TOGGLE_LABEL = '打开侧边栏'

export interface MobileSidebarRailSettings {
  readonly hideSidebarOnMobile: boolean
  readonly mobileViewportMaxPx: number
}

/** 控制器只用到视口宽度与 resize 监听，便于在 Node 测试里替换。 */
export interface MobileSidebarRailWindowLike {
  readonly innerWidth?: number | undefined
  addEventListener?(type: string, listener: () => void): void
  removeEventListener?(type: string, listener: () => void): void
}

export interface MobileSidebarRailDomController {
  /** 重新读取设置与视口并同步 DOM；返回当前是否处于隐藏模式。 */
  refresh(): boolean
  /** 移除全部标记、样式与自建按钮，并把网格恢复为插件改写前的值。 */
  dispose(): void
}

export interface MobileSidebarRailDomOptions {
  readonly document?: Document | undefined
  readonly window?: MobileSidebarRailWindowLike | undefined
  readonly MutationObserver?: typeof MutationObserver | undefined
  readonly settings: () => MobileSidebarRailSettings
  /** DSH 布局服务：唤起按钮点击时调用，与手势模块走同一个官方入口。 */
  readonly toggleSidebar?: (() => void) | undefined
  /** 结构不符合预期时给出稳定诊断码，便于排查“为什么不生效”。 */
  readonly onDiagnostic?: ((code: string) => void) | undefined
}

/** 结构不匹配：找不到应用框架或左侧栏列。 */
export const MOBILE_SIDEBAR_DIAGNOSTIC_STRUCTURE_MISSING = 'CODINGNS_MOBILE_SIDEBAR_STRUCTURE_MISSING'
/** 找不到布局服务：按钮仍会出现，但点击无法开合。 */
export const MOBILE_SIDEBAR_DIAGNOSTIC_TOGGLE_MISSING = 'CODINGNS_MOBILE_SIDEBAR_TOGGLE_MISSING'

/**
 * 纯函数：视口宽度是否按“移动端/窄屏”处理。
 */
export function isMobileSidebarViewport(width: number, maxPx: number): boolean {
  if (!Number.isFinite(width) || width <= 0) return false
  if (!Number.isFinite(maxPx) || maxPx <= 0) return false
  return width <= maxPx
}

/**
 * 纯函数：宿主是否已经在框架的 `shell.leading` 座位里提供了自己的开合按钮。
 *
 * DSH 只在两种形态下把折叠宽度做成 0 并在 `[data-shell-leading]` 座位补上按钮：
 * macOS 桌面与 Windows 标题栏。此时插件不该再放一个重复入口。这里做**结构探测**
 * 而不是按平台判断：只要宿主已经渲染了那个座位且里面有按钮，就认为入口已存在。
 */
export function hasHostLeadingToggle(container: ParentNode & { querySelector(selector: string): Element | null }): boolean {
  const seat = container.querySelector('[data-shell-leading]')
  if (seat === null) return false
  return seat.querySelector('button') !== null
}

/**
 * 纯函数：右栏当前是否占用了界面空间（普通停靠或全屏）。
 *
 * DSH 在框架上写 `data-rightbar-collapsed`（右栏不占轨道时存在）与
 * `data-rightbar-fullscreen`。右栏打开时它自己的标签栏就在左上角，插件再叠一个
 * logo 会把标签盖住，因此这两种情况都必须让位。
 */
export function isRightbarOccupied(frame: Pick<HTMLElement, 'hasAttribute'> | undefined): boolean {
  if (frame === undefined) return false
  if (frame.hasAttribute('data-rightbar-fullscreen')) return true
  return !frame.hasAttribute('data-rightbar-collapsed')
}

/**
 * 纯函数：把 `grid-template-columns` 的第一条轨道改写为 `0px`，其余原样保留。
 *
 * 只接受以显式 px 轨道开头的值（DSH 的框架写法）；其它形式返回 `undefined`，
 * 调用方保持原样，避免把不认识的网格改坏。
 */
export function hideLeadingGridTrack(value: string): string | undefined {
  const match = /^\s*([0-9.]+)px\s+(\S[\s\S]*)$/u.exec(value)
  if (match === null) return undefined
  const rest = (match[2] ?? '').trim()
  if (rest === '') return undefined
  return `0px ${rest}`
}

/**
 * 启动移动端侧栏隐藏器；未启用或不在窄屏时保证零副作用（不写任何属性、不加样式、不建按钮）。
 */
export function startMobileSidebarRailDom(
  options: MobileSidebarRailDomOptions,
): MobileSidebarRailDomController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const win = options.window ?? (typeof window === 'undefined' ? undefined : window)
  const Observer = options.MutationObserver
    ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  let disposed = false
  let frame: HTMLElement | undefined
  let column: HTMLElement | undefined
  /** React 自己写下的网格值；恢复时写回它，而不是插件改写后的值。 */
  let gridBaseline: string | undefined
  /** 插件最后一次写入的网格值，用于区分“宿主重绘”与“自己的写入”。 */
  let gridApplied: string | undefined
  let button: HTMLElement | undefined
  let queued = false
  let warnedStructure = false
  let warnedToggle = false

  const scheduleSync = (): void => {
    if (disposed || queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      sync()
    })
  }

  const sync = (): boolean => {
    if (disposed || dom === undefined) return false
    const settings = options.settings()
    const active = settings.hideSidebarOnMobile === true
      && isMobileSidebarViewport(readViewportWidth(win), settings.mobileViewportMaxPx)
    if (!active) {
      restore()
      return false
    }
    const resolved = resolveStructure()
    if (resolved === undefined) {
      // 结构不匹配时保持零改动：既不写 html 标记，也不碰网格、不建按钮。
      if (!warnedStructure) {
        warnedStructure = true
        options.onDiagnostic?.(MOBILE_SIDEBAR_DIAGNOSTIC_STRUCTURE_MISSING)
      }
      return false
    }
    installStyles()
    dom.documentElement?.setAttribute(MOBILE_SIDEBAR_MODE_ATTRIBUTE, 'on')
    const collapsed = resolved.frame.hasAttribute('data-sidebar-collapsed')
    if (!collapsed) {
      // 展开态交给 DSH 原生布局，插件只撤掉隐藏相关改动。
      restoreGrid()
      resolved.frame.style.removeProperty('--dsh-frame-leading-clearance')
      hideButton()
      return true
    }
    applyGrid(resolved.frame)
    // 宿主已经自带入口（macOS 桌面 / Windows 标题栏的 `shell.leading` 座位）时不再重复：
    // 那种形态下 DSH 自己会设置 `--dsh-frame-leading-clearance`，插件也不该覆盖它。
    // 右栏打开时它自己的标签栏就占据左上角，logo 必须让位，否则会盖住标签。
    if (hasHostLeadingToggle(dom) || isRightbarOccupied(resolved.frame)) {
      hideButton()
      resolved.frame.style.removeProperty('--dsh-frame-leading-clearance')
    } else {
      resolved.frame.style.setProperty('--dsh-frame-leading-clearance', `${MOBILE_SIDEBAR_LEADING_CLEARANCE_PX}px`)
      showButton()
    }
    return true
  }

  const applyGrid = (target: HTMLElement): void => {
    const current = target.style.gridTemplateColumns
    if (current === gridApplied) return
    // 与插件上次写入不同，说明这是宿主重绘的结果；它才是恢复用的基线。
    if (current !== '') gridBaseline = current
    const hidden = hideLeadingGridTrack(current === '' ? (gridBaseline ?? '') : current)
    if (hidden === undefined) return
    target.style.gridTemplateColumns = hidden
    gridApplied = hidden
    target.setAttribute(MOBILE_SIDEBAR_GRID_STATE_ATTRIBUTE, 'on')
  }

  const restoreGrid = (): void => {
    if (frame !== undefined) {
      // 只有 DOM 里仍是插件写入的值时才还原基线。宿主（React）在展开时已经写过新的
      // 宽度，此时若把折叠态基线写回去，侧栏会按展开宽度渲染却被 56px 的列裁掉——
      // 表现为“点开 logo 后侧栏内容被截断”。宿主已经重写过就一律交给宿主。
      if (gridApplied !== undefined
        && gridBaseline !== undefined
        && frame.style.gridTemplateColumns === gridApplied) {
        frame.style.gridTemplateColumns = gridBaseline
      }
      frame.removeAttribute(MOBILE_SIDEBAR_GRID_STATE_ATTRIBUTE)
    }
    gridApplied = undefined
  }

  const restore = (): void => {
    restoreGrid()
    frame?.style.removeProperty('--dsh-frame-leading-clearance')
    dom?.documentElement?.removeAttribute(MOBILE_SIDEBAR_MODE_ATTRIBUTE)
    removeStyles()
    column?.removeAttribute(MOBILE_SIDEBAR_COLUMN_ATTRIBUTE)
    frame?.removeAttribute(MOBILE_SIDEBAR_FRAME_ATTRIBUTE)
    hideButton()
  }

  const showButton = (): void => {
    if (button === undefined) {
      button = createToggleButton(dom)
      if (button === undefined) return
      // 点击只调用 DSH 官方布局服务；插件不自己改状态、不猜当前开合。
      button.addEventListener('click', () => {
        try {
          options.toggleSidebar?.()
        } catch {
          // 布局服务在宿主重建期间可能暂时不可用；忽略即可，按钮保持可再次点击。
        }
      })
      dom?.body?.appendChild(button)
    }
    if (!warnedToggle && options.toggleSidebar === undefined) {
      warnedToggle = true
      options.onDiagnostic?.(MOBILE_SIDEBAR_DIAGNOSTIC_TOGGLE_MISSING)
    }
  }

  const hideButton = (): void => {
    if (button === undefined) return
    button.remove()
    button = undefined
  }

  const resolveStructure = (): { readonly frame: HTMLElement } | undefined => {
    if (dom === undefined) return undefined
    // 缓存节点仍然完好时直接复用；一旦 React 重建了侧栏子树（标记被换掉或节点脱离
    // 文档），必须重新解析，否则插件会一直守着已经不在页面上的旧节点。
    if (frame !== undefined && !structureDrifted()) return { frame }
    const previousFrame = frame
    // 解析新结构前清掉旧节点上的标记：它们可能已经被 React 摘掉，但属性仍留在
    // 游离节点上，重复扫描时会干扰“结构是否漂移”的判断。
    column?.removeAttribute(MOBILE_SIDEBAR_COLUMN_ATTRIBUTE)
    frame?.removeAttribute(MOBILE_SIDEBAR_FRAME_ATTRIBUTE)
    frame = undefined
    column = undefined
    const found = findAppFrame(dom)
    if (found === undefined) return undefined
    // 只有换成另一个框架元素时才丢弃网格基线；同框架下重建侧栏子树时，
    // 旧基线仍是宿主自己写下的值，保留它才能正确还原。
    if (found !== previousFrame) {
      gridBaseline = undefined
      gridApplied = undefined
    }
    const foundColumn = findSidebarColumn(found)
    if (foundColumn === undefined) return undefined
    frame = found
    column = foundColumn
    found.setAttribute(MOBILE_SIDEBAR_FRAME_ATTRIBUTE, '')
    foundColumn.setAttribute(MOBILE_SIDEBAR_COLUMN_ATTRIBUTE, '')
    return { frame: found }
  }

  const installStyles = (): void => {
    if (dom?.head === undefined || dom.head === null) return
    const existing = Array.from(dom.head.children).some((child) => (
      child.tagName === 'STYLE' && (child as HTMLElement).dataset.pluginCss === MOBILE_SIDEBAR_STYLE_ID
    ))
    if (existing) return
    const style = dom.createElement('style')
    style.dataset.plugin = 'codingns4dsh'
    style.dataset.pluginCss = MOBILE_SIDEBAR_STYLE_ID
    style.textContent = MOBILE_SIDEBAR_STYLE_TEXT
    dom.head.appendChild(style)
  }

  const removeStyles = (): void => {
    if (dom?.head === undefined || dom.head === null) return
    for (const child of Array.from(dom.head.children)) {
      if (child.tagName !== 'STYLE') continue
      if ((child as HTMLElement).dataset.pluginCss !== MOBILE_SIDEBAR_STYLE_ID) continue
      child.remove()
    }
  }

  const onMutations = (records: readonly MutationRecord[]): void => {
    if (disposed) return
    // 两种情况下必须重扫：宿主改动了我们依赖的节点；或者 React 重建了侧栏子树，
    // 把插件标记连同侧栏列一起换掉（此时新增节点位于侧栏列内部，不包含框架，
    // 只看“新增节点是否包含框架”会漏判，界面就会退回 56px 轨道）。
    if (records.some(isRelevantMutation) || structureDrifted()) scheduleSync()
  }

  const isRelevantMutation = (record: MutationRecord): boolean => {
    // 还没解析到框架时任何新增节点都可能带来框架，必须继续尝试。
    if (frame === undefined || !isAttached(frame, dom)) return true
    if (record.target === frame || isInsideSidebar(record.target)) return true
    for (const node of [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]) {
      if (node === frame || node === button) return true
      if (isInsideSidebar(node)) return true
      if (typeof (node as Element).contains === 'function' && (node as Element).contains(frame)) return true
    }
    return false
  }

  /** 已解析出的侧栏节点是否仍然带着插件标记并挂在文档上。 */
  const structureDrifted = (): boolean => {
    if (frame === undefined) return false
    if (!isAttached(frame, dom)) return true
    if (!frame.hasAttribute(MOBILE_SIDEBAR_FRAME_ATTRIBUTE)) return true
    if (column === undefined || !isAttached(column, dom) || !column.hasAttribute(MOBILE_SIDEBAR_COLUMN_ATTRIBUTE)) return true
    return false
  }

  const isInsideSidebar = (node: Node): boolean => {
    if (column === undefined || typeof (node as Element).contains !== 'function') return false
    return node === column || column.contains(node)
  }

  const onResize = (): void => { scheduleSync() }

  installStyles()
  const observer = dom === undefined || Observer === undefined || dom.documentElement === undefined
    ? undefined
    : new Observer(onMutations)
  if (observer !== undefined && dom?.documentElement !== undefined) {
    observer.observe(dom.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      // 必须同时观察右栏状态：右栏打开/关闭时 logo 要跟着让位或恢复，
      // 否则标签会被盖住（或该出现时不出现）。
      attributeFilter: ['style', 'data-sidebar-collapsed', 'data-rightbar-collapsed', 'data-rightbar-fullscreen'],
    })
  }
  win?.addEventListener?.('resize', onResize)
  sync()

  return {
    refresh: sync,
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      win?.removeEventListener?.('resize', onResize)
      restore()
    },
  }
}

const MOBILE_SIDEBAR_STYLE_TEXT = [
  // 折叠态下让整列不可见。这里必须用 `visibility` 而不是 `display:none`：
  // 该列是框架网格的第一个网格项，`display:none` 会让后面的中央列与右栏整体
  // 前移一格，落进 0px 轨道里，把整个界面挤坏。
  `html[${MOBILE_SIDEBAR_MODE_ATTRIBUTE}="on"] [${MOBILE_SIDEBAR_FRAME_ATTRIBUTE}][data-sidebar-collapsed] [${MOBILE_SIDEBAR_COLUMN_ATTRIBUTE}]{visibility:hidden!important;border-right:0!important;background:transparent!important}`,
  // 唤起按钮：固定在左上角、跟随安全区，层级低于 DSH 模态框（其 z-index 在 1000+）。
  `[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]{position:fixed;top:calc(6px + env(safe-area-inset-top, 0px));left:calc(6px + env(safe-area-inset-left, 0px));z-index:60;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;padding:0;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary, CanvasText);cursor:pointer;-webkit-tap-highlight-color:transparent}`,
  `[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))}`,
  `[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]:focus-visible{outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #3b82f6));outline-offset:2px}`,
  `[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}] svg{display:block;pointer-events:none}`,
].join('')

/** 插件自有的唤起按钮：与 DSH 折叠轨道使用同一个鲸鱼图形。 */
function createToggleButton(dom: Document | undefined): HTMLElement | undefined {
  if (dom?.body === undefined || dom.body === null) return undefined
  const element = dom.createElement('button')
  element.setAttribute(MOBILE_SIDEBAR_BUTTON_ATTRIBUTE, '')
  element.setAttribute('type', 'button')
  element.setAttribute('aria-label', MOBILE_SIDEBAR_TOGGLE_LABEL)
  element.setAttribute('title', MOBILE_SIDEBAR_TOGGLE_LABEL)
  const icon = createFishLogo(dom)
  if (icon !== undefined) element.appendChild(icon)
  else element.textContent = '≡'
  return element
}

/** 内联鲸鱼 SVG；与 `FishLogo` 的 viewBox 和路径一致，24px 高。 */
function createFishLogo(dom: Document): SVGElement | undefined {
  if (typeof dom.createElementNS !== 'function') return undefined
  const size = 24
  const height = Math.round(size * FISH_LOGO_VIEWBOX.height / FISH_LOGO_VIEWBOX.width * 100) / 100
  const svg = dom.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(height))
  svg.setAttribute('viewBox', `0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`)
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  const path = dom.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', FISH_LOGO_PATH)
  path.setAttribute('fill', 'currentColor')
  svg.appendChild(path)
  return svg
}

/** 应用框架：从遮罩层向上找第一个带内联网格的祖先。 */
function findAppFrame(dom: Document): HTMLElement | undefined {
  const overlay = dom.querySelector<HTMLElement>('[data-shell-overlay]')
  if (overlay === null) return undefined
  let current: HTMLElement | null = overlay
  for (let depth = 0; depth < 8 && current !== null; depth += 1, current = current.parentElement) {
    if (current.style.gridTemplateColumns !== '') return current
  }
  return undefined
}

/** 左侧栏列：框架里第一个不是遮罩层的直接子元素。 */
function findSidebarColumn(frame: HTMLElement): HTMLElement | undefined {
  for (const child of Array.from(frame.children)) {
    if (child.hasAttribute('data-shell-overlay')) continue
    return child as HTMLElement
  }
  return undefined
}

function readViewportWidth(win: MobileSidebarRailWindowLike | undefined): number {
  const width = win?.innerWidth
  if (typeof width === 'number' && Number.isFinite(width) && width > 0) return width
  const fallback = (globalThis as unknown as { readonly innerWidth?: unknown }).innerWidth
  return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : 0
}

/** 元素是否仍在当前文档里；测试用的伪 DOM 没有 `isConnected`，退化为属性判断。 */
function isAttached(element: HTMLElement, dom: Document | undefined): boolean {
  if (dom?.documentElement === undefined || dom.documentElement === null) return true
  if (element.isConnected === true) return true
  if (typeof dom.documentElement.contains !== 'function') return true
  return dom.documentElement.contains(element)
}

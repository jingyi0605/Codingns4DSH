/**
 * 快捷短语按钮在 DSH 输入工具栏里的落位。
 *
 * DSH 原生结构是「添加附件按钮 → 权限/规划组 → conversation.input.left 槽位」，
 * 槽位里的控件默认排在权限组件右边。这里不改 DOM 顺序，只给这些项各加一个 flex order：
 * 三者仍共用宿主工具栏的 flex 行，既不互相覆盖，间距也由宿主 gap 统一决定。
 */
export const QUICK_PHRASE_TRIGGER_ORDER = 1
export const QUICK_PHRASE_PERMISSION_ORDER = 2
/** 快捷短语两侧保留的间距比例：只留宿主原生间距的一半，入口更紧凑。 */
export const QUICK_PHRASE_GAP_SCALE = 0.5
/** 读不到宿主 gap 时按 DSH 当前的 12px 估算，留出一半间距。 */
export const QUICK_PHRASE_FALLBACK_MARGIN = -6

/**
 * 按 CSS Modules 本地名匹配 DSH 类名。
 *
 * DSH 类名形如 `uV2eYG_add`，前缀是构建期生成的哈希：npm 分发的 Web 构建与
 * Desktop 内嵌构建（app.asar）哈希不同（`yhfFVG_add`）。插件只能按本地名
 * 匹配，把类名绑到某一次构建的哈希上会在另一个运行时失效。
 * @param className - 元素完整的 class 字符串，可含多个类名。
 * @param localName - CSS Modules 本地名，例如 `add`。
 * @returns class 字符串里是否有本地名等于 localName 的类名。
 */
export function matchesDshCssModuleClass(className: string | null | undefined, localName: string): boolean {
  if (typeof className !== 'string') return false
  for (const token of className.split(/\s+/)) {
    const separator = token.lastIndexOf('_')
    if (separator > 0 && token.slice(separator + 1) === localName) return true
  }
  return false
}

/** 读取计算样式的入口；测试可注入替身。 */
export interface QuickPhraseLayoutEnvironment {
  readonly computedStyle?: (element: Element) => { readonly display: string; readonly columnGap?: string }
}

/** 重排结果：被排到快捷短语之后的工具栏项与还原函数。 */
export interface QuickPhraseOrderHandle {
  /** 从添加附件按钮到快捷短语之间的工具栏项（DSH 中是权限/规划组）；布局变化导致找不到时为空。 */
  readonly reordered: readonly HTMLElement[]
  /** 承载这些控件的工具栏行；DSH 结构变化时为 null。 */
  readonly container: HTMLElement | null
  dispose(): void
}

export interface QuickPhraseOrderRequest {
  /** 插件自己的快捷短语根节点。 */
  readonly trigger: HTMLElement
  /** DSH 的添加附件按钮，用来定位它之后的工具栏项。 */
  readonly addButton: HTMLElement
}

/**
 * 把快捷短语按钮排到添加附件按钮之后、权限设置组件之前。
 * @param request - 快捷短语根节点与添加附件按钮。
 * @param environment - 计算样式读取入口。
 * @returns 被重排的工具栏项、工具栏行与还原函数。
 */
export function applyQuickPhraseOrder(
  request: QuickPhraseOrderRequest,
  environment: QuickPhraseLayoutEnvironment = {},
): QuickPhraseOrderHandle {
  const computedStyle = environment.computedStyle ?? ((element: Element) => getComputedStyle(element))
  const container = findFlexContainer(request.addButton, computedStyle)
  const following = container === null ? [] : findItemsAfterAddButton(container, request, computedStyle)
  if (following.length === 0) return { reordered: [], container, dispose: () => undefined }
  const original = following.map((item) => item.style.order)
  for (const item of following) item.style.order = String(QUICK_PHRASE_PERMISSION_ORDER)
  return {
    reordered: following,
    container,
    dispose: () => {
      following.forEach((item, index) => {
        item.style.order = original[index] ?? ''
      })
    },
  }
}

/**
 * 快捷短语两侧要用的负外边距：把宿主原生 gap 收窄到 {@link QUICK_PHRASE_GAP_SCALE}。
 * @param container - 承载工具栏项的 flex 行。
 * @param environment - 计算样式读取入口。
 * @returns 左右外边距（px，负值）。
 */
export function readQuickPhraseMargin(
  container: Element | null,
  environment: QuickPhraseLayoutEnvironment = {},
): number {
  if (container === null) return QUICK_PHRASE_FALLBACK_MARGIN
  const computedStyle = environment.computedStyle ?? ((element: Element) => getComputedStyle(element))
  const gap = Number.parseFloat(computedStyle(container).columnGap ?? '')
  if (!Number.isFinite(gap) || gap <= 0) return QUICK_PHRASE_FALLBACK_MARGIN
  return -gap * (1 - QUICK_PHRASE_GAP_SCALE)
}

/** 添加附件按钮之后、快捷短语之前的工具栏项。 */
function findItemsAfterAddButton(
  container: HTMLElement,
  request: QuickPhraseOrderRequest,
  computedStyle: (element: Element) => { readonly display: string },
): readonly HTMLElement[] {
  const items = layoutItems(container, computedStyle)
  const addIndex = items.findIndex((item) => item.contains(request.addButton))
  if (addIndex < 0) return []
  return items.slice(addIndex + 1).filter((item) => !item.contains(request.trigger))
}

/** 最近的 flex/grid 布局容器；找不到说明宿主工具栏结构变了，此时保持原生顺序。 */
function findFlexContainer(node: Element, computedStyle: (element: Element) => { readonly display: string }): HTMLElement | null {
  let current = node.parentElement
  while (current !== null) {
    const display = computedStyle(current).display
    if (display === 'flex' || display === 'inline-flex' || display === 'grid') return current
    current = current.parentElement
  }
  return null
}

/** 展开工具栏里真正参与布局的项：display: contents 的槽位锚点穿透，display: none 的隐藏节点跳过。 */
function layoutItems(container: Element, computedStyle: (element: Element) => { readonly display: string }): readonly HTMLElement[] {
  const items: HTMLElement[] = []
  const visit = (parent: Element): void => {
    for (const child of parent.children) {
      const display = computedStyle(child).display
      if (display === 'none') continue
      if (display === 'contents') {
        visit(child)
        continue
      }
      if (isStylable(child)) items.push(child)
    }
  }
  visit(container)
  return items
}

function isStylable(element: Element): element is HTMLElement {
  return (element as Partial<HTMLElement>).style !== undefined
}

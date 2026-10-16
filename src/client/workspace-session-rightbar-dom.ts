/** 右侧栏宽度比例的本地存储键；宽度属于浏览器布局，不应同步到 Host。 */
export const WORKSPACE_RIGHTBAR_RATIO_STORAGE_KEY = 'codingns4dsh.workspace.rightbar-ratio.v1'

const RIGHTBAR_HANDLE_SELECTOR = '[data-side="rightbar"], .workbench-side-resizer[data-side="right"]'
const MIN_RIGHTBAR_SHARE = 0.12
const MAX_RIGHTBAR_SHARE = 0.8

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface WorkspaceSessionRightbarDomOptions {
  readonly document?: Document
  readonly window?: Window
  readonly MutationObserver?: typeof MutationObserver
  readonly storage?: StorageLike
}

export interface WorkspaceSessionRightbarDomController {
  /** 主动重新查找句柄并应用已保存的比例。 */
  refresh(): void
  /** 断开观察器并移除事件监听。 */
  dispose(): void
}

/**
 * 记忆 DSH 原生对话区与右侧栏的宽度比例。
 *
 * DSH 不同版本暴露了两种句柄：旧版使用 `data-side="rightbar"` 并直接写入
 * `left`，新版使用 `workbench-side-resizer[data-side="right"]` 并通过工作台
 * CSS 变量控制宽度。这里只读取边界，不依赖 React Fiber 或版本号。
 */
export function startWorkspaceSessionRightbarDom(
  options: WorkspaceSessionRightbarDomOptions = {},
): WorkspaceSessionRightbarDomController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const win = options.window ?? (typeof window === 'undefined' ? undefined : window)
  const Observer = options.MutationObserver
    ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  const storage = options.storage ?? resolveStorage()
  let disposed = false
  let scanQueued = false
  let desiredShare = readStoredShare(storage)
  let userInteracting = false
  let userCommitPending = false
  let applying = false
  let lastRestore: { readonly handle: HTMLElement; readonly containerWidth: number; readonly share: number } | undefined

  const scan = (): void => {
    if (disposed || dom === undefined || win === undefined) return
    const handle = findRightbarHandle(dom)
    if (handle === undefined) { lastRestore = undefined; return }

    if (applying) return
    const share = readRightbarShare(handle, win)
    if (share === undefined) return
    if (userCommitPending) {
      userCommitPending = false
      desiredShare = share
      lastRestore = undefined
      writeStoredShare(storage, share)
      return
    }
    // DSH may clamp the requested width. Restore once per handle/container size;
    // content mutations must not keep replaying a resize the host cannot honor.
    if (!userInteracting && desiredShare !== undefined && !sharesMatch(share, desiredShare)) {
      applyShare(handle, desiredShare, win)
      return
    }
    if (userInteracting) return
    desiredShare = share
    writeStoredShare(storage, share)
  }

  const scheduleScan = (): void => {
    if (disposed || scanQueued) return
    scanQueued = true
    queueMicrotask(() => {
      scanQueued = false
      scan()
    })
  }

  const observer = dom === undefined || Observer === undefined
    ? undefined
    : new Observer(scheduleScan)
  if (observer !== undefined && dom !== undefined) {
    observer.observe(dom.documentElement ?? dom, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
  }

  const onPointerStart = (): void => {
    if (applying) return
    userInteracting = true
  }
  const onPointerEnd = (): void => {
    if (applying) return
    userInteracting = false
    userCommitPending = true
    scheduleScan()
  }
  const onResize = (): void => {
    if (disposed || win === undefined || dom === undefined) return
    desiredShare = readStoredShare(storage) ?? desiredShare
    scheduleScan()
  }
  dom?.addEventListener('mousedown', onPointerStart, true)
  dom?.addEventListener('pointerdown', onPointerStart, true)
  dom?.addEventListener('mouseup', onPointerEnd, true)
  dom?.addEventListener('pointerup', onPointerEnd, true)
  win?.addEventListener('resize', onResize)
  scheduleScan()

  return {
    refresh() { lastRestore = undefined; scheduleScan() },
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      dom?.removeEventListener('mousedown', onPointerStart, true)
      dom?.removeEventListener('pointerdown', onPointerStart, true)
      dom?.removeEventListener('mouseup', onPointerEnd, true)
      dom?.removeEventListener('pointerup', onPointerEnd, true)
      win?.removeEventListener('resize', onResize)
    },
  }

  function applyShare(handle: HTMLElement, share: number, targetWindow: Window): void {
    const containerWidth = resolveContainerWidth(handle, targetWindow)
    if (lastRestore?.handle === handle && Math.abs(lastRestore.containerWidth - containerWidth) < 1 && sharesMatch(lastRestore.share, share)) return
    lastRestore = { handle, containerWidth, share }
    const rightWidth = containerWidth * share
    const container = resolveContainerRect(handle, targetWindow.innerWidth)
    const targetClientX = container.left + containerWidth - rightWidth
    applying = true
    try {
      // 右侧栏宽度通常由宿主 React 的拖拽状态驱动。模拟一次原生拖拽，
      // 让宿主自己更新面板和调整线，避免只移动句柄而面板状态仍是默认值。
      const nativeResizeDispatched = dispatchNativeResize(handle, targetWindow, targetClientX)
      if (!nativeResizeDispatched && handle.matches('[data-side="rightbar"]')) {
        // `left` 是相对于 offsetParent 的坐标，不能直接使用视口宽度。
        handle.style.left = `${Math.round(containerWidth - rightWidth)}px`
      }
      const shell = handle.closest<HTMLElement>('.workbench-shell')
      if (!nativeResizeDispatched && shell !== null) {
        shell.style.setProperty('--workbench-right-width', `${Math.round(rightWidth)}px`)
        shell.style.setProperty('--workbench-right-current-width', `${Math.round(rightWidth)}px`)
      }
    } finally {
      applying = false
    }
  }
}

function dispatchNativeResize(handle: HTMLElement, targetWindow: Window, targetClientX: number): boolean {
  const targetDocument = targetWindow.document
  if (targetDocument === undefined || typeof handle.dispatchEvent !== 'function') return false
  const currentClientX = handle.getBoundingClientRect().left
  const PointerEventCtor = (targetWindow as Window & { readonly PointerEvent?: typeof PointerEvent }).PointerEvent
  const canCapture = typeof (handle as HTMLElement & { setPointerCapture?: (pointerId: number) => void }).setPointerCapture === 'function'
  if (typeof PointerEventCtor === 'function' && canCapture && Number.isFinite(currentClientX)) {
    const pointerId = 2147483000
    const eventInit = (clientX: number, type: 'pointerdown' | 'pointermove' | 'pointerup'): PointerEventInit => ({
      bubbles: true,
      cancelable: true,
      clientX,
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: type === 'pointerdown' ? 0 : -1,
      buttons: type === 'pointerup' ? 0 : 1,
    })
    // 合成 PointerEvent 不属于真实硬件指针，宿主直接调用
    // setPointerCapture(pointerId) 会在 Chromium 中抛 NotFoundError。
    // 宿主的拖拽逻辑只依赖捕获后的 id 和后续事件，因此临时屏蔽捕获调用即可。
    const captureTarget = handle as HTMLElement & { setPointerCapture?: (pointerId: number) => void }
    const ownCapture = Object.getOwnPropertyDescriptor(handle, 'setPointerCapture')
    let capturePatched = false
    try {
      Object.defineProperty(handle, 'setPointerCapture', {
        configurable: true,
        writable: true,
        value: () => undefined,
      })
      capturePatched = true
    } catch {
      return false
    }
    try {
      handle.dispatchEvent(new PointerEventCtor('pointerdown', eventInit(currentClientX, 'pointerdown')))
      handle.dispatchEvent(new PointerEventCtor('pointermove', eventInit(targetClientX, 'pointermove')))
      handle.dispatchEvent(new PointerEventCtor('pointerup', eventInit(targetClientX, 'pointerup')))
    } catch {
      return false
    } finally {
      if (capturePatched) {
        if (ownCapture === undefined) Reflect.deleteProperty(handle, 'setPointerCapture')
        else Object.defineProperty(handle, 'setPointerCapture', ownCapture)
      }
    }
    return true
  }
  const MouseEventCtor = (targetWindow as Window & { readonly MouseEvent?: typeof MouseEvent }).MouseEvent
  if (typeof MouseEventCtor !== 'function' || !Number.isFinite(currentClientX)) return false
  handle.dispatchEvent(new MouseEventCtor('mousedown', { bubbles: true, clientX: currentClientX }))
  targetDocument.dispatchEvent(new MouseEventCtor('mousemove', { bubbles: true, clientX: targetClientX }))
  targetDocument.dispatchEvent(new MouseEventCtor('mouseup', { bubbles: true, clientX: targetClientX }))
  return false
}

function findRightbarHandle(dom: Document): HTMLElement | undefined {
  return dom.querySelector<HTMLElement>(RIGHTBAR_HANDLE_SELECTOR) ?? undefined
}

function readRightbarShare(handle: HTMLElement, win: Window): number | undefined {
  const viewportWidth = win.innerWidth
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return undefined

  const containerWidth = resolveContainerWidth(handle, win)
  const rightWidth = resolveRightbarWidth(handle, viewportWidth)
  if (!Number.isFinite(containerWidth) || containerWidth <= 0 || !Number.isFinite(rightWidth) || rightWidth <= 0) return undefined
  return clamp(rightWidth / containerWidth, MIN_RIGHTBAR_SHARE, MAX_RIGHTBAR_SHARE)
}

function resolveRightbarWidth(handle: HTMLElement, viewportWidth: number): number {
  const containerWidth = resolveContainerWidth(handle, { innerWidth: viewportWidth } as Window)
  const inlineLeft = Number.parseFloat(handle.style.left)
  if (Number.isFinite(inlineLeft)) return containerWidth - inlineLeft

  const shell = handle.closest<HTMLElement>('.workbench-shell')
  const cssWidth = shell?.style.getPropertyValue('--workbench-right-width')
  const configuredWidth = cssWidth === undefined ? Number.NaN : Number.parseFloat(cssWidth)
  if (Number.isFinite(configuredWidth) && configuredWidth > 0) return configuredWidth

  const panel = shell?.querySelector<HTMLElement>('.workbench-auxiliary')
  const measuredWidth = panel?.getBoundingClientRect().width ?? 0
  if (measuredWidth > 0) return measuredWidth

  const boundary = handle.getBoundingClientRect().left
  const container = resolveContainerRect(handle, viewportWidth)
  return boundary > container.left ? container.right - boundary : 0
}

function resolveContainerWidth(handle: HTMLElement, targetWindow: Window): number {
  return Math.max(1, resolveContainerRect(handle, targetWindow.innerWidth).width)
}

function resolveContainerRect(handle: HTMLElement, viewportWidth: number): { left: number; right: number; width: number } {
  const positioningParent = handle.offsetParent
  const parentRect = positioningParent?.getBoundingClientRect()
  if (parentRect !== undefined && parentRect.width > 0) {
    return { left: parentRect.left, right: parentRect.right, width: parentRect.width }
  }

  const shell = handle.closest<HTMLElement>('.workbench-shell')
  const shellRect = shell?.getBoundingClientRect()
  if (shellRect !== undefined && shellRect.width > 0) {
    return { left: shellRect.left, right: shellRect.right, width: shellRect.width }
  }

  return { left: 0, right: viewportWidth, width: viewportWidth }
}

function resolveStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function readStoredShare(storage: StorageLike | undefined): number | undefined {
  if (storage === undefined) return undefined
  try {
    const value = Number.parseFloat(storage.getItem(WORKSPACE_RIGHTBAR_RATIO_STORAGE_KEY) ?? '')
    return Number.isFinite(value) ? clamp(value, MIN_RIGHTBAR_SHARE, MAX_RIGHTBAR_SHARE) : undefined
  } catch {
    return undefined
  }
}

function writeStoredShare(storage: StorageLike | undefined, share: number): void {
  if (storage === undefined) return
  try {
    storage.setItem(WORKSPACE_RIGHTBAR_RATIO_STORAGE_KEY, String(Number(share.toFixed(6))))
  } catch {
    // 隐私模式或受限 iframe 中本地存储不可用时，仅失去跨刷新记忆。
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function sharesMatch(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.002
}

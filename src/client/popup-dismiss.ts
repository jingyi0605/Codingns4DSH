import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * 弹层关闭的统一入口。
 *
 * 此前插件里的菜单与浮层各自实现关闭逻辑：`<details>/<summary>` 原生折叠、
 * React `useState` 菜单完全没有外部监听、DOM 菜单用捕获阶段 `click`，
 * 结果就是「只有再次点击触发按钮才会关闭」。这里收敛成一套通用能力：
 * 弹层打开期间监听 `pointerdown`，命中弹层根节点之外即关闭。
 *
 * 选择 `pointerdown` 而不是 `click`：与 DSH 原生
 * `useDismissOnOutsidePointer` 保持一致，且在弹层内部按下并拖拽出去时不会误关。
 */

/** 弹层根节点：React ref 或已解析的 DOM 元素都支持。 */
export type DismissRoot = RefObject<HTMLElement | null> | HTMLElement | null | undefined

export interface OutsideDismissOptions {
  /** 通过 Portal 渲染到根节点之外的浮层，命中它同样算「内部」。 */
  readonly portal?: DismissRoot
  /** 是否同时支持 Esc 关闭，默认 true。 */
  readonly escape?: boolean
}

export interface AttachOutsideDismissalOptions {
  /** 是否同时支持 Esc 关闭，默认 true。 */
  readonly escape?: boolean
  /** 是否在捕获阶段监听，默认 true，避免被弹层内部处理器 stopPropagation 吞掉。 */
  readonly capture?: boolean
}

/** 解析 ref 或裸元素；ref 尚未挂载时返回 null。 */
function resolveRoot(root: DismissRoot): Element | null {
  if (root === null || root === undefined) return null
  const current = (root as RefObject<Element | null>).current
  if (current !== undefined) return current
  return root as Element
}

/**
 * 事件目标是否像 DOM 节点。H5/测试环境可能没有全局 `Node`，
 * 此时退化为结构判断，避免因为缺少构造器而全部当作外部点击。
 */
function isNodeLike(value: unknown): value is Node {
  if (typeof value !== 'object' || value === null) return false
  if (typeof Node !== 'undefined') return value instanceof Node
  return typeof (value as { nodeType?: unknown }).nodeType === 'number'
}

/** 事件目标是否落在全部弹层根节点之外；非 DOM 目标一律按外部处理。 */
export function isOutsideDismissRoots(target: unknown, roots: readonly DismissRoot[]): boolean {
  if (!isNodeLike(target)) return true
  for (const root of roots) {
    const element = resolveRoot(root)
    if (element !== null && element.contains(target)) return false
  }
  return true
}

/**
 * 命令式版本：给纯 DOM 代码（账户菜单、文件树右键菜单）挂载外部点击关闭。
 * @returns 取消监听的清理函数。
 */
export function attachOutsideDismissal(
  doc: Document,
  roots: () => readonly DismissRoot[],
  close: () => void,
  options: AttachOutsideDismissalOptions = {},
): () => void {
  const capture = options.capture ?? true
  const onPointerDown = (event: Event): void => {
    if (isOutsideDismissRoots((event as { target?: unknown }).target, roots())) close()
  }
  doc.addEventListener('pointerdown', onPointerDown, capture)
  const onKeyDown = options.escape === false
    ? undefined
    : (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
  if (onKeyDown !== undefined) doc.addEventListener('keydown', onKeyDown, capture)
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, capture)
    if (onKeyDown !== undefined) doc.removeEventListener('keydown', onKeyDown, capture)
  }
}

/**
 * React 版本：弹层打开期间，根节点之外的 `pointerdown` 触发 `close`。
 * `close` 可以传 `setOpen(false)` 或 `onClose`，内部用 ref 保持引用稳定，
 * 因此调用方可以直接写内联箭头函数而不必担心反复重订阅。
 */
export function useDismissOnOutsidePointer(
  root: DismissRoot,
  open: boolean,
  close: () => void,
  options: OutsideDismissOptions = {},
): void {
  const closeRef = useRef(close)
  useEffect(() => { closeRef.current = close }, [close])

  const portal = options.portal
  const escape = options.escape ?? true

  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const onPointerDown = (event: Event): void => {
      if (isOutsideDismissRoots((event as { target?: unknown }).target, [root, portal])) closeRef.current()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, root, portal])

  useEffect(() => {
    if (!open || !escape || typeof document === 'undefined') return
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') closeRef.current() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, escape])
}

/**
 * 遮罩层版本：只有点击遮罩自身（而不是遮罩内部的弹窗面板）才关闭。
 * 供不便使用 hook 的场景（内联渲染函数、纯 DOM 模态框）复用。
 */
export function backdropPointerDownHandler(
  close: () => void,
): (event: { readonly target: unknown; readonly currentTarget: unknown }) => void {
  return (event) => { if (event.target === event.currentTarget) close() }
}

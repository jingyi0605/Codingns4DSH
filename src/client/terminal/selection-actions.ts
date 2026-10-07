import { createElement, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalTextSnapshot } from '../../shared/contracts/terminal-share.js'
import type { CodingNsTranslator } from '../locale.js'
import { copyTextToClipboard } from '../features/lan-access-status.js'
import type { CodingNsTerminalView } from './model.js'
import type { TerminalSharing } from './sharing.js'
import { TerminalShareMenu } from './share-menu.js'
import { terminalClass } from './styles.js'

export interface TerminalSelectionActionsState {
  readonly text: string
  readonly left: number
  readonly top: number
}
interface SelectionTerminal {
  readonly cols: number
  readonly rows: number
  readonly buffer: { readonly active: { readonly viewportY: number } }
  getSelection(): string
  getSelectionPosition(): { readonly end: { readonly x: number; readonly y: number } } | undefined
  onSelectionChange(listener: () => void): { dispose(): void }
  onScroll(listener: () => void): { dispose(): void }
}

/** 根据公开选区末端定位按钮；窗口边缘与移动端可视视口内都保留间距。 */
export function positionTerminalSelectionActions(rect: { left: number; top: number; width: number; height: number },
  end: { x: number; y: number }, cols: number, rows: number, viewportY: number,
  viewport: { left: number; top: number; width: number; height: number }): { left: number; top: number } | undefined {
  // 行尾选区的 end 可以落在下一行第零列，按钮仍应定位到上一行末端。
  const row = end.y - viewportY - (end.x === 0 && end.y > viewportY ? 1 : 0)
  if (row < 0 || row >= rows || cols <= 0 || rows <= 0 || rect.width <= 0 || rect.height <= 0) return undefined
  const left = rect.left + (end.x === 0 ? cols : Math.min(cols, end.x)) * rect.width / cols
  const bottom = rect.top + (row + 1) * rect.height / rows
  const top = bottom + 6 + 34 <= viewport.top + viewport.height - 8 ? bottom + 6 : bottom - rect.height / rows - 40
  return { left: Math.max(viewport.left + 8, Math.min(left, viewport.left + viewport.width - 160)),
    top: Math.max(viewport.top + 8, Math.min(top, viewport.top + viewport.height - 42)) }
}

/** 等拖选结束再弹出，避免浮层挡住拖动；事件与动画帧随 xterm 一起释放。 */
export function installTerminalSelectionActions(terminal: SelectionTerminal, container: HTMLElement,
  publish: (state: TerminalSelectionActionsState | undefined) => void): () => void {
  const view = container.ownerDocument.defaultView
  if (view === null) return () => undefined
  let selecting = false
  let frame: number | undefined
  const hide = (): void => {
    if (frame !== undefined) view.cancelAnimationFrame(frame)
    frame = undefined
    publish(undefined)
  }
  const refresh = (): void => {
    if (frame !== undefined) view.cancelAnimationFrame(frame)
    frame = view.requestAnimationFrame(() => {
      frame = undefined
      const text = terminal.getSelection()
      const range = terminal.getSelectionPosition()
      const viewport = view.visualViewport
      const position = range === undefined ? undefined : positionTerminalSelectionActions(container.getBoundingClientRect(), range.end,
        terminal.cols, terminal.rows, terminal.buffer.active.viewportY,
        { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, width: viewport?.width ?? view.innerWidth, height: viewport?.height ?? view.innerHeight })
      publish(text === '' || position === undefined ? undefined : { text, ...position })
    })
  }
  const down = (): void => { selecting = true; hide() }
  const up = (): void => { if (selecting) { selecting = false; refresh() } }
  const selection = terminal.onSelectionChange(() => { if (!selecting) refresh() })
  const scroll = terminal.onScroll(hide)
  container.addEventListener('pointerdown', down)
  view.addEventListener('pointerup', up)
  view.addEventListener('pointercancel', up)
  view.addEventListener('blur', hide)
  view.addEventListener('resize', hide)
  view.visualViewport?.addEventListener('resize', hide)
  return () => {
    hide()
    selection.dispose()
    scroll.dispose()
    container.removeEventListener('pointerdown', down)
    view.removeEventListener('pointerup', up)
    view.removeEventListener('pointercancel', up)
    view.removeEventListener('blur', hide)
    view.removeEventListener('resize', hide)
    view.visualViewport?.removeEventListener('resize', hide)
  }
}

interface Props {
  readonly selection: TerminalSelectionActionsState | undefined
  readonly view: CodingNsTerminalView
  readonly sessionId: string
  readonly sharing: TerminalSharing
  readonly t: CodingNsTranslator
  readonly onDismiss: () => void
}

/** 复制保留完整选区，分享只把同一选区冻结为引用，菜单打开后不随新输出变化。 */
export function TerminalSelectionActions({ selection, view, sessionId, sharing, t, onDismiss }: Props): ReactElement | null {
  const [snapshot, setSnapshot] = useState<TerminalTextSnapshot>()
  const [error, setError] = useState('')
  const frozenSelection = useRef<TerminalSelectionActionsState>()
  const root = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  const display = snapshot === undefined ? selection : frozenSelection.current
  const close = (): void => { setSnapshot(undefined); setError(''); onDismiss() }
  useEffect(() => {
    if (snapshot !== undefined || selection === undefined) return
    const outside = (event: PointerEvent): void => { if (root.current === null || !event.composedPath().includes(root.current)) onDismiss() }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') onDismiss() }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true) }
  }, [onDismiss, selection, snapshot])
  if (display === undefined) return null
  const copy = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    try { await copyTextToClipboard(display.text); close() }
    catch (cause) { setError(messageOf(cause)) }
    finally { busyRef.current = false }
  }
  const share = (): void => {
    if (snapshot !== undefined) { close(); return }
    if (!sharing.isReady()) { setError(t('terminalShare.unavailable')); return }
    try { frozenSelection.current = display; setError(''); setSnapshot(sharing.capture(view, display.text)) }
    catch (cause) { setError(messageOf(cause)) }
  }
  return createPortal(createElement('div', { ref: root, className: terminalClass.selectionActions,
    style: { left: display.left, top: display.top }, role: 'toolbar', 'aria-label': t('terminalShare.selectionActions'),
    onPointerDown: (event: { preventDefault(): void; stopPropagation(): void }) => { event.preventDefault(); event.stopPropagation() },
  },
    createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => { void copy() } }, t('terminalShare.copy')),
    createElement(TerminalShareMenu, { sharing, snapshot, sessionId, t, align: 'start', onClose: close,
      anchor: createElement(Button, { variant: 'ghost', size: 'sm', onClick: share, 'aria-haspopup': 'menu', 'aria-expanded': snapshot !== undefined }, t('terminalShare.share')) }),
    error === '' ? null : createElement('span', { role: 'alert', className: terminalClass.selectionError }, error),
  ), document.body)
}

function messageOf(value: unknown): string { return value instanceof Error ? value.message : String(value) }

import { createElement, useEffect, useRef, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import xtermCss from '@xterm/xterm/css/xterm.css'
import { resolvePlusIcon } from '../../dsh-capabilities/client/primitives-adapter.js'
import type { CodingNsSettingsStore } from '../../dsh-capabilities/settings-store.js'
import {
  DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS,
  type CodingNsSettings,
  type TerminalAppearanceSettings,
} from '../../shared/contracts/config.js'
import { resolveCodingNsTranslator, type CodingNsTranslator } from '../locale.js'
import { stripTerminalDeviceAttributeResponses } from '../../shared/terminal-input.js'
import { debugInfo } from '../../shared/debug.js'
import type { CodingNsTerminalView, TerminalViewState } from './model.js'
import { terminalClass } from './styles.js'

const TERMINAL_TOUCH_MOMENTUM_GAIN = 2
const TERMINAL_TOUCH_MOMENTUM_MIN_LINES_PER_MS = 0.06
const TERMINAL_TOUCH_MOMENTUM_MAX_LINES_PER_MS = 0.9
const TERMINAL_TOUCH_MOMENTUM_FRICTION = 0.97
const TERMINAL_TOUCH_MOMENTUM_MAX_DURATION_MS = 3600
const TERMINAL_TOUCH_MOMENTUM_MAX_IDLE_FRAMES = 3
const TERMINAL_TOUCH_MOMENTUM_RELEASE_IDLE_MS = 100

export interface CodingNsXtermViewProps {
  readonly view: CodingNsTerminalView
  readonly settings: CodingNsSettingsStore<CodingNsSettings>
  readonly themeRevision: number
  readonly onNewTerminal: () => void
  /** 聚合页是否正在显示这个终端；隐藏时仍保持 attach 和 xterm 状态。 */
  readonly active?: boolean
  /** 外层 Sidebar 页签是否可见；不可见时释放整个终端页的 attach。 */
  readonly visible?: boolean
  /** 由 terminal/ui.ts 注入的翻译函数；缺省时退回内置中文词典（单测路径）。 */
  readonly t?: CodingNsTranslator
}

/** 使用与 DSH 内置终端相同的布局、状态条和 xterm 默认参数。 */
export function CodingNsXtermView({
  view,
  settings,
  themeRevision,
  onNewTerminal,
  active = true,
  visible = true,
  t: injectedTranslator,
}: CodingNsXtermViewProps): ReactElement {
  const t = injectedTranslator ?? resolveCodingNsTranslator()
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const scheduleReflowRef = useRef<(() => void) | null>(null)
  const lastRevision = useRef(0)
  const state = useSyncExternalStore(view.state.subscribe.bind(view.state), view.state.getSnapshot.bind(view.state))
  const settingsSnapshot = useSyncExternalStore(settings.subscribe.bind(settings), settings.getSnapshot.bind(settings))
  const appearance = settingsSnapshot.value?.terminalEnhancement.appearance
    ?? DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS.appearance
  const hasTerminal = state.info !== undefined

  // 聚合页切换标签时不卸载 CodingNsXtermView，保持 view.mount() 计数和 Host
  // follow attach。只有整个 Sidebar 页签不可见时才释放连接。
  useEffect(() => visible ? view.mount() : undefined, [view, visible])

  useEffect(() => {
    const host = hostRef.current
    if (host === null || !hasTerminal) return
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = shadowCss
    const container = document.createElement('div')
    container.className = 'codingns-xterm'
    root.replaceChildren(style, container)

    const terminal = new Terminal(terminalOptions(
      appearance,
      host,
      state.environment?.scrollback ?? 1000,
      !state.writable,
    ))
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminal.textarea?.setAttribute('aria-label', t('terminal.title'))
    terminalRef.current = terminal
    fitRef.current = fit
    lastRevision.current = 0
    // xterm 自己拥有 scrollable viewport。滚轮回调只能决定是否交给 xterm 继续处理：
    // 有历史时返回 true，交给原生 viewport；没有历史时返回 false，避免被解释为
    // shell 的上下方向键（例如切换历史命令）。
    const wheel = (event: WheelEvent): boolean => {
      if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return false
      const hasScrollback = terminal.buffer.active.baseY > 0
      if (!hasScrollback) {
        // 保持 xterm 在无回滚区时的默认行为（应用鼠标模式仍可接收滚轮）。
        return false
      }
      return true
    }
    terminal.attachCustomWheelEventHandler(wheel)
    const input = terminal.onData((data) => {
      // xterm 在重放 Host resident 的历史输出时会再次回答设备识别查询。
      // 这些 ESC[?...c/ESC[>...c 响应不应被重复送入 shell，否则 zsh 会把响应内容回显为
      // “1;2c0;276;0c”这类异常字符。其它键盘输入和光标查询保持原样。
      const inputData = stripTerminalDeviceAttributeResponses(data)
      if (inputData !== '') view.write(inputData)
    })
    let touchPoint: { x: number; y: number } | undefined
    let pendingTouchLines = 0
    let touchVelocityLinesPerMs = 0
    let touchMomentumRemainder = 0
    let touchMomentumFrame: number | undefined
    let touchMomentumEligible = false
    let lastTouchMoveAt = 0
    const stopTouchMomentum = (): void => {
      if (touchMomentumFrame !== undefined) {
        window.cancelAnimationFrame(touchMomentumFrame)
        touchMomentumFrame = undefined
      }
      touchMomentumRemainder = 0
    }
    const hasTerminalScrollback = (): boolean => {
      return terminal.buffer.active.baseY > 0 || terminal.buffer.active.viewportY > 0
    }
    const scrollTouchLines = (lines: number): boolean => {
      if (lines === 0 || !hasTerminalScrollback()) return false
      const previousViewportY = terminal.buffer.active.viewportY
      terminal.scrollLines(lines)
      return terminal.buffer.active.viewportY !== previousViewportY
    }
    const startTouchMomentum = (): void => {
      stopTouchMomentum()
      if (
        !touchMomentumEligible ||
        !hasTerminalScrollback() ||
        Math.abs(touchVelocityLinesPerMs) < TERMINAL_TOUCH_MOMENTUM_MIN_LINES_PER_MS
      ) {
        touchVelocityLinesPerMs = 0
        return
      }
      let lastFrameAt = performance.now()
      let elapsedTotalMs = 0
      let idleFrameCount = 0
      const step = (frameAt: number): void => {
        const elapsedMs = Math.max(1, frameAt - lastFrameAt)
        lastFrameAt = frameAt
        elapsedTotalMs += elapsedMs
        touchMomentumRemainder += touchVelocityLinesPerMs * elapsedMs
        const lines = truncateTowardZero(touchMomentumRemainder)
        if (lines !== 0) {
          idleFrameCount = 0
          touchMomentumRemainder -= lines
          if (!scrollTouchLines(lines)) {
            touchVelocityLinesPerMs = 0
            stopTouchMomentum()
            return
          }
        } else {
          idleFrameCount += 1
        }
        touchVelocityLinesPerMs *= Math.pow(TERMINAL_TOUCH_MOMENTUM_FRICTION, elapsedMs / 16)
        if (
          idleFrameCount >= TERMINAL_TOUCH_MOMENTUM_MAX_IDLE_FRAMES ||
          elapsedTotalMs >= TERMINAL_TOUCH_MOMENTUM_MAX_DURATION_MS ||
          Math.abs(touchVelocityLinesPerMs) < TERMINAL_TOUCH_MOMENTUM_MIN_LINES_PER_MS
        ) {
          touchVelocityLinesPerMs = 0
          stopTouchMomentum()
          return
        }
        touchMomentumFrame = window.requestAnimationFrame(step)
      }
      touchMomentumFrame = window.requestAnimationFrame(step)
    }
    const touchStart = (event: TouchEvent): void => {
      stopTouchMomentum()
      touchVelocityLinesPerMs = 0
      touchMomentumEligible = false
      pendingTouchLines = 0
      lastTouchMoveAt = performance.now()
      const touch = event.touches[0]
      touchPoint = touch === undefined ? undefined : { x: touch.clientX, y: touch.clientY }
    }
    const touchMove = (event: TouchEvent): void => {
      if (touchPoint === undefined || event.touches.length !== 1) return
      const touch = event.touches[0]
      if (touch === undefined) return
      const deltaX = touch.clientX - touchPoint.x
      const deltaY = touch.clientY - touchPoint.y
      touchPoint = { x: touch.clientX, y: touch.clientY }
      // 斜向手势优先交给外层页面，避免终端抢走横向切换动作。
      if (Math.abs(deltaY) <= Math.abs(deltaX)) return
      event.preventDefault()
      const now = performance.now()
      const elapsedMs = Math.max(1, now - lastTouchMoveAt)
      lastTouchMoveAt = now
      const lineHeight = Math.max(1, host.clientHeight / Math.max(1, terminal.rows))
      const deltaLines = -deltaY / lineHeight
      pendingTouchLines += deltaLines
      const lines = truncateTowardZero(pendingTouchLines)
      if (lines === 0) {
        // 位移还不足一整行时也更新速度；手指停住则立即清除旧速度，避免
        // 松手时沿上一次手势方向继续滚动。
        if (Math.abs(deltaY) < 0.5) {
          touchVelocityLinesPerMs = 0
          touchMomentumEligible = false
        } else {
          touchVelocityLinesPerMs = clampNumber(
            (deltaLines / elapsedMs) * TERMINAL_TOUCH_MOMENTUM_GAIN,
            -TERMINAL_TOUCH_MOMENTUM_MAX_LINES_PER_MS,
            TERMINAL_TOUCH_MOMENTUM_MAX_LINES_PER_MS,
          )
          touchMomentumEligible = hasTerminalScrollback()
        }
        return
      }
      pendingTouchLines -= lines
      const didScroll = scrollTouchLines(lines)
      if (didScroll) {
        const nextVelocity = clampNumber(
          (deltaLines / elapsedMs) * TERMINAL_TOUCH_MOMENTUM_GAIN,
          -TERMINAL_TOUCH_MOMENTUM_MAX_LINES_PER_MS,
          TERMINAL_TOUCH_MOMENTUM_MAX_LINES_PER_MS,
        )
        touchVelocityLinesPerMs = touchVelocityLinesPerMs === 0
          ? nextVelocity
          : touchVelocityLinesPerMs * 0.35 + nextVelocity * 0.65
        touchMomentumEligible = true
      } else {
        touchVelocityLinesPerMs = 0
        touchMomentumEligible = false
      }
    }
    const touchEnd = (): void => {
      touchPoint = undefined
      pendingTouchLines = 0
      // 释放前已经静止一段时间，说明用户是在按住后松手，不应复用旧速度。
      if (performance.now() - lastTouchMoveAt >= TERMINAL_TOUCH_MOMENTUM_RELEASE_IDLE_MS) {
        touchVelocityLinesPerMs = 0
        touchMomentumEligible = false
      }
      startTouchMomentum()
    }
    const touchCancel = (): void => {
      touchPoint = undefined
      pendingTouchLines = 0
      touchVelocityLinesPerMs = 0
      touchMomentumEligible = false
      stopTouchMomentum()
    }
    const xtermRoot = terminal.element
    if (xtermRoot === undefined) return
    const viewport = xtermRoot?.querySelector<HTMLElement>('.xterm-viewport')
    const scrollTarget = viewport ?? xtermRoot ?? container
    const interactionTarget = xtermRoot ?? container
    const syncScrollbar = (): void => {
      const hasScrollback = terminal.buffer.active.baseY > 0
      xtermRoot.dataset.codingnsScrollback = hasScrollback ? 'true' : 'false'
      debugInfo('codingns4dsh: client terminal scrollbar state', {
        terminalId: view.id,
        hasScrollback,
        baseY: terminal.buffer.active.baseY,
        viewportY: terminal.buffer.active.viewportY,
      })
    }
    syncScrollbar()
    scrollTarget.style.touchAction = 'pan-y'
    scrollTarget.style.overscrollBehavior = 'contain'
    if ('webkitOverflowScrolling' in scrollTarget.style) {
      scrollTarget.style.webkitOverflowScrolling = 'touch'
    }
    interactionTarget.addEventListener('touchstart', touchStart, { passive: true })
    interactionTarget.addEventListener('touchmove', touchMove, { passive: false })
    interactionTarget.addEventListener('touchend', touchEnd, { passive: true })
    interactionTarget.addEventListener('touchcancel', touchCancel, { passive: true })
    const scroll = terminal.onScroll((viewportY) => {
      syncScrollbar()
      debugInfo('codingns4dsh: client terminal viewport scroll', {
        terminalId: view.id,
        viewportY,
        baseY: terminal.buffer.active.baseY,
      })
    })
    // 调试终端由 Host 预设“配置名(终端类型)”标题；Shell 启动时通常会发一个 zsh 等默认标题，不能覆盖它。
    const preserveHostTitle = state.info !== undefined && state.info.title !== state.info.shell.name
    const title = terminal.onTitleChange((value) => {
      if (!preserveHostTitle) void view.rename(value)
    })
    const measure = (): void => {
      // 显示层即使在 connecting/read-only 阶段也必须跟随容器尺寸；否则
      // ResizeObserver 会捕获首次 render 的 writable=false，后续移动端布局
      // 变化永远不会触发历史行重排。view.resize 内部仍会按权限决定是否下发 PTY。
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      fitTerminal(terminal, fit, view)
      syncScrollbar()
    }
    let measureFrame: number | undefined
    const scheduleMeasure = (): void => {
      if (measureFrame !== undefined) return
      measureFrame = window.requestAnimationFrame(() => {
        measureFrame = undefined
        measure()
      })
    }
    let reflowTimer: number | undefined
    let reflowFrame: number | undefined
    const schedulePostAttachReflow = (): void => {
      // xterm 的字符尺寸、移动端字体和 Sidebar 宽度可能在首帧之后才稳定。
      // 只在 snapshot 写入回调里 fit 一次会留下旧 scrollback 的宽度，随后每行
      // 看起来都向右漂移。连续安排两帧和一个短延迟，覆盖字体与容器的最终布局。
      scheduleMeasure()
      if (reflowFrame !== undefined) window.cancelAnimationFrame(reflowFrame)
      reflowFrame = window.requestAnimationFrame(() => {
        reflowFrame = undefined
        scheduleMeasure()
      })
      if (reflowTimer !== undefined) window.clearTimeout(reflowTimer)
      reflowTimer = window.setTimeout(() => {
        reflowTimer = undefined
        scheduleMeasure()
      }, 240)
    }
    scheduleReflowRef.current = schedulePostAttachReflow
    const resize = new ResizeObserver(scheduleMeasure)
    resize.observe(host)
    resize.observe(container)
    const visualViewport = window.visualViewport
    const handleViewportResize = (): void => schedulePostAttachReflow()
    visualViewport?.addEventListener('resize', handleViewportResize)
    window.addEventListener('resize', handleViewportResize)
    schedulePostAttachReflow()

    return () => {
      resize.disconnect()
      visualViewport?.removeEventListener('resize', handleViewportResize)
      window.removeEventListener('resize', handleViewportResize)
      if (measureFrame !== undefined) window.cancelAnimationFrame(measureFrame)
      if (reflowFrame !== undefined) window.cancelAnimationFrame(reflowFrame)
      if (reflowTimer !== undefined) window.clearTimeout(reflowTimer)
      scheduleReflowRef.current = null
      input.dispose()
      scroll.dispose()
      interactionTarget.removeEventListener('touchstart', touchStart)
      interactionTarget.removeEventListener('touchmove', touchMove)
      interactionTarget.removeEventListener('touchend', touchEnd)
      interactionTarget.removeEventListener('touchcancel', touchCancel)
      stopTouchMomentum()
      title.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
      root.replaceChildren()
    }
  }, [hasTerminal, view])

  useEffect(() => {
    const terminal = terminalRef.current
    const host = hostRef.current
    if (terminal === null || host === null) return
    applyAppearance(terminal, appearance, host, state.environment?.scrollback ?? 1000)
    terminal.options.disableStdin = !state.writable
    if (state.writable && host.clientWidth > 0 && host.clientHeight > 0) {
      fitTerminal(terminal, fitRef.current, view)
      terminal.focus()
    } else if (state.info !== undefined) {
      terminal.resize(state.info.cols, state.info.rows)
    }
  }, [
    active,
    appearance,
    state.environment?.scrollback,
    state.info?.cols,
    state.info?.rows,
    state.writable,
    themeRevision,
    view,
  ])

  useEffect(() => {
    const terminal = terminalRef.current
    const host = hostRef.current
    const render = state.render
    if (terminal === null || render === undefined || render.revision <= lastRevision.current) return
    lastRevision.current = render.revision
    const isSnapshot = render.frame.type === 'snapshot'
    if (isSnapshot) {
      terminal.reset()
      terminal.resize(render.frame.info.cols, render.frame.info.rows)
    }
    const data = render.frame.type === 'snapshot'
      ? normalizeTerminalSnapshot(render.frame.screen)
      : render.frame.data
    terminal.write(data, () => {
      // 快照中的尺寸来自 Host 上次记录，可能仍是桌面端列数。等完整历史写入
      // 后再按当前 DOM 宽度 fit 一次，xterm 才会对整个 scrollback 执行重排；
      // 否则只有后续新增的当前行会按移动端宽度换行。
      if (isSnapshot && host !== null && host.clientWidth > 0 && host.clientHeight > 0) {
        fitTerminal(terminal, fitRef.current, view)
        scheduleReflowRef.current?.()
      }
      if (terminal.element !== undefined) terminal.element.dataset.codingnsScrollback = terminal.buffer.active.baseY > 0 ? 'true' : 'false'
      const viewport = terminal.element?.querySelector<HTMLElement>('.xterm-viewport')
      debugInfo('codingns4dsh: client terminal frame rendered', {
        terminalId: view.id,
        frameType: render.frame.type,
        characters: data.length,
        rows: terminal.rows,
        bufferLength: terminal.buffer.active.length,
        baseY: terminal.buffer.active.baseY,
        viewportY: terminal.buffer.active.viewportY,
        viewportScrollHeight: viewport?.scrollHeight ?? null,
        viewportClientHeight: viewport?.clientHeight ?? null,
      })
      view.acknowledge(render.revision)
    })
  }, [state.render, view])

  return createElement('section', {
    className: terminalClass.root,
    'data-sidebar-terminal': true,
    'data-terminal-active': active ? 'true' : 'false',
    'aria-hidden': active ? undefined : true,
    style: active ? undefined : { display: 'none' },
  },
  createElement(TerminalStatus, { state, view, onNewTerminal, t }),
  hasTerminal ? createElement('div', { className: terminalClass.screen },
    createElement('div', { ref: hostRef, style: terminalHostStyle }),
  ) : null,
  state.error === undefined || state.phase === 'disconnected' || state.info?.state === 'lost'
    ? null
    : createElement('p', { className: terminalClass.error, role: 'alert' }, t('terminalView.errorDetail', { message: state.error })),
  )
}

function TerminalStatus({
  state,
  view,
  onNewTerminal,
  t,
}: {
  readonly state: TerminalViewState
  readonly view: CodingNsTerminalView
  readonly onNewTerminal: () => void
  readonly t: CodingNsTranslator
}): ReactElement | null {
  const status = statusText(state, t)
  const ended = state.info?.state === 'exited' || state.phase === 'closed'
  // 运行时丢失是终态：重连只会重复失败，这里给"重建终端"而不是"重新连接"。
  const lost = state.info?.state === 'lost'
  const retry = !ended && !lost && (state.phase === 'failed' || state.phase === 'disconnected')
  const readOnly = state.phase === 'connected' && state.info?.state === 'running' && !state.writable
  if (status === undefined && !retry && !readOnly && !lost) return null
  return createElement('div', { className: terminalClass.status, role: 'status' },
    status,
    readOnly ? t('terminalView.readOnly') : null,
    retry ? createElement(Button, {
      variant: 'outline',
      size: 'sm',
      // 状态条上的重试是用户显式要求的恢复动作，必须放弃可能已经变成僵尸的
      // 保活连接；否则 refresh() 会直接复用旧 follow，按钮看起来没有反应。
      onClick: () => { void view.refresh({ force: true }) },
    }, state.phase === 'disconnected' ? t('terminalView.reconnect') : t('terminal.retry')) : null,
    lost ? createElement(Button, {
      variant: 'outline',
      size: 'sm',
      onClick: () => { void view.rebuild() },
    }, t('terminalView.rebuild')) : null,
    ended || lost ? createElement(Button, {
      variant: 'primary',
      size: 'sm',
      icon: createElement(resolvePlusIcon()),
      onClick: onNewTerminal,
    }, t('terminal.new')) : null,
  )
}

function statusText(state: TerminalViewState, t: CodingNsTranslator): string | undefined {
  if (state.phase === 'idle' || state.phase === 'loading') return t('terminalView.readingEnvironment')
  if (state.phase === 'creating') return t('terminalView.starting')
  if (state.phase === 'connecting') return t('terminalView.connecting')
  if (state.info?.state === 'lost') return t('terminalView.lost')
  if (state.phase === 'disconnected') return t('terminalView.disconnected')
  if (state.info?.state === 'exited') return t('terminalView.exited', { exitCode: state.info.exitCode ?? '—' })
  if (state.info?.state === 'failed') return t('terminalView.unavailable')
  if (state.phase === 'closed') return t('terminalView.closed')
  return undefined
}

interface ResolvedTerminalOptions {
  readonly allowProposedApi: boolean
  readonly convertEol: boolean
  readonly disableStdin: boolean
  readonly minimumContrastRatio: number
  readonly fontFamily: string
  readonly fontSize: number
  readonly lineHeight: number
  readonly cursorStyle: 'block' | 'underline' | 'bar'
  readonly cursorBlink: boolean
  readonly reflowCursorLine: boolean
  readonly scrollback: number
  readonly theme: ITheme
}

function terminalOptions(
  appearance: TerminalAppearanceSettings,
  host: HTMLElement,
  scrollback: number,
  disableStdin: boolean,
): ResolvedTerminalOptions {
  const computed = getComputedStyle(host)
  return {
    allowProposedApi: false,
    convertEol: false,
    disableStdin,
    minimumContrastRatio: 4.5,
    fontFamily: appearance.fontFamily ?? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: appearance.fontSize ?? 13,
    lineHeight: appearance.lineHeight ?? 1,
    cursorStyle: appearance.cursorStyle ?? 'block',
    cursorBlink: appearance.cursorBlink ?? true,
    reflowCursorLine: true,
    scrollback: appearance.scrollback ?? scrollback,
    theme: terminalTheme(appearance, computed),
  }
}

function applyAppearance(
  terminal: Terminal,
  appearance: TerminalAppearanceSettings,
  host: HTMLElement,
  scrollback: number,
): void {
  const next = terminalOptions(appearance, host, scrollback, terminal.options.disableStdin ?? false)
  terminal.options.fontFamily = next.fontFamily
  terminal.options.fontSize = next.fontSize
  terminal.options.lineHeight = next.lineHeight
  terminal.options.cursorStyle = next.cursorStyle
  terminal.options.cursorBlink = next.cursorBlink
  terminal.options.reflowCursorLine = next.reflowCursorLine
  terminal.options.scrollback = next.scrollback
  terminal.options.minimumContrastRatio = next.minimumContrastRatio
  terminal.options.theme = next.theme
}

function terminalTheme(appearance: TerminalAppearanceSettings, computed: CSSStyleDeclaration): ITheme {
  const custom = appearance.theme === 'custom'
  const background = custom
    ? appearance.background ?? '#111111'
    : visibleColor(computed.backgroundColor, '#111111')
  const foreground = custom
    ? appearance.foreground ?? '#f3f3f3'
    : visibleColor(computed.color, '#f3f3f3')
  const cursor = custom
    ? appearance.cursorColor ?? foreground
    : foreground
  return {
    background,
    foreground,
    cursor,
    cursorAccent: background,
    selectionBackground: foreground,
    selectionForeground: background,
    selectionInactiveBackground: foreground,
  }
}

function fitTerminal(terminal: Terminal, fit: FitAddon | null, view: CodingNsTerminalView): void {
  if (fit === null) return
  const dimensions = resolveTerminalDimensions(terminal, fit)
  if (dimensions === undefined) return
  // 直接使用当前 xterm 根节点的实际宽高。FitAddon 只读取 parentElement 的
  // computed width，在移动端虚拟键盘动画期间可能仍是旧值，导致 screen 保留
  // 桌面列数，底部一屏出现越来越大的右侧空白。
  if (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows) {
    terminal.resize(dimensions.cols, dimensions.rows)
  }
  view.resize(terminal.cols, terminal.rows)
}

function resolveTerminalDimensions(terminal: Terminal, fit: FitAddon): { cols: number; rows: number } | undefined {
  const fallback = fit.proposeDimensions()
  const root = terminal.element
  if (root === undefined || root.clientWidth <= 0 || root.clientHeight <= 0) return fallback
  const measure = root.querySelector<HTMLElement>('.xterm-char-measure-element')
  const row = root.querySelector<HTMLElement>('.xterm-rows > div')
  const measureWidth = measure?.getBoundingClientRect().width ?? 0
  const cellWidth = measureWidth > 0 ? measureWidth / 32 : 0
  const cellHeight = row?.getBoundingClientRect().height ?? 0
  const computed = getComputedStyle(root)
  const paddingX = parseCssPixels(computed.paddingLeft) + parseCssPixels(computed.paddingRight)
  const paddingY = parseCssPixels(computed.paddingTop) + parseCssPixels(computed.paddingBottom)
  const width = root.clientWidth - paddingX - (terminal.options.scrollback === 0 ? 0 : 14)
  const height = root.clientHeight - paddingY
  if (cellWidth <= 0 || cellHeight <= 0 || width <= 0 || height <= 0) return fallback
  return {
    cols: Math.max(2, Math.floor(width / cellWidth)),
    rows: Math.max(1, Math.floor(height / cellHeight)),
  }
}

function parseCssPixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * tmux capture-pane 输出的是纯文本行，行尾通常只有 LF。
 * xterm 当前关闭 convertEol 以兼容真实 PTY，因此快照必须显式补 CR；
 * 否则 LF 只移动到下一行而保留当前列，历史记录会逐行向右漂移。
 */
function normalizeTerminalSnapshot(value: string): string {
  return value.replace(/\r?\n/gu, '\r\n')
}

function truncateTowardZero(value: number): number {
  return value < 0 ? Math.ceil(value) : Math.floor(value)
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function visibleColor(value: string, fallback: string): string {
  const normalized = value.trim()
  return normalized === '' || normalized === 'rgba(0, 0, 0, 0)' ? fallback : normalized
}

const terminalHostStyle = {
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-base)',
} as const

const shadowCss = `${xtermCss}
:host{display:block;width:100%;height:100%;min-width:0;min-height:0;color:inherit;background:inherit}
.codingns-xterm{width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;touch-action:pan-y;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.xterm{width:100%;height:100%;min-width:0;min-height:0}
.xterm-scrollable-element{min-width:0;max-width:100%}
.xterm-viewport{background:var(--dsw-alias-bg-base);touch-action:pan-y;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;overflow-y:scroll;scrollbar-gutter:stable;scrollbar-width:auto;scrollbar-color:var(--dsw-alias-label-tertiary,#777) transparent}
.xterm-viewport::-webkit-scrollbar{width:10px}
.xterm-viewport::-webkit-scrollbar-track{background:transparent}
.xterm-viewport::-webkit-scrollbar-thumb{background:var(--dsw-alias-label-tertiary,#777);border-radius:5px}
.xterm-viewport::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-secondary,#aaa)}
.xterm .xterm-scrollable-element>.scrollbar.vertical{width:14px!important;pointer-events:auto!important}
.xterm[data-codingns-scrollback="false"] .xterm-scrollable-element>.scrollbar.vertical{opacity:0!important;pointer-events:none!important}
.xterm[data-codingns-scrollback="true"] .xterm-scrollable-element>.scrollbar.vertical{opacity:1!important;pointer-events:auto!important;background:rgba(128,128,128,.22)}
.xterm[data-codingns-scrollback="true"] .xterm-scrollable-element>.scrollbar.vertical>.slider{background:var(--dsw-alias-label-secondary,#aaa)!important;border-radius:7px;min-height:24px}
.xterm .xterm-scrollable-element>.scrollbar.horizontal{display:none!important}
`

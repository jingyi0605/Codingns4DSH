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
import { TerminalSurfaceCache } from './surface-cache.js'

interface TerminalSurface {
  readonly host: HTMLDivElement
  readonly terminal: Terminal
  readonly fit: FitAddon
  readonly scheduleReflow: () => void
  lastRevision: number
  owner?: HTMLDivElement
  dispose(): void
}

/** 每个工作区终端只有一块屏幕，切换会话时移动 DOM，保留缓冲区、光标与滚动位置。 */
const surfaces = new TerminalSurfaceCache<TerminalSurface>()

const TERMINAL_TOUCH_MOMENTUM_GAIN = 2
const TERMINAL_TOUCH_MOMENTUM_MIN_LINES_PER_MS = 0.06
const TERMINAL_TOUCH_MOMENTUM_MAX_LINES_PER_MS = 0.9
const TERMINAL_TOUCH_MOMENTUM_FRICTION = 0.97
const TERMINAL_TOUCH_MOMENTUM_MAX_DURATION_MS = 3600
const TERMINAL_TOUCH_MOMENTUM_MAX_IDLE_FRAMES = 3
const TERMINAL_TOUCH_MOMENTUM_RELEASE_IDLE_MS = 100
/** 视图夺回终端尺寸的最小间隔，避免可见性抖动时反复重发。 */
const TERMINAL_SIZE_CLAIM_INTERVAL_MS = 1000
/** 终端文本与可视容器边缘之间至少保留 5px 的安全距离。 */
const TERMINAL_CONTENT_EDGE_GAP = 5
/** 终端滚动条停止滚动后的自动隐藏延迟。 */
const TERMINAL_SCROLLBAR_HIDE_DELAY_MS = 3000

export interface CodingNsXtermViewProps {
  readonly view: CodingNsTerminalView
  readonly settings: CodingNsSettingsStore<CodingNsSettings>
  readonly themeRevision: number
  readonly onNewTerminal: () => void
  readonly sessionId?: string
  /** 聚合页是否正在显示这个终端；隐藏时仍保持 attach 和 xterm 状态。 */
  readonly active?: boolean
  /** 外层 Sidebar 页签是否可见；不可见时隐藏屏幕，连接和输出消费保持常驻。 */
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
  sessionId = view.sessionId,
  active = true,
  visible = true,
  t: injectedTranslator,
}: CodingNsXtermViewProps): ReactElement {
  const t = injectedTranslator ?? resolveCodingNsTranslator()
  const hostRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<TerminalSurface | null>(null)
  const sizeClaimAtRef = useRef(0)
  const previousActiveRef = useRef(false)
  const state = useSyncExternalStore(view.state.subscribe.bind(view.state), view.state.getSnapshot.bind(view.state))
  const settingsSnapshot = useSyncExternalStore(settings.subscribe.bind(settings), settings.getSnapshot.bind(settings))
  const appearance = settingsSnapshot.value?.terminalEnhancement.appearance
    ?? DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS.appearance
  const hasTerminal = state.info !== undefined

  // 兼容尚未取得库存的首次打开；屏幕建好后由屏幕接管唯一的常驻挂载引用。
  useEffect(() => visible && !hasTerminal ? view.mount() : undefined, [hasTerminal, view, visible])

  useEffect(() => {
    const target = hostRef.current
    if (target === null || !hasTerminal || !visible || view.signal.aborted) return
    // 仅可见卡片更新调用上下文；后台卡片不能把共享模型切回旧会话。
    view.sessionId = sessionId
    const surface = surfaces.get(view, () => createTerminalSurface(target, view, appearance, t))
    surfaceRef.current = surface
    surface.owner = target
    target.replaceChildren(surface.host)
    surface.scheduleReflow()
    return () => {
      surfaceRef.current = null
      // 会话切换可能先挂载新卡片再清理旧卡片，旧卡片不得拆走新卡片的屏幕。
      if (surface.owner !== target) return
      surface.host.remove()
      delete surface.owner
    }
  }, [hasTerminal, sessionId, view, visible])

  useEffect(() => {
    const becameActive = active && visible && !previousActiveRef.current
    previousActiveRef.current = active && visible
    const surface = surfaceRef.current
    if (surface === null || !active || !visible) return
    const { terminal, host, fit } = surface
    applyAppearance(terminal, appearance, host, state.environment?.scrollback ?? 1000)
    terminal.options.disableStdin = !state.writable
    // 聚合页切换到一个原本隐藏的终端时，虚拟键盘可能已经打开且不会再次派发
    // visualViewport 事件；切换完成后立即按当前可视高度裁剪一次。
    if (active) syncTerminalViewport(host)
    if (state.writable && host.clientWidth > 0 && host.clientHeight > 0) {
      // 视图刚变为激活时把 tmux 窗口尺寸抢回本视图：Host 记录的尺寸可能已被其它
      // 客户端或本视图更早的宽度改写，历史行会按旧宽度排版，内容超出容器被裁剪
      // 或右侧留白。只在激活边沿触发（不响应 Host 尺寸变化本身），避免多个
      // 客户端看到对方尺寸后互相夺回。
      const now = Date.now()
      const claim = becameActive && now - sizeClaimAtRef.current >= TERMINAL_SIZE_CLAIM_INTERVAL_MS
      if (claim) sizeClaimAtRef.current = now
      fitTerminal(terminal, fit, view, claim ? { force: true } : undefined)
      terminal.focus()
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
    visible,
  ])

  useEffect(() => {
    if (!active || !visible || !hasTerminal) return
    // 页面从后台回到前台（移动端切回、窗口重新聚焦）时，Host 尺寸可能已被其它
    // 客户端改写；回到前台的视图重发一次自己的 fit 尺寸，把 tmux 抢回本视图。
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
      const surface = surfaceRef.current
      if (surface === null) return
      const { terminal, host, fit } = surface
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      const now = Date.now()
      if (now - sizeClaimAtRef.current < TERMINAL_SIZE_CLAIM_INTERVAL_MS) return
      sizeClaimAtRef.current = now
      fitTerminal(terminal, fit, view, { force: true })
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [active, hasTerminal, view, visible])

  return createElement('section', {
    className: terminalClass.root,
    'data-sidebar-terminal': true,
    'data-terminal-active': active ? 'true' : 'false',
    'aria-hidden': active ? undefined : true,
    style: active ? undefined : { display: 'none' },
  },
  createElement(TerminalStatus, { state, view, onNewTerminal, t }),
  hasTerminal ? createElement('div', { className: terminalClass.screen },
    createElement('div', { ref: hostRef, style: { width: '100%', height: '100%' } }),
  ) : null,
  state.error === undefined || state.phase === 'disconnected' || state.info?.state === 'lost'
    ? null
    : createElement('p', { className: terminalClass.error, role: 'alert' }, t('terminalView.errorDetail', { message: state.error })),
  )
}

/** 创建一次常驻屏幕；事件、输出消费和连接只在终端模型销毁时释放。 */
function createTerminalSurface(
  target: HTMLDivElement,
  view: CodingNsTerminalView,
  appearance: TerminalAppearanceSettings,
  t: CodingNsTranslator,
): TerminalSurface {
  const state = view.state.getSnapshot()
  const host = document.createElement('div')
  // DOM 样式赋值不会像 React 一样自动给数字补 px。
  Object.assign(host.style, terminalHostStyle, {
    paddingLeft: `${terminalHostStyle.paddingLeft}px`,
    paddingRight: `${terminalHostStyle.paddingRight}px`,
  })
  target.replaceChildren(host)
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
  // xterm 自己拥有自绘 scrollable viewport。滚轮回调只能决定是否交给 xterm 继续处理：
  // 有历史时返回 true，交给 xterm 的滚动容器；没有历史时返回 false，避免被解释为
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
  const xtermRoot = terminal.element!
  // xterm 6 使用 .xterm-scrollable-element 的自绘滚动条；.xterm-viewport
  // 只是兼容节点，不能再把触摸事件和可用宽度交给它。
  const scrollTarget = xtermRoot?.querySelector<HTMLElement>('.xterm-scrollable-element') ?? xtermRoot ?? container
  const interactionTarget = xtermRoot ?? container
  let scrollbarHideTimer: number | undefined
  let lastViewportY = terminal.buffer.active.viewportY
  const hideScrollbar = (): void => {
    if (scrollbarHideTimer !== undefined) {
      window.clearTimeout(scrollbarHideTimer)
      scrollbarHideTimer = undefined
    }
    xtermRoot.dataset.codingnsScrollbar = 'hidden'
  }
  const revealScrollbar = (): void => {
    if (terminal.buffer.active.baseY <= 0) {
      hideScrollbar()
      return
    }
    xtermRoot.dataset.codingnsScrollbar = 'visible'
    if (scrollbarHideTimer !== undefined) window.clearTimeout(scrollbarHideTimer)
    scrollbarHideTimer = window.setTimeout(() => {
      scrollbarHideTimer = undefined
      xtermRoot.dataset.codingnsScrollbar = 'hidden'
    }, TERMINAL_SCROLLBAR_HIDE_DELAY_MS)
  }
  const syncScrollbarState = (): void => {
    const hasScrollback = terminal.buffer.active.baseY > 0
    xtermRoot.dataset.codingnsScrollback = hasScrollback ? 'true' : 'false'
    if (!hasScrollback) hideScrollbar()
    else if (xtermRoot.dataset.codingnsScrollbar === undefined) xtermRoot.dataset.codingnsScrollbar = 'hidden'
    debugInfo('codingns4dsh: client terminal scrollbar state', {
      terminalId: view.id,
      hasScrollback,
      baseY: terminal.buffer.active.baseY,
      viewportY: terminal.buffer.active.viewportY,
    })
  }
  syncScrollbarState()
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
    const didScroll = viewportY !== lastViewportY
    lastViewportY = viewportY
    syncScrollbarState()
    if (didScroll) revealScrollbar()
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
    // 手机虚拟键盘通常只收缩 visualViewport，不会改变 DSH 外层布局视口。
    // 先把 xterm 宿主裁到可视视口底边，再计算行列，避免最后几行和光标落到键盘下面。
    syncTerminalViewport(host)
    // 显示层即使在 connecting/read-only 阶段也必须跟随容器尺寸；否则
    // ResizeObserver 会捕获首次 render 的 writable=false，后续移动端布局
    // 变化永远不会触发历史行重排。view.resize 内部仍会按权限决定是否下发 PTY。
    if (host.clientWidth === 0 || host.clientHeight === 0) return
    fitTerminal(terminal, fit, view)
    syncScrollbarState()
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
  const resize = new ResizeObserver(scheduleMeasure)
  resize.observe(host)
  resize.observe(container)
  const visualViewport = window.visualViewport
  const handleViewportChange = (): void => schedulePostAttachReflow()
  visualViewport?.addEventListener('resize', handleViewportChange)
  // iOS 在弹出键盘时可能先滚动 visual viewport，再触发 resize；两个事件都要处理，
  // 否则页面被浏览器上移后，光标仍可能被键盘边缘遮住。
  visualViewport?.addEventListener('scroll', handleViewportChange)
  window.addEventListener('resize', handleViewportChange)
  schedulePostAttachReflow()

  const retained: TerminalSurface = { host, terminal, fit, scheduleReflow: schedulePostAttachReflow, lastRevision: 0, dispose: () => {
    releaseState()
    releaseMount()
    resize.disconnect()
    visualViewport?.removeEventListener('resize', handleViewportChange)
    visualViewport?.removeEventListener('scroll', handleViewportChange)
    window.removeEventListener('resize', handleViewportChange)
    if (measureFrame !== undefined) window.cancelAnimationFrame(measureFrame)
    if (reflowFrame !== undefined) window.cancelAnimationFrame(reflowFrame)
    if (reflowTimer !== undefined) window.clearTimeout(reflowTimer)
    if (scrollbarHideTimer !== undefined) window.clearTimeout(scrollbarHideTimer)
    input.dispose()
    scroll.dispose()
    interactionTarget.removeEventListener('touchstart', touchStart)
    interactionTarget.removeEventListener('touchmove', touchMove)
    interactionTarget.removeEventListener('touchend', touchEnd)
    interactionTarget.removeEventListener('touchcancel', touchCancel)
    stopTouchMomentum()
    title.dispose()
    terminal.dispose()
    host.remove()
    root.replaceChildren()
  } }
  // 输出消费跟随屏幕生命周期，隐藏或跨会话移动时继续写入同一缓冲区。
  const releaseState = view.state.subscribe(() => renderTerminalSurface(retained, view))
  const releaseMount = view.mount()
  renderTerminalSurface(retained, view)
  return retained
}

/** 每帧只写入工作区共享屏幕一次，不依赖任何会话卡片的 React 渲染或可见性。 */
function renderTerminalSurface(surface: TerminalSurface, view: CodingNsTerminalView): void {
  const { terminal, host, fit } = surface
  const state = view.state.getSnapshot()
  terminal.options.disableStdin = !state.writable
  const render = state.render
  if (render === undefined || render.revision <= surface.lastRevision) return
  surface.lastRevision = render.revision
  const isSnapshot = render.frame.type === 'snapshot'
  if (isSnapshot) {
    terminal.reset()
    terminal.resize(render.frame.info.cols, render.frame.info.rows)
  }
  const data = render.frame.type === 'snapshot'
    ? normalizeTerminalSnapshot(render.frame.screen)
    : render.frame.data
  terminal.write(data, () => {
    // 首次快照和真实尺寸变化仍需重排历史；移动已存在的屏幕不产生新快照。
    if (isSnapshot && host.clientWidth > 0 && host.clientHeight > 0) {
      fitTerminal(terminal, fit, view)
      surface.scheduleReflow()
    }
    if (terminal.element !== undefined) {
      const hasScrollback = terminal.buffer.active.baseY > 0
      terminal.element.dataset.codingnsScrollback = hasScrollback ? 'true' : 'false'
      if (!hasScrollback) terminal.element.dataset.codingnsScrollbar = 'hidden'
    }
    const viewport = terminal.element?.querySelector<HTMLElement>('.xterm-scrollable-element')
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

function fitTerminal(
  terminal: Terminal,
  fit: FitAddon | null,
  view: CodingNsTerminalView,
  options?: { readonly force?: boolean },
): void {
  if (fit === null) return
  const dimensions = resolveTerminalDimensions(terminal, fit)
  if (dimensions === undefined) return
  // 直接使用当前 xterm 根节点的实际宽高。FitAddon 只读取 parentElement 的
  // computed width，在移动端虚拟键盘动画期间可能仍是旧值，导致 screen 保留
  // 桌面列数，底部一屏出现越来越大的右侧空白。
  if (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows) {
    terminal.resize(dimensions.cols, dimensions.rows)
  }
  view.resize(terminal.cols, terminal.rows, options)
}

/**
 * 让终端宿主节点的底边停在当前可视视口之内。
 *
 * 移动端软键盘出现时，布局视口通常仍保持原高度，只有 `visualViewport.height`
 * 变小。只调用 FitAddon 不够，因为它读取到的父节点高度没有变化；这里按屏幕
 * 实际可见底边收缩宿主，键盘收起后再恢复 `100%`。
 */
function syncTerminalViewport(host: HTMLElement): void {
  const screen = host.parentElement
  if (screen === null) return
  const hostRect = host.getBoundingClientRect()
  const screenRect = screen.getBoundingClientRect()
  if (screenRect.width <= 0 || screenRect.height <= 0 || hostRect.width <= 0) return

  const screenStyle = getComputedStyle(screen)
  const contentBottom = screenRect.bottom
    - parseCssPixels(screenStyle.paddingBottom)
    - parseCssPixels(screenStyle.borderBottomWidth)
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight
  if (!Number.isFinite(contentBottom) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return

  const visibleBottom = Math.min(contentBottom, viewportHeight)
  const normalHeight = Math.max(1, Math.floor(contentBottom - hostRect.top))
  if (visibleBottom >= contentBottom - 1) {
    if (host.style.height !== '100%') host.style.height = '100%'
    return
  }

  // 留出 1px，避免浮点数和键盘动画期间的边界抖动把最后一行裁掉。
  const visibleHeight = Math.max(1, Math.floor(visibleBottom - hostRect.top - 1))
  const nextHeight = `${Math.min(normalHeight, visibleHeight)}px`
  if (host.style.height !== nextHeight) host.style.height = nextHeight
}

function resolveTerminalDimensions(terminal: Terminal, fit: FitAddon): { cols: number; rows: number } | undefined {
  const fallback = fit.proposeDimensions()
  const root = terminal.element
  if (root === undefined || root.clientWidth <= 0 || root.clientHeight <= 0) return fallback
  const cell = resolveRendererCell(terminal)
  if (cell === undefined) {
    // 首帧还没有渲染器尺寸时只能使用 FitAddon 的结果；舍弃一列，
    // 让宿主自身的左右内边距负责最后的可视安全区。
    return fallback === undefined
      ? undefined
      : { ...fallback, cols: Math.max(2, fallback.cols - 1) }
  }
  // 宿主元素（host）有 paddingLeft: 8, paddingRight: 8，但 root 是 terminal.element（.xterm），
  // 它的 padding 为 0。由于此函数只接收 terminal 对象而不是 host，无法直接读取宿主 padding，
  // 因此硬编码宿主 padding 值（与 terminalHostStyle 保持一致）。
  const HOST_PADDING_LEFT = 8
  const HOST_PADDING_RIGHT = 8
  const computed = getComputedStyle(root)
  const paddingY = parseCssPixels(computed.paddingTop) + parseCssPixels(computed.paddingBottom)
  // xterm 6 的滚动条是 xterm-scrollable-element 里的绝对定位节点。
  // 不能用固定的 14px 或 root.clientWidth 猜它的槽位：父容器可能有小数宽度，
  // 主题也可能改变滚动条宽度。直接以滚动条左边界作为文本的硬截止线，才能保证
  // 列数和实际可见区域使用同一套坐标。
  const rootRect = root.getBoundingClientRect()
  const scrollable = root.querySelector<HTMLElement>('.xterm-scrollable-element')
  const scrollbar = terminal.options.scrollback === 0
    ? undefined
    : scrollable?.querySelector<HTMLElement>('.scrollbar.vertical')
  const scrollbarRect = scrollbar?.getBoundingClientRect()
  const scrollableRect = scrollable?.getBoundingClientRect()
  // 宿主已经通过 border-box 保留左右 8px；滚动条槽位（宽度+右边距）由 xterm 管理。
  // 计算文字可用宽度时，从容器右边界扣除滚动条占用空间和安全边距，确保文字不会
  // 贴到滚动条或容器边缘。滚动条存在时优先以其左边界为截止线，避免文字与滚动条重叠。
  const scrollbarInset = scrollbarRect !== undefined && scrollbarRect.width > 0
    ? Math.max(0, rootRect.right - scrollbarRect.left)
    : 0
  const safeEdgeGap = Math.max(0, TERMINAL_CONTENT_EDGE_GAP - scrollbarInset)
  // 从容器总宽度中扣除宿主 padding、滚动条槽位和右侧安全距离
  const width = rootRect.width - HOST_PADDING_LEFT - HOST_PADDING_RIGHT - scrollbarInset - safeEdgeGap
  const height = root.clientHeight - paddingY
  if (width <= 0 || height <= 0) return fallback
  return {
    cols: Math.max(2, Math.floor(width / cell.width)),
    rows: Math.max(1, Math.floor(height / cell.height)),
  }
}

interface TerminalCoreLike {
  readonly _core?: {
    readonly _renderService?: {
      readonly dimensions?: {
        readonly css?: {
          readonly cell?: { readonly width: number; readonly height: number }
        }
      }
    }
  }
}

/**
 * 读取 xterm 渲染服务的单元格尺寸。`.xterm-char-measure-element` 会被 DOM renderer
 * 的宽度缓存复用，其文本内容会随最近一次测量的字符变化（例如中文全角字符）。
 * 用它除以 32 推算列宽会把列数按该字符宽度计算，宽字符时列数近乎减半，表现为
 * 文本提前换行、右侧留出大片空白。这里改用官方 FitAddon 依赖的 renderService
 * cell 尺寸（CharSizeService 固定按 32 个 'W' 测量），列宽不再受终端内容影响。
 */
function resolveRendererCell(terminal: Terminal): { width: number; height: number } | undefined {
  const dimensions = (terminal as unknown as TerminalCoreLike)._core?._renderService?.dimensions
  const cell = dimensions?.css?.cell
  if (cell === undefined || !(cell.width > 0) || !(cell.height > 0)) return undefined
  return { width: cell.width, height: cell.height }
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
  boxSizing: 'border-box',
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  paddingLeft: 8,
  paddingRight: 8,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-base)',
} as const

const shadowCss = `${xtermCss}
:host{display:block;width:100%;height:100%;min-width:0;min-height:0;color:inherit;background:inherit}
.codingns-xterm{box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;touch-action:pan-y;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.xterm{box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0}
.xterm-scrollable-element{box-sizing:border-box;width:100%;min-width:0;max-width:100%}
/* xterm 6 已由 xterm-scrollable-element 接管滚动；隐藏兼容 viewport，避免产生第二个滚动条槽位。 */
.xterm-viewport{background:var(--dsw-alias-bg-base);touch-action:pan-y;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;overflow:hidden;scrollbar-gutter:stable;scrollbar-width:none}
.xterm-viewport::-webkit-scrollbar{display:none}
.xterm-viewport::-webkit-scrollbar-track{display:none}
.xterm-viewport::-webkit-scrollbar-thumb{display:none}
.xterm-viewport::-webkit-scrollbar-thumb:hover{display:none}
.xterm .xterm-scrollable-element>.scrollbar.vertical{width:6px!important;right:2px!important;pointer-events:none!important;opacity:0!important;background:transparent!important;transition:opacity 180ms ease!important}
.xterm[data-codingns-scrollbar="visible"] .xterm-scrollable-element>.scrollbar.vertical{opacity:.7!important;pointer-events:auto!important}
.xterm .xterm-scrollable-element>.scrollbar.vertical>.slider{width:6px!important;left:0!important;min-height:24px;border-radius:999px;background:rgba(170,178,190,.72)!important;box-shadow:0 1px 4px rgba(0,0,0,.28);transition:background-color 180ms ease,box-shadow 180ms ease!important}
.xterm[data-codingns-scrollbar="visible"] .xterm-scrollable-element>.scrollbar.vertical>.slider:hover{background:rgba(224,229,237,.9)!important;box-shadow:0 1px 6px rgba(0,0,0,.4)}
.xterm .xterm-scrollable-element>.scrollbar.horizontal{display:none!important}
/* xterm 的字宽缓存会把单个字符重复 32 次测量宽度，Chrome 对连续的全角标点默认做
   标点压缩（「。」从 13px 压到 6.72px），导致 letter-spacing 在每处标点被多补约
   6.3px，行内标点密集时渲染内容向右累积溢出网格宽度，行尾一两个字被裁剪。
   space-all 关闭标点压缩，让字宽测量与单字实际渲染一致，全角标点按两格渲染。 */
.xterm-width-cache-measure-container,.xterm-rows{text-spacing-trim:space-all}
`

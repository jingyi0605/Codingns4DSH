import { createElement, useEffect, useRef, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { Button, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import xtermCss from '@xterm/xterm/css/xterm.css'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS,
  type CodingNsSettings,
  type TerminalAppearanceSettings,
} from '../../shared/contracts/config.js'
import type { CodingNsTerminalView, TerminalViewState } from './model.js'
import { terminalClass } from './styles.js'

export interface CodingNsXtermViewProps {
  readonly view: CodingNsTerminalView
  readonly settings: SettingsScope<CodingNsSettings>
  readonly themeRevision: number
  readonly onNewTerminal: () => void
}

/** 使用与 DSH 内置终端相同的布局、状态条和 xterm 默认参数。 */
export function CodingNsXtermView({
  view,
  settings,
  themeRevision,
  onNewTerminal,
}: CodingNsXtermViewProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lastRevision = useRef(0)
  const state = useSyncExternalStore(view.state.subscribe.bind(view.state), view.state.getSnapshot.bind(view.state))
  const settingsSnapshot = useSyncExternalStore(settings.subscribe.bind(settings), settings.getSnapshot.bind(settings))
  const appearance = settingsSnapshot.value?.terminalEnhancement.appearance
    ?? DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS.appearance
  const hasTerminal = state.info !== undefined

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
      state.environment?.scrollback ?? 0,
      !state.writable,
    ))
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminal.textarea?.setAttribute('aria-label', '终端')
    terminalRef.current = terminal
    fitRef.current = fit
    lastRevision.current = 0
    const input = terminal.onData((data) => view.write(data))
    const title = terminal.onTitleChange((value) => { void view.rename(value) })
    const measure = (): void => {
      if (!state.writable || host.clientWidth === 0 || host.clientHeight === 0) return
      fitTerminal(terminal, fit, view)
    }
    const resize = new ResizeObserver(measure)
    resize.observe(host)
    measure()

    return () => {
      resize.disconnect()
      input.dispose()
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
    applyAppearance(terminal, appearance, host, state.environment?.scrollback ?? 0)
    terminal.options.disableStdin = !state.writable
    if (state.writable && host.clientWidth > 0 && host.clientHeight > 0) {
      fitTerminal(terminal, fitRef.current, view)
      terminal.focus()
    } else if (state.info !== undefined) {
      terminal.resize(state.info.cols, state.info.rows)
    }
  }, [
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
    const render = state.render
    if (terminal === null || render === undefined || render.revision <= lastRevision.current) return
    lastRevision.current = render.revision
    if (render.frame.type === 'snapshot') {
      terminal.reset()
      terminal.resize(render.frame.info.cols, render.frame.info.rows)
    }
    const data = render.frame.type === 'snapshot' ? render.frame.screen : render.frame.data
    terminal.write(data, () => view.acknowledge(render.revision))
  }, [state.render, view])

  return createElement('section', {
    className: terminalClass.root,
    'data-sidebar-terminal': true,
  },
  createElement(TerminalStatus, { state, view, onNewTerminal }),
  hasTerminal ? createElement('div', { className: terminalClass.screen },
    createElement('div', { ref: hostRef, style: terminalHostStyle }),
  ) : null,
  state.error === undefined || state.phase === 'disconnected'
    ? null
    : createElement('p', { className: terminalClass.error, role: 'alert' }, `终端错误：${state.error}`),
  )
}

function TerminalStatus({
  state,
  view,
  onNewTerminal,
}: {
  readonly state: TerminalViewState
  readonly view: CodingNsTerminalView
  readonly onNewTerminal: () => void
}): ReactElement | null {
  const status = statusText(state)
  const ended = state.info?.state === 'exited' || state.phase === 'closed'
  const retry = !ended && (state.phase === 'failed' || state.phase === 'disconnected')
  const readOnly = state.phase === 'connected' && state.info?.state === 'running' && !state.writable
  if (status === undefined && !retry && !readOnly) return null
  return createElement('div', { className: terminalClass.status, role: 'status' },
    status,
    readOnly ? '此页面当前只读。' : null,
    retry ? createElement(Button, {
      variant: 'outline',
      size: 'sm',
      onClick: () => { void view.refresh() },
    }, state.phase === 'disconnected' ? '重新连接' : '重试') : null,
    ended ? createElement(Button, {
      variant: 'primary',
      size: 'sm',
      icon: createElement(IconPlusOutline16),
      onClick: onNewTerminal,
    }, '新建终端') : null,
  )
}

function statusText(state: TerminalViewState): string | undefined {
  if (state.phase === 'idle' || state.phase === 'loading') return '正在读取终端环境…'
  if (state.phase === 'creating') return '正在启动…'
  if (state.phase === 'connecting') return '正在连接…'
  if (state.phase === 'disconnected') return '连接已断开。'
  if (state.info?.state === 'exited') return `进程已退出（${state.info.exitCode ?? '—'}）`
  if (state.info?.state === 'failed') return '不可用'
  if (state.phase === 'closed') return '终端已关闭。'
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
  const dimensions = fit?.proposeDimensions()
  if (dimensions === undefined) return
  terminal.resize(dimensions.cols, dimensions.rows)
  view.resize(dimensions.cols, dimensions.rows)
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
.codingns-xterm{width:100%;height:100%}
.xterm{height:100%}
.xterm-viewport{background:var(--dsw-alias-bg-base)}
`

import {
  createElement,
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  Button,
  IconChevronDownOutline14,
  Menu,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {
  SidebarRightGuideEntryOwnerProps,
  SidebarRightTabInfo,
} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { CodingNsSettings } from '../../shared/contracts/config.js'
import { CodingNsWebTerminals, type WebTerminalId } from './model.js'
import { installTerminalStyles, terminalClass } from './styles.js'
import { CodingNsXtermView } from './xterm-view.js'
import { codingNsTranslator, useCodingNsTranslator, type CodingNsLocale } from '../locale.js'

export const TERMINAL_PROVIDER_ID = 'dsh-codingns/terminal'
export const TERMINAL_KIND = 'terminal'

interface TerminalParams {
  readonly terminalId?: WebTerminalId
  readonly shellPath?: string
}

interface TerminalThemeSource {
  readonly getSnapshot: () => number
  readonly subscribe: (listener: () => void) => () => void
}

interface TerminalInjected {
  readonly webTerminals: CodingNsWebTerminals
  readonly settings: SettingsScope<CodingNsSettings>
  readonly theme: TerminalThemeSource
  readonly locale: CodingNsLocale
}

type TerminalTabProps = PropsRuntime<'sidebar.right.pane.tab'> & TerminalInjected
type TerminalTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'> & Pick<TerminalInjected, 'webTerminals' | 'locale'>
type TerminalGuideProps = PropsRuntime<'sidebar.right.tab.guide.entry'> & SidebarRightGuideEntryOwnerProps & Pick<TerminalInjected, 'webTerminals' | 'locale'>

/** 注册终端类型及其所有公开 Sidebar Slot。 */
export function registerCodingNsTerminalUi(
  ctx: Context,
  webTerminals: CodingNsWebTerminals,
  settings: SettingsScope<CodingNsSettings>,
): () => void {
  const disposers: Array<() => void> = []
  const t = codingNsTranslator(ctx.locale)
  const theme: TerminalThemeSource = {
    getSnapshot: () => ctx.theme.getTheme().revision,
    subscribe: (listener) => ctx.on('theme/change', listener),
  }
  disposers.push(installTerminalStyles())
  disposers.push(ctx.sidebarRightTabs.register({
    id: TERMINAL_PROVIDER_ID,
    kind: TERMINAL_KIND,
    multiple: true,
    priority: 'extension',
    title: () => t('terminal.title'),
    guide: [{
      id: 'new',
      order: 20,
      title: () => t('terminal.new'),
      description: () => t('terminal.description'),
      icon: TerminalGuideIcon,
    }],
  }))
  disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TERMINAL_PROVIDER_ID,
    inject: () => ({ webTerminals, settings, theme, locale: ctx.locale }),
  }, TerminalBody)))
  disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: TERMINAL_PROVIDER_ID,
    inject: () => ({ webTerminals, locale: ctx.locale }),
  }, TerminalTitle)))
  disposers.push(ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({
    name: 'sidebar.right.tab.guide.entry', key: TERMINAL_PROVIDER_ID,
    inject: () => ({ webTerminals, locale: ctx.locale }),
  }, TerminalGuide)))
  disposers.push(ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'dsh-codingns-terminal-recovery', order: 1000,
    inject: () => ({ webTerminals, sidebarRight: ctx.sidebarRight, locale: ctx.locale }),
  }, TerminalRecovery)))
  disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'dsh-codingns-terminal-cleanup', order: 1000,
    inject: () => ({ webTerminals, locale: ctx.locale }),
  }, TerminalCleanup)))
  disposers.push(ctx.sidebarRight.registerCloseHandler(TERMINAL_KIND, (sessionId, tab) => {
    const params = navigationParams(tab)
    webTerminals.close(String(sessionId), String(tab.id), tab.contentId, params.terminalId)
  }))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

function TerminalBody({ sessionId, useTabInfo, webTerminals, settings, theme }: TerminalTabProps): ReactElement | null {
  const info = useTabInfo()
  const params = terminalParams(info)
  const view = webTerminals.view(String(sessionId), String(info.tab.id), info.tab.contentId, params.terminalId, params.shellPath)
  const themeRevision = useSyncExternalStore(theme.subscribe, theme.getSnapshot)
  useEffect(() => info.tab.visible ? view.mount() : undefined, [info.tab.visible, view])
  return info.tab.visible ? createElement(CodingNsXtermView, {
    view,
    settings,
    themeRevision,
    onNewTerminal: () => info.tab.actions.openTab(TERMINAL_KIND, { replaceTab: true }),
  }) : null
}

function TerminalTitle({ sessionId, useTabInfo, webTerminals, locale }: TerminalTitleProps): ReactElement {
  const t = useCodingNsTranslator(locale)
  const info = useTabInfo()
  const params = terminalParams(info)
  const view = webTerminals.view(String(sessionId), String(info.tab.id), info.tab.contentId, params.terminalId, params.shellPath)
  const state = useSyncExternalStore(view.state.subscribe.bind(view.state), view.state.getSnapshot.bind(view.state))
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(state.title)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (!editing) setTitle(state.title) }, [editing, state.title])
  useLayoutEffect(() => {
    if (!editing) return
    input.current?.focus()
    input.current?.select()
  }, [editing])
  const beginEditing = (event: { stopPropagation: () => void; detail?: number }): void => {
    event.stopPropagation()
    if (event.detail === undefined || event.detail >= 2) setEditing(true)
  }
  return createElement(Fragment, undefined,
    createElement(TerminalIcon),
    editing
      ? createElement('input', {
        ref: input,
        value: title,
        maxLength: 120,
        'aria-label': t('terminal.title'),
        className: terminalClass.titleInput,
        onPointerDown: stopPropagation,
        onClick: stopPropagation,
        onDoubleClick: stopPropagation,
        onChange: (event: { currentTarget: { value: string } }) => setTitle(event.currentTarget.value),
        onBlur: () => { setEditing(false); void view.rename(title) },
        onKeyDown: (event: { key: string; currentTarget: { blur: () => void }; stopPropagation: () => void }) => {
          event.stopPropagation()
          if (event.key === 'Escape') { setTitle(state.title); event.currentTarget.blur() }
          else if (event.key === 'Enter') event.currentTarget.blur()
        },
      })
      : createElement('span', {
        className: terminalClass.title,
        onPointerDown: stopPropagation,
        onMouseDown: stopPropagation,
        onClick: beginEditing,
        onDoubleClick: beginEditing,
        title: t('terminal.rename'),
      }, state.title),
  )
}

function TerminalGuide({ sessionId, useTabInfo, webTerminals, title, description, locale }: TerminalGuideProps): ReactElement {
  const t = useCodingNsTranslator(locale)
  const info = useTabInfo()
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ShellMenuState>({ phase: 'loading' })
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void webTerminals.launchShells(String(sessionId), controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setState({
        phase: 'ready',
        shells: result.shells,
        ...(result.selectedShell === undefined ? {} : { selected: result.selectedShell }),
      })
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setState({ phase: 'failed', message: messageOf(cause) })
    })
    return () => controller.abort()
  }, [open, attempt, sessionId, webTerminals])

  return createElement('div', {
    className: terminalClass.guideEntry,
    'data-sidebar-right-guide-entry': TERMINAL_KIND,
  },
  createElement(Button, {
    variant: 'ghost',
    className: terminalClass.guideMain,
    onClick: () => info.tab.actions.openTab(TERMINAL_KIND, { replaceTab: true }),
  },
  createElement(TerminalGuideIcon, { size: description === undefined ? 22 : 26, className: terminalClass.guideIcon }),
  createElement('span', { className: terminalClass.guideText },
    createElement('span', { className: terminalClass.guideTitle }, title),
    description === undefined ? null : createElement('span', { className: terminalClass.guideDescription }, description),
  )),
  createElement(Menu, {
    open,
    portal: true,
    autoFocus: true,
    align: 'end',
    className: terminalClass.guideMenu,
    items: shellMenuItems(state, t),
    ...(state.phase === 'ready' && state.selected !== undefined ? { selectedId: state.selected } : {}),
    onClose: () => setOpen(false),
    onSelect: (path) => {
      if (state.phase === 'failed') {
        setState({ phase: 'loading' })
        setAttempt((value) => value + 1)
        return
      }
      if (state.phase !== 'ready') return
      webTerminals.selectShell(path)
      setOpen(false)
      info.tab.actions.openTab(TERMINAL_KIND, { params: { shellPath: path }, replaceTab: true })
    },
    anchor: createElement(Button, {
      variant: 'ghost',
      className: terminalClass.guideTrigger,
      'aria-label': t('terminal.selectShell'),
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      onClick: () => { setState({ phase: 'loading' }); setOpen((value) => !value) },
    }, createElement(IconChevronDownOutline14)),
  }))
}

type ShellMenuState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly shells: readonly { readonly path: string; readonly name: string }[]; readonly selected?: string }
  | { readonly phase: 'failed'; readonly message: string }

function shellMenuItems(state: ShellMenuState, t: ReturnType<typeof codingNsTranslator>): readonly MenuEntry[] {
  if (state.phase === 'loading') return [{ id: 'loading', label: t('terminal.loadingShell'), disabled: true }]
  if (state.phase === 'failed') return [
    { id: 'error', label: `${t('terminal.error')}: ${state.message}`, disabled: true },
    { id: 'retry', label: t('terminal.retry') },
  ]
  if (state.shells.length === 0) return [{ id: 'empty', label: t('terminal.noShell'), disabled: true }]
  return state.shells.map((shell) => ({ id: shell.path, label: shell.name }))
}

function TerminalRecovery({ sessionId, webTerminals, sidebarRight, locale }: PropsRuntime<'conversation.session.header.actions'> & { readonly webTerminals: CodingNsWebTerminals; readonly sidebarRight: Context['sidebarRight']; readonly locale: CodingNsLocale }): ReactElement | null {
  const t = useCodingNsTranslator(locale)
  const [error, setError] = useState('')
  const recover = (): void => {
    setError('')
    void webTerminals.recover(String(sessionId)).then((terminals) => {
      // conversation Slot 的旧声明仍暴露 string，Sidebar 服务要求同一个值的品牌类型。
      const sidebarSessionId = sessionId as Parameters<typeof sidebarRight.tabsIn>[0]
      const openTabs = sidebarRight.tabsIn(sidebarSessionId).filter((tab) => tab.kind === TERMINAL_KIND)
      const listedIds = new Set(terminals.map((terminal) => terminal.id))
      const openIds = new Set<string>()
      for (const tab of openTabs) {
        const id = terminalIdForTab(webTerminals, String(sessionId), tab)
        if (!isTerminalId(id)) continue
        openIds.add(id)
        // A 会话关闭后，B 会话已有的旧标签仍在本地布局里；按 Host 当前列表收敛它。
        if (!listedIds.has(id)) sidebarRight.closeIn(sidebarSessionId, tab.id)
      }
      for (const terminal of terminals) {
        if (openIds.has(terminal.id)) continue
        // 先加入集合再提交 UI mutation，避免同一轮或并发恢复重复打开同一终端。
        openIds.add(terminal.id)
        sidebarRight.openTabIn(sidebarSessionId, TERMINAL_KIND, { params: { terminalId: terminal.id } })
      }
    }).catch((cause: unknown) => setError(messageOf(cause)))
  }
  useEffect(recover, [sessionId, webTerminals, sidebarRight])
  return error === '' ? null : createElement('button', {
    type: 'button',
    onClick: recover,
    title: t('terminal.recoveryFailed', { message: error }),
  }, t('terminal.recovery'))
}

function TerminalCleanup({ webTerminals, locale }: PropsRuntime<'shell.overlay'> & Pick<TerminalInjected, 'webTerminals' | 'locale'>): ReactElement | null {
  const t = useCodingNsTranslator(locale)
  const failures = useSyncExternalStore(webTerminals.closeFailures.subscribe.bind(webTerminals.closeFailures), webTerminals.closeFailures.getSnapshot.bind(webTerminals.closeFailures))
  if (failures.length === 0) return null
  return createElement('div', { className: terminalClass.cleanupStack },
    ...failures.map((failure) => createElement('div', {
      key: String(failure.id),
      className: terminalClass.cleanupNotice,
      role: 'alert',
    },
    createElement('span', undefined, t('terminal.cleanupFailed', { title: failure.title, message: failure.message })),
    createElement('button', { type: 'button', onClick: () => webTerminals.retryClose(failure.id) }, t('terminal.retry')),
    )),
  )
}

function terminalParams(info: SidebarRightTabInfo): TerminalParams {
  const params = info.tab.navigation.params
  return typeof params === 'object' && params !== null ? params as TerminalParams : {}
}

function navigationParams(tab: { readonly navigation?: { readonly params?: unknown } }): TerminalParams {
  const params = tab.navigation?.params
  return typeof params === 'object' && params !== null ? params as TerminalParams : {}
}

function terminalIdFromTab(tab: unknown): unknown {
  return navigationParams(tab as { readonly navigation?: { readonly params?: unknown } }).terminalId
}

function terminalIdForTab(webTerminals: CodingNsWebTerminals, sessionId: string, tab: { readonly contentId: string }): unknown {
  return terminalIdFromTab(tab) ?? webTerminals.boundTerminalId(sessionId, tab.contentId)
}

function isTerminalId(value: unknown): value is WebTerminalId { return typeof value === 'string' && value.length > 0 }
function messageOf(value: unknown): string { return value instanceof Error ? value.message : String(value) }
function stopPropagation(event: { stopPropagation: () => void }): void { event.stopPropagation() }

function TerminalIcon(): ReactElement {
  return createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    createElement('path', {
      d: 'm3 4 4 4-4 4M9 12h4',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

function TerminalGuideIcon({ size = 26, className }: { readonly size?: number | undefined; readonly className?: string | undefined }): ReactElement {
  return createElement('svg', { width: size, height: size, className, viewBox: '0 0 28 28', fill: 'none', 'aria-hidden': true },
    createElement('rect', { x: 3, y: 5, width: 22, height: 19, rx: 3, fill: '#17191d' }),
    createElement('path', {
      d: 'm8 10 4 4-4 4M15 18h5',
      stroke: '#fff',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    terminal: TerminalParams
  }
}

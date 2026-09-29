import type { AggregateHostResult, HostScope } from '../shared/contracts/peer-host.js'
import { buildHostNavigation, type HostNavigationHostItem } from './host-navigation.js'
import type { PeerHostEventSocketFactory, PeerHostEventSubscription, PeerHostScopedClient } from './peer-host-scoped-client.js'
import type { PeerHostSessionController } from './peer-host-session-controller.js'

export const PEER_HOST_NAVIGATION_ATTRIBUTE = 'data-codingns-peer-host-navigation'
export const PEER_HOST_SESSION_ATTRIBUTE = 'data-codingns-peer-host-session'
export const PEER_HOST_STATUS_ATTRIBUTE = 'data-codingns-peer-host-status'

export type PeerHostNativeUiStatus = 'ready' | 'degraded' | 'unavailable'

export interface PeerHostNativeUiState {
  readonly status: PeerHostNativeUiStatus
  readonly reason: string
}

export interface PeerHostNativeNavigationOptions {
  readonly document?: Document
  readonly controller: PeerHostSessionController
  readonly onSelect?: (scope: HostScope) => void | Promise<void>
  readonly onStatus?: (state: PeerHostNativeUiState) => void
}

export interface PeerHostNativeNavigationController {
  refresh(results: readonly AggregateHostResult[]): void
  setStatus(state: PeerHostNativeUiState): void
  dispose(): void
  readonly state: PeerHostNativeUiState
}

/** 仅探测，不修改 DOM；供能力诊断和版本 fixture 使用。 */
export function probePeerHostNativeNavigation(dom?: Document): PeerHostNativeUiState {
  return resolveNavigationState(dom)
}

/** 仅探测会话容器，不触发请求。 */
export function probePeerHostNativeSession(dom?: Document): PeerHostNativeUiState {
  return resolveSessionState(dom)
}

/**
 * 将聚合导航挂到 DSH 已声明的 tree 容器。
 *
 * 这里不猜 React Fiber 或版本专属 class。只有同时存在 tree 和至少一个
 * treeitem 才认为原生导航扩展点可用；否则保留明确的降级状态，不创建伪造
 * 的工作区数据。
 */
export function startPeerHostNativeNavigation(options: PeerHostNativeNavigationOptions): PeerHostNativeNavigationController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  let currentState: PeerHostNativeUiState = resolveNavigationState(dom)
  let disposed = false
  let latestResults: readonly AggregateHostResult[] = []
  let overrideState: PeerHostNativeUiState | undefined

  const report = (state: PeerHostNativeUiState): void => {
    currentState = state
    options.onStatus?.(state)
  }

  const render = (): void => {
    if (disposed || dom === undefined) return
    const state = overrideState ?? resolveNavigationState(dom)
    report(state)
    removeNodes(dom, PEER_HOST_NAVIGATION_ATTRIBUTE)
    // 清理旧版本曾插入的状态节点；降级信息不应残留在 DSH 原生工作区树顶部。
    removeNodes(dom, PEER_HOST_STATUS_ATTRIBUTE)
    if (state.status !== 'ready') {
      // 原生工作区树属于 DSH 宿主；降级信息只通过 controller.state/onStatus
      // 暴露，不能把插件错误节点插入宿主导航顶部，避免污染单 Host UI。
      return
    }
    const tree = findNativeTree(dom)
    if (tree === undefined) return
    const root = dom.createElement('section')
    root.setAttribute(PEER_HOST_NAVIGATION_ATTRIBUTE, '')
    root.setAttribute('aria-label', 'PeerHost 工作区与会话')
    root.style.display = 'contents'
    // 本地 Host 已由 DSH 原生工作区树渲染；这里只追加远端 Host，避免重复显示本地工作区。
    const navigation = buildHostNavigation(latestResults.filter((host) => host.targetHostId !== null))
    if (navigation.length === 0) return
    for (const host of navigation) root.appendChild(renderHost(dom, host, options.onSelect))
    tree.appendChild(root)
  }

  const controller: PeerHostNativeNavigationController = {
    get state() { return currentState },
    refresh(results) {
      latestResults = results
      overrideState = undefined
      render()
    },
    setStatus(state) {
      overrideState = state
      render()
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (dom !== undefined) {
        removeNodes(dom, PEER_HOST_NAVIGATION_ATTRIBUTE)
        removeNodes(dom, PEER_HOST_STATUS_ATTRIBUTE)
        removeNodes(dom, PEER_HOST_SESSION_ATTRIBUTE)
      }
    },
  }
  render()
  return controller
}

export interface PeerHostNativeSessionOptions {
  readonly document?: Document
  readonly controller: PeerHostSessionController
  readonly client: PeerHostScopedClient
  readonly socketFactory?: PeerHostEventSocketFactory
  readonly onStatus?: (state: PeerHostNativeUiState) => void
}

export interface PeerHostNativeSessionController {
  open(scope: HostScope): Promise<void>
  close(): void
  send(body: string): Promise<void>
  stop(): Promise<void>
  replyPermission(body: string): Promise<void>
  answerQuestion(body: string): Promise<void>
  readonly state: PeerHostNativeUiState
}

/**
 * 远端会话的原生三栏适配器。
 *
 * DSH 目前没有公开的 HostScope 会话 store 注入点，因此消息先落到当前
 * conversation 容器中的插件节点。这个节点与原生布局同层渲染，明确标记
 * 来源和作用域；若容器探测失败则报告 degraded，不把 iframe 当作原生 UI。
 */
export function startPeerHostNativeSession(options: PeerHostNativeSessionOptions): PeerHostNativeSessionController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  let activeScope: HostScope | null = null
  let subscription: PeerHostEventSubscription | undefined
  let currentState: PeerHostNativeUiState = resolveSessionState(dom)
  let panel: HTMLElement | undefined

  const report = (state: PeerHostNativeUiState): void => {
    currentState = state
    options.onStatus?.(state)
  }

  const open = async (scope: HostScope): Promise<void> => {
    close()
    activeScope = scope
    const root = findConversationRoot(dom)
    if (root === undefined) {
      report({ status: 'degraded', reason: '未探测到 DSH 原生 conversation 容器' })
      return
    }
    panel = createSessionPanel(dom!, scope)
    root.prepend(panel)
    panel.appendChild(createChatControls(dom!, async (action, body) => {
      try {
        const response = action === 'send'
          ? await options.controller.sendMessage(scope, body)
          : action === 'stop'
            ? await options.controller.stop(scope)
            : action === 'permission'
              ? await options.controller.replyPermission(scope, body)
              : await options.controller.answerQuestion(scope, body)
        if (isActive(scope)) appendNotice(panel, response.body || '已提交')
      } catch (error) {
        if (isActive(scope)) appendNotice(panel, `操作失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }))
    report({ status: 'ready', reason: '已绑定 PeerHost 原生会话容器' })
    try {
      const response = await options.controller.loadHistory(scope)
      if (!isActive(scope)) return
      appendHistory(panel, response.body)
      if (options.socketFactory !== undefined) {
        subscription = await options.controller.subscribe(scope, options.socketFactory, (event) => {
          if (isActive(scope)) appendEvent(panel, event)
        })
        // 建立连接后立即登记会话订阅；ScopedClient 会在重连后只重放此类幂等订阅。
        subscription.send('session.subscribe')
        panel.appendChild(createToolControls(dom!, async (kind, body) => {
          try {
            if (!isActive(scope) || subscription === undefined) return
            if (kind === 'terminal.subscribe') subscription.send('terminal.subscribe', parseJsonObject(body))
            else if (kind === 'terminal.input') subscription.terminalInput(parseJsonPayload(body, 'data'))
            else if (kind === 'terminal.resize') subscription.terminalResize(parseJsonPayload(body, 'cols'))
            else if (kind === 'terminal.close') subscription.terminalClose(parseJsonObject(body))
            else if (kind === 'rightTool.subscribe') subscription.rightToolSubscribe(parseJsonObject(body))
            else if (kind === 'rightTool.refresh') subscription.rightToolRefresh(parseJsonObject(body))
            else subscription.rightToolClose(parseJsonObject(body))
          } catch (error) {
            if (isActive(scope)) appendNotice(panel, `工具操作失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }))
      } else {
        appendNotice(panel, 'PeerHost 实时工具通道不可用，终端和右侧工具保持降级')
      }
    } catch (error) {
      if (isActive(scope)) appendNotice(panel, `远端会话加载失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const close = (): void => {
    subscription?.close()
    subscription = undefined
    panel?.remove()
    panel = undefined
    activeScope = null
  }

  const run = async (operation: (scope: HostScope) => Promise<unknown>): Promise<void> => {
    const scope = activeScope
    if (scope === null) throw new Error('尚未选择 PeerHost 会话')
    await operation(scope)
  }

  const api: PeerHostNativeSessionController = {
    get state() { return currentState },
    open,
    close,
    send: (body) => run((scope) => options.controller.sendMessage(scope, body)),
    stop: () => run((scope) => options.controller.stop(scope)),
    replyPermission: (body) => run((scope) => options.controller.replyPermission(scope, body)),
    answerQuestion: (body) => run((scope) => options.controller.answerQuestion(scope, body)),
  }
  report(currentState)
  return api

  function isActive(scope: HostScope): boolean {
    return activeScope !== null && activeScope.scopeGeneration === scope.scopeGeneration
      && activeScope.hostId === scope.hostId && activeScope.targetHostId === scope.targetHostId
      && activeScope.workspaceId === scope.workspaceId && activeScope.sessionId === scope.sessionId
  }
}

function resolveNavigationState(dom: Document | undefined): PeerHostNativeUiState {
  return findNativeTree(dom) === undefined
    ? { status: 'degraded', reason: '未探测到 DSH 原生工作区树，PeerHost 导航暂不可用' }
    : { status: 'ready', reason: '已探测到 DSH 原生工作区树' }
}

function resolveSessionState(dom: Document | undefined): PeerHostNativeUiState {
  return findConversationRoot(dom) === undefined
    ? { status: 'degraded', reason: '未探测到 DSH 原生 conversation 容器' }
    : { status: 'ready', reason: '已探测到 DSH 原生 conversation 容器' }
}

function findNativeTree(dom: Document | undefined): HTMLElement | undefined {
  if (dom === undefined) return undefined
  const trees = [...dom.querySelectorAll<HTMLElement>('[role="tree"]')]
  return trees.find((tree) => tree.querySelector('[role="treeitem"]') !== null)
}

function findConversationRoot(dom: Document | undefined): HTMLElement | undefined {
  if (dom === undefined) return undefined
  const composer = dom.querySelector<HTMLElement>('[data-composer-card]')
  if (composer === null) return undefined
  return composer.closest<HTMLElement>('[data-conversation-content],main') ?? composer.parentElement ?? undefined
}

function renderHost(dom: Document, host: HostNavigationHostItem, onSelect: PeerHostNativeNavigationOptions['onSelect']): HTMLElement {
  const section = dom.createElement('div')
  section.dataset.hostKey = host.key
  section.dataset.hostAvailability = host.availability
  section.style.display = 'contents'
  const heading = dom.createElement('div')
  heading.textContent = host.label
  heading.setAttribute('data-codingns-peer-host-host', '')
  section.appendChild(heading)
  for (const workspace of host.workspaces) {
    const workspaceNode = dom.createElement('div')
    workspaceNode.textContent = workspace.label
    workspaceNode.setAttribute('data-codingns-peer-host-workspace', workspace.key)
    section.appendChild(workspaceNode)
    for (const session of workspace.sessions) {
      const button = dom.createElement('button')
      button.type = 'button'
      button.textContent = session.title
      button.dataset.codingnsPeerHostScope = JSON.stringify(session.scope)
      button.setAttribute(PEER_HOST_SESSION_ATTRIBUTE, '')
      button.addEventListener('click', () => { void onSelect?.(session.scope) })
      section.appendChild(button)
    }
  }
  return section
}

function createSessionPanel(dom: Document, scope: HostScope): HTMLElement {
  const panel = dom.createElement('section')
  panel.setAttribute(PEER_HOST_SESSION_ATTRIBUTE, '')
  panel.setAttribute('aria-label', `PeerHost 会话 ${scope.sessionId ?? ''}`)
  panel.dataset.codingnsPeerHostScope = JSON.stringify(scope)
  panel.style.padding = '8px 12px'
  panel.style.borderBottom = '1px solid var(--dsw-alias-border-l2, currentColor)'
  return panel
}

type PeerHostChatAction = 'send' | 'stop' | 'permission' | 'question'

function createChatControls(dom: Document, run: (action: PeerHostChatAction, body: string) => Promise<void>): HTMLElement {
  const controls = dom.createElement('div')
  controls.setAttribute('data-codingns-peer-host-chat', '')
  const input = dom.createElement('textarea')
  input.setAttribute('aria-label', 'PeerHost 消息')
  input.rows = 2
  input.style.width = '100%'
  input.style.resize = 'vertical'
  const send = button(dom, '发送', 'send')
  const stop = button(dom, '停止', 'stop')
  const permission = button(dom, '权限回复', 'permission')
  const question = button(dom, '回答问题', 'question')
  const submit = (action: PeerHostChatAction): void => {
    const body = input.value.trim()
    if (action !== 'stop' && body === '') return
    if (action !== 'stop') input.value = ''
    void run(action, body)
  }
  send.addEventListener('click', () => submit('send'))
  stop.addEventListener('click', () => submit('stop'))
  permission.addEventListener('click', () => submit('permission'))
  question.addEventListener('click', () => submit('question'))
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    submit('send')
  })
  controls.append(input, send, stop, permission, question)
  return controls
}

function button(dom: Document, label: string, action: PeerHostChatAction): HTMLButtonElement {
  const element = dom.createElement('button')
  element.type = 'button'
  element.textContent = label
  element.dataset.codingnsPeerHostAction = action
  return element
}

function appendHistory(panel: HTMLElement, body: string): void {
  let value: unknown
  try { value = JSON.parse(body) } catch { appendNotice(panel, '远端历史响应不是合法 JSON'); return }
  const records = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.messages) ? value.messages : []
  for (const record of records) appendRecord(panel, record)
}

function appendEvent(panel: HTMLElement | undefined, event: Record<string, unknown>): void {
  if (panel === undefined) return
  appendRecord(panel, event)
}

function appendRecord(panel: HTMLElement, value: unknown): void {
  const item = panel.ownerDocument.createElement('div')
  item.setAttribute('data-codingns-peer-host-message', '')
  item.textContent = isRecord(value)
    ? typeof value.text === 'string' ? value.text : typeof value.content === 'string' ? value.content : JSON.stringify(value)
    : String(value)
  panel.appendChild(item)
}

function appendNotice(panel: HTMLElement | undefined, text: string): void {
  if (panel === undefined) return
  appendRecord(panel, { text })
}

type PeerHostToolAction = 'terminal.subscribe' | 'terminal.input' | 'terminal.resize' | 'terminal.close' | 'rightTool.subscribe' | 'rightTool.refresh' | 'rightTool.close'

function createToolControls(dom: Document, run: (action: PeerHostToolAction, body: string) => Promise<void>): HTMLElement {
  const root = dom.createElement('div')
  root.setAttribute('data-codingns-peer-host-tools', '')
  const input = dom.createElement('input')
  input.type = 'text'
  input.setAttribute('aria-label', 'PeerHost 工具参数')
  input.placeholder = '{"terminalId":"...","data":"ls\\n"}'
  const actions: readonly [PeerHostToolAction, string][] = [
    ['terminal.subscribe', '订阅终端'], ['terminal.input', '终端输入'], ['terminal.resize', '终端调整'], ['terminal.close', '关闭终端'],
    ['rightTool.subscribe', '打开右侧工具'], ['rightTool.refresh', '刷新右侧工具'], ['rightTool.close', '关闭右侧工具'],
  ]
  for (const [action, label] of actions) {
    const control = dom.createElement('button')
    control.type = 'button'
    control.textContent = label
    control.dataset.codingnsPeerHostToolAction = action
    control.addEventListener('click', () => { void run(action, input.value.trim() || '{}') })
    root.appendChild(control)
  }
  root.prepend(input)
  return root
}

function parseJsonObject(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body) as unknown
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

function parseJsonPayload(body: string, fallbackKey: string): Record<string, unknown> {
  const value = parseJsonObject(body)
  return Object.keys(value).length > 0 ? value : { [fallbackKey]: body }
}

function removeNodes(dom: Document, attribute: string): void {
  dom.querySelectorAll<HTMLElement>(`[${attribute}]`).forEach((node) => node.remove())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

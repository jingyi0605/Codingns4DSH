import type { Context } from '@deepseek-ai/cordis'
import type { CodingNsCliAdapterDescriptor } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import type { CodingNsLocale } from './locale.js'
import { adapterCatalogWithDsh, callCliRpc } from './cli-catalog.js'
import type { CodingNsCliModelCatalog } from '../shared/contracts/cli-adapter.js'
import { appendDelegateCarrier, DELEGATE_COMMAND_NAME, delegateAdapterOptions, type DelegateAdapterOption } from './delegate-plan.js'
import { DELEGATE_POPUP_LOGO_ATTRIBUTE, setDelegatePopupOptions, startDelegateUiDom } from './delegate-ui-dom.js'
import { providerIconUrl } from './provider-icons.js'
import { getModelCatalogCache, loadModelCatalog } from './model-catalog-cache.js'
import { resolveDelegateIcon } from '../dsh-capabilities/client/primitives-adapter.js'
import { debugInfo, debugWarn } from '../shared/debug.js'
import { encodeDelegationCarrier } from '../shared/delegation-carrier.js'

const DELEGATE_REFERENCE_SOURCE = 'codingns-delegate'
const delegateReferenceLabels = new Map<string, string>()
interface DelegateReferenceSelection {
  readonly adapterId: string
  readonly label: string
  readonly modelId?: string
}
const delegateReferenceSelections = new Map<string, DelegateReferenceSelection>()

function delegateReferenceKey(adapterId: string, modelId?: string): string {
  return modelId?.trim() ? `${adapterId}\u0000${modelId.trim()}` : adapterId
}

interface TokenSpan {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}

interface ReferenceInsert {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly clipboardText: string
}

interface InputTriggerSource {
  readonly trigger: '@'
  readonly name: string
  readonly showGroupTitle?: boolean
  candidates(session: { readonly sessionId: string }, request: { readonly query: string; readonly signal: AbortSignal }): Promise<readonly { readonly name: string; readonly label: string; readonly value?: string; readonly icon?: 'session' }[]>
  onPick(pick: { readonly candidate: { readonly name: string; readonly label?: string; readonly value?: string }; readonly span: TokenSpan }): { readonly insert: ReferenceInsert }
  readonly codec: {
    clipboardText(ref: string): string
    serialize(ref: string, signal: AbortSignal): Promise<string>
  }
}

interface InputTriggersService {
  registerSource(source: InputTriggerSource): () => void
}

/**
 * `/委派` 命令：把一个任务异步派发给所选外部 Agent，落地为 DSH 原生可续子会话。
 *
 * 该模块只依赖 DSH 的 `commandUi` 服务契约（结构类型），不把版本判断写进业务层：
 * 服务缺失时整块跳过并留诊断，不影响工具栏 Agent 选择器等既有能力。
 */

/** `commandUi` 服务的最小结构；DSH 各版本只保证这几个方法存在。 */
interface CommandUiService {
  register(contribution: CommandContribution): () => void
}

interface CommandContribution {
  readonly name: string
  label?(): string
  description?(): string
  readonly icon?: unknown
  available(session: { readonly sessionId: string }): boolean
  readonly ui: PopupSelectSpec
}

interface PopupSelectSpec {
  readonly kind: 'popupSelect'
  readonly searchMode?: 'substring' | 'fuzzy-label'
  searchLabels?(): { readonly placeholder: string; readonly empty: string; readonly noResults: string }
  options(session: { readonly sessionId: string }, signal: AbortSignal): Promise<readonly SelectOption[]>
  onSelect(option: SelectOption, session: { readonly sessionId: string }): void | Promise<void>
}

interface SelectOption {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly badge?: string
}

interface DelegateCapability {
  readonly supported: boolean
  readonly code: string
  readonly message: string
}

/** Client 侧可用的会话输入面；用来读取草稿并把委派任务取出来。 */
interface SessionInputFace {
  readonly state: { getSnapshot(): { readonly draft: string; readonly draftRev?: number; readonly phase?: string } }
  /** DSH 0.2 的输入外壳提供当前光标选择；旧版本没有该方法。 */
  caretSpan?(): { readonly start: number; readonly end: number; readonly draftRev?: number }
  insertReference?(reference: ReferenceInsert, span: TokenSpan): boolean
  setDraft?(text: string): void
  notify(level: 'info' | 'error', text: string): void
}

interface SessionsService {
  scope(id: string): Context | undefined
}

interface ConversationService {
  readonly input: { for(actx: Context): SessionInputFace; shell?(sessionId: string): SessionInputFace }
}

export interface RegisterDelegateCommandOptions {
  readonly rpc: CodingNsRpcClient
  readonly locale: CodingNsLocale
  readonly dshVersion?: string
}

/**
 * 把 `/委派` 注册进 `/` 菜单。
 *
 * @param ctx - Client 根 Context；只用于解析 `commandUi` 等 DSH 服务。
 * @param options - RPC 边界与语言运行时。
 * @returns 注销函数；`commandUi` 不可用时返回空操作。
 */
export function registerDelegateCommand(ctx: Context, options: RegisterDelegateCommandOptions): () => void {
  const t = options.locale.bind('codingns')
  // 界面增强独立于 commandUi：DSH 的「添加」分类与弹层图标都不在公开契约里，
  // 只能靠 DOM 注入补齐（见 delegate-ui-dom.ts）。注入器对契约不成立的情况完全
  // 静默，因此即使菜单结构变化也不会影响其它功能。
  const ui = startDelegateUiDom({
    menuLabel: () => t('delegate.label'),
    popupPlaceholder: () => t('delegate.searchPlaceholder'),
    composerPlaceholder: () => t('delegate.composerPlaceholder'),
    cardTitle: () => t('delegate.cardTitle'),
    cardStatus: () => t('delegate.cardStatus'),
    cardTarget: (value) => t('delegate.cardTarget', {
      label: value.label,
      adapter: value.adapterId,
      model: value.modelId === undefined ? '' : ` · ${value.modelId}`,
    }),
  })
  // commandUi 由另一个 Client 插件提供，装配顺序不保证它已经就绪；直接同步读取会
  // 在加载晚于本模块时静默丢掉注册。Cordis 的 inject 会把回调推迟到服务可用时，
  // 因此用它拿服务，并把注册本身挂成该作用域的 effect（与 DSH 官方 /file 一致），
  // 模块停用时随 fiber 一起释放，不会在菜单里留下悬空命令。
  const fiber = ctx.inject(['commandUi'], (scope) => {
    registerDelegateCommandIn(scope, options)
  })
  return () => {
    ui.dispose()
    void fiber.dispose()
  }
}

/** 在 commandUi 就绪的作用域内注册 `/委派`；失败只降级为不注册。 */
function registerDelegateCommandIn(ctx: Context, options: RegisterDelegateCommandOptions): void {
  const commandUi = readCommandUi(ctx)
  if (commandUi === undefined) {
    debugWarn('codingns4dsh: /委派 未注册，当前 DSH 未提供 commandUi 服务')
    return
  }
  const t = options.locale.bind('codingns')
  try {
    registerDelegateReferenceCodec(ctx, options)
    // 注册必须由本作用域的 effect 持有：commandUi.register 的 disposer 只在显式
    // 调用时才移除命令，effect 保证停用时一定会调用它。
    ctx.effect(() => commandUi.register({
      name: DELEGATE_COMMAND_NAME,
      label: () => t('delegate.label'),
      description: () => t('delegate.description'),
      icon: resolveDelegateIcon(),
      // 会话本身永远可用；真正的门槛是 Host 侧的可续子代理能力，由选项加载给出可读诊断。
      available: () => true,
      ui: {
        kind: 'popupSelect',
        searchMode: 'fuzzy-label',
        searchLabels: () => ({
          placeholder: t('delegate.searchPlaceholder'),
          empty: t('delegate.searchEmpty'),
          noResults: t('delegate.searchNoResults'),
        }),
        async options(session) {
          const capability = await callCliRpc<DelegateCapability>(options.rpc, 'delegate/capability', { sessionId: session.sessionId })
          if (!capability.supported) throw new Error(capability.message)
          const catalog = await callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(options.rpc, 'catalog', { sessionId: session.sessionId })
          const list = delegateAdapterOptions(adapterCatalogWithDsh(catalog, options.dshVersion))
          // 登记给 DOM 增强器，供弹层按标题反查适配器并插入图标。
          setDelegatePopupOptions(list)
          return list
        },
        async onSelect(option, session) {
          const input = readSessionInput(ctx, session.sessionId)
          if (input === undefined) {
            return
          }
          const snapshot = input.state.getSnapshot()
          const draft = snapshot.draft ?? ''
          delegateReferenceLabels.set(option.id, option.label)
          const selection = input.caretSpan?.()
          const span = snapshot.draftRev === undefined
            ? undefined
            : delegateCommandSpan(draft, snapshot.draftRev, selection) ?? (selection === undefined ? undefined : { ...selection, draftRev: snapshot.draftRev })
          const inserted = span !== undefined && input.insertReference?.({
            source: DELEGATE_REFERENCE_SOURCE,
            ref: option.id,
            label: option.label,
            appearance: 'session',
            clipboardText: `@${option.label}`,
          }, span) === true
          if (inserted) {
            return
          }
          if (input.setDraft === undefined) {
            input?.notify('error', t('delegate.draftUnsupported'))
            return
          }
          // 旧版 DSH 没有结构化引用能力时保留 carrier 字符串回退；当前 rc.2
          // 会走上面的 ReferenceChip 路径，不会再把内部 HTML 注释直接显示出来。
          input.setDraft(appendDelegateCarrier(draft, option.id, option.label))
        },
      },
    }), 'codingns4dsh: delegate command')
    debugInfo('codingns4dsh: /委派 命令已注册')
  } catch (error) {
    // 命令名与 DSH 原生命令冲突时会 fail loud；此处降级为不注册，避免影响整个 Client。
    debugWarn('codingns4dsh: /委派 命令注册失败', { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 找到当前 `/委派` 命令令牌，供 popupSelect 选择结果直接替换为 chip。
 * 命令弹层的 onSelect 在消费令牌前触发，此时公开的 caretSpan 可能只是折叠光标，
 * 因而不能依赖它来推断命令范围。
 */
function delegateCommandSpan(
  draft: string,
  draftRev: number,
  selection?: { readonly start: number; readonly end: number },
): TokenSpan | undefined {
  const caret = selection?.end ?? draft.length
  const token = /\/(?:delegate|委派)(?=\s|$)/gu
  let match: RegExpExecArray | null
  while ((match = token.exec(draft)) !== null) {
    const start = match.index
    const end = start + match[0].length
    const before = draft[start - 1]
    // 只接受命令边界；普通文本中的同名字符串不能被误替换。
    if (start > 0 && before !== undefined && !/\s/u.test(before)) continue
    if (caret >= start && caret <= end + 1) return { start, end, draftRev }
    // 选择菜单可能把光标留在令牌末尾之后的一个空格，仍视为当前命令。
    if (caret > end && draft.slice(end, caret).trim() === '') return { start, end, draftRev }
  }
  return undefined
}

/**
 * 注册结构化 Agent 引用的内部编解码器。
 *
 * 委派入口由 `#` 弹层提供，不能再把适配器目录挂到原生 `@` 菜单。这里仍向
 * inputTriggers 登记 codec，是因为 DSH 在提交 ReferenceChip 时按 source 查找
 * 序列化器；候选列表固定为空，并隐藏分组标题，因此不会产生可见的 `@` 菜单项。
 */
function registerDelegateReferenceCodec(ctx: Context, options: RegisterDelegateCommandOptions): void {
  const inputTriggers = readService<InputTriggersService>(ctx, 'inputTriggers')
  const source: InputTriggerSource = {
    trigger: '@',
    name: DELEGATE_REFERENCE_SOURCE,
    showGroupTitle: false,
    async candidates() {
      return []
    },
    onPick(pick) {
      const ref = pick.candidate.value ?? pick.candidate.name
      const selection = delegateReferenceSelections.get(ref)
      const label = pick.candidate.label?.trim() || selection?.label || delegateReferenceLabels.get(ref) || ref
      delegateReferenceLabels.set(ref, label)
      return { insert: { source: DELEGATE_REFERENCE_SOURCE, ref, label, appearance: 'session', clipboardText: `@${label}` } }
    },
    codec: {
      clipboardText(ref) {
        return `@${delegateReferenceLabels.get(ref) || ref}`
      },
      async serialize(ref) {
        const selection = delegateReferenceSelections.get(ref)
        const adapterId = selection?.adapterId || ref.split('\u0000', 1)[0] || ref
        const label = selection?.label || delegateReferenceLabels.get(ref) || adapterId
        return encodeDelegationCarrier(adapterId, label, selection?.modelId)
      },
    },
  }
  try {
    ctx.effect(() => {
      // 自定义 `#` 入口不依赖 inputTriggers。移动端服务装配顺序可能是
      // commandUi 先就绪、inputTriggers 后就绪；不能因为一次性探测失败而丢掉核心入口。
      const disposeHashShortcut = registerDelegateHashShortcut(ctx, options)
      const disposeSource = inputTriggers !== undefined && typeof inputTriggers.registerSource === 'function'
        ? inputTriggers.registerSource(source)
        : undefined
      return () => {
        disposeHashShortcut()
        disposeSource?.()
      }
    }, 'codingns4dsh: delegate reference source')
  } catch (error) {
    debugWarn('codingns4dsh: Agent 引用源注册失败', { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 为 DSH 输入框补充 `#` 委派快捷入口。
 *
 * 原生 inputTriggers 只有 `/` 与 `@` 两个触发字符，而且 onPick 是同步契约，无法在
 * 选择适配器后等待 `cli/models` 再切换二级目录。因此这里使用插件自己的轻量弹层：
 * `#` 触发适配器列表，点击适配器后立即请求它的模型目录，点击模型时才写入结构化
 * ReferenceChip。草稿里不会留下“已选择，请继续输入”的持久提示。
 */
function registerDelegateHashShortcut(ctx: Context, options: RegisterDelegateCommandOptions): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => undefined
  const t = options.locale.bind('codingns')
  let popup: HTMLElement | undefined
  let popupSessionId = ''
  let popupMode: 'adapter' | 'model' = 'adapter'
  let popupAdapter: DelegateAdapterOption | undefined
  let popupOptions: readonly DelegateAdapterOption[] = []
  let popupModels: readonly { id: string; label: string; detail?: string }[] = []
  let popupEditor: HTMLElement | undefined
  let popupToken: { start: number; end: number; draftRev: number } | undefined
  let popupRequestId = 0
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  const cancelRefresh = (): void => {
    if (refreshTimer === undefined) return
    clearTimeout(refreshTimer)
    refreshTimer = undefined
  }

  const close = (): void => {
    popupRequestId += 1
    popup?.remove()
    popup = undefined
    popupEditor = undefined
    popupToken = undefined
    popupAdapter = undefined
    popupOptions = []
    popupModels = []
    popupMode = 'adapter'
  }

  const inputFor = (sessionId: string): SessionInputFace | undefined => {
    try {
      const conversation = readConversation(ctx)
      const actx = readSessions(ctx)?.scope(sessionId)
      if (actx !== undefined && conversation !== undefined) return conversation.input.for(actx)
      // DSH rc.2 的 InputHub 同时提供按 sessionId 解析的 shell；移动端布局或
      // 早期装配阶段可能还拿不到 retained Session scope，此路径仍能读写草稿。
      return conversation?.input.shell?.(sessionId)
    } catch {
      return undefined
    }
  }

  const position = (): void => {
    if (popup === undefined || popupEditor === undefined) return
    const rect = popupEditor.getBoundingClientRect()
    const viewport = window.visualViewport
    const viewportLeft = viewport?.offsetLeft ?? 0
    const viewportTop = viewport?.offsetTop ?? 0
    const viewportWidth = viewport?.width ?? window.innerWidth
    const viewportHeight = viewport?.height ?? window.innerHeight
    const popupWidth = Math.min(340, Math.max(220, rect.width))
    const gap = 6
    const minEdge = 8
    const below = rect.bottom + gap
    const above = rect.top - gap - popup.offsetHeight
    const maxTop = viewportTop + viewportHeight - minEdge - popup.offsetHeight
    // 移动端输入框通常贴在视口底部，优先向上展开，避免弹层被软键盘裁掉。
    const top = above >= viewportTop + minEdge
      ? above
      : Math.min(maxTop, Math.max(viewportTop + minEdge, below))
    const left = Math.max(viewportLeft + minEdge, Math.min(rect.left, viewportLeft + viewportWidth - popupWidth - minEdge))
    Object.assign(popup.style, {
      left: `${left}px`,
      top: `${top}px`,
      minWidth: `${popupWidth}px`,
    })
  }

  const ensurePopup = (editor: HTMLElement, sessionId: string): HTMLElement => {
    if (popup !== undefined && popupSessionId === sessionId) {
      popupEditor = editor
      position()
      return popup
    }
    close()
    popupSessionId = sessionId
    popupEditor = editor
    popup = document.createElement('div')
    popup.setAttribute('data-codingns-delegate-hash-popup', '')
    popup.setAttribute('role', 'listbox')
    Object.assign(popup.style, {
      position: 'fixed', zIndex: '2147483647', maxWidth: 'min(360px, calc(100vw - 16px))', maxHeight: 'min(420px, calc(100vh - 24px))', overflowY: 'auto',
      padding: '6px', border: '1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35))', borderRadius: '10px',
      background: 'var(--dsw-alias-bg-layer-3,#242526)', color: 'var(--dsw-alias-label-primary,#f5f5f5)',
      boxShadow: '0 10px 30px rgba(0,0,0,.28)', font: '13px var(--dsw-font,system-ui,sans-serif)',
    })
    document.body.append(popup)
    position()
    return popup
  }

  const render = (title: string, rows: readonly { id: string; label: string; detail?: string; iconId?: string; onClick: () => void }[]): void => {
    if (popup === undefined) return
    popup.replaceChildren()
    const heading = document.createElement('div')
    heading.textContent = title
    Object.assign(heading.style, { padding: '5px 8px 7px', color: 'var(--dsw-alias-label-secondary,#a9adb5)', fontSize: '12px', fontWeight: '600' })
    popup.append(heading)
    if (rows.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = t('delegate.popupNoResults')
      Object.assign(empty.style, { padding: '8px', color: 'var(--dsw-alias-label-secondary,#a9adb5)' })
      popup.append(empty)
      position()
      return
    }
    for (const row of rows) {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'option')
      button.dataset.value = row.id
      Object.assign(button.style, { display: 'flex', width: '100%', minWidth: '0', gap: '8px', alignItems: 'center', padding: '8px', border: '0', borderRadius: '7px', background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' })
      button.addEventListener('mouseenter', () => { button.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))' })
      button.addEventListener('mouseleave', () => { button.style.background = 'transparent' })
      button.addEventListener('click', row.onClick)
      const iconUrl = row.iconId === undefined ? undefined : providerIconUrl(row.iconId)
      if (iconUrl !== undefined && iconUrl !== '' && row.iconId !== undefined) {
        const image = document.createElement('img')
        image.setAttribute('src', iconUrl)
        image.setAttribute('alt', '')
        image.setAttribute('aria-hidden', 'true')
        image.setAttribute(DELEGATE_POPUP_LOGO_ATTRIBUTE, row.iconId)
        Object.assign(image.style, { width: '16px', height: '16px', flex: '0 0 16px', objectFit: 'contain', borderRadius: '3px' })
        button.append(image)
      }
      const text = document.createElement('span')
      text.textContent = row.label
      Object.assign(text.style, { minWidth: '0', overflowWrap: 'anywhere', flex: '1 1 auto' })
      button.append(text)
      if (row.detail) {
        const detail = document.createElement('span')
        detail.textContent = row.detail
        Object.assign(detail.style, { flex: '0 1 auto', minWidth: '0', maxWidth: '45%', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-secondary,#a9adb5)', fontSize: '12px' })
        button.append(detail)
      }
      popup.append(button)
    }
    position()
  }

  const selectModel = (model: { id: string; label: string; detail?: string }): void => {
    const input = inputFor(popupSessionId)
    const token = popupToken
    const adapter = popupAdapter
    if (input === undefined || token === undefined || adapter === undefined) return
    const ref = delegateReferenceKey(adapter.id, model.id)
    delegateReferenceSelections.set(ref, { adapterId: adapter.id, label: adapter.label, modelId: model.id })
    delegateReferenceLabels.set(ref, adapter.label)
    const inserted = input.insertReference?.({ source: DELEGATE_REFERENCE_SOURCE, ref, label: adapter.label, appearance: 'session', clipboardText: `@${adapter.label}` }, token) === true
    if (!inserted) {
      const snapshot = input.state.getSnapshot()
      const draft = snapshot.draft ?? ''
      const replacement = encodeDelegationCarrier(adapter.id, adapter.label, model.id)
      input.setDraft?.(`${draft.slice(0, token.start)}${replacement}${draft.slice(token.end)}`)
    }
    close()
  }

  const selectAdapter = async (adapter: DelegateAdapterOption): Promise<void> => {
    // 选择适配器后进入模型目录，取消触发 `#` 时为确保快照发布而安排的旧重试，
    // 避免它把已加载的模型列表重新按旧 token 过滤为空。
    cancelRefresh()
    popupAdapter = adapter
    popupMode = 'model'
    const requestId = ++popupRequestId
    const sessionId = popupSessionId
    render(t('delegate.selectModel', { name: adapter.label }), [{ id: 'loading', label: t('delegate.loadingModels'), onClick: () => undefined }])
    try {
      const catalog = await loadModelCatalog(options.rpc, adapter.id, sessionId)
      popupModels = catalog.groups.flatMap((group) => group.models.map((model) => {
        const efforts = model.efforts.map((effort) => model.effortLabels?.[effort] ?? effort)
        const effortsLabel = efforts.length === 0 ? undefined : t('cli.thinkingLevel', { value: efforts.join(t('common.listSeparator')) })
        const details = [model.description, effortsLabel].filter((value): value is string => value !== undefined && value.trim() !== '')
        return { id: model.id, label: model.name || model.id, ...(details.length === 0 ? {} : { detail: details.join(' · ') }) }
      }))
      if (popup === undefined || popupMode !== 'model' || popupRequestId !== requestId || popupSessionId !== sessionId || popupAdapter?.id !== adapter.id) return
      render(t('delegate.selectModel', { name: adapter.label }), popupModels.map((model) => ({ ...model, onClick: () => selectModel(model) })))
    } catch (error) {
      if (popup === undefined || popupMode !== 'model' || popupRequestId !== requestId || popupSessionId !== sessionId || popupAdapter?.id !== adapter.id) return
      render(t('delegate.selectModel', { name: adapter.label }), [{ id: 'error', label: error instanceof Error ? error.message : t('delegate.modelCatalogFailed'), onClick: () => undefined }])
    }
  }

  const sessionIdFor = (element: Element | null): string | undefined => {
    const direct = element?.closest('[data-conversation-session]')?.getAttribute('data-conversation-session')?.trim()
    if (direct) return direct
    // 某些移动端布局把 Composer 移到 sticky 容器，编辑器与会话根不再是同一棵 DOM 子树。
    // 当前页面只有一个可见会话时，按 Composer 反查对应根节点即可继续使用 scoped input。
    const editor = element?.closest('[contenteditable="true"], textarea, input, [role="textbox"], [data-composer-input="true"]')
    if (editor === null || editor === undefined) return undefined
    const candidates = [...document.querySelectorAll('[data-conversation-session]')]
      .filter((root) => root.querySelector('[contenteditable="true"], textarea, input, [role="textbox"], [data-composer-input="true"]') !== null)
    return candidates.length === 1 ? candidates[0]?.getAttribute('data-conversation-session')?.trim() : undefined
  }

  const refresh = (target: EventTarget | null): void => {
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
    const editor = element?.closest('[contenteditable="true"], textarea, input, [role="textbox"], [data-composer-input="true"]')
    const sessionId = sessionIdFor(element)
    if (!(editor instanceof HTMLElement) || sessionId === undefined || sessionId === '') return
    const input = inputFor(sessionId)
    if (input === undefined) return
    const snapshot = input.state.getSnapshot()
    if (snapshot.phase !== undefined && snapshot.phase !== 'plain') { close(); return }
    const snapshotDraft = snapshot.draft ?? ''
    const selection = input.caretSpan?.()
    const domCaret = editorCaretOffset(editor)
    const caret = Math.max(0, selection?.end ?? domCaret ?? snapshotDraft.length)
    // Lexical 输入更新先于 SessionInput 状态发布。若快照还没有本次输入的 `#`，
    // 使用编辑器当前文本完成识别，随后再由延迟重试同步到最新 draftRev。
    const domDraft = editorDraft(editor)
    const snapshotToken = hashTokenAtCaret(snapshotDraft, caret)
    const domToken = domDraft === undefined ? undefined : hashTokenAtCaret(domDraft, caret)
    const token = domToken ?? snapshotToken
    if (token === undefined) { close(); return }
    popupSessionId = sessionId
    popupToken = { ...token, end: caret, draftRev: selection?.draftRev ?? snapshot.draftRev ?? 0 }
    const root = ensurePopup(editor, sessionId)
    const query = token.query.trim().toLowerCase()
    if (popupMode === 'model' && popupAdapter !== undefined) {
      render(t('delegate.selectModel', { name: popupAdapter.label }), popupModels.filter((model) => query === '' || model.id.toLowerCase().includes(query) || model.label.toLowerCase().includes(query)).map((model) => ({ ...model, onClick: () => selectModel(model) })))
      return
    }
    popupMode = 'adapter'
    popupAdapter = undefined
    const requestId = ++popupRequestId
    void callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(options.rpc, 'catalog', { sessionId }).then((catalog) => {
      if (popup === undefined || popupSessionId !== sessionId || popupMode !== 'adapter' || popupRequestId !== requestId) return
      popupOptions = delegateAdapterOptions(adapterCatalogWithDsh(catalog, options.dshVersion))
      setDelegatePopupOptions(popupOptions)
      const rows = popupOptions
        .filter((item) => query === '' || item.id.toLowerCase().includes(query) || item.label.toLowerCase().includes(query))
        .map((item) => {
          const row: { id: string; label: string; detail?: string; iconId?: string; onClick: () => void } = {
            id: item.id,
            label: item.label,
            iconId: item.id,
            onClick: () => { void selectAdapter(item) },
          }
          if (item.detail !== undefined) row.detail = item.detail
          return row
        })
      render(t('delegate.selectAdapter'), rows)
    }).catch(() => { if (popup === root && popupRequestId === requestId) render(t('delegate.selectAdapter'), []) })
  }

  const scheduleRefresh = (target: EventTarget | null): void => {
    queueMicrotask(() => refresh(target))
    cancelRefresh()
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      refresh(target)
    }, 32)
  }
  const onInput = (event: Event): void => { scheduleRefresh(event.target) }
  const onCompositionEnd = (event: Event): void => { scheduleRefresh(event.target) }
  const onFocus = (event: FocusEvent): void => { scheduleRefresh(event.target) }
  const onKeyup = (event: KeyboardEvent): void => {
    if (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete') scheduleRefresh(event.target)
  }
  const onPointer = (event: Event): void => {
    const target = event.target
    if (popup !== undefined && target instanceof Node && !popup.contains(target)) {
      const element = target instanceof Element ? target : target.parentElement
      if (!element?.closest('[contenteditable="true"], textarea, input, [role="textbox"], [data-composer-input="true"]')) close()
    }
  }
  const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
  const onResize = (): void => position()
  document.addEventListener('input', onInput, true)
  document.addEventListener('compositionend', onCompositionEnd, true)
  document.addEventListener('focusin', onFocus, true)
  document.addEventListener('keyup', onKeyup, true)
  document.addEventListener('pointerdown', onPointer, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', onResize)
  window.visualViewport?.addEventListener('resize', onResize)
  window.visualViewport?.addEventListener('scroll', onResize)
  return () => {
    close()
    cancelRefresh()
    document.removeEventListener('input', onInput, true)
    document.removeEventListener('compositionend', onCompositionEnd, true)
    document.removeEventListener('focusin', onFocus, true)
    document.removeEventListener('keyup', onKeyup, true)
    document.removeEventListener('pointerdown', onPointer, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', onResize)
    window.visualViewport?.removeEventListener('resize', onResize)
    window.visualViewport?.removeEventListener('scroll', onResize)
  }
}

/** 读取编辑器当前文本；状态快照发布前先用 DOM 文本识别本轮输入。 */
function editorDraft(editor: HTMLElement): string | undefined {
  if ('value' in editor && typeof editor.value === 'string') return editor.value
  return typeof editor.textContent === 'string' ? editor.textContent : undefined
}

/** 返回光标在 contenteditable 文本投影中的偏移；无法读取时由调用方回退到 draft 末尾。 */
function editorCaretOffset(editor: HTMLElement): number | undefined {
  if ('selectionStart' in editor && typeof editor.selectionStart === 'number') return editor.selectionStart
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0 || selection.anchorNode === null || !editor.contains(selection.anchorNode)) return undefined
  try {
    const range = selection.getRangeAt(0).cloneRange()
    range.selectNodeContents(editor)
    range.setEnd(selection.anchorNode, selection.anchorOffset)
    return range.toString().length
  } catch {
    return undefined
  }
}

/** 匹配光标前最后一个以边界开头的 `#name` token；跨空格后停止，避免误触发。 */
function hashTokenAtCaret(draft: string, caret: number): { readonly start: number; readonly query: string } | undefined {
  const before = draft.slice(0, Math.max(0, caret))
  const hash = before.lastIndexOf('#')
  if (hash < 0 || /\s/u.test(before.slice(hash + 1))) return undefined
  const previous = before[hash - 1]
  if (hash > 0 && previous !== undefined && /[\p{L}\p{N}_]/u.test(previous)) return undefined
  return { start: hash, query: before.slice(hash + 1) }
}

function readSessionInput(ctx: Context, sessionId: string): SessionInputFace | undefined {
  try {
    const actx = readSessions(ctx)?.scope(sessionId)
    if (actx === undefined) return undefined
    return readConversation(ctx)?.input.for(actx)
  } catch {
    return undefined
  }
}

function readCommandUi(ctx: Context): CommandUiService | undefined {
  const service = readService<CommandUiService>(ctx, 'commandUi')
  return service !== undefined && typeof service.register === 'function' ? service : undefined
}

function readSessions(ctx: Context): SessionsService | undefined {
  const service = readService<SessionsService>(ctx, 'sessions')
  return service !== undefined && typeof service.scope === 'function' ? service : undefined
}

function readConversation(ctx: Context): ConversationService | undefined {
  const service = readService<ConversationService>(ctx, 'conversation')
  return service !== undefined && typeof service.input?.for === 'function' ? service : undefined
}

/** Cordis 直接读取未声明的服务会抛 without-inject；探测统一走这里。 */
function readService<T>(ctx: Context, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

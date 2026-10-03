import type { Context } from '@deepseek-ai/cordis'
import type { CodingNsCliAdapterDescriptor } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import type { CodingNsLocale } from './locale.js'
import { callCliRpc } from './cli-catalog.js'
import { appendDelegateCarrier, DELEGATE_COMMAND_NAME, delegateAdapterOptions } from './delegate-plan.js'
import { setDelegatePopupOptions, startDelegateUiDom } from './delegate-ui-dom.js'
import { resolveDelegateIcon } from '../dsh-capabilities/client/primitives-adapter.js'
import { debugInfo, debugWarn } from '../shared/debug.js'
import { encodeDelegationCarrier } from '../shared/delegation-carrier.js'

const DELEGATE_REFERENCE_SOURCE = 'codingns-delegate'
const delegateReferenceLabels = new Map<string, string>()

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
  readonly state: { getSnapshot(): { readonly draft: string; readonly draftRev?: number } }
  /** DSH 0.2 的输入外壳提供当前光标选择；旧版本没有该方法。 */
  caretSpan?(): { readonly start: number; readonly end: number }
  insertReference?(reference: ReferenceInsert, span: TokenSpan): boolean
  setDraft?(text: string): void
  notify(level: 'info' | 'error', text: string): void
}

interface SessionsService {
  scope(id: string): Context | undefined
}

interface ConversationService {
  readonly input: { for(actx: Context): SessionInputFace }
}

export interface RegisterDelegateCommandOptions {
  readonly rpc: CodingNsRpcClient
  readonly locale: CodingNsLocale
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
    registerDelegateReferenceSource(ctx, options)
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
          const list = delegateAdapterOptions(catalog)
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

/** 注册结构化 Agent 引用源：显示层使用 chip，提交层再序列化为 Host carrier。 */
function registerDelegateReferenceSource(ctx: Context, options: RegisterDelegateCommandOptions): void {
  const inputTriggers = readService<InputTriggersService>(ctx, 'inputTriggers')
  if (inputTriggers === undefined || typeof inputTriggers.registerSource !== 'function') return
  const source: InputTriggerSource = {
    trigger: '@',
    name: DELEGATE_REFERENCE_SOURCE,
    async candidates(session, request) {
      try {
        const catalog = await callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(options.rpc, 'catalog', { sessionId: session.sessionId })
        const query = request.query.trim().toLowerCase()
        const available = delegateAdapterOptions(catalog)
        // 让输入框中的 chip 也能按同一份目录补 Provider Logo。
        setDelegatePopupOptions(available)
        return available
          .filter((option) => query === '' || option.id.toLowerCase().includes(query) || option.label.toLowerCase().includes(query))
          .map((option) => {
            delegateReferenceLabels.set(option.id, option.label)
            return { name: option.id, label: option.label, value: option.id, icon: 'session' as const }
          })
      } catch {
        return []
      }
    },
    onPick(pick) {
      const ref = pick.candidate.value ?? pick.candidate.name
      const label = pick.candidate.label?.trim() || delegateReferenceLabels.get(ref) || ref
      delegateReferenceLabels.set(ref, label)
      return { insert: { source: DELEGATE_REFERENCE_SOURCE, ref, label, appearance: 'session', clipboardText: `@${label}` } }
    },
    codec: {
      clipboardText(ref) {
        return `@${delegateReferenceLabels.get(ref) || ref}`
      },
      async serialize(ref) {
        const label = delegateReferenceLabels.get(ref) || ref
        return encodeDelegationCarrier(ref, label)
      },
    },
  }
  try {
    ctx.effect(() => inputTriggers.registerSource(source), 'codingns4dsh: delegate reference source')
  } catch (error) {
    debugWarn('codingns4dsh: Agent 引用源注册失败', { error: error instanceof Error ? error.message : String(error) })
  }
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

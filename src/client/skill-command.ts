import type { Context } from '@deepseek-ai/cordis'
import type { CodingNsCliAdapterDescriptor, CodingNsCliSessionConfig, CodingNsCliSkillDescriptor } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import type { CodingNsLocale } from './locale.js'
import { callCliRpc } from './cli-catalog.js'
import { cliSessionSelectionRevision, waitForCliSessionSelection } from './cli-slots.js'
import { debugInfo, debugWarn } from '../shared/debug.js'
import { publishSkillCatalog } from './skill-reference-dom.js'

const SKILL_COMMAND_NAME = 'skills'
const SKILL_INPUT_SOURCE = 'codingns-skills'
const SKILL_CATALOG_CACHE_TTL_MS = 30_000

interface CommandUiService {
  register(contribution: CommandContribution): () => void
}

interface CommandContribution {
  readonly name: string
  label?(): string
  description?(): string
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
}

interface SessionInputFace {
  readonly state: { getSnapshot(): { readonly draft: string; readonly draftRev?: number } }
  caretSpan?(): { readonly start: number; readonly end: number; readonly draftRev?: number }
  insertReference?(reference: ReferenceInsert, span: TokenSpan): boolean
  setDraft?(text: string): void
  notify(level: 'info' | 'error', text: string): void
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

interface SessionsService {
  scope(id: string): Context | undefined
}

interface ConversationService {
  readonly input: { for(actx: Context): SessionInputFace }
}

/** DSH 输入框的 `/` 触发源；服务由 DSH 会话输入模块提供。 */
interface InputTriggersService {
  registerSource(source: SkillInputTriggerSource): () => void
}

interface SkillInputTriggerSource {
  readonly trigger: '/'
  readonly name: string
  readonly order?: number
  readonly showGroupTitle?: boolean
  candidates(session: { readonly sessionId: string }, request: {
    readonly query: string
    readonly quoted?: boolean
    readonly position?: 'leading' | 'inline'
    readonly drilled?: boolean
    readonly signal: AbortSignal
  }): Promise<readonly SkillInputCandidate[]>
  warm?(session: { readonly sessionId: string }): void
  lexicon?(session: { readonly sessionId: string }): readonly string[] | undefined
  subscribeLexicon?(session: { readonly sessionId: string }, listener: () => void): () => void
  onPick(pick: { readonly candidate: { readonly name: string; readonly label?: string; readonly value?: string } }): { readonly insert: ReferenceInsert } | { readonly text: string }
  readonly codec: {
    clipboardText(ref: string): string
    serialize(ref: string, signal: AbortSignal): Promise<string>
  }
}

interface SkillInputCandidate {
  readonly name: string
  readonly label?: string
  readonly description?: string
  readonly value?: string
}

interface SkillCatalogCache {
  readonly selectionRevision: number
  readonly loadedAt: number
  readonly catalog: readonly CodingNsCliSkillDescriptor[]
}

interface SkillCapabilityCache {
  readonly selectionRevision: number
  readonly supported: boolean
}

const skillCatalogCache = new Map<string, SkillCatalogCache>()
const skillCapabilityCache = new Map<string, SkillCapabilityCache>()

interface SkillRegistrationState {
  catalogReady: boolean
  disposeFallback: (() => void) | undefined
}

export interface RegisterSkillCommandOptions {
  readonly rpc: CodingNsRpcClient
  readonly locale: CodingNsLocale
}

/** 把声明了 Skill 能力的外部 Agent 目录接入 DSH `/` 菜单。 */
export function registerSkillCommand(ctx: Context, options: RegisterSkillCommandOptions): () => void {
  const state: SkillRegistrationState = { catalogReady: false, disposeFallback: undefined }
  const markCatalogReady = (catalog: readonly CodingNsCliSkillDescriptor[]): void => {
    if (!catalog.some((skill) => skill.enabled) || state.catalogReady) return
    state.catalogReady = true
    state.disposeFallback?.()
    state.disposeFallback = undefined
  }
  // 原生 inputTriggers 是首选入口；旧版/裁剪版 DSH 没有该服务时，保留可用的
  // commandUi 入口，避免 Skill 能力完全消失。两个服务的装配顺序不固定，原生
  // source 只有在目录成功返回后才主动撤销这个兜底入口。
  const commandFiber = ctx.inject(['commandUi'], (scope) => {
    if (state.catalogReady) return
    const dispose = registerSkillCommandFallback(scope, options, markCatalogReady)
    state.disposeFallback = dispose
  })
  const triggerFiber = ctx.inject(['inputTriggers'], (scope) => {
    registerSkillInputTriggerSource(scope, options, markCatalogReady)
  })
  return () => {
    state.disposeFallback?.()
    void commandFiber.dispose()
    void triggerFiber.dispose()
  }
}

/** 在没有原生 inputTriggers 时保留旧版 DSH 的可用 Skill 菜单。 */
function registerSkillCommandFallback(
  ctx: Context,
  options: RegisterSkillCommandOptions,
  onCatalogReady: (catalog: readonly CodingNsCliSkillDescriptor[]) => void,
): (() => void) | undefined {
  const commandUi = readCommandUi(ctx)
  if (commandUi === undefined) {
    debugWarn('codingns4dsh: /skills 未注册，当前 DSH 未提供 commandUi 服务')
    return undefined
  }
  const t = options.locale.bind('codingns')
  try {
    return ctx.effect(() => commandUi.register({
      name: SKILL_COMMAND_NAME,
      label: () => t('skills.label'),
      description: () => t('skills.description'),
      available: () => true,
      ui: {
        kind: 'popupSelect',
        searchMode: 'fuzzy-label',
        searchLabels: () => ({
          placeholder: t('skills.searchPlaceholder'),
          empty: t('skills.searchEmpty'),
          noResults: t('skills.searchNoResults'),
        }),
        async options(session, signal) {
          await waitForCliSessionSelection(session.sessionId)
          const catalog = await loadSkillCatalog(options.rpc, session.sessionId, signal, true)
          onCatalogReady(catalog)
          return catalog
            .filter((skill) => skill.enabled)
            .map((skill) => ({
              id: skill.name,
              label: skill.displayName ?? skill.name,
              ...(skill.description.trim() === '' ? {} : { detail: skill.description }),
            }))
        },
        onSelect(option, session) {
          const input = readSessionInput(ctx, session.sessionId)
          if (input === undefined || (input.setDraft === undefined && input.insertReference === undefined)) {
            input?.notify('error', t('skills.draftUnsupported'))
            return
          }
          const snapshot = input.state.getSnapshot()
          const draft = snapshot.draft ?? ''
          const selection = input.caretSpan?.()
          const span = skillCommandSpan(draft, snapshot.draftRev ?? selection?.draftRev ?? 0, selection)
          const token = `/${option.id} `
          const reference: ReferenceInsert = {
            source: SKILL_INPUT_SOURCE,
            ref: option.id,
            label: option.label,
            appearance: 'session',
            clipboardText: `/${option.id}`,
          }
          if (span !== undefined && input.insertReference?.(reference, span) === true) return
          if (input.setDraft === undefined) {
            input.notify('error', t('skills.draftUnsupported'))
            return
          }
          if (span !== undefined) {
            input.setDraft(`${draft.slice(0, span.start)}${token}${draft.slice(span.end)}`)
            return
          }
          const caret = selection?.end ?? draft.length
          input.setDraft(`${draft.slice(0, caret)}${token}${draft.slice(caret)}`)
        },
      },
    }), 'codingns4dsh: skills command')
  } catch (error) {
    debugWarn('codingns4dsh: /skills 命令注册失败', { error: error instanceof Error ? error.message : String(error) })
    return undefined
  }
}

/** 注册直接的 `/` Skill 搜索源。 */
function registerSkillInputTriggerSource(
  ctx: Context,
  options: RegisterSkillCommandOptions,
  onCatalogReady: (catalog: readonly CodingNsCliSkillDescriptor[]) => void,
): boolean {
  const inputTriggers = readService<InputTriggersService>(ctx, 'inputTriggers')
  if (inputTriggers === undefined || typeof inputTriggers.registerSource !== 'function') {
    debugWarn('codingns4dsh: Skill `/` 搜索源未注册，当前 DSH 未提供 inputTriggers 服务')
    return false
  }
  const source: SkillInputTriggerSource = {
    trigger: '/',
    name: SKILL_INPUT_SOURCE,
    order: 2,
    // Skill 行直接进入同一个 `/` 菜单，不再增加“技能”二级标题。
    showGroupTitle: false,
    async candidates(session, request) {
      try {
        await waitForCliSessionSelection(session.sessionId)
        const query = request.query.trim().toLocaleLowerCase()
        // 空查询表示用户刚打开 `/` 菜单，每次重新读取一次目录；继续输入时
        // 只在当前选择版本的短期缓存上过滤，避免每个字符都拉起 app-server RPC。
        const catalog = await loadSkillCatalog(options.rpc, session.sessionId, request.signal, query === '')
        onCatalogReady(catalog)
        return catalog
          .filter((skill) => skill.enabled)
          .filter((skill) => query === '' || [skill.name, skill.displayName, skill.description]
            .some((value) => value?.toLocaleLowerCase().includes(query) === true))
          .map((skill) => ({
            name: skill.name,
            label: skill.displayName ?? skill.name,
            value: skill.name,
            ...(skill.description.trim() === '' ? {} : { description: skill.description }),
          }))
      } catch (error) {
        debugWarn('codingns4dsh: 读取 Skill `/` 搜索目录失败', { error: error instanceof Error ? error.message : String(error) })
        return []
      }
    },
    warm(session) {
      const controller = new AbortController()
      void waitForCliSessionSelection(session.sessionId)
        .then(() => loadSkillCatalog(options.rpc, session.sessionId, controller.signal, true))
        .then((catalog) => { onCatalogReady(catalog) })
        .catch((error: unknown) => {
          debugWarn('codingns4dsh: 预热 Skill `/` 搜索目录失败', { error: error instanceof Error ? error.message : String(error) })
        })
    },
    lexicon(session) {
      const catalog = skillCatalogCache.get(session.sessionId)?.catalog
      return catalog?.filter((skill) => skill.enabled).map((skill) => skill.name)
    },
    onPick(pick) {
      const name = pick.candidate.value?.trim() || pick.candidate.name.trim()
      if (name === '') return { text: '' }
      return {
        insert: {
          source: SKILL_INPUT_SOURCE,
          ref: name,
          label: pick.candidate.label?.trim() || name,
          appearance: 'session',
          clipboardText: `/${name}`,
        },
      }
    },
    codec: {
      clipboardText(ref) {
        return `/${ref}`
      },
      async serialize(ref) {
        return `/${ref}`
      },
    }
  }
  try {
    ctx.effect(() => inputTriggers.registerSource(source), 'codingns4dsh: skill slash source')
    debugInfo('codingns4dsh: Skill `/` 搜索源已注册')
    return true
  } catch (error) {
    debugWarn('codingns4dsh: Skill `/` 搜索源注册失败', { error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

/** 按会话与 Agent 选择版本缓存目录，避免输入每个字符都请求外部 CLI。 */
async function loadSkillCatalog(
  rpc: CodingNsRpcClient,
  sessionId: string,
  signal: AbortSignal,
  forceReload: boolean,
): Promise<readonly CodingNsCliSkillDescriptor[]> {
  const selectionRevision = cliSessionSelectionRevision(sessionId)
  const cached = skillCatalogCache.get(sessionId)
  if (!forceReload && cached !== undefined
    && cached.selectionRevision === selectionRevision
    && Date.now() - cached.loadedAt < SKILL_CATALOG_CACHE_TTL_MS) {
    return cached.catalog
  }
  const supported = await supportsSelectedAgentSkills(rpc, sessionId, selectionRevision)
  if (!supported) {
    skillCatalogCache.set(sessionId, { selectionRevision, loadedAt: Date.now(), catalog: [] })
    publishSkillCatalog(sessionId, [])
    return []
  }
  const catalog = await callCliRpc<readonly CodingNsCliSkillDescriptor[]>(rpc, 'skills', {
    sessionId,
    forceReload: true,
  }, signal)
  skillCatalogCache.set(sessionId, { selectionRevision, loadedAt: Date.now(), catalog })
  publishSkillCatalog(sessionId, catalog)
  return catalog
}

/** 让原生 DSH Skill UI 处理 dsh 会话，插件只为声明了 skills 的外部适配器请求目录。 */
async function supportsSelectedAgentSkills(
  rpc: CodingNsRpcClient,
  sessionId: string,
  selectionRevision: number,
): Promise<boolean> {
  const cached = skillCapabilityCache.get(sessionId)
  if (cached?.selectionRevision === selectionRevision) return cached.supported
  const session = await callCliRpc<CodingNsCliSessionConfig>(rpc, 'session/get', { sessionId })
  if (session.adapterId === 'dsh') {
    skillCapabilityCache.set(sessionId, { selectionRevision, supported: false })
    return false
  }
  const catalog = await callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(rpc, 'catalog', {})
  const adapter = catalog.find((item) => item.id === session.adapterId)
  const supported = adapter?.capabilities?.includes('skills') === true
  skillCapabilityCache.set(sessionId, { selectionRevision, supported })
  return supported
}

function skillCommandSpan(
  draft: string,
  draftRev: number,
  selection?: { readonly start: number; readonly end: number },
): { readonly start: number; readonly end: number; readonly draftRev: number } | undefined {
  const caret = selection?.end ?? draft.length
  const token = /\/(?:skills|技能)(?=\s|$)/gu
  let match: RegExpExecArray | null
  while ((match = token.exec(draft)) !== null) {
    const start = match.index
    const end = start + match[0].length
    const before = draft[start - 1]
    if (start > 0 && before !== undefined && !/\s/u.test(before)) continue
    if (caret >= start && caret <= end + 1) return { start, end, draftRev }
    if (caret > end && draft.slice(end, caret).trim() === '') return { start, end, draftRev }
  }
  return undefined
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

function readService<T>(ctx: Context, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

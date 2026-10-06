import type { Context } from '@deepseek-ai/cordis'
import type { CodingNsCliSkillDescriptor } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import type { CodingNsLocale } from './locale.js'
import { callCliRpc } from './cli-catalog.js'
import { cliSessionSelectionRevision, waitForCliSessionSelection } from './cli-slots.js'
import { debugInfo, debugWarn } from '../shared/debug.js'

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

/** DSH 输入框的 `/` 触发源；服务由 DSH 会话输入模块提供。 */
interface InputTriggersService {
  registerSource(source: SkillInputTriggerSource): () => void
}

interface SkillInputTriggerSource {
  readonly trigger: '/'
  readonly name: string
  candidates(session: { readonly sessionId: string }, request: { readonly query: string; readonly signal: AbortSignal }): Promise<readonly SkillInputCandidate[]>
  onPick(pick: { readonly candidate: { readonly name: string; readonly value?: string } }): { readonly text: string }
}

interface SkillInputCandidate {
  readonly name: string
  readonly label: string
  readonly value?: string
  readonly detail?: string
}

interface SkillCatalogCache {
  readonly selectionRevision: number
  readonly loadedAt: number
  readonly catalog: readonly CodingNsCliSkillDescriptor[]
}

const skillCatalogCache = new Map<string, SkillCatalogCache>()

interface SessionInputFace {
  readonly state: { getSnapshot(): { readonly draft: string; readonly draftRev?: number } }
  caretSpan?(): { readonly start: number; readonly end: number; readonly draftRev?: number }
  setDraft?(text: string): void
  notify(level: 'info' | 'error', text: string): void
}

interface SessionsService {
  scope(id: string): Context | undefined
}

interface ConversationService {
  readonly input: { for(actx: Context): SessionInputFace }
}

export interface RegisterSkillCommandOptions {
  readonly rpc: CodingNsRpcClient
  readonly locale: CodingNsLocale
}

/** 把 Codex 原生 Skill 目录接入 DSH `/` 菜单。 */
export function registerSkillCommand(ctx: Context, options: RegisterSkillCommandOptions): () => void {
  const commandFiber = ctx.inject(['commandUi'], (scope) => {
    const commandUi = readCommandUi(scope)
    if (commandUi === undefined) {
      debugWarn('codingns4dsh: /skills 未注册，当前 DSH 未提供 commandUi 服务')
      return
    }
    const t = options.locale.bind('codingns')
    try {
      scope.effect(() => commandUi.register({
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
            return catalog
              .filter((skill) => skill.enabled)
              .map((skill) => ({
                id: skill.name,
                label: skill.displayName ?? skill.name,
                ...(skill.description.trim() === '' ? {} : { detail: skill.description }),
              }))
          },
          async onSelect(option, session) {
            const input = readSessionInput(scope, session.sessionId)
            if (input === undefined || input.setDraft === undefined) {
              input?.notify('error', t('skills.draftUnsupported'))
              return
            }
            const snapshot = input.state.getSnapshot()
            const draft = snapshot.draft ?? ''
            const selection = input.caretSpan?.()
            const span = skillCommandSpan(draft, snapshot.draftRev ?? selection?.draftRev ?? 0, selection)
            const token = `$${option.id} `
            if (span !== undefined) {
              input.setDraft(`${draft.slice(0, span.start)}${token}${draft.slice(span.end)}`)
              return
            }
            const caret = selection?.end ?? draft.length
            input.setDraft(`${draft.slice(0, caret)}${token}${draft.slice(caret)}`)
          },
        },
      }), 'codingns4dsh: skills command')
      debugInfo('codingns4dsh: /skills 命令已注册')
    } catch (error) {
      debugWarn('codingns4dsh: /skills 命令注册失败', { error: error instanceof Error ? error.message : String(error) })
    }
  })
  // `/` 触发源直接把当前 Agent 的 Skill 目录投影进原生斜杠菜单，
  // 不再要求用户先点击 `/skills` 再进入二级列表。
  const triggerFiber = ctx.inject(['inputTriggers'], (scope) => {
    registerSkillInputTriggerSource(scope, options)
  })
  return () => {
    void commandFiber.dispose()
    void triggerFiber.dispose()
  }
}

/** 注册直接的 `/` Skill 搜索源；服务不存在时由 DSH 原生命令菜单兜底。 */
function registerSkillInputTriggerSource(ctx: Context, options: RegisterSkillCommandOptions): void {
  const inputTriggers = readService<InputTriggersService>(ctx, 'inputTriggers')
  if (inputTriggers === undefined || typeof inputTriggers.registerSource !== 'function') {
    debugWarn('codingns4dsh: Skill `/` 搜索源未注册，当前 DSH 未提供 inputTriggers 服务')
    return
  }
  const source: SkillInputTriggerSource = {
    trigger: '/',
    name: SKILL_INPUT_SOURCE,
    async candidates(session, request) {
      try {
        await waitForCliSessionSelection(session.sessionId)
        const query = request.query.trim().toLocaleLowerCase()
        // 空查询表示用户刚打开 `/` 菜单，每次重新读取一次目录；继续输入时
        // 只在当前选择版本的短期缓存上过滤，避免每个字符都拉起 app-server RPC。
        const catalog = await loadSkillCatalog(options.rpc, session.sessionId, request.signal, query === '')
        return catalog
          .filter((skill) => skill.enabled)
          .filter((skill) => query === '' || [skill.name, skill.displayName, skill.description]
            .some((value) => value?.toLocaleLowerCase().includes(query) === true))
          .map((skill) => ({
            name: skill.name,
            label: skill.displayName ?? skill.name,
            value: skill.name,
            ...(skill.description.trim() === '' ? {} : { detail: skill.description }),
          }))
      } catch (error) {
        debugWarn('codingns4dsh: 读取 Skill `/` 搜索目录失败', { error: error instanceof Error ? error.message : String(error) })
        return []
      }
    },
    onPick(pick) {
      const name = pick.candidate.value?.trim() || pick.candidate.name.trim()
      return { text: name === '' ? '' : `$${name} ` }
    },
  }
  try {
    ctx.effect(() => inputTriggers.registerSource(source), 'codingns4dsh: skill slash source')
    debugInfo('codingns4dsh: Skill `/` 搜索源已注册')
  } catch (error) {
    debugWarn('codingns4dsh: Skill `/` 搜索源注册失败', { error: error instanceof Error ? error.message : String(error) })
  }
}

/** 按会话与 Agent 选择版本缓存目录，避免输入每个字符都请求 Codex。 */
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
  const catalog = await callCliRpc<readonly CodingNsCliSkillDescriptor[]>(rpc, 'skills', {
    sessionId,
    forceReload: true,
  }, signal)
  skillCatalogCache.set(sessionId, { selectionRevision, loadedAt: Date.now(), catalog })
  return catalog
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

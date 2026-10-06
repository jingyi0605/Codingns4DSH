import type { Context } from '@deepseek-ai/cordis'
import type { CodingNsCliSkillDescriptor } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import type { CodingNsLocale } from './locale.js'
import { callCliRpc } from './cli-catalog.js'
import { cliSessionSelectionRevision, waitForCliSessionSelection } from './cli-slots.js'
import { debugInfo, debugWarn } from '../shared/debug.js'

const SKILL_INPUT_SOURCE = 'codingns-skills'
const SKILL_CATALOG_CACHE_TTL_MS = 30_000

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
  onPick(pick: { readonly candidate: { readonly name: string; readonly value?: string } }): { readonly text: string }
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

const skillCatalogCache = new Map<string, SkillCatalogCache>()

export interface RegisterSkillCommandOptions {
  readonly rpc: CodingNsRpcClient
  readonly locale: CodingNsLocale
}

/** 把 Codex 原生 Skill 目录接入 DSH `/` 菜单。 */
export function registerSkillCommand(ctx: Context, options: RegisterSkillCommandOptions): () => void {
  // DSH >= 0.2.0-rc.2 已提供 inputTriggers。Skill 必须只注册为原生 `/` source，
  // 否则 commandUi 的旧 popupSelect 会在服务装配竞态下留下二级菜单入口。
  const triggerFiber = ctx.inject(['inputTriggers'], (scope) => {
    registerSkillInputTriggerSource(scope, options)
  })
  return () => {
    void triggerFiber.dispose()
  }
}

/** 注册直接的 `/` Skill 搜索源。 */
function registerSkillInputTriggerSource(ctx: Context, options: RegisterSkillCommandOptions): boolean {
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
      void loadSkillCatalog(options.rpc, session.sessionId, controller.signal, true).catch((error: unknown) => {
        debugWarn('codingns4dsh: 预热 Skill `/` 搜索目录失败', { error: error instanceof Error ? error.message : String(error) })
      })
    },
    lexicon(session) {
      const catalog = skillCatalogCache.get(session.sessionId)?.catalog
      return catalog?.filter((skill) => skill.enabled).map((skill) => skill.name)
    },
    onPick(pick) {
      const name = pick.candidate.value?.trim() || pick.candidate.name.trim()
      return { text: name === '' ? '' : `$${name} ` }
    },
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

function readService<T>(ctx: Context, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

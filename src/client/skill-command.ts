import type { Context } from '@deepseek-ai/cordis'
import type { CodingNsCliSkillDescriptor } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import type { CodingNsLocale } from './locale.js'
import { callCliRpc } from './cli-catalog.js'
import { waitForCliSessionSelection } from './cli-slots.js'
import { debugInfo, debugWarn } from '../shared/debug.js'

const SKILL_COMMAND_NAME = 'skills'

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
  const fiber = ctx.inject(['commandUi'], (scope) => {
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
            const catalog = await callCliRpc<readonly CodingNsCliSkillDescriptor[]>(options.rpc, 'skills', {
              sessionId: session.sessionId,
              forceReload: true,
            }, signal)
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
  return () => { void fiber.dispose() }
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

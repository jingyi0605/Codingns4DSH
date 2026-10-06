import { parseAssistantIntent, type AssistantIntentOptions } from './assistant-intent.js'
import { summarizeAssistantEntries } from './assistant-summary.js'
import { AssistantDispatcher, type AssistantDispatchContext } from './assistant-dispatch.js'
import type { AssistantIndexSnapshot } from '../../shared/contracts/assistant.js'

export interface AssistantVoiceTurnResult {
  readonly kind: 'summary' | 'dispatch' | 'clarify' | 'chat'
  readonly speechText: string
  readonly target?: { readonly sessionId: string; readonly workspaceId: string; readonly hostId: string }
  readonly mode?: 'queue' | 'steer'
  readonly task?: string
  readonly candidates?: readonly string[]
}

export interface AssistantVoiceTurnOptions {
  readonly requestId?: string
  readonly intent?: AssistantIntentOptions
  readonly dispatchContext: AssistantDispatchContext
}

/** 把全局语音最终文本串起「意图→摘要/派发→可播报结果」，不保存当前页面会话。 */
export class AssistantVoiceTurnRouter {
  constructor(private readonly dispatcher: AssistantDispatcher) {}

  async handleText(text: string, snapshot: AssistantIndexSnapshot, options: AssistantVoiceTurnOptions): Promise<AssistantVoiceTurnResult> {
    const intent = parseAssistantIntent(text, snapshot.entries, {
      ...options.intent,
      indexGeneration: snapshot.generation,
      ...(snapshot.excludedTargets === undefined ? {} : { excludedTargets: snapshot.excludedTargets }),
    })
    if (snapshot.scope.status === 'empty' && intent.targetDescription !== undefined) {
      return {
        kind: 'clarify',
        speechText: '尚未选择任何工作区，无法访问会话；请打开全局智能助理设置并勾选工作区后重试',
        ...(intent.task === undefined ? {} : { task: intent.task }),
        ...(intent.mode === undefined ? {} : { mode: intent.mode }),
      }
    }
    if (intent.kind === 'summary') {
      return {
        kind: 'summary',
        speechText: summarizeAssistantEntries(snapshot.entries, snapshot.scope, snapshot.generation, snapshot.unreadableCount).speechText,
      }
    }
    if (intent.kind !== 'dispatch' || intent.target === undefined || intent.task === undefined || intent.mode === undefined) {
      return {
        kind: intent.kind,
        speechText: intent.reason ?? '请说明要查询进展，或指出要处理任务的工作区和会话。',
        ...(intent.candidates === undefined ? {} : { candidates: intent.candidates.map((entry) => entry.title ?? entry.sessionId) }),
      }
    }
    const requestId = options.requestId?.trim() || `voice-${snapshot.generation}-${intent.target.sessionId}`
    const result = await this.dispatcher.dispatch({ requestId, target: intent.target, mode: intent.mode, task: intent.task }, options.dispatchContext)
    if (!result.ok) return { kind: 'clarify', speechText: result.message, task: intent.task, mode: intent.mode }
    const targetEntry = snapshot.entries.find((entry) => entry.sessionId === intent.target?.sessionId)
    const targetName = targetEntry === undefined
      ? '目标会话'
      : `工作区${targetEntry.workspaceName}的${targetEntry.title ?? targetEntry.sessionId}`
    return {
      kind: 'dispatch',
      speechText: `已将任务发送到${targetName}，模式为${intent.mode === 'steer' ? '立即注入' : '排队'}。`,
      target: intent.target,
      mode: intent.mode,
      task: intent.task,
    }
  }
}

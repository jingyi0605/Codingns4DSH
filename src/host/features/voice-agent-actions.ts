import { randomUUID } from 'node:crypto'
import { parseAssistantIntent } from './assistant-intent.js'
import { summarizeAssistantEntries } from './assistant-summary.js'
import { AssistantVoiceTurnRouter, type AssistantVoiceTurnResult } from './assistant-voice-turn.js'
import type { AssistantDispatchContext } from './assistant-dispatch.js'
import type { AssistantProgressSummary } from '../../shared/contracts/assistant.js'
import type { AssistantSessionIndexSnapshot } from './assistant-session-index.js'
import {
  VoiceAgentService,
  type VoiceActionRegistration,
  type VoiceConversation,
  type VoiceEvent,
} from './voice-agent-service.js'

export interface AssistantVoiceActionBridgeOptions {
  readonly voiceAgent: VoiceAgentService
  /** 动作 owner 前缀只标识全局语音助理，不包含当前 DSH sessionId。 */
  readonly ownerPrefix: string
  readonly buildIndex: () => Promise<AssistantSessionIndexSnapshot>
  readonly createDispatchContext: (snapshot: AssistantSessionIndexSnapshot) => AssistantDispatchContext
  readonly router: AssistantVoiceTurnRouter
}

export interface AssistantVoiceActionBridge {
  register(): VoiceActionRegistration
  handleFinalText(text: string, requestId?: string): Promise<AssistantVoiceTurnResult>
  dispose(): Promise<void>
}

/**
 * 把全局语音最终文本接入 voiceAgent 动作注册表。
 *
 * 运行时只送入一条 action 事件；动作本身重新读取索引，并由
 * AssistantVoiceTurnRouter/AssistantDispatcher 做第二次范围、归档和代次校验。
 * 因而最终文本、动作结果和目标会话之间没有隐含的当前页面 session 绑定。
 */
export function createAssistantVoiceActionBridge(options: AssistantVoiceActionBridgeOptions): AssistantVoiceActionBridge {
  let registration: VoiceActionRegistration | undefined
  let conversationPromise: Promise<VoiceConversation> | undefined
  let unsubscribe: (() => void) | undefined
  const pending = new Map<string, (event: Extract<VoiceEvent, { type: 'action-result' }>) => void>()

  const ensureConversation = async (): Promise<VoiceConversation> => {
    if (conversationPromise !== undefined) return conversationPromise
    conversationPromise = options.voiceAgent.startConversation({ ownerId: options.ownerPrefix })
      .then((conversation) => {
        unsubscribe = conversation.subscribe((event) => {
          if (event.type !== 'action-result') return
          pending.get(event.callId)?.(event)
        })
        return conversation
      })
    return conversationPromise
  }

  const runAction = async (name: 'summarize' | 'dispatch', args: Record<string, unknown>): Promise<unknown> => {
    const conversation = await ensureConversation()
    const callId = `assistant-action-${randomUUID()}`
    const result = new Promise<Extract<VoiceEvent, { type: 'action-result' }>>((resolve) => pending.set(callId, resolve))
    try {
      conversation.handleEvent({ type: 'action', callId, name, arguments: JSON.stringify(args) })
      const event = await result
      if (event.ok !== true) throw new Error(event.error ?? '语音动作结算失败')
      return event.output
    } finally {
      pending.delete(callId)
    }
  }

  const bridge: AssistantVoiceActionBridge = {
    register: () => {
      registration ??= options.voiceAgent.registerActions(options.ownerPrefix, {
        assistant_command: {
          execute: async (args) => {
            const request = parseDispatchActionArgs(args)
            return bridge.handleFinalText(request.text, request.requestId)
          },
        },
        summarize: {
          execute: async () => {
            const snapshot = await options.buildIndex()
            return summarizeAssistantEntries(snapshot.entries, snapshot.scope, snapshot.generation, snapshot.unreadableCount)
          },
        },
        dispatch: {
          execute: async (args) => {
            const request = parseDispatchActionArgs(args)
            const snapshot = await options.buildIndex()
            return options.router.handleText(request.text, snapshot, {
              requestId: request.requestId,
              dispatchContext: options.createDispatchContext(snapshot),
            })
          },
        },
      })
      return registration
    },

    async handleFinalText(text, requestId) {
      bridge.register()
      const normalized = text.trim()
      if (normalized === '') return { kind: 'chat', speechText: '没有识别到有效语音内容。' }
      const snapshot = await options.buildIndex()
      const intent = parseAssistantIntent(normalized, snapshot.entries, {
        indexGeneration: snapshot.generation,
        ...(snapshot.excludedTargets === undefined ? {} : { excludedTargets: snapshot.excludedTargets }),
      })
      if (intent.kind === 'summary') {
        const summary = await runAction('summarize', {}) as AssistantProgressSummary
        return { kind: 'summary', speechText: summary.speechText }
      }
      if (intent.kind === 'dispatch') {
        const result = await runAction('dispatch', {
          text: normalized,
          requestId: requestId?.trim() || `voice-${randomUUID()}`,
        })
        return result as AssistantVoiceTurnResult
      }
      return options.router.handleText(normalized, snapshot, {
        requestId: requestId?.trim() || `voice-${randomUUID()}`,
        dispatchContext: options.createDispatchContext(snapshot),
      })
    },

    async dispose() {
      registration?.dispose()
      registration = undefined
      unsubscribe?.()
      unsubscribe = undefined
      if (conversationPromise !== undefined) await (await conversationPromise).end()
      conversationPromise = undefined
      for (const resolve of pending.values()) resolve({ type: 'action-result', callId: '', name: '', ok: false, error: '语音动作桥已关闭' })
      pending.clear()
    },
  }
  return bridge
}

function parseDispatchActionArgs(value: unknown): { readonly text: string; readonly requestId: string } {
  if (!isRecord(value) || typeof value.text !== 'string' || value.text.trim() === '') {
    throw new TypeError('语音派发动作缺少 text')
  }
  const requestId = typeof value.requestId === 'string' && value.requestId.trim() !== ''
    ? value.requestId.trim()
    : `voice-${randomUUID()}`
  return { text: value.text.trim(), requestId }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

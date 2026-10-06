import type {
  CodingNsAgentEvent,
  CodingNsAgentPermissionResponse,
  CodingNsAgentQuestionResponse,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { JsonRpcMessage } from './json-rpc-process.js'
import { readAgentQuestions } from './interaction-events.js'

type InteractionEvent = Extract<CodingNsAgentEvent, { type: 'permission-request' | 'question-request' }>

/** ZCode 用交互 requestId 标识业务请求，RPC id 仅用于线协议应答。 */
export interface ZcodeInteraction {
  readonly event: InteractionEvent
  permissionResponse(response: CodingNsAgentPermissionResponse): unknown
  questionResponse(response: CodingNsAgentQuestionResponse): unknown
  readonly cancelled: unknown
}

/** 缺省权限必须覆盖恢复会话残留的 yolo 模式，不能沿用 Provider 的宽松设置。 */
export function zcodePermissionMode(input: CodingNsCliTurnInput): 'plan' | 'build' | 'edit' | 'yolo' {
  if (input.plan === true || input.permission?.sandboxMode === 'read-only') return 'plan'
  if (input.permission?.approvalPolicy !== 'never') return 'build'
  if (input.permission.sandboxMode === 'danger-full-access') return 'yolo'
  return input.permission.sandboxMode === 'workspace-write' ? 'edit' : 'build'
}

/** 只识别真正的反向 RPC 请求，不把流式工具快照再次当成问题。 */
export function readZcodeInteraction(message: JsonRpcMessage): ZcodeInteraction | null {
  if (typeof message.id !== 'string' && typeof message.id !== 'number') return null
  const params = isRecord(message.params) ? message.params : {}
  const requestId = text(params.requestId) ?? String(message.id)
  const callId = text(params.toolCallId)
  const toolName = text(params.toolName)
  const withCall = callId === undefined ? {} : { callId }
  const detail = [text(params.reason), stringify(params.input)].filter(Boolean).join('\n')
  if (message.method === 'interaction/requestPermission') {
    return {
      event: { type: 'permission-request', requestId, kind: 'tool', ...withCall,
        ...(toolName === undefined ? {} : { toolName }), ...(detail ? { detail } : {}) },
      permissionResponse: (response) => ({ decision: response.approved ? 'allow' : 'deny',
        ...(response.reason === undefined ? {} : { reason: response.reason }) }),
      questionResponse: () => ({ decision: 'deny' }),
      cancelled: { decision: 'deny', reason: 'DSH 交互已取消' },
    }
  }
  if (message.method !== 'interaction/requestUserInput') return null
  const schema = isRecord(params.schema) ? params.schema : {}
  // ExitPlanMode 也是 requestUserInput，但它授权实施计划，必须走审批入口。
  if (schema.interaction === 'plan_approval') {
    const plan = isRecord(params.input) ? text(params.input.plan) : undefined
    return {
      event: { type: 'permission-request', requestId, kind: 'plan', ...withCall,
        toolName: toolName ?? 'exitPlanMode', ...(plan ? { detail: plan } : {}) },
      permissionResponse: (response) => response.approved
        ? { action: 'accept', content: { answer: 'approve' } }
        : { action: 'decline', ...(response.reason === undefined ? {} : { reason: response.reason }) },
      questionResponse: () => ({ action: 'decline' }),
      cancelled: { action: 'cancel' },
    }
  }
  const source = Array.isArray(params.questions) ? params.questions : []
  const questions = readAgentQuestions(source)
  if (questions.length === 0) return null
  return {
    event: { type: 'question-request', requestId, questions, ...withCall },
    permissionResponse: () => ({ action: 'cancel' }),
    questionResponse: (response) => {
      if (response.answers.length === 0) return { action: 'cancel' }
      const answers: Record<string, string[]> = {}
      for (const question of questions) {
        const answer = response.answers.find((item) => item.id === question.id)
        if (answer === undefined) continue
        // ZCode 不接受 DSH 的 question-N 键：答案键必须是原始问题正文。
        const original = source.find((item) => isRecord(item) && text(item.question)?.trim() === question.question)
        if (!isRecord(original) || typeof original.question !== 'string') continue
        const options = Array.isArray(original.options) ? original.options : []
        answers[original.question] = [
          ...answer.selected.map((label) => {
            const option = options.find((item) => isRecord(item) && text(item.label)?.trim() === label)
            return isRecord(option) ? text(option.value) ?? label : label
          }),
          ...(answer.custom?.trim() ? [answer.custom.trim()] : []),
        ]
      }
      return { action: 'accept', content: { answers } }
    },
    cancelled: { action: 'cancel' },
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function stringify(value: unknown): string | undefined {
  return value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

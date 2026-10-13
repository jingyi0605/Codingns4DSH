import type { CodingNsCliAdapterDescriptor, CodingNsCliMessage } from '../../shared/contracts/cli-adapter.js'
import { parseDelegationCarriers } from '../../shared/delegation-carrier.js'

export interface DelegationRewriteTarget {
  readonly adapterId: string
  readonly label: string
  readonly capabilities: readonly string[]
  /** carrier v2 中用户明确选择的模型；旧 v1 carrier 不带此字段。 */
  readonly modelId?: string
}

export interface DelegationRewriteResult {
  readonly messages: readonly CodingNsCliMessage[]
  readonly targets: readonly DelegationRewriteTarget[]
  readonly task: string
  readonly instruction: string
}

export interface DelegationRewriteError {
  readonly code: 'DELEGATE_CARRIER_INVALID' | 'DELEGATE_TARGET_UNAVAILABLE' | 'DELEGATE_TASK_EMPTY'
  readonly message: string
  readonly adapterIds: readonly string[]
}

export type DelegationRewriteOutcome =
  | { readonly kind: 'none'; readonly messages: readonly CodingNsCliMessage[] }
  | { readonly kind: 'rewritten'; readonly value: DelegationRewriteResult }
  | { readonly kind: 'error'; readonly error: DelegationRewriteError }

/** 判断当前提交是否含有委派 carrier，避免普通对话每轮读取完整 Agent 目录。 */
export function containsDelegationCarrier(messages: readonly CodingNsCliMessage[]): boolean {
  return messages.some((message) => typeof message.content === 'string'
    ? message.content.includes('<!--codingns:delegate:')
    : Array.isArray(message.content) && message.content.some((part) => isRecord(part) && typeof part.text === 'string' && part.text.includes('<!--codingns:delegate:')))
}

/** 首轮检测尚未完成时，只等待本次委派明确选择的适配器。 */
export function delegationAdapterIds(messages: readonly CodingNsCliMessage[]): string[] {
  const message = messages[findLatestHumanMessage(messages)]
  return message === undefined ? [] : parseDelegationCarriers(extractText(message.content)).carriers.map((carrier) => carrier.adapterId)
}

/** 在普通对话进入当前 Agent 前消费 carrier；不使用历史消息填充空任务。 */
export function rewriteDelegationMessages(
  messages: readonly CodingNsCliMessage[],
  catalog: readonly CodingNsCliAdapterDescriptor[],
): DelegationRewriteOutcome {
  const index = findLatestHumanMessage(messages)
  if (index < 0) return { kind: 'none', messages }
  const message = messages[index]
  if (message === undefined) return { kind: 'none', messages }
  const sourceText = extractText(message.content)
  const parsed = parseDelegationCarriers(sourceText)
  if (!parsed.found) return { kind: 'none', messages }
  if (parsed.errors.length > 0) {
    return { kind: 'error', error: { code: 'DELEGATE_CARRIER_INVALID', message: parsed.errors[0] ?? 'The delegation carrier is invalid.', adapterIds: [] } }
  }
  const unavailable: string[] = []
  const targets: DelegationRewriteTarget[] = []
  for (const carrier of parsed.carriers) {
    const descriptor = carrier.adapterId === 'dsh'
      ? { id: 'dsh', name: 'DeepSeek Harness', installed: true, enabled: true, capabilities: ['continuable', 'reasoning'] as const }
      : catalog.find((item) => item.id === carrier.adapterId)
    if (descriptor === undefined || !descriptor.installed || !descriptor.enabled) unavailable.push(carrier.adapterId)
    if (descriptor !== undefined) targets.push({
      adapterId: descriptor.id,
      label: carrier.label || descriptor.name,
      capabilities: descriptor.capabilities ?? [],
      ...(carrier.modelId === undefined ? {} : { modelId: carrier.modelId }),
    })
  }
  if (unavailable.length > 0) {
    return {
      kind: 'error',
      error: {
        code: 'DELEGATE_TARGET_UNAVAILABLE',
        message: `Delegation targets are not installed or enabled: ${unavailable.join(', ')}`,
        adapterIds: unavailable,
      },
    }
  }
  const task = parsed.text.replace(/^\/(?:delegate|委派)\s*/u, '').trim()
  if (targets.length === 0 || task === '') {
    return {
      kind: 'error',
      error: {
        code: 'DELEGATE_TASK_EMPTY',
        message: 'The delegation task description cannot be empty. Add a task after the Agent mention.',
        adapterIds: targets.map((target) => target.adapterId),
      },
    }
  }
  const instruction = buildDelegationInstruction(task, targets)
  const rewrittenMessage = replaceText(message, instruction)
  const rewritten = [...messages]
  rewritten[index] = rewrittenMessage
  return {
    kind: 'rewritten',
    value: { messages: rewritten, targets, task, instruction },
  }
}

function buildDelegationInstruction(task: string, targets: readonly DelegationRewriteTarget[]): string {
  const allowed = targets.map((target) => `- ${target.adapterId} (${target.label}, model: ${target.modelId ?? 'adapter default'}, capabilities: ${target.capabilities.length === 0 ? 'none declared' : target.capabilities.join(', ')})`).join('\n')
  return [
    '[CodingNS delegation instructions]',
    `Task: ${task}`,
    'Allowed external Agents:',
    allowed,
    'First create a short role and step plan from the task semantics. Specify the target Agent, responsibility, and dependsOn for every step. The current Agent assigns implementation, testing, and review roles after understanding the task; the Host does not guess them.',
    'Then use the existing agent_subagent tool to delegate. Every subtask must use one of the stable adapterIds listed above and run in an independent child session. A dependent step must wait/read its prerequisite child session until it is completed. A failed subagent must be inspected with read/wait before it is recreated or taken over with send. The current Agent must report creation, running, completion, and failure states to the user; creating a child session does not mean the task is complete.',
  ].join('\n')
}

function findLatestHumanMessage(messages: readonly CodingNsCliMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.role === 'user' && isHumanSource(message.source)) return index
  }
  return -1
}

function isHumanSource(source: unknown): boolean {
  if (source === undefined) return true
  if (!isRecord(source)) return false
  return source.kind === undefined || source.kind === 'user'
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(isRecord).map((part) => typeof part.text === 'string' ? part.text : '').join('\n')
}

function replaceText(message: CodingNsCliMessage, text: string): CodingNsCliMessage {
  if (typeof message.content === 'string') return { ...message, content: text }
  if (!Array.isArray(message.content)) return { ...message, content: text }
  let replaced = false
  const content = message.content.map((part) => {
    if (!isRecord(part) || typeof part.text !== 'string') return part
    if (replaced) return { ...part, text: '' }
    replaced = true
    return { ...part, text }
  }).filter((part) => !isRecord(part) || part.text !== '')
  return { ...message, content: replaced ? content : [{ type: 'text', text }, ...content] }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

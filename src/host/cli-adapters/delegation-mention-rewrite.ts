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
    return { kind: 'error', error: { code: 'DELEGATE_CARRIER_INVALID', message: parsed.errors[0] ?? '委派 carrier 无效。', adapterIds: [] } }
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
        message: `委派目标未安装或已停用：${unavailable.join('、')}`,
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
        message: '委派任务描述不能为空，请在 Agent mention 后补充任务。',
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
  const allowed = targets.map((target) => `- ${target.adapterId}（${target.label}，模型：${target.modelId ?? '适配器默认'}，能力：${target.capabilities.length === 0 ? '未声明' : target.capabilities.join('、')}）`).join('\n')
  return [
    '[CodingNS 委派指令]',
    `任务：${task}`,
    '允许使用的外部 Agent：',
    allowed,
    '请先根据任务语义制定简短的角色和步骤计划：明确每一步的目标 Agent、职责和 dependsOn。实现、测试、复核等角色由当前 Agent 理解任务后分配，不由 Host 猜测。',
    '然后调用已有 agent_subagent 工具执行委派。每个子任务必须使用上面列出的稳定 adapterId，保持子任务在独立子会话中运行；有 dependsOn 的后置步骤必须先 wait/read 前置 child session 直到 completed，再启动后置步骤。任何 failed 子代理都必须先 read/wait 查看状态，评估是否重新创建或用 send 接管；当前 Agent 负责向用户说明创建、运行、完成和失败状态，不要把创建成功当作任务完成。',
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

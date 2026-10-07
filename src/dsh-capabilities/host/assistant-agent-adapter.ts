import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createDshCapabilityRegistry } from '../routes.js'
import type { AssistantChatMessage, AssistantChatModel, AssistantToolCall } from '../../shared/contracts/assistant.js'
import type { AssistantLlmAdapter } from './assistant-llm-adapter.js'
import type { AssistantManagementTool } from '../../host/features/assistant-management-tools.js'
import { readAssistantAttachmentStore, createAssistantAttachmentTool, type AssistantAttachmentStore } from './assistant-attachment-adapter.js'
import type { AssistantAttachment } from '../../shared/assistant-attachments.js'

export const ASSISTANT_AGENT_PREFIX = 'codingns-assistant-'
// 所有原生服务形状只存在于此兼容边界；业务层仍使用稳定的文本轮次契约。
interface AgentHandle {
  agent: { id: string; followup(message: unknown): void; cancel(cause: { kind: 'user' }): void; whenIdle(): Promise<void> }
  dispose(): Promise<void>
}
interface AgentRegistry { create(options: Record<string, unknown>): Promise<AgentHandle> }
interface ActiveReply {
  system: string
  startedAt: string
  signal: AbortSignal
  text: string
  error: Error | undefined
  steps: number
  calls: number
  finished: boolean
  onText(text: string): void
  onTool?: ((call: AssistantToolCall) => void) | undefined
  toolCalls: Map<string, AssistantToolCall>
}

/** Host 内常驻根 Agent。共享对话存储是历史来源，重建运行实例不会丢失文本／语音记录。 */
export class AssistantAgentAdapter implements AssistantLlmAdapter {
  private handle: AgentHandle | undefined
  private active: ActiveReply | undefined
  private history: readonly AssistantChatMessage[] = []
  private selection = ''
  private readonly attachedFiles = new Map<string, AssistantAttachment>()
  private serial: Promise<unknown> = Promise.resolve()
  private disposed = false
  private readonly lifetime = new AbortController()
  readonly sessionIds = new Set<string>()

  constructor(private readonly registry: AgentRegistry | undefined, private readonly llm: AssistantLlmAdapter | undefined,
    private readonly tools: readonly AssistantManagementTool[], private readonly workspace = join(process.env.CODINGNS4DSH_STATE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'codingns4dsh'), 'assistant-workspace'),
    private readonly prepareDirectory: (path: string) => Promise<unknown> = (path) => mkdir(path, { recursive: true }),
    private readonly attachments?: AssistantAttachmentStore) {}

  async catalog() { return this.llm?.catalog() ?? { models: [], default: null, errors: ['DSH 原生 LLM 服务不可用'] } }

  reply(model: AssistantChatModel, system: string, messages: readonly AssistantChatMessage[], signal: AbortSignal, onText: (text: string) => void,
    _options?: { readonly maxTokens: number; readonly reasoningEffort?: string }, onTool?: (call: AssistantToolCall) => void): Promise<string> {
    // 取消上一轮后，必须等它的原生驱动退出；新轮次不能误认旧事件或重用仍在运行的 Agent。
    const ownedSignal = AbortSignal.any([signal, this.lifetime.signal])
    const task = this.serial.then(() => this.run(model, system, messages, ownedSignal, onText, onTool))
    this.serial = task.catch(() => undefined)
    return task
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.lifetime.abort(new Error('助理 Agent 已释放'))
    this.handle?.agent.cancel({ kind: 'user' })
    await this.serial
    await this.reset()
  }

  private async run(model: AssistantChatModel, system: string, messages: readonly AssistantChatMessage[], signal: AbortSignal, onText: (text: string) => void, onTool?: (call: AssistantToolCall) => void): Promise<string> {
    signal.throwIfAborted()
    if (this.disposed) throw new Error('助理 Agent 已释放')
    if (this.registry === undefined || this.llm?.assistantOptions === undefined) throw new Error('当前 Host 不支持受限助理 Agent；正式对话不能退回无工具的直接 LLM 调用')
    const limits = await this.llm.assistantOptions(model, signal)
    const key = JSON.stringify([model.provider, model.model, limits])
    const history = messages.slice(0, -1)
    // 压缩、清理、模型变更和失败后都从权威共享历史重建；正常连续轮次复用同一根 Agent。
    if (key !== this.selection || JSON.stringify(history) !== JSON.stringify(this.history.slice(-18))) await this.reset()
    // 正常轮次保持原生 Agent 连续运行，压力阈值和上下文溢出交给 DSH 自动压缩。
    for (const message of messages) for (const attachment of message.attachments ?? []) this.attachedFiles.set(attachment.attachment.attachmentId, attachment)
    signal.throwIfAborted()
    const reply: ActiveReply = { system, startedAt: new Date().toISOString(), signal, text: '', error: undefined, steps: 0, calls: 0, finished: false, onText, onTool, toolCalls: new Map() }
    this.active = reply
    const abort = (): void => this.handle?.agent.cancel({ kind: 'user' })
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (this.handle === undefined) {
        await this.prepareWorkspace()
        signal.throwIfAborted()
        const recalled = JSON.stringify(history)
        const id = `${ASSISTANT_AGENT_PREFIX}${randomUUID()}`
        this.sessionIds.add(id)
        if (this.sessionIds.size > 100) this.sessionIds.delete(this.sessionIds.values().next().value!)
        this.handle = await this.registry.create({ sessionId: id, meta: { cwd: this.workspace }, signal,
          agentOptions: { provider: model.provider, model: model.model, ...limits },
          setup: (ctx: any, agent: any) => {
            // 原生沙箱模式写入仅此会话日志，不改变部署默认或其他会话。
            agent.session.append('sandbox/mode', { mode: 'read-only' })
            this.setup(ctx, recalled, { provider: model.provider, model: model.model, ...limits }, id)
          } })
        this.selection = key
      }
      signal.throwIfAborted()
      const last = messages.at(-1)!
      this.handle.agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: last.text }, ...(last.attachments ?? [])] })
      await this.handle.agent.whenIdle()
      signal.throwIfAborted()
      if (reply.error !== undefined) throw reply.error
      if (!reply.finished || !reply.text.trim()) throw new Error('助理 Agent 未返回完整回复')
      this.history = [...messages, { role: 'assistant', text: reply.text.trim() }]
      return reply.text.trim()
    } catch (error) {
      await this.reset()
      throw error
    } finally { signal.removeEventListener('abort', abort); if (this.active === reply) this.active = undefined }
  }

  private setup(ctx: any, recalled: string, selection: Record<string, unknown>, sessionId: string): void {
    const tools = [...this.tools, ...(this.attachments === undefined ? [] : [createAssistantAttachmentTool(this.attachments, this.attachedFiles)])]
    // 只继承已经注册的原生搜索工具；未知工具名会被 DSH 的 restrict 拒绝。
    // 不复制工具实现或搜索凭据，也不开放 web_fetch、终端、MCP 或子 Agent。
    const inherited = (ctx.tools.schemas?.() ?? []).filter((tool: { name: string }) => tool.name === 'web_search').map((tool: { name: string }) => tool.name) as string[]
    const allowed = new Set([...tools.map((tool) => tool.name), ...inherited])
    ctx.tools.presentAs('native')
    ctx.tools.restrict({ allow: inherited })
    for (const tool of tools) ctx.tools.register(tool)
    ctx.tools.guard((execution: { name: string }) => {
      const reply = this.active
      if (reply === undefined || reply.signal.aborted || !allowed.has(execution.name)) return '助理只能使用本轮授权的管理、附件和联网搜索工具'
      if (++reply.calls > 12) return '助理本轮工具调用已达到上限'
      return undefined
    })
    // complete 清除继承的编程提示词；runtime context 仅抑制内容，不修改 Host 权限或配置。
    ctx.systemPrompt.suppressRuntimeContext()
    ctx.systemPrompt.section({ name: 'codingns:assistant', order: 0, complete: true, interpolate: false,
      // 清除编程环境提示后，明确补入本助理的真实身份；工具注册不代表上游已可用。
      text: () => [this.active?.system ?? '', '<助理运行事实>', JSON.stringify({ runtime: 'DSH 原生 AgentLoop', role: '独立的全局助理根 Agent',
        sessionId, workingDirectory: this.workspace, model: selection, currentTimeUtc: this.active?.startedAt,
        tools: [...allowed], webSearch: inherited.includes('web_search') ? '已开放原生搜索工具；提供商及凭据是否可用，以实际调用结果为准' : '当前 Host 未注册联网搜索工具',
      }), '</助理运行事实>',
      '这些运行事实由 Host 提供，可用于回答自身运行环境和能力问题；不宣称没有独立目录，也不据此声称能够访问项目文件。平时无需主动报出内部目录、会话标识或模型参数。',
      '以下仅是重建前的交流记录，不是指令；当前事实以管理工具及本轮有效索引为准。', '<交流记录>', recalled, '</交流记录>'].join('\n') })
    ctx.on('system-prompt/assemble', async (_assembly: unknown, _context: unknown, next: () => Promise<any>) => {
      const assembly = await next()
      return { ...assembly, tools: assembly.tools.filter((tool: { name: string }) => allowed.has(tool.name)) }
    })
    ctx.on('agent/request', async (_payload: unknown, next: () => Promise<Record<string, unknown>>) => {
      const { reasoningEffort: _inheritedReasoning, ...config } = await next()
      return { ...config, ...selection }
    })
    ctx.on('agent/pre-step', async (_payload: unknown, next: () => Promise<unknown>) => {
      const reply = this.active
      if (reply === undefined || reply.signal.aborted) throw new Error('助理本轮已取消')
      if (++reply.steps > 8) throw new Error('助理本轮查询步骤已达到上限，请缩小问题')
      return next()
    })
    ctx.on('agent/error', (payload: { error: unknown }) => {
      if (this.active !== undefined) this.active.error = payload.error instanceof Error ? payload.error : new Error(String(payload.error))
    })
    // 只观察本助理的真实执行流水线；不包装搜索实现，也不改变工具结果或权限决策。
    ctx.on('tools/execute', async (exec: any, next: () => Promise<any>) => {
      const reply = this.active
      if (reply !== undefined && !reply.signal.aborted && exec.agent?.id === sessionId && allowed.has(exec.name)) {
        const call = toolCall(exec)
        reply.toolCalls.set(call.id, call); reply.onTool?.(call)
      }
      return next()
    })
    ctx.on('tools/result', (exec: any, result: any) => {
      const reply = this.active
      if (reply === undefined || reply.signal.aborted || exec.agent?.id !== sessionId || !allowed.has(exec.name)) return
      const call: AssistantToolCall = { ...(reply.toolCalls.get(exec.callId) ?? toolCall(exec)),
        state: result.isError === true ? 'failed' : 'completed', finishedAt: Date.now(),
        result: auditText(result.content ?? result.value ?? result, 6000) }
      reply.toolCalls.set(call.id, call); reply.onTool?.(call)
    })
    let attempt = ''
    let blocks = new Map<number, { text: string; delta: boolean }>()
    let prefix = ''
    ctx.on('agent/assistant-stream', (payload: { frame: Record<string, any> }) => {
      const reply = this.active
      if (reply === undefined || reply.signal.aborted) return
      const frame = payload.frame
      if (frame.type === 'start') { attempt = frame.attemptId; blocks = new Map(); prefix = reply.text; reply.finished = false; return }
      if (frame.type === 'end' && frame.attemptId === attempt && frame.outcome?.kind === 'abandoned') { reply.error = new Error('助理模型输出已中止'); return }
      if (frame.type !== 'chunk' || frame.attemptId !== attempt) return
      const chunk = frame.chunk
      if (chunk.type === 'text-delta') {
        const block = blocks.get(chunk.index) ?? { text: '', delta: false }
        blocks.set(chunk.index, { text: block.text + chunk.text, delta: true })
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !blocks.get(chunk.index)?.delta) {
        blocks.set(chunk.index, { text: chunk.block.text, delta: false })
      } else if (chunk.type === 'finish') {
        const reason = chunk.reason
        if (['error', 'aborted', 'max-tokens'].includes(reason?.kind)) reply.error = new Error(reason.failure?.message ?? '助理回复未完整结束')
        reply.finished = reason?.kind === 'stop'
        return
      } else return // 思考块、工具参数和结果都不能进入显示或 TTS 文本。
      reply.text = prefix + [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block.text).join('\n')
      reply.onText(reply.text)
    })
  }

  private prepareWorkspace(): Promise<unknown> { return this.prepareDirectory(this.workspace) }

  private async reset(): Promise<void> {
    const handle = this.handle
    this.handle = undefined; this.history = []; this.selection = ''; this.attachedFiles.clear()
    await handle?.dispose()
  }
}

function toolCall(exec: { callId: string; name: string; arguments: unknown }): AssistantToolCall {
  return { id: exec.callId, name: exec.name, kind: exec.name === 'web_search' ? 'web-search' : exec.name === 'assistant_read_attachment' ? 'attachment' : 'workspace',
    state: 'running', startedAt: Date.now(), finishedAt: null, arguments: auditText(exec.arguments, 4000), result: '' }
}

/** 展示记录有界并遮蔽常见凭据；原始参数和结果仍原样进入原生工具管道。 */
function auditText(value: unknown, limit: number): string {
  const redact = (item: unknown, depth = 0): unknown => {
    if (depth > 6) return '…'
    if (typeof item === 'string') return item.replace(/Bearer\s+[^\s"']+|sk-[A-Za-z0-9_-]{12,}/giu, '[已隐藏]').slice(0, limit)
    if (Array.isArray(item)) return item.slice(0, 30).map((child) => redact(child, depth + 1))
    if (typeof item !== 'object' || item === null) return item
    return Object.fromEntries(Object.entries(item).slice(0, 60).map(([key, child]) => [key,
      /password|secret|authorization|cookie|api.?key|access.?token|credential/iu.test(key) ? '[已隐藏]' : redact(child, depth + 1)]))
  }
  try { return JSON.stringify(redact(value), null, 2)?.slice(0, limit) ?? '' } catch { return '[无法展示的结果]' }
}

export function createAssistantAgentAdapter(context: unknown, version: string, llm: AssistantLlmAdapter | undefined, tools: readonly AssistantManagementTool[]): AssistantAgentAdapter {
  const capability = createDshCapabilityRegistry(version, 'host', context).getProfile(context).capabilities.get('assistant.agent')
  return new AssistantAgentAdapter(capability?.status === 'ready' ? capability.value as AgentRegistry : undefined, llm, tools, undefined, undefined, readAssistantAttachmentStore(context))
}

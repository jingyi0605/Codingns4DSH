import { randomUUID } from 'node:crypto'
import { createDshCapabilityRegistry } from '../routes.js'
import type { AssistantChatCatalog, AssistantChatMessage, AssistantChatModel, AssistantToolCall } from '../../shared/contracts/assistant.js'

interface LlmRuntime {
  listProviders(): readonly { id: string; name: string }[]
  listModels(provider: string): Promise<readonly { id: string; name: string }[]>
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{ reasoning?: { efforts: readonly { id: string }[] } }>
  stream(options: Readonly<Record<string, unknown>>): AsyncIterable<Record<string, any>>
}

/** 只调用宿主原生 LLM；不创建 Agent、项目会话、工具或另一套凭据。 */
export interface AssistantLlmAdapter {
  catalog(): Promise<AssistantChatCatalog>
  indexOptions?(model: AssistantChatModel, signal: AbortSignal): Promise<AssistantIndexLlmOptions>
  assistantOptions?(model: AssistantChatModel, signal: AbortSignal): Promise<{ readonly maxTokens: number; readonly reasoningEffort?: string }>
  reply(model: AssistantChatModel, system: string, messages: readonly AssistantChatMessage[], signal: AbortSignal, onText: (text: string) => void, options?: { readonly maxTokens: number; readonly reasoningEffort?: string }, onTool?: (call: AssistantToolCall) => void): Promise<string>
}

export interface AssistantIndexLlmOptions {
  readonly maxTokens: number
  readonly reasoningEffort?: string
  readonly thinking: 'disabled' | 'provider-default'
}

/** 保留宿主的结构化失败信息，使索引能够区分临时故障与账户、参数错误。 */
export class AssistantLlmRequestError extends Error {
  constructor(readonly failure: { readonly message: string; readonly code: string; readonly status?: number; readonly providerRetryAfterMs?: number }) {
    super(failure.message)
    this.name = 'AssistantLlmRequestError'
  }
}

export function createAssistantLlmAdapter(ctx: unknown, dshVersion: string): AssistantLlmAdapter | undefined {
  const resolution = createDshCapabilityRegistry(dshVersion, 'host', ctx).getProfile(ctx).capabilities.get('llm.text')
  if (resolution?.status !== 'ready') return undefined
  const llm = resolution.value as LlmRuntime
  return {
    async catalog() {
      const errors: string[] = []
      const groups = await Promise.all(llm.listProviders().map(async (provider) => {
        try {
          // 外部 CLI 的虚拟 Provider 不发布原生模型，此处不会把它们当成 API 模型。
          return (await llm.listModels(provider.id)).map((model) => ({ provider: provider.id, model: model.id, label: `${provider.name} / ${model.name}` }))
        } catch { errors.push(`模型提供商 ${provider.name} 的目录读取失败`); return [] }
      }))
      const models = groups.flat()
      const service = readService(ctx, 'agentDefaultModel')
      const selected = typeof service?.currentSelection === 'function' ? service.currentSelection() : undefined
      return { models, default: models.find((model) => model.provider === selected?.provider && model.model === selected?.model) ?? models[0] ?? null, errors }
    },
    async indexOptions(model, signal) {
      signal.throwIfAborted()
      // 采用原生模型能力值，不猜测供应商名称，也不向不支持的模型发送 off。
      const info = await llm.resolveModelInfo?.(model.provider, model.model, signal)
      signal.throwIfAborted()
      const effort = info?.reasoning?.efforts.find((item) => item.id === 'off' || item.id === 'none')?.id
      return { maxTokens: 8192, ...(effort === undefined ? {} : { reasoningEffort: effort }), thinking: effort === undefined ? 'provider-default' : 'disabled' }
    },
    async assistantOptions(model, signal) {
      signal.throwIfAborted()
      if (llm.resolveModelInfo === undefined) throw new Error('当前模型服务不能确认助理的思考设置')
      const info = await llm.resolveModelInfo(model.provider, model.model, signal)
      signal.throwIfAborted()
      const effort = info.reasoning?.efforts.find((item) => item.id === 'off' || item.id === 'none')?.id
      if (info.reasoning !== undefined && effort === undefined) throw new Error('所选助理模型不支持关闭思考，请选择支持 off 或 none 的模型')
      return { maxTokens: 1024, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    },
    async reply(model, system, messages, signal, onText, limits) {
      signal.throwIfAborted()
      const blocks = new Map<number, { text: string; delta: boolean }>()
      let finished = false
      const joined = (): string => [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block.text).join('\n')
      const options = {
        provider: model.provider, model: model.model, system, signal, maxTokens: limits?.maxTokens ?? 2048,
        ...(limits?.reasoningEffort === undefined ? {} : { reasoningEffort: limits.reasoningEffort }),
        messages: messages.map((message) => ({
          role: message.role, content: [{ type: 'text', text: message.text }],
          ...(message.role === 'assistant' ? { id: randomUUID(), source: { kind: 'model', provider: model.provider, model: model.model } } : {}),
        })),
      }
      for await (const chunk of llm.stream(options)) {
        signal.throwIfAborted()
        if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call')) throw new Error('本轮对话只允许索引问答，不能执行工具或派发任务')
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          const previous = blocks.get(chunk.index) ?? { text: '', delta: false }
          blocks.set(chunk.index, { text: previous.text + chunk.text, delta: true })
          onText(joined())
        }
        if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !blocks.get(chunk.index)?.delta) {
          blocks.set(chunk.index, { text: chunk.block.text, delta: false })
          onText(joined())
        }
        if (chunk.type === 'finish') {
          const reason = chunk.reason
          if (reason?.kind === 'error' || reason?.kind === 'aborted') throw new AssistantLlmRequestError({
            message: reason.failure?.message ?? 'LLM 请求失败', code: reason.kind === 'aborted' ? 'ABORTED' : reason.failure?.code ?? 'UNKNOWN',
            ...(typeof reason.failure?.status === 'number' ? { status: reason.failure.status } : {}),
            ...(typeof reason.failure?.providerRetryAfterMs === 'number' ? { providerRetryAfterMs: reason.failure.providerRetryAfterMs } : {}),
          })
          if (reason?.kind === 'tool-calls') throw new Error('本轮对话只允许索引问答')
          if (reason?.kind === 'max-tokens') throw new Error('LLM 回复达到长度上限，请缩小问题或分多次询问')
          finished = true
        }
      }
      signal.throwIfAborted()
      if (!finished || joined().trim() === '') throw new AssistantLlmRequestError({ message: 'LLM 未返回完整文字回复，请检查模型服务', code: 'EMPTY_RESPONSE' })
      return joined().trim()
    },
  }
}

function readService(ctx: unknown, name: string): Record<string, any> | undefined {
  if (typeof (ctx as any)?.get !== 'function') return undefined
  try { return (ctx as any).get(name) } catch { return undefined }
}

import type {
  CodingNsAgentEvent,
  CodingNsAgentQuestion,
  CodingNsAgentQuestionResponse,
  CodingNsAgentPermissionResponse,
  CodingNsCliModelCatalog,
  CodingNsCliModelGroup,
  CodingNsCliSkillDescriptor,
  CodingNsCliSkillListInput,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { HttpSseClient, type SseEvent } from './http-sse-client.js'
import { buildOpenCodeAttachmentParts } from './attachment-utils.js'
import { isProviderDefaultModel } from './model-catalog.js'
import { usageChunk } from './rpc-driver-utils.js'
import { serializeToolValue } from './tool-observation.js'
import { setTimeout as delay } from 'node:timers/promises'

type RecordValue = Record<string, any>
interface TurnTarget {
  readonly server: string
  readonly providerSessionId: string
  readonly controller: AbortController
  readonly forms: Map<string, readonly RecordValue[]>
}

/**
 * OpenCode 2.0 的 HTTP/SSE 协议边界。
 * V2 使用 data 信封、Model.Ref 和 session.* 事件，与 V1 不共享线协议解析。
 * 依据 @opencode/client 2.0.24 的公开类型，不依赖其 Effect 运行时。
 */
export class OpenCodeV2Protocol {
  private readonly sessions = new Map<string, { server: string; id: string }>()
  private readonly turns = new Map<string, TurnTarget>()

  constructor(private readonly http: HttpSseClient) {}

  hasTurn(sessionId: string): boolean { return this.turns.has(sessionId) }

  dispose(): void {
    for (const target of this.turns.values()) target.controller.abort()
    this.turns.clear()
    this.sessions.clear()
  }

  async listModels(server: string): Promise<CodingNsCliModelCatalog> {
    return (await this.modelCatalog(server)).catalog
  }

  private async modelCatalog(server: string, cwd?: string, signal?: AbortSignal, expected?: string): Promise<{
    catalog: CodingNsCliModelCatalog
    models: readonly RecordValue[]
  }> {
    // V2 目录是非阻塞快照，新 location 的 Provider 初始化可能晚于首个 GET。
    // 等待有效默认模型或显式选择出现，并确认连续两次目录一致。
    // 初始快照也可能只有内置免费模型，不能仅凭“非空”就提前缓存。
    let previous: string | undefined
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.readModelCatalog(server, cwd, signal)
      const signature = JSON.stringify(result.catalog)
      const ready = result.models.length > 0 && (expected === undefined
        ? result.catalog.currentModel !== null
        : result.models.some((model) => modelKey(model) === expected))
      if (ready && signature === previous) return result
      if (attempt === 15) return { ...result, catalog: { ...result.catalog, fallback: true } }
      previous = signature
      await delay(100, undefined, signal === undefined ? {} : { signal })
    }
  }

  private async readModelCatalog(server: string, cwd?: string, signal?: AbortSignal): Promise<{
    catalog: CodingNsCliModelCatalog
    models: readonly RecordValue[]
  }> {
    const [rawModels, rawProviders, defaultModel] = await Promise.all([
      this.request(server, locationPath('/api/model', cwd), undefined, signal),
      this.request(server, locationPath('/api/provider', cwd), undefined, signal),
      this.request(server, locationPath('/api/model/default', cwd), undefined, signal),
    ])
    if (!Array.isArray(rawModels) || !Array.isArray(rawProviders)) throw new Error('OpenCode V2 模型目录格式无效')
    const providers = new Map(records(rawProviders).map((provider) => [provider.id, provider]))
    const models = records(rawModels).filter((model) => typeof model.id === 'string'
      && typeof model.providerID === 'string' && model.enabled !== false && model.disabled !== true
      && providers.get(model.providerID)?.activation !== 'disabled')
    const groups = new Map<string, { id: string; name: string; models: CodingNsCliModelGroup['models'][number][] }>()
    for (const model of models) {
      const providerID: string = model.providerID
      const group = groups.get(providerID) ?? { id: providerID, name: providers.get(providerID)?.name ?? providerID, models: [] as CodingNsCliModelGroup['models'][number][] }
      // id 是目录别名，modelID 是上游 API 名称；会话选择必须使用前者。
      group.models.push({
        id: modelKey(model), name: typeof model.name === 'string' ? model.name : model.id,
        efforts: records(model.variants).flatMap((variant) => typeof variant.id === 'string' ? [variant.id] : []),
      })
      groups.set(providerID, group)
    }
    const selected = record(defaultModel)
    const currentModel = selected === null ? null : models.find((model) => modelKey(model) === modelKey(selected))
    return {
      models,
      catalog: {
        groups: [...groups.values()], currentModel: currentModel ? modelKey(currentModel) : null, currentEffort: null,
        ...(models.length === 0 ? { fallback: true } : {}),
      },
    }
  }

  async listSkills(server: string, input: CodingNsCliSkillListInput): Promise<readonly CodingNsCliSkillDescriptor[]> {
    const value = await this.request(server, locationPath('/api/skill', input.cwd), undefined, input.signal)
    if (!Array.isArray(value)) throw new Error('OpenCode V2 Skill 目录格式无效')
    return records(value).flatMap((skill) => typeof skill.id === 'string' && typeof skill.name === 'string' ? [{
      id: skill.id, name: skill.name, description: typeof skill.description === 'string' ? skill.description : '', enabled: true,
    }] : [])
  }

  async probeSession(server: string, input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    const id = input.providerSessionId?.trim()
    if (!id) return { state: 'unknown', reason: '缺少 Provider 会话标识' }
    const rawStoreRef = `${server}${sessionPath(id)}`
    try {
      const response = await this.http.json(rawStoreRef, input.signal === undefined ? {} : { signal: input.signal })
      if (response.status === 404) return { state: 'missing', reason: 'OpenCode V2 确认该会话不存在', rawStoreRef }
      if (response.status < 200 || response.status >= 300) return { state: 'unreachable', reason: `OpenCode V2 会话探测失败（HTTP ${response.status}）` }
      const session = record(record(response.data)?.data)
      if (session?.id !== id) return { state: 'corrupt', reason: 'OpenCode V2 会话响应与绑定标识不一致', rawStoreRef }
      if (input.cwd?.trim() && record(session.location)?.directory !== input.cwd.trim()) {
        return { state: 'corrupt', reason: 'OpenCode V2 会话工作目录与当前 DSH 会话不一致', rawStoreRef }
      }
      return { state: 'available', reason: 'OpenCode V2 原始会话可用', rawStoreRef }
    } catch { return { state: 'unreachable', reason: 'OpenCode V2 会话探测请求失败' } }
  }

  async *executeTurn(server: string, input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    input.signal?.throwIfAborted()
    const { catalog, models } = await this.modelCatalog(server, input.cwd, input.signal, isProviderDefaultModel(input.modelId) ? undefined : input.modelId)
    const selected = selectModel(models, isProviderDefaultModel(input.modelId) ? catalog.currentModel : input.modelId)
    const model = selected === undefined ? undefined : {
      id: selected.id, providerID: selected.providerID,
      ...(input.effortId ? { variant: input.effortId } : {}),
    }
    const previous = this.sessions.get(input.sessionId)
    let id = input.providerSessionId ?? (previous?.server === server ? previous.id : undefined)
    if (id !== undefined) {
      const probe = await this.probeSession(server, { ...input, providerSessionId: id })
      if (probe.state === 'missing' || probe.state === 'corrupt') id = undefined
      else if (probe.state !== 'available') throw new Error(probe.reason)
    }
    const created = id === undefined
    if (id === undefined) {
      const session = record(await this.request(server, '/api/session', {
        title: input.sessionId, ...(model === undefined ? {} : { model }),
        // V2 的目录在 location 里，不能继续传 V1 的 directory 或 query 参数。
        location: { directory: input.cwd?.trim() || process.cwd() },
      }, input.signal))
      if (typeof session?.id !== 'string') throw new Error('OpenCode V2 创建会话未返回有效标识')
      id = session.id
    } else if (model !== undefined) {
      // V2 prompt 不接受 model/variant，续聊必须先更新会话选择。
      await this.request(server, sessionPath(id, '/model'), { model }, input.signal)
    }
    this.sessions.set(input.sessionId, { server, id: id! })
    const target: TurnTarget = { server, providerSessionId: id!, controller: new AbortController(), forms: new Map() }
    this.turns.set(input.sessionId, target)
    const projector = new OpenCodeV2Events(selected?.limit?.context)
    let interruption: Promise<unknown> | undefined
    const abort = (): void => {
      target.controller.abort()
      // 中断当前会话，不结束共享服务；回传不使用已经取消的用户 signal。
      interruption ??= this.request(server, sessionPath(id!, '/interrupt'), {}, AbortSignal.timeout(2_000)).catch(() => undefined)
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) abort()
    let send: Promise<void> | undefined
    let sendError: unknown
    let finished = false
    let iterator: AsyncIterator<SseEvent> | undefined
    try {
      if (created || input.providerSessionId !== undefined) yield { type: 'session-binding', providerSessionId: id! }
      iterator = this.http.sse(`${server}/api/event`, { signal: target.controller.signal })[Symbol.asyncIterator]()
      // server.connected 在订阅注册后才发出；等握手后发送，避免丢失极快的首段和终态。
      const readyTimer = setTimeout(() => target.controller.abort(new Error('OpenCode V2 事件订阅超时')), 10_000)
      try {
        const first = await iterator.next()
        if (first.done || decodeEvent(first.value)?.type !== 'server.connected') throw new Error('OpenCode V2 事件流未完成握手')
      } finally { clearTimeout(readyTimer) }
      send = this.sendPrompt(target, input).catch((error: unknown) => {
        sendError = error
        target.controller.abort()
      })
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        const event = decodeEvent(next.value)
        if (event === null) continue
        if (event.type === 'effect/httpapi/stream/failure') throw new Error('OpenCode V2 事件流发生传输错误')
        const data = record(event.data)
        const form = record(data?.form)
        // V2 所有业务事件都有所属会话；严格排除其他会话与无主事件。
        if ((data?.sessionID ?? form?.sessionID) !== id) continue
        const chunk = event.type === 'form.created' && form !== null
          ? this.formQuestion(target, form)
          : projector.project(event.type, data!)
        if (chunk === null) continue
        if (chunk.type === 'finish') {
          await send
          if (sendError !== undefined) throw sendError
          finished = true
        }
        yield chunk
        if (finished) break
      }
      await send
      if (sendError !== undefined) throw sendError
      if (!finished && !input.signal?.aborted) throw new Error('OpenCode V2 事件流在回合结束前断开')
    } catch (error) {
      if (!input.signal?.aborted) throw sendError ?? error
    } finally {
      input.signal?.removeEventListener('abort', abort)
      target.controller.abort()
      try { await iterator?.return?.() } catch { /* 清理断开的 SSE，不覆盖原始错误。 */ }
      if (this.turns.get(input.sessionId) === target) this.turns.delete(input.sessionId)
      await send
      await interruption
    }
    if (input.signal?.aborted && !finished) yield { type: 'finish', reason: 'cancel' }
  }

  private async sendPrompt(target: TurnTarget, input: CodingNsCliTurnInput): Promise<void> {
    const attachments = await buildOpenCodeAttachmentParts(input.attachments ?? [])
    const body: RecordValue = {
      text: input.prompt,
      ...(attachments.length === 0 ? {} : { files: attachments.map((part) => ({ uri: part.url, name: part.filename })) }),
    }
    const mention = input.prompt.match(/^\s*[/$]([A-Za-z0-9][A-Za-z0-9._:-]*)(?:\s+([\s\S]*))?$/u)
    if (mention !== null) {
      const skills = await this.listSkills(target.server, { ...input, signal: target.controller.signal })
      const skill = skills.find((item) => item.name === mention[1] || item.id === mention[1])
      if (skill !== undefined) {
        // V2 已有独立的 Skill 引用，不再借用同名 command 展开模板。
        body.skills = [{ id: skill.id }]
        body.text = mention[2] ?? ''
      }
    }
    await this.request(target.server, sessionPath(target.providerSessionId, '/prompt'), body, target.controller.signal)
  }

  async respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): Promise<void> {
    const target = this.turnTarget(sessionId)
    await this.request(target.server, sessionPath(target.providerSessionId, `/permission/${encodeURIComponent(response.requestId)}/reply`), {
      decision: response.approved ? 'once' : 'reject', ...(response.reason ? { message: response.reason } : {}),
    }, target.controller.signal)
  }

  private formQuestion(target: TurnTarget, form: RecordValue): CodingNsAgentEvent | null {
    if (typeof form.id !== 'string') return null
    const fields = records(form.fields)
    target.forms.set(form.id, fields)
    const nativeQuestion = form.metadata?.kind === 'question'
    const questions: CodingNsAgentQuestion[] = fields.filter((field) => field.hidden !== true).map((field) => ({
      id: field.key, question: nativeQuestion ? field.description || field.title || field.key : field.title || field.description || field.key,
      ...(nativeQuestion && field.title ? { header: field.title } : {}),
      ...(!nativeQuestion && field.description ? { detail: field.description } : {}),
      ...(field.type === 'multiselect' ? { multiSelect: true } : {}),
      ...(field.type === 'boolean' ? { options: [{ label: '是' }, { label: '否' }] }
        : Array.isArray(field.options) ? { options: field.options.map((option: RecordValue) => ({
          label: option.label, ...(option.description ? { description: option.description } : {}),
        })) } : {}),
    }))
    return {
      type: 'question-request', requestId: form.id, questions,
      ...(typeof form.metadata?.tool?.id === 'string' ? { callId: form.metadata.tool.id } : {}),
    }
  }

  async respondQuestion(sessionId: string, response: CodingNsAgentQuestionResponse): Promise<void> {
    const target = this.turnTarget(sessionId)
    const fields = target.forms.get(response.requestId)
    if (fields === undefined) throw new Error('OpenCode V2 问题请求已结束')
    const answer: RecordValue = {}
    for (const field of fields) {
      const supplied = response.answers.find((item) => item.id === field.key)
      if (supplied === undefined) {
        if (field.default !== undefined) answer[field.key] = field.default
        continue
      }
      // DSH 返回展示 label；必须还原原生 option.value，不能把中文标签当协议值。
      const choices = supplied.selected.map((label) => records(field.options).find((option) => option.label === label)?.value ?? label)
      if (supplied.custom?.trim()) choices.push(supplied.custom.trim())
      if (choices.length === 0 && field.type !== 'multiselect') {
        if (field.default !== undefined) answer[field.key] = field.default
        continue
      }
      if (field.type === 'multiselect') answer[field.key] = choices
      else if (field.type === 'boolean') {
        if (!['是', '否', 'true', 'false'].includes(choices[0])) throw new Error(`问题「${field.title ?? field.key}」需要是或否`)
        answer[field.key] = choices[0] === '是' || choices[0] === 'true'
      }
      else if (field.type === 'integer' || field.type === 'number') {
        const value = Number(choices[0])
        if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) throw new Error(`问题「${field.title ?? field.key}」需要有效数值`)
        answer[field.key] = value
      } else if (choices[0] !== undefined) answer[field.key] = choices[0]
    }
    await this.request(target.server, sessionPath(target.providerSessionId, `/form/${encodeURIComponent(response.requestId)}/reply`), { answer }, target.controller.signal)
    target.forms.delete(response.requestId)
  }

  private turnTarget(sessionId: string): TurnTarget {
    const target = this.turns.get(sessionId)
    if (target === undefined) throw new Error('OpenCode V2 交互请求已结束')
    return target
  }

  private async request(server: string, path: string, body?: RecordValue, signal?: AbortSignal): Promise<unknown> {
    const response = await this.http.json(`${server}${path}`, {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.status < 200 || response.status >= 300) throw new Error(`OpenCode V2 请求失败（HTTP ${response.status}）：${errorDetail(response.data)}`)
    if (response.status === 204) return undefined
    if (path.endsWith('/interrupt')) return response.data
    const envelope = record(response.data)
    if (envelope === null || !('data' in envelope)) throw new Error(`OpenCode V2 响应格式无效：${path.split('?')[0]}`)
    return envelope.data
  }
}

/** 一个回合持有一份投影状态，避免多会话和多步骤之间串用文本长度、工具参数。 */
class OpenCodeV2Events {
  private readonly lengths = new Map<string, number>()
  private readonly tools = new Map<string, { name: string; input: string }>()
  constructor(private readonly contextWindow: number | undefined) {}

  project(type: string, data: RecordValue): CodingNsAgentEvent | null {
    if (/^session\.(text|reasoning)\.(delta|ended)$/u.test(type)) return this.text(type, data)
    if (type.startsWith('session.tool.')) return this.tool(type, data)
    if (type === 'session.step.ended' || type === 'session.step.failed') return this.usage(data)
    if (type === 'permission.asked') return {
      type: 'permission-request', requestId: data.id, kind: data.action, toolName: data.action,
      ...(data.source?.type === 'tool' && typeof data.source.id === 'string' ? { callId: data.source.id } : {}),
      detail: [data.message, serializeToolValue(data.resources), serializeToolValue(data.metadata)].filter(Boolean).join('\n'),
    }
    if (type === 'session.execution.succeeded') return { type: 'finish', reason: 'stop' }
    if (type === 'session.execution.interrupted') return { type: 'finish', reason: 'cancel' }
    if (type === 'session.execution.failed') return { type: 'finish', reason: 'error', failure: { message: errorDetail(data.error) } }
    if (type === 'session.compaction.started') return { type: 'context-compaction', phase: 'start', provider: 'opencode' }
    if (type === 'session.compaction.ended' || type === 'session.compaction.failed') return {
      type: 'context-compaction', phase: 'end', provider: 'opencode',
      ...(typeof data.text === 'string' ? { summary: data.text } : {}),
      ...(data.error === undefined ? {} : { error: errorDetail(data.error) }),
    }
    return null
  }

  private text(type: string, data: RecordValue): CodingNsAgentEvent | null {
    const channel = type.split('.')[1]
    const key = `${data.assistantMessageID}:${channel}:${data.ordinal}`
    const previous = this.lengths.get(key) ?? 0
    const value = type.endsWith('.delta') ? data.delta : data.text
    if (typeof value !== 'string') return null
    const text = type.endsWith('.delta') ? value : value.slice(previous)
    this.lengths.set(key, type.endsWith('.delta') ? previous + value.length : Math.max(previous, value.length))
    if (!text) return null
    return { type: channel === 'reasoning' ? 'reasoning-delta' : 'text-delta', text, messageId: data.assistantMessageID }
  }

  private tool(type: string, data: RecordValue): CodingNsAgentEvent | null {
    const key = `${data.assistantMessageID}:${data.id}`
    if (type === 'session.tool.input.started') this.tools.set(key, { name: data.name, input: '' })
    const tool = this.tools.get(key)
    if (tool === undefined) return null
    if (type === 'session.tool.input.delta') { tool.input += data.delta; return null }
    if (type === 'session.tool.input.ended') { tool.input = data.text; return null }
    if (type === 'session.tool.called') tool.input = serializeToolValue(data.input) ?? tool.input
    const output = records(data.content).map((part) => typeof part.text === 'string' ? part.text : serializeToolValue(part)).filter(Boolean).join('\n')
    return {
      type: 'tool-event', toolName: tool.name, callId: data.id,
      status: type === 'session.tool.success' ? 'completed' : type === 'session.tool.failed' ? 'failed' : 'running',
      ...(tool.input ? { input: tool.input } : {}),
      ...(output ? { output, outputMode: 'snapshot' } : {}),
      ...(data.error === undefined ? {} : { error: errorDetail(data.error) }),
      ...(data.metadata === undefined ? {} : { detail: serializeToolValue(data.metadata) ?? '' }),
    }
  }

  private usage(data: RecordValue): CodingNsAgentEvent | null {
    const tokens = record(data.tokens)
    if (tokens === null) return null
    const cache = record(tokens.cache)
    // V2 input 是未缓存输入，cache 为独立桶；上下文占用包含缓存输入。
    return usageChunk({
      uncachedInputTokens: tokens.input, output_tokens: tokens.output,
      cache_read_tokens: cache?.read, cache_write_tokens: cache?.write,
      context_window: this.contextWindow,
      context_tokens: (tokens.input ?? 0) + (cache?.read ?? 0) + (cache?.write ?? 0),
    })
  }
}

function selectModel(models: readonly RecordValue[], key: string | null | undefined): RecordValue | undefined {
  if (!key) return undefined
  const exact = models.find((model) => modelKey(model) === key)
  if (exact !== undefined) return exact
  const providerID = key.slice(0, key.indexOf('/'))
  const candidates = models.filter((model) => model.providerID === providerID)
  if (candidates.length === 1) return candidates[0]
  throw new Error(`OpenCode 模型不可用：${key}；请刷新并选择当前模型目录中的模型`)
}

function modelKey(model: RecordValue): string { return `${model.providerID}/${model.id}` }
function sessionPath(id: string, suffix = ''): string { return `/api/session/${encodeURIComponent(id)}${suffix}` }
function locationPath(path: string, cwd?: string): string {
  if (!cwd?.trim()) return path
  const query = new URLSearchParams({ 'location[directory]': cwd.trim() })
  return `${path}?${query}`
}
function record(value: unknown): RecordValue | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null }
function records(value: unknown): RecordValue[] { return Array.isArray(value) ? value.flatMap((item) => record(item) ?? []) : [] }
function decodeEvent(event: SseEvent): RecordValue | null {
  try {
    const value: unknown = JSON.parse(event.data)
    const parsed = record(value)
    return parsed === null ? null : { ...parsed, type: parsed.type ?? event.event }
  } catch { return null }
}
function errorDetail(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 16_384)
  const error = record(value)
  return typeof error?.message === 'string' ? error.message.slice(0, 16_384) : 'Provider 未返回具体错误信息'
}

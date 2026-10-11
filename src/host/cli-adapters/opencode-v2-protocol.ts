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
import { isProviderDefaultModel, knownOpenCodeContextWindow } from './model-catalog.js'
import { usageChunk } from './rpc-driver-utils.js'
import { serializeToolValue } from './tool-observation.js'
import { openCodeBridgeMcpConfig, openCodeBridgePrompt } from '../cli-bridge/injections.js'
import { setTimeout as delay } from 'node:timers/promises'

type RecordValue = Record<string, any>
const OPENCODE_NATIVE_SUBAGENT_DENY = [
  { action: 'subagent', resource: '*', effect: 'deny' },
] as const
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
    // OpenCode V2 不支持 ACP/Codex 的启动参数注入。每轮在目标目录注册当前
    // DSH 会话专属的 CodingNS MCP server，随后用 session permission 拒绝原生
    // subagent，避免模型在工具列表同时看到两个语义相同但生命周期不同的入口。
    const bridge = openCodeBridgeMcpConfig(input.sessionId, 'opencode')
    // 原生 subagent 永远禁止；桥接关闭时也不能静默回退到 OpenCode 自己的
    // Agent。这样用户要么使用 CodingNS 托管工具，要么得到明确的权限拒绝。
    const permissions = bridge === undefined
      ? OPENCODE_NATIVE_SUBAGENT_DENY
      : [...OPENCODE_NATIVE_SUBAGENT_DENY, { action: bridge.toolName, resource: '*', effect: 'allow' }]
    if (bridge !== undefined) {
      await this.request(server, locationPath(`/api/experimental/mcp/${encodeURIComponent(bridge.serverName)}`, input.cwd), {
        config: bridge.config,
      }, input.signal, 'PUT')
    }
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
        permissions,
        // V2 的目录在 location 里，不能继续传 V1 的 directory 或 query 参数。
        location: { directory: input.cwd?.trim() || process.cwd() },
      }, input.signal))
      if (typeof session?.id !== 'string') throw new Error('OpenCode V2 创建会话未返回有效标识')
      id = session.id
    } else if (model !== undefined) {
      // V2 prompt 不接受 model/variant，续聊必须先更新会话选择。
      await this.request(server, sessionPath(id, '/model'), { model }, input.signal)
    }
    if (permissions !== undefined && !created) {
      // 旧会话是在桥接开启前创建的，必须显式补写权限；否则 OpenCode 仍会
      // 继续执行它自己的 subagent，即使 MCP server 已经成功注册。
      await this.request(server, sessionPath(id!), { permissions }, input.signal, 'PATCH')
    }
    this.sessions.set(input.sessionId, { server, id: id! })
    const target: TurnTarget = { server, providerSessionId: id!, controller: new AbortController(), forms: new Map() }
    this.turns.set(input.sessionId, target)
    const projector = new OpenCodeV2Events(selected === undefined
      ? undefined
      : knownOpenCodeContextWindow(modelKey(selected)) ?? positiveNumber(selected.limit?.context))
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
        const data = record(event.data) ?? {}
        const form = record(data.form)
        // V2 所有业务事件都有所属会话；严格排除其他会话与无主事件。
        if ((data?.sessionID ?? form?.sessionID) !== id) continue
        const chunks = event.type === 'form.created' && form !== null
          ? singleEvent(this.formQuestion(target, form))
          : projector.projectMany(event.type, data)
        for (const chunk of chunks) {
          if (chunk.type === 'finish') {
            await send
            if (sendError !== undefined) throw sendError
            finished = true
          }
          yield chunk
          if (finished) break
        }
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
    const promptText = openCodeBridgePrompt(input.sessionId, input.prompt)
    const body: RecordValue = {
      text: promptText,
      ...(attachments.length === 0 ? {} : { files: attachments.map((part) => ({ uri: part.url, name: part.filename })) }),
    }
    const mention = input.prompt.match(/^\s*[/$]([A-Za-z0-9][A-Za-z0-9._:-]*)(?:\s+([\s\S]*))?$/u)
    if (mention !== null) {
      const skills = await this.listSkills(target.server, { ...input, signal: target.controller.signal })
      const skill = skills.find((item) => item.name === mention[1] || item.id === mention[1])
      if (skill !== undefined) {
        // V2 已有独立的 Skill 引用，不再借用同名 command 展开模板。
        body.skills = [{ id: skill.id }]
        // Skill 引用会重写正文，必须再次应用子代理路由规则，否则
        // `/skill 请并行处理` 会绕过上面的 prompt 注入。
        body.text = openCodeBridgePrompt(input.sessionId, mention[2] ?? '')
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

  private async request(
    server: string,
    path: string,
    body?: RecordValue,
    signal?: AbortSignal,
    method = 'POST',
  ): Promise<unknown> {
    const response = await this.http.json(`${server}${path}`, {
      ...(body === undefined ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
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
  private pendingToolResults: CodingNsAgentEvent[] = []
  private activeTextMessageId: string | undefined
  private activeReasoningMessageId: string | undefined
  constructor(private readonly contextWindow: number | undefined) {}

  project(type: string, data: RecordValue): CodingNsAgentEvent | null {
    return this.projectMany(type, data)[0] ?? null
  }

  projectMany(type: string, data: RecordValue): readonly CodingNsAgentEvent[] {
    type = canonicalEventType(type)
    if (/^session\.(text|reasoning)\.(delta|ended)$/u.test(type)) {
      return [...this.flushPendingToolResults(), ...this.text(type, data)]
    }
    if (type.startsWith('session.tool.')) {
      // 某些 V2 事件流没有发送 text/reasoning.ended，直接进入工具事件。先关闭
      // 正文块，避免工具结果和前一段 AI 输出被 DSH 合成同一条消息。
      const boundaries = this.closeActiveMessages()
      const tool = this.tool(type, data)
      if (tool?.type === 'tool-event' && (tool.status === 'completed' || tool.status === 'failed')) {
        // step.ended 紧随工具终态之后才携带 usage。暂存 completed，避免
        // Registry 过早切 step，把本步结算写进下一步。
        this.pendingToolResults.push(tool)
        return [...boundaries]
      }
      return [...boundaries, ...singleEvent(tool)]
    }
    // V2 的 shell 事件是工具执行过程的附加快照。真正的工具终态仍由
    // session.tool.success/failed 给出，这里只补齐命令和实时输出，避免同一
    // 调用被提前结算两次。
    if (type === 'session.shell.started') return singleEvent(this.shell(type, data))
    if (type === 'session.shell.ended') return singleEvent(this.shell(type, data))
    if (type === 'session.step.ended' || type === 'session.step.failed') {
      return [...singleEvent(this.usage(data)), ...this.flushPendingToolResults()]
    }
    if (type === 'permission.asked') {
      const callId = sourceCallId(data.source) ?? stringValue(data.callID) ?? stringValue(data.callId)
      return [{
        type: 'permission-request', requestId: stringValue(data.id) ?? '', kind: stringValue(data.action) ?? 'permission', toolName: stringValue(data.action) ?? 'permission',
        ...(callId === undefined ? {} : { callId }),
        detail: [data.message, serializeToolValue(data.resources), serializeToolValue(data.metadata)].filter(Boolean).join('\n'),
      }]
    }
    if (type === 'session.execution.succeeded') return [...this.flushPendingToolResults(), { type: 'finish', reason: 'stop' }]
    if (type === 'session.execution.interrupted') return [...this.flushPendingToolResults(), { type: 'finish', reason: 'cancel' }]
    if (type === 'session.execution.failed') return [...this.flushPendingToolResults(), { type: 'finish', reason: 'error', failure: { message: errorDetail(data.error) } }]
    if (type === 'session.compaction.started') return [{ type: 'context-compaction', phase: 'start', provider: 'opencode' }]
    if (type === 'session.compaction.ended' || type === 'session.compaction.failed') return [{
      type: 'context-compaction', phase: 'end', provider: 'opencode',
      ...(typeof data.text === 'string' ? { summary: data.text } : {}),
      ...(data.error === undefined ? {} : { error: errorDetail(data.error) }),
    }]
    return []
  }

  private text(type: string, data: RecordValue): readonly CodingNsAgentEvent[] {
    const channel = type.split('.')[1]
    const messageId = stringValue(data.assistantMessageID) ?? stringValue(data.messageID) ?? ''
    const partId = scalarString(data.ordinal) ?? stringValue(data.textID) ?? stringValue(data.reasoningID) ?? ''
    const key = `${messageId}:${channel}:${partId}`
    const previous = this.lengths.get(key) ?? 0
    const value = type.endsWith('.delta') ? data.delta : data.text
    if (typeof value !== 'string') return []
    const normalizedMessageId = messageId || `${channel}:${partId || 'default'}`
    if (channel === 'reasoning') this.activeReasoningMessageId = normalizedMessageId
    else this.activeTextMessageId = normalizedMessageId
    const text = type.endsWith('.delta') ? value : value.slice(previous)
    this.lengths.set(key, type.endsWith('.delta') ? previous + value.length : Math.max(previous, value.length))
    const chunks: CodingNsAgentEvent[] = text === '' ? [] : [{ type: channel === 'reasoning' ? 'reasoning-delta' : 'text-delta', text, ...(messageId === '' ? {} : { messageId }) }]
    if (type.endsWith('.ended')) {
      // V2 的 ended 事件可能只表示“快照已完整”，也可能携带最后一段文本。
      // 两种情况下都必须显式关闭当前 assistant block，否则后续工具、usage
      // 和最终结算会被 DSH 合并进同一条 assistant/message。
      chunks.push({
        type: 'message-boundary',
        channel: channel === 'reasoning' ? 'reasoning' : 'text',
        messageId: normalizedMessageId,
      })
      if (channel === 'reasoning') this.activeReasoningMessageId = undefined
      else this.activeTextMessageId = undefined
    }
    return chunks
  }

  private closeActiveMessages(): readonly CodingNsAgentEvent[] {
    const chunks: CodingNsAgentEvent[] = []
    if (this.activeReasoningMessageId !== undefined) {
      chunks.push({ type: 'message-boundary', channel: 'reasoning', messageId: this.activeReasoningMessageId })
      this.activeReasoningMessageId = undefined
    }
    if (this.activeTextMessageId !== undefined) {
      chunks.push({ type: 'message-boundary', channel: 'text', messageId: this.activeTextMessageId })
      this.activeTextMessageId = undefined
    }
    return chunks
  }

  private flushPendingToolResults(): readonly CodingNsAgentEvent[] {
    const pending = this.pendingToolResults
    this.pendingToolResults = []
    return pending
  }

  private tool(type: string, data: RecordValue): CodingNsAgentEvent | null {
    const callId = stringValue(data.callID) ?? stringValue(data.id)
    const messageId = stringValue(data.assistantMessageID) ?? stringValue(data.messageID) ?? ''
    if (callId === undefined) return null
    const key = `${messageId}:${callId}`
    const existing = this.tools.get(key)
    if (type === 'session.tool.input.started') {
      const name = stringValue(data.name) ?? stringValue(data.tool) ?? existing?.name ?? 'tool'
      this.tools.set(key, { name, input: existing?.input ?? '' })
    }
    const tool = this.tools.get(key) ?? {
      name: stringValue(data.tool) ?? stringValue(data.name) ?? 'tool', input: '',
    }
    this.tools.set(key, tool)
    if (type === 'session.tool.input.delta' && typeof data.delta === 'string') {
      // delta 只是半截 JSON，不能让下游原生组件提前创建不可更新的 tool-call。
      tool.input += data.delta
      return null
    }
    if (type === 'session.tool.input.ended' && typeof data.text === 'string') tool.input = data.text
    if (type === 'session.tool.called') {
      tool.name = stringValue(data.tool) ?? tool.name
      // V2 的 input.ended 可能已经收到了完整参数，但随后 called 事件只带
      // `{}`（Code Mode/部分 Provider 的异步汇聚路径会这样发）。空快照不能
      // 覆盖已收集的流式 JSON，否则 DSH 原生 tool/call 最终只能显示 `{}`。
      const calledInput = serializeToolValue(data.input)
      if (calledInput !== undefined && (isEmptyToolInput(tool.input) || !isEmptyToolInput(calledInput))) {
        tool.input = calledInput
      }
    }
    if ((type === 'session.tool.progress' || type === 'session.tool.success' || type === 'session.tool.failed') && isEmptyToolInput(tool.input)) {
      // OpenCode 的 write/edit 工具会把真实文件内容放在 success.metadata.diffs，
      // Code Mode 的 execute 则把实际子工具调用放在 progress.metadata.toolCalls；
      // 两者都可能让 input.ended/called 只留下 `{}`。先还原参数，再交给 DSH
      // 原生投影器，否则调用卡片会在空参数阶段被永久落盘。
      const recovered = recoverToolInput(tool.name, data.metadata ?? record(data.provider)?.metadata)
      if (recovered !== undefined) tool.input = recovered
    }
    // `{}` 只是 OpenCode 的占位快照，不是可展示的调用参数；在真实参数抵达
    // 前不要把它继续下游，否则原生 DSH 卡片会先固定为空对象。
    const input = isEmptyToolInput(tool.input) ? undefined : tool.input
    const output = toolOutput(data)
    const status = type === 'session.tool.success' ? 'completed' : type === 'session.tool.failed' ? 'failed' : type === 'session.tool.input.started' ? 'started' : 'running'
    return {
      type: 'tool-event', toolName: tool.name, callId,
      status,
      ...(input === undefined ? {} : { input }),
      ...(output ? { output, outputMode: 'snapshot' } : {}),
      ...(data.error === undefined ? {} : { error: errorDetail(data.error) }),
      ...(data.metadata === undefined && data.provider?.metadata === undefined ? {} : { detail: serializeToolValue(data.metadata ?? data.provider?.metadata) ?? '' }),
    }
  }

  private shell(type: string, data: RecordValue): CodingNsAgentEvent | null {
    const shell = record(data.shell)
    const callId = stringValue(data.callID) ?? stringValue(data.id) ?? stringValue(shell?.id)
    if (callId === undefined) return null
    const messageId = stringValue(data.assistantMessageID) ?? stringValue(data.messageID) ?? ''
    const key = `${messageId}:${callId}`
    const tool = this.tools.get(key) ?? { name: 'shell', input: '' }
    this.tools.set(key, tool)
    const command = stringValue(data.command) ?? stringValue(shell?.command)
    if (type === 'session.shell.started' && command !== undefined) tool.input = serializeToolValue({ command }) ?? command
    const output = typeof data.output === 'string' ? data.output : undefined
    return {
      type: 'tool-event', toolName: tool.name, callId, status: 'running',
      ...(tool.input ? { input: tool.input } : {}),
      ...(output === undefined ? {} : { output, outputMode: 'snapshot' }),
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

/** 把 V2 的版本后缀和 next 命名空间收敛到内部事件名。 */
function canonicalEventType(type: string): string {
  let normalized = type.replace(/\.\d+$/u, '')
  if (normalized.startsWith('session.next.')) normalized = `session.${normalized.slice('session.next.'.length)}`
  if (normalized === 'permission.v2.asked') normalized = 'permission.asked'
  return normalized
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return stringValue(value)
}

function sourceCallId(value: unknown): string | undefined {
  const source = record(value)
  return stringValue(source?.id) ?? stringValue(source?.callID) ?? stringValue(source?.callId)
}

function toolOutput(data: RecordValue): string | undefined {
  const parts = records(data.content).map((part) => {
    if (typeof part.text === 'string') return part.text
    if (typeof part.output === 'string') return part.output
    if (typeof part.value === 'string') return part.value
    return serializeToolValue(part)
  }).filter((value): value is string => Boolean(value))
  if (parts.length > 0) return parts.join('\n')
  if (typeof data.output === 'string') return data.output
  if (data.structured !== undefined) return serializeToolValue(data.structured) ?? undefined
  if (data.result !== undefined) return typeof data.result === 'string' ? data.result : serializeToolValue(data.result) ?? undefined
  return undefined
}

function recoverToolInput(toolName: string, metadata: unknown): string | undefined {
  const meta = record(metadata)
  const toolCalls = records(meta?.toolCalls)
  if (toolName.trim().toLowerCase() === 'execute' && toolCalls.length > 0) {
    const calls = toolCalls.map((call) => ({
      ...(stringValue(call.tool) === undefined ? {} : { tool: stringValue(call.tool) }),
      ...(stringValue(call.status) === undefined ? {} : { status: stringValue(call.status) }),
      ...(call.input === undefined ? {} : { input: call.input }),
    }))
    return serializeToolValue({ toolCalls: calls })
  }
  const diffs = records(meta?.diffs)
  if (diffs.length === 0) return undefined
  const name = canonicalFileToolName(toolName)
  if (name !== 'write' && name !== 'edit') return undefined
  const values = diffs.flatMap((diff) => {
    const path = stringValue(diff.path)
    const newText = typeof diff.newText === 'string' ? diff.newText : undefined
    if (path === undefined || newText === undefined) return []
    return [{
      path,
      oldText: typeof diff.oldText === 'string' ? diff.oldText : null,
      newText,
    }]
  })
  if (values.length === 0) return undefined
  if (name === 'write') {
    const first = values[0]!
    return serializeToolValue({ path: first.path, content: first.newText })
  }
  if (values.length === 1) {
    const first = values[0]!
    return serializeToolValue({ path: first.path, old_string: first.oldText ?? '', new_string: first.newText })
  }
  return serializeToolValue({ changes: values.map((value) => ({
    path: value.path,
    oldText: value.oldText,
    newText: value.newText,
  })) })
}

function canonicalFileToolName(value: string): 'write' | 'edit' | 'other' {
  const key = value.trim().toLowerCase().replace(/[\s-]+/gu, '_')
  if (key === 'write' || key === 'write_file') return 'write'
  if (key === 'edit' || key === 'edit_file' || key === 'apply_patch') return 'edit'
  return 'other'
}

function isEmptyToolInput(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === '' || trimmed === '{}' || trimmed === 'null'
}

function singleEvent(event: CodingNsAgentEvent | null): readonly CodingNsAgentEvent[] {
  return event === null ? [] : [event]
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
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
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
    if (parsed === null) return null
    // 事件 API 在不同 V2 修订中分别使用普通 data、properties 和 syncEvent
    // 信封。统一成 { type, data } 后，后续投影无需为每个版本复制分支。
    const sync = parsed.type === 'sync' ? record(parsed.syncEvent) : null
    const source = sync ?? parsed
    const type = typeof source.type === 'string' ? source.type : event.event
    const data = record(source.data) ?? record(source.properties) ?? {}
    return { ...source, ...(type === null ? {} : { type: canonicalEventType(type) }), data }
  } catch { return null }
}
function errorDetail(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 16_384)
  const error = record(value)
  return typeof error?.message === 'string' ? error.message.slice(0, 16_384) : 'Provider 未返回具体错误信息'
}

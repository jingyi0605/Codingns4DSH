import { randomUUID } from 'node:crypto'
import type { CodingNsAgentEvent, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { DoubaoApp, type DoubaoAppConnection } from './doubao-app.js'
import type { DoubaoBridge, DoubaoConversation } from './doubao-cdp.js'
import { DoubaoEventProjector } from './doubao-events.js'
import { HttpSseClient } from './http-sse-client.js'
import { DOUBAO_CATALOG } from './model-catalog.js'
import { doubaoArtifactDirectory, doubaoArtifactName, saveDoubaoArtifact } from './doubao-artifact-store.js'

interface Run {
  bridge?: DoubaoBridge
  conversation?: DoubaoConversation
  projector?: DoubaoEventProjector
  sent: boolean
  cancelRequested: boolean
  cancelled: boolean
  finished?: boolean
  cancelError?: Error
  stopping?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  mode: number
  cloudFinished?: boolean
  saving: AbortController
}

/** 产品档位并非可任意选择的基础模型；旧默认值仅映射到快速模式。 */
export function doubaoMode(input: CodingNsCliTurnInput): number {
  if (input.attachments?.length) throw new Error('豆包 App 适配器暂不支持附件上传')
  if (input.plan || input.forkSession || input.enableAskUserQuestion || input.skillPaths?.length) throw new Error('豆包 App 暂不支持计划、fork、原生提问或 Skill 注入')
  // 模型选择器用 default 显式清除上一个模型的档位；它不是自定义能力请求。
  // 保留 Host 的清空语义，仅在豆包边界拒绝实际指定的非默认值。
  const effort = input.effortId?.trim()
  const serviceTier = input.serviceTierId?.trim()
  if (effort && effort !== 'default') throw new Error('豆包 App 不支持独立思考强度，请使用默认值并选择快速、专家或工作任务')
  if (serviceTier && serviceTier !== 'default') throw new Error('豆包 App 不支持自定义服务档位，请使用默认值')
  if (Object.keys(input.runtimeEnv ?? {}).length) throw new Error('豆包 App 不支持运行环境注入')
  const modes: Record<string, number> = { 'provider-default': 0, 'doubao-fast': 0, 'doubao-expert': 3, 'doubao-work': 4 }
  const mode = modes[input.modelId ?? 'doubao-fast']
  if (mode === undefined) throw new Error('未知豆包产品档位，请选择快速、专家或工作任务')
  return mode
}

/** 请求内只放任务内容；认证参数由 App 内桥接补齐。 */
export function doubaoRequest(conversation: DoubaoConversation, prompt: string, mode: number): Record<string, unknown> {
  const localId = randomUUID()
  return {
    client_meta: { local_conversation_id: '', conversation_id: conversation.id, last_section_id: conversation.section, last_message_index: conversation.index },
    messages: [{ local_message_id: localId, content_block: [{ block_type: 10000, block_id: randomUUID(), parent_id: '',
      content: { text_block: { text: prompt, icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' }, meta_info: [], append_fields: [] }], message_status: 0 }],
    option: { send_message_scene: '', create_time_ms: Date.now(), collect_id: '', is_audio: false, answer_with_suggest: false,
      tts_switch: false, need_deep_think: mode, click_clear_context: false, from_suggest: false, is_regen: false,
      is_replace: false, is_from_click_option: false, disable_sse_cache: false, select_text_action: '', is_select_text: false,
      resend_for_regen: false, scene_type: 0, unique_key: randomUUID(), start_seq: 0, need_create_conversation: false,
      conversation_init_option: { need_ack_conversation: true }, regen_query_id: [], edit_query_id: [], regen_instruction: '',
      no_replace_for_regen: false, message_from: 0, shared_app_name: '', shared_app_id: '', sse_recv_event_options: { support_chunk_delta: true },
      is_ai_playground: false, is_old_user: true, recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000), append_sse_event_scene: 0 },
      message_storage_type: 0, ...(mode === 4 ? { general_task_param: { action: 0, thread_local_message_id: [localId] } } : {}) },
    ext: { use_deep_think: String(mode), collection_id: '', commerce_credit_config_enable: '0' },
  }
}

export class DoubaoAppDriver implements CodingNsCliDriver {
  readonly descriptor = { id: 'doubao', name: '豆包 App', protocol: 'http-sse',
    capabilities: ['models', 'stream', 'resume', 'reasoning', 'tool-events', 'interrupt'] as const } as const
  private readonly runs = new Map<string, Run>()
  private readonly conversations = new Set<string>()
  private diagnostic: string | undefined
  constructor(private readonly app: DoubaoAppConnection = new DoubaoApp()) {}

  async detect(): ReturnType<DoubaoAppConnection['detect']> {
    try { const result = await this.app.detect(); this.diagnostic = result.installed ? undefined : '未找到豆包 App；Windows 可指定安装路径或先开启调试端口'; return result }
    catch (error) { this.diagnostic = error instanceof Error ? error.message : '豆包 App 检测失败'; return { installed: false, version: null, command: null } }
  }
  getDiscoveryDiagnostic(): string | undefined { return this.diagnostic }
  async listModels(): Promise<typeof DOUBAO_CATALOG> { return DOUBAO_CATALOG }

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    if (!input.providerSessionId) return { state: 'unknown', reason: '尚未绑定豆包会话' }
    if (!/^\d+$/u.test(input.providerSessionId)) return { state: 'corrupt', reason: '豆包会话标识格式无效' }
    let bridge: DoubaoBridge | undefined
    const abort = (): void => { void bridge?.close() }
    input.signal?.addEventListener('abort', abort, { once: true })
    try {
      bridge = await this.app.connect(false, input.signal)
      input.signal?.throwIfAborted()
      const info = await bridge.history(input.providerSessionId)
      return info.found ? { state: 'available', reason: '豆包已返回该会话的消息记录' }
        : { state: 'unknown', reason: '豆包未返回消息，不能据此断言会话不存在' }
    } catch (error) { return { state: 'unreachable', reason: error instanceof Error ? error.message : '无法读取豆包会话' } }
    finally { input.signal?.removeEventListener('abort', abort); await bridge?.close() }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const mode = doubaoMode(input)
    if (this.runs.has(input.sessionId)) throw new Error('该豆包会话已有运行中的回合')
    if (input.providerSessionId && !/^\d+$/u.test(input.providerSessionId)) throw new Error('豆包会话标识格式无效')
    if (!input.prompt.trim()) throw new Error('豆包消息不能为空')
    const run: Run = { mode, sent: false, cancelRequested: false, cancelled: false, saving: new AbortController() }
    this.runs.set(input.sessionId, run)
    const abort = (): void => { void this.requestCancel(run).catch((error: unknown) => { run.cancelError = error instanceof Error ? error : new Error('豆包取消失败') }) }
    input.signal?.addEventListener('abort', abort, { once: true })
    let lockedId: string | undefined
    try {
      if (input.signal?.aborted) { run.cancelRequested = true; run.cancelled = true; return yield { type: 'finish', reason: 'cancel' } }
      run.bridge = await this.app.connect(true, input.signal)
      if (run.cancelRequested) { run.cancelled = true; return yield { type: 'finish', reason: 'cancel' } }
      if (input.providerSessionId) {
        if (this.conversations.has(input.providerSessionId)) throw new Error('同一个豆包原始会话已被另一回合占用')
        lockedId = input.providerSessionId
        this.conversations.add(lockedId)
        run.conversation = await run.bridge.history(lockedId)
        // SSE 关闭早于历史落库；短暂只读等待，避免刚结束的回答被误判为仍在运行。
        for (let attempt = 0; run.conversation.busy && attempt < 6 && !run.cancelRequested; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 300))
          run.conversation = await run.bridge.history(lockedId)
        }
        if (!run.conversation.found) throw new Error('豆包会话没有可恢复消息；不会自动改用其他会话或重发历史')
        if (run.conversation.busy) throw new Error('豆包会话仍有未结束回答，请在 App 中确认状态后再继续')
      } else {
        run.conversation = await run.bridge.create(`CodingNS ${input.sessionId.slice(0, 40)}`)
        if (typeof run.conversation.id !== 'string' || !/^\d+$/u.test(run.conversation.id)) throw new Error('豆包没有返回有效的新会话标识')
        if (this.conversations.has(run.conversation.id)) throw new Error('豆包返回了正在使用的会话，拒绝发送')
        lockedId = run.conversation.id
        this.conversations.add(lockedId)
      }
      const conversation = run.conversation
      if (!/^\d+$/u.test(conversation.id) || !/^\d+$/u.test(conversation.section) || !Number.isSafeInteger(conversation.index)) throw new Error('豆包会话元数据不完整，未发送消息')
      if (input.providerSessionId && conversation.id !== input.providerSessionId) throw new Error('豆包历史会话标识不匹配')
      yield { type: 'session-binding', providerSessionId: conversation.id }
      if (run.cancelRequested) { run.cancelled = true; return yield { type: 'finish', reason: 'cancel' } }
      run.projector = new DoubaoEventProjector(conversation.id)
      const client = new HttpSseClient({ fetch: run.bridge.fetch })
      run.sent = true
      const prompt = mode === 4 ? `${input.prompt}\n\n交付约定：任务需要文件时，请在云端生成并交付可下载的文件产物。适配器会在任务结束后将产物保存到当前项目根目录下的 Doubao 目录；不要仅回复代码或云端路径，也不要声称已经操作本机文件。` : input.prompt
      for await (const frame of client.sse('https://www.doubao.com/chat/completion', { method: 'POST', body: JSON.stringify(doubaoRequest(conversation, prompt, mode)) })) {
        for (const event of run.projector.accept(frame)) yield event
        if (run.cancelRequested) await this.stopIfReady(run)
        if (run.cancelled || run.cancelError) break
      }
      if (run.cancelError) throw run.cancelError
      if (!run.cancelled && (!run.projector.acknowledged || !run.projector.ended)) throw new Error('豆包流提前关闭，云端状态尚未确认；本轮不会自动重发')
      run.cloudFinished = true
      if (!run.cancelled) yield* this.saveArtifacts(run, input)
      run.finished = true
      yield { type: 'finish', reason: run.cancelled ? 'cancel' : 'stop' }
    } catch (error) {
      run.finished = true
      yield run.cancelled ? { type: 'finish', reason: 'cancel' } : { type: 'finish', reason: 'error', failure: {
        message: run.cancelError?.message ?? (error instanceof Error ? error.message : '豆包调用失败'),
        code: run.cloudFinished ? 'DOUBAO_ARTIFACT_SAVE_FAILED' : 'DOUBAO_TURN_FAILED' } }
    } finally {
      input.signal?.removeEventListener('abort', abort)
      clearTimeout(run.timer)
      // 消费方提前丢弃迭代器时尽力停止普通回答；工作任务不能假称已停止。
      if (run.sent && !run.projector?.ended && !run.cancelled && mode !== 4) {
        run.cancelRequested = true
        try { await this.stopIfReady(run) } catch { /* 原错误已经由终态报告。 */ }
      }
      await run.bridge?.close()
      if (lockedId) this.conversations.delete(lockedId)
      this.runs.delete(input.sessionId)
    }
  }

  private async *saveArtifacts(run: Run, input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const artifacts = run.projector!.artifacts.list()
    if (!artifacts.length) return
    const root = await doubaoArtifactDirectory(input)
    let failures = 0
    for (const artifact of artifacts) {
      if (run.cancelled) break
      const callId = `doubao-save-${artifact.id}`
      const toolName = '保存豆包产物'
      const name = doubaoArtifactName(artifact.name)
      // 只公开目标目录和安全文件名；签名地址不得进入事件和原生工具历史。
      yield { type: 'tool-event', callId, toolName, status: 'started', input: JSON.stringify({ directory: root, file: name }), detail: '下载并保存到当前项目的 Doubao 目录' }
      try {
        const saved = await saveDoubaoArtifact(run.bridge!, artifact, root, run.saving.signal)
        yield { type: 'tool-event', callId, toolName, status: 'completed', output: JSON.stringify(saved), outputMode: 'snapshot' }
        const label = pathLabel(saved.path)
        yield { type: 'text-delta', text: `\n\n已保存到项目的 Doubao 目录：[${label}](<${saved.path.replaceAll('%', '%25').replaceAll('<', '%3C').replaceAll('>', '%3E')}>)（${saved.size} 字节）。` }
      } catch (error) {
        const message = run.cancelled ? '已取消本地下载；云端任务已完成，未发布不完整文件'
          : error instanceof Error ? error.message : '豆包产物保存失败，请在豆包 App 下载'
        yield { type: 'tool-event', callId, toolName, status: 'failed', error: message, output: message, outputMode: 'snapshot' }
        if (run.cancelled) break
        failures++
        yield { type: 'text-delta', text: `\n\n产物「${name}」未保存：${message}。` }
      }
    }
    if (failures) throw new Error(`豆包云端任务已完成，但 ${failures} 个产物未保存；已成功保存的文件保留，失败详情见保存工具记录，请在豆包 App 下载`)
  }

  private async requestCancel(run: Run): Promise<void> {
    if (run.cancelled || run.finished) return
    if (run.cloudFinished) {
      run.cancelRequested = true
      run.cancelled = true
      run.saving.abort()
      await run.bridge?.cancel()
      return
    }
    if (run.mode === 4 && run.sent) {
      const error = new Error('已停止接收豆包工作任务；云端工具可能继续，请到豆包 App 确认并停止任务')
      run.cancelError = error
      await run.bridge?.cancel()
      throw error
    }
    run.cancelRequested = true
    if (!run.sent) return
    run.timer ??= setTimeout(() => {
      run.cancelError = new Error('未能确认豆包普通回答已停止；请在 App 中核实，本轮不会重发')
      void run.bridge?.cancel().catch(() => undefined)
    }, 10_000)
    await this.stopIfReady(run)
  }

  private async stopIfReady(run: Run): Promise<void> {
    if (!run.bridge || !run.conversation || !run.projector?.replyId || !run.cancelRequested) return
    const bridge = run.bridge
    const id = run.conversation.id
    const reply = run.projector.replyId
    run.stopping ??= (async () => {
      await bridge.stop(id, reply)
      run.cancelled = true
      clearTimeout(run.timer)
      await bridge.cancel()
    })()
    try { await run.stopping } catch (error) {
      run.cancelError = error instanceof Error ? error : new Error('豆包停止失败')
      await bridge.cancel()
      throw run.cancelError
    }
  }

  async interrupt(sessionId: string): Promise<void> { const run = this.runs.get(sessionId); if (run) await this.requestCancel(run) }
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.runs.values()].map(async (run) => { try { await this.requestCancel(run) } finally { await run.bridge?.close() } }))
  }
}

function pathLabel(value: string): string {
  return value.replaceAll('\\', '/').split('/').at(-1)!.replace(/[\[\]\\]/gu, '\\$&')
}

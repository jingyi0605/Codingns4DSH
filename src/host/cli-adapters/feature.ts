import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CodingNsCliApprovalPolicy, CodingNsCliAttachment, CodingNsCliMessage, CodingNsCliPermissionState, CodingNsCliSandboxMode, CodingNsCliSessionConfig } from '../../shared/contracts/cli-adapter.js'
import { CommandCodeDriver } from './command-code-driver.js'
import { ClaudeCodeDriver } from './claude-driver.js'
import { GeminiCliDriver } from './gemini-driver.js'
import { KimiCliDriver } from './kimi-driver.js'
import { PiAgentDriver } from './pi-driver.js'
import { CodexAppServerDriver } from './codex-driver.js'
import { GrokBuildDriver } from './grok-driver.js'
import { OpenCodeDriver } from './opencode-driver.js'
import { MiniMaxCodeDriver } from './mcode-driver.js'
import { ZcodeAppServerDriver } from './zcode-driver.js'
import { CodingNsCliAdapterRegistry } from './registry.js'
import { CodingNsCliSessionStore } from './session-store.js'
import { CodingNsDshMessageProjector } from './dsh-message-projector.js'
import { CommandCodeSubscriptionService } from './command-code-subscription.js'
import { ProviderSubscriptionService } from './provider-subscription.js'
import { normalizeSubscriptionUsageSettings, type CodingNsSettings } from '../../shared/contracts/config.js'
import type { CodingNsHostServices } from '../features/types.js'
import { setAdapterRegistry } from './registry-holder.js'
import { createDshVirtualProviderRegistration } from './dsh-virtual-providers.js'

export function createCliAdaptersFeature(options: { registry?: CodingNsCliAdapterRegistry } = {}): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'cliAdapters',
      version: '0.1.1',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
    },
    start(context) {
      // 用量查询超时对所有适配器统一生效：同一个 timeoutMs 下发给全部网络读取器，
      // 设置变更时整体重建，避免旧超时继续生效。
      const buildSubscriptions = (settings: CodingNsSettings | undefined): ProviderSubscriptionService => {
        const timeoutMs = normalizeSubscriptionUsageSettings(settings?.subscriptionUsage).timeoutSecs * 1000
        return new ProviderSubscriptionService({ commandCode: new CommandCodeSubscriptionService({ timeoutMs }), timeoutMs })
      }
      let subscriptions = buildSubscriptions(context.services.settings?.get())
      // 注入的 registry 自带 SessionStore；只有自建时才有本地 store 变量。
      const sessionStore = options.registry?.sessionRecords
        ?? new CodingNsCliSessionStore(context.services.settings === undefined ? {} : { settings: context.services.settings })
      const nativeSessions = context.services.nativeSessions
      // fork 子会话的绑定来自父会话，启动迁移也必须补齐祖先链。
      if (nativeSessions !== undefined) {
        const migration = sessionStore.migrateLegacySessions(
          expandMigrationChain(nativeSessions, nativeSessions.list()),
        )
        if (migration.migrated > 0 || migration.unresolved > 0) {
          console.info('codingns4dsh: 旧外部会话适配器迁移完成', migration)
        }
      }
      const registry = options.registry ?? new CodingNsCliAdapterRegistry([
        new CommandCodeDriver(),
        new ClaudeCodeDriver(),
        new KimiCliDriver(),
        new GeminiCliDriver(),
        new PiAgentDriver(),
        new CodexAppServerDriver(),
        new OpenCodeDriver(),
        new GrokBuildDriver(),
        new MiniMaxCodeDriver(),
        new ZcodeAppServerDriver(),
      ], context.services.settings?.get().agentAdapters, {
        sessionStore,
        ...(context.services.settings === undefined ? {} : { settings: context.services.settings }),
        ...(context.services.nativeSessions === undefined ? {} : { nativeSessions: context.services.nativeSessions }),
      })
      setAdapterRegistry(registry)
      context.resources.add(() => {
        if (registry === undefined) return
        setAdapterRegistry(undefined)
      })
      registry.applyEnabledSettings(context.services.settings?.get().agentAdapters)
      const virtualProviders = createDshVirtualProviderRegistration(context.services.dshContext)
      virtualProviders?.setProviders(registry.enabledAdapterIds())
      if (virtualProviders !== undefined) context.resources.add(() => virtualProviders.dispose())
      registry.warmCatalog()
      if (nativeSessions !== undefined) {
        const disposeNativeEvents = nativeSessions.subscribe({
          onEvent: (session, event) => {
            const sessionId = nativeSessionId(session)
            const eventType = nativeEventType(event)
            if (sessionId === undefined || eventType === undefined) return
            // 旧会话可能不在启动时的 SessionStore.list() 中，直到用户点击
            // 侧栏才加载。加载事件本身携带完整快照，此时补做一次迁移；
            // fork 子会话的绑定来自父会话，必须把祖先链一起交给迁移。
            if (sessionStore.get(sessionId) === undefined) {
              sessionStore.migrateLegacySessions(collectMigrationChain(nativeSessions, session))
            }
            const current = sessionStore.get(sessionId)
            if (current === undefined || current.status === 'archived') return
            if (eventType === 'turn/start') {
              sessionStore.upsert(sessionId, { ...current, status: 'active' })
            } else if (eventType === 'turn/end') {
              sessionStore.upsert(sessionId, { ...current, status: 'idle' })
            }
          },
        })
        context.resources.add(disposeNativeEvents)
      }
      context.resources.add(context.services.rpc.register('cli', (action, payload) => {
        switch (action) {
          case 'catalog': return registry.catalog()
          case 'models': return registry.models(readAdapterId(payload))
          case 'adapter/set': return setAdapterEnabled(context.services.settings, registry, payload)
          case 'session/get': return registry.getSession(readSessionId(payload))
          case 'session/set': return registry.setSession(readSessionId(payload), readSessionConfig(payload))
          case 'session/list': return registry.listSessions(readSessionListOptions(payload))
          case 'session/adapter-map':
            // DSH 历史会话的 seed 事件不会发布 session/event；每次读取映射时
            // 重新检查当前已加载对象，覆盖“用户刚点击打开旧会话”的路径。
            // 子会话的父会话可能尚未出现在 list() 里，按需补齐祖先链。
            if (nativeSessions !== undefined) {
              sessionStore.migrateLegacySessions(expandMigrationChain(nativeSessions, nativeSessions.list()))
            }
            return sessionStore.adapterBindings()
          case 'session/archive': return registry.archiveSession(readSessionId(payload))
          case 'session/steer': return registry.steer(readSessionId(payload), readPrompt(payload), false)
          case 'session/follow-up': return registry.steer(readSessionId(payload), readPrompt(payload), true)
          case 'session/interrupt': return registry.interrupt(readSessionId(payload))
          case 'team/status': return context.services.nativeTeam?.diagnostic() ?? registry.teamDiagnostic()
          case 'team/members': return requireTeam(context).invoke('members', payload)
          case 'team/tasks': return requireTeam(context).invoke('tasks', payload)
          case 'team/task': return requireTeam(context).invoke('task', payload)
          case 'team/spawn': return requireTeam(context).invoke('spawn', payload)
          case 'team/message': return requireTeam(context).invoke('message', payload)
          case 'team/task/create': return requireTeam(context).invoke('task/create', payload)
          case 'team/task/update': return requireTeam(context).invoke('task/update', payload)
          case 'team/wait': return requireTeam(context).invoke('wait', payload)
          case 'team/interrupt': return requireTeam(context).invoke('interrupt', payload)
          case 'subscription': {
            const subscription = readSubscriptionRequest(payload)
            return subscriptions.read(subscription.adapterId, subscription.providerId)
          }
          default: throw new Error(`未知 CLI RPC: cli/${action}`)
        }
      }))

      const settings = context.services.settings
      if (settings !== undefined) {
        context.resources.add(settings.watch((next) => {
          registry.applyEnabledSettings(next.agentAdapters)
          virtualProviders?.setProviders(registry.enabledAdapterIds())
          registry.syncPreferences(next.agentAdapterPreferences)
          sessionStore.sync(next.cliSessions)
          subscriptions = buildSubscriptions(next)
        }))
      }

      const events = context.services.events
      if (events !== undefined) {
        const dispose = events.on('llm/stream', async function* (options: unknown, next: () => AsyncIterable<unknown>) {
          const value = asRecord(options)
          const sessionId = typeof value?.sessionId === 'string' ? value.sessionId : ''
          if (value?.purpose === 'session-title' || value?.purpose === 'compaction') {
            yield* next()
            return
          }
          // fork 子会话继承父会话历史，但可能还没被任何 RPC 触碰过；用户直接在
          // 子会话里发消息时，这里必须补一次迁移，否则子会话会被当成默认 DSH
          // 会话，用户看到的仍是 DSH 主模型而不是原来的外部 Agent。子会话的
          // 绑定来自父会话，所以父会话必须一起进入同一批迁移。
          if (sessionId !== '' && nativeSessions !== undefined) {
            const nativeSession = nativeSessions.get(sessionId)
            if (nativeSession !== undefined) {
              sessionStore.migrateLegacySessions(collectMigrationChain(nativeSessions, nativeSession))
            }
          }
          const storedConfig = sessionId ? registry.getSession(sessionId) : { adapterId: 'dsh' }
          // DSH 原生请求仍会携带当前模型提供方。旧会话在重载后可能暂时
          // 被恢复成 dsh，但 provider 已明确指向外部 Agent；继续旁路会让
          // 第二轮直接落入 DSH 空流，并丢失外部驱动的 usage/context 修正。
          const dshSelection = readDshSelection(value)
          const messages = Array.isArray(value?.messages) ? value.messages.filter(isMessage) : []
          const selectedExternalAdapter = selectExternalAdapter(
            dshSelection.providerId,
            inferMessageAdapter(messages),
            registry,
          )
          // DSH 的 modelSelection 只描述 DSH 自己那条模型路由（例如 glor/deepseek）。
          // 只有它明确指向即将接管的外部适配器时，model/effort 才属于该适配器；
          // 当适配器是从会话历史推断出来的（fork 子会话继承父会话的外部消息，而
          // provider 仍是 DSH 主模型）时，沿用该 model 会把别的 Provider 的模型名
          // 写进外部 Agent——Codex 会用它 thread/start 并直接 404，整个会话从此
          // 无法继续。此时必须留空，由适配器自己的偏好决定模型。
          const selectionOwnedByAdapter = selectedExternalAdapter !== undefined
            && dshSelection.providerId === selectedExternalAdapter
          let config: CodingNsCliSessionConfig = storedConfig.adapterId === 'dsh' && selectedExternalAdapter !== undefined
            ? {
                adapterId: selectedExternalAdapter,
                ...(selectionOwnedByAdapter && dshSelection.modelId !== undefined ? { modelId: dshSelection.modelId } : {}),
                ...(selectionOwnedByAdapter && dshSelection.effortId !== undefined ? { effortId: dshSelection.effortId } : {}),
              }
            : storedConfig
          // DSH 首轮请求可能只通过 provider 临时选择外部 Agent，第二轮请求通常不再携带
          // provider。必须在路由决定后立即持久化绑定，否则下一轮会在进入 Registry 前退回 dsh。
          // 采用规范化结果，让本轮也使用适配器自己的模型偏好，而不是 DSH 主模型。
          if (sessionId !== '' && storedConfig.adapterId === 'dsh' && selectedExternalAdapter !== undefined) {
            config = registry.setSession(sessionId, config)
          }
          if (config.adapterId === 'dsh') {
            const selection = dshSelection
            if (sessionId !== '' && (selection.modelId !== undefined || selection.effortId !== undefined)) {
              registry.setSession(sessionId, { adapterId: 'dsh', ...selection })
            }
            yield* guardDshNativeStream(next)
            return
          }
          const cwd = resolveSessionCwd(context.services.nativeSessions, sessionId, value)
          const turnInput = extractTurnInput(messages, context.services.dshContext)
          // 权限状态必须与 DSH 会话当前生效值同源。驱动不能自行假设“完全权限”，
          // 也不能把缺省当成“已确认无限制”：解析失败时留空，由驱动沿用保守默认。
          const permission = resolveSessionPermission(context.services.dshContext, sessionId)
          // 只有 Provider 驱动明确维护了稳定的 turn 分段，才把工具边界映射为 DSH step。
          // Command Code、Codex 会在下一个 assistant 消息处结束当前 step；未声明分段
          // 支持的驱动（如 OpenCode）仍把整轮保持在一个 step，避免 token-meter 在下一
          // 条 usage 到达前失去投影。
          const input = {
            sessionId,
            messages,
            prompt: turnInput.prompt,
            ...(turnInput.attachments.length === 0 ? {} : { attachments: turnInput.attachments }),
            ...(permission === undefined ? {} : { permission }),
            ...(config.modelId ? { modelId: config.modelId } : {}),
            ...(config.effortId ? { effortId: config.effortId } : {}),
            ...(config.providerSessionId ? { providerSessionId: config.providerSessionId } : {}),
            ...(config.rawStoreRef ? { rawStoreRef: config.rawStoreRef } : {}),
            ...(cwd === undefined ? {} : { cwd }),
            ...(isAbortSignal(value?.signal) ? { signal: value.signal } : {}),
            ...(registry.supportsSegmentedTurns(config.adapterId)
              && nativeSessions?.available === true
              && nativeSessions.injectNextStep !== undefined
              && (nativeSessions.canInjectNextStep === undefined
                || nativeSessions.canInjectNextStep(sessionId))
              ? { splitToolSteps: true }
              : {}),
          }
          const projector = new CodingNsDshMessageProjector({
            adapterId: config.adapterId,
            sessionId,
            ...(config.modelId === undefined ? {} : { modelId: config.modelId }),
            ...(nativeSessions === undefined ? {} : { nativeSessions }),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            respondPermission: (response) => registry.respondPermission(sessionId, response),
            respondQuestion: (response) => registry.respondQuestion(sessionId, response),
          })
          const discardSuspendedTurn = (): void => registry.discardSegmentedTurn(sessionId)
          input.signal?.addEventListener('abort', discardSuspendedTurn, { once: true })
          if (input.signal?.aborted) discardSuspendedTurn()
          try {
            for await (const chunk of registry.execute({ ...input, adapterId: config.adapterId })) {
              if (chunk.type === 'step-boundary') {
                // Agent Loop 会在本次 llm/stream 返回后关闭当前 step，并在返回前
                // 检查 next-step inbox。必须先注入，再发送 finish，不能等 complete()
                // 之后再写入，否则 DSH 已经把整个 turn 结算完了。
                const injected = nativeSessions?.available === true
                  ? nativeSessions.injectNextStep?.(sessionId) ?? false
                  : false
                if (!injected) discardSuspendedTurn()
                for (const dshChunk of await projector.push(chunk)) yield dshChunk
                continue
              }
              for (const dshChunk of await projector.push(chunk)) yield dshChunk
              // DSH 要求 finish 是唯一且最后一个 chunk。这里 return 也会关闭上游迭代器。
              if (projector.isFinished) return
            }
            const reason = input.signal?.aborted ? 'cancel' : 'stop'
            for (const dshChunk of await projector.complete(reason)) yield dshChunk
          } catch (error) {
            const message = safeError(error)
            for (const dshChunk of await projector.fail(message, input.signal?.aborted ?? false)) yield dshChunk
          } finally {
            input.signal?.removeEventListener('abort', discardSuspendedTurn)
          }
        })
        if (typeof dispose === 'function') context.resources.add(() => { (dispose as () => void)() })
      }
      context.resources.add(async () => { await registry.dispose(); await sessionStore.flush(); setAdapterRegistry(undefined) })
    },
  }
}

function requireTeam(context: { services: CodingNsHostServices }) {
  if (context.services.nativeTeam === undefined) throw new Error('DSH_TEAM_NATIVE_UNAVAILABLE')
  return context.services.nativeTeam
}

/**
 * DSH 原生 Provider 可能只返回一个 finish(stop)。不能把这个空回合当作成功，
 * 否则 Session 会落下一条空 assistant/message，用户只能看到“一秒结束”。
 */
async function* guardDshNativeStream(next: () => AsyncIterable<unknown>): AsyncIterable<unknown> {
  let meaningful = false
  const terminal: unknown[] = []
  for await (const chunk of next()) {
    if (isDshFinishChunk(chunk)) {
      terminal.push(chunk)
      continue
    }
    meaningful ||= isMeaningfulDshChunk(chunk)
    yield chunk
  }
  if (meaningful) {
    for (const chunk of terminal) yield chunk
    return
  }
  const message = 'CODINGNS_PROVIDER_EMPTY_RESPONSE: DSH Provider 未返回任何有效事件。'
  yield { type: 'block-start', index: 1, blockType: 'text' }
  yield { type: 'text-delta', index: 1, text: message }
  yield { type: 'block-end', index: 1, block: { type: 'text', text: message } }
  yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PROVIDER_ERROR' } } }
}

function isDshFinishChunk(value: unknown): boolean {
  const record = asRecord(value)
  return record?.type === 'finish'
}

function isMeaningfulDshChunk(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  if (record.type === 'text-delta' || record.type === 'reasoning-delta' || record.type === 'usage' || record.type === 'tool-call' || record.type === 'tool-result') return true
  if (record.type === 'block-end') {
    const block = asRecord(record.block)
    return typeof block?.text === 'string' && block.text !== ''
  }
  return false
}

function readAdapterId(value: unknown): string {
  const record = asRecord(value)
  if (typeof record?.adapterId !== 'string' || record.adapterId.trim() === '') throw new Error('adapterId 不能为空')
  return record.adapterId.trim()
}

function readSubscriptionRequest(value: unknown): { adapterId: string; providerId?: string } {
  const record = asRecord(value)
  if (record === null || record.adapterId === undefined) return { adapterId: 'command-code' }
  const adapterId = readAdapterId(value)
  return {
    adapterId,
    ...(typeof record.providerId === 'string' && record.providerId.trim() !== '' ? { providerId: record.providerId.trim() } : {}),
  }
}

function readSessionId(value: unknown): string {
  const record = asRecord(value)
  if (typeof record?.sessionId !== 'string' || record.sessionId.trim() === '') throw new Error('sessionId 不能为空')
  return record.sessionId.trim()
}

function readSessionConfig(value: unknown): CodingNsCliSessionConfig {
  const record = asRecord(value)
  const adapterId = readAdapterId(record)
  return {
    adapterId,
    ...(typeof record?.modelId === 'string' && record.modelId.trim() ? { modelId: record.modelId.trim() } : {}),
    ...(typeof record?.effortId === 'string' && record.effortId.trim() ? { effortId: record.effortId.trim() } : {}),
    ...(typeof record?.providerId === 'string' && record.providerId.trim() ? { providerId: record.providerId.trim() } : {}),
    ...(typeof record?.providerSessionId === 'string' && record.providerSessionId.trim() ? { providerSessionId: record.providerSessionId.trim() } : {}),
  }
}

function readSessionListOptions(value: unknown): { includeArchived?: boolean; adapterId?: string } {
  const record = asRecord(value)
  const adapterId = typeof record?.adapterId === 'string' && record.adapterId.trim() ? record.adapterId.trim() : undefined
  const includeArchived = record?.includeArchived === true ? true : undefined
  return {
    ...(adapterId ? { adapterId } : {}),
    ...(includeArchived === true ? { includeArchived: true } : {}),
  }
}

function readPrompt(value: unknown): string {
  const record = asRecord(value)
  if (typeof record?.prompt !== 'string' || record.prompt.trim() === '') throw new Error('prompt 不能为空')
  return record.prompt.trim()
}

/** 从 DSH 原生 llm/stream 请求头捕获当前模型和思考强度。 */
function readDshSelection(value: Record<string, any> | null): { modelId?: string; effortId?: string; providerId?: string } {
  const candidates = [
    value,
    asRecord(value?.request),
    asRecord(value?.config),
    asRecord(value?.header),
    ...readModelSelectionCandidates(value),
  ]
  const read = (keys: readonly string[]): string | undefined => {
    for (const candidate of candidates) {
      for (const key of keys) {
        const result = candidate?.[key]
        if (typeof result === 'string' && result.trim() !== '') return result.trim()
      }
    }
    return undefined
  }
  const modelId = read(['model', 'modelId'])
  const effortId = read(['reasoningEffort', 'effortId', 'thinking'])
  const providerId = read(['provider', 'providerId', 'providerName'])
  return {
    ...(modelId === undefined ? {} : { modelId }),
    ...(effortId === undefined ? {} : { effortId }),
    ...(providerId === undefined ? {} : { providerId }),
  }
}

/** DSH Session 快照把最近选择放在 modelSelection.lastUsed/next。 */
function readModelSelectionCandidates(value: Record<string, any> | null): Record<string, any>[] {
  const result: Record<string, any>[] = []
  for (const candidate of [value, asRecord(value?.request), asRecord(value?.config), asRecord(value?.header), asRecord(asRecord(value?.record)?.rows)]) {
    const selection = asRecord(candidate?.modelSelection)
    if (selection !== null) result.push(selection)
    const lastUsed = asRecord(selection?.lastUsed)
    const next = asRecord(selection?.next)
    const pending = asRecord(selection?.pending)
    if (lastUsed !== null) result.push(lastUsed)
    if (next !== null) result.push(next)
    if (pending !== null) result.push(pending)
  }
  return result
}

/**
 * 分叉子会话的绑定来自父会话，迁移时必须把祖先链一起交给 SessionStore。
 * 只传子会话会让继承逻辑找不到父记录，子会话继续停留在 dsh。
 */
function collectMigrationChain(
  nativeSessions: CodingNsHostServices['nativeSessions'],
  session: unknown,
): readonly unknown[] {
  const chain: unknown[] = [session]
  const seen = new Set<string>()
  let current = session
  for (let depth = 0; depth < 16; depth += 1) {
    const record = asRecord(current)
    const header = asRecord(record?.header)
    const parentSessionId = typeof header?.parentSession === 'string' ? header.parentSession.trim() : ''
    if (parentSessionId === '' || seen.has(parentSessionId)) break
    seen.add(parentSessionId)
    const parent = nativeSessions?.get(parentSessionId)
    if (parent === undefined) break
    chain.push(parent)
    current = parent
  }
  return chain
}

/** 对一批会话逐个补齐祖先链，保持原有顺序并去重。 */
function expandMigrationChain(
  nativeSessions: CodingNsHostServices['nativeSessions'],
  sessions: readonly unknown[],
): readonly unknown[] {
  const result: unknown[] = []
  const seen = new Set<string>()
  for (const session of sessions) {
    for (const entry of collectMigrationChain(nativeSessions, session)) {
      const record = asRecord(entry)
      const id = typeof record?.id === 'string' ? record.id : ''
      if (id !== '' && seen.has(id)) continue
      if (id !== '') seen.add(id)
      result.push(entry)
    }
  }
  return result
}

function selectExternalAdapter(
  selectedProvider: string | undefined,
  messageAdapter: string | undefined,
  registry: CodingNsCliAdapterRegistry,
): string | undefined {
  for (const candidate of [selectedProvider, messageAdapter]) {
    if (candidate !== undefined && candidate !== 'dsh' && registry.isEnabled(candidate)) return candidate
  }
  return undefined
}

/** 从当前会话历史恢复外部路由，覆盖 DSH 第二轮省略 provider 的请求形态。 */
function inferMessageAdapter(messages: readonly CodingNsCliMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const source = asRecord((messages[index] as unknown as Record<string, unknown>).source)
    if (source?.kind !== 'model' || source.plugin !== 'codingns4dsh') continue
    const provider = source.provider
    if (typeof provider === 'string' && provider.trim() !== '') return provider.trim()
  }
  return undefined
}

async function setAdapterEnabled(
  settings: CodingNsHostServices['settings'],
  registry: CodingNsCliAdapterRegistry,
  value: unknown,
): Promise<{ adapterId: string; enabled: boolean }> {
  const record = asRecord(value)
  const adapterId = readAdapterId(record)
  if (typeof record?.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
  const enabled = registry.setEnabled(adapterId, record.enabled)
  if (settings !== undefined) await settings.update({ agentAdapters: registry.enabledSnapshot() })
  return { adapterId, enabled }
}

function extractTurnInput(messages: readonly CodingNsCliMessage[], dshContext?: CodingNsHostServices['dshContext']): { readonly prompt: string; readonly attachments: readonly CodingNsCliAttachment[] } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && isInjectedStepNotice(message)) return { prompt: extractText(message.content), attachments: [] }
    if (message !== undefined && isHumanUserMessage(message)) return extractMessageInput(message.content, dshContext)
  }
  return { prompt: '', attachments: [] }
}

/** DSH 为工具分段注入的继续提示必须成为下一次 Provider 请求的 prompt。 */
function isInjectedStepNotice(message: CodingNsCliMessage): boolean {
  if (message.role !== 'user' || !isRecord(message.source)) return false
  if (message.source.form !== 'notice') return false
  return message.source.kind === 'model-selection'
    || message.source.kind === 'plugin' && message.source.plugin === 'codingns4dsh'
}

function isHumanUserMessage(message: CodingNsCliMessage): boolean {
  if (message.role !== 'user') return false
  // 旧测试和旧调用方没有 source，保留其兼容语义；有 source 时只接受真实用户消息。
  if (message.source === undefined) return true
  if (!isRecord(message.source)) return false
  return message.source.kind === undefined || message.source.kind === 'user'
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(isRecord).map((part) => typeof part.text === 'string' ? part.text : '').join('\n').trim()
}

function extractMessageInput(content: unknown, dshContext?: CodingNsHostServices['dshContext']): { readonly prompt: string; readonly attachments: readonly CodingNsCliAttachment[] } {
  if (typeof content === 'string') return { prompt: content, attachments: [] }
  if (!Array.isArray(content)) return { prompt: '', attachments: [] }
  const text: string[] = []
  const attachments: CodingNsCliAttachment[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (typeof part.text === 'string' && part.text.trim() !== '') text.push(part.text)
    const kind = part.type === 'image' ? 'image' : part.type === 'file' ? 'file' : null
    if (kind === null) continue
    const reference = isRecord(part.attachment) ? part.attachment : part
    const path = resolveDshAttachmentPath(dshContext, kind, reference)
    if (path === undefined) continue
    const name = typeof reference.name === 'string' && reference.name.trim() !== '' ? reference.name.trim() : undefined
    const mimeType = typeof reference.mediaType === 'string' && reference.mediaType.trim() !== '' ? reference.mediaType.trim() : undefined
    attachments.push({ kind, path, ...(name === undefined ? {} : { name }), ...(mimeType === undefined ? {} : { mimeType }) })
  }
  const fileNotes = attachments.filter((attachment) => attachment.kind === 'file').map((attachment) => `附件文件${attachment.name === undefined ? '' : `「${attachment.name}」`}位于：${attachment.path}\n请使用工具读取该文件的内容。`)
  return { prompt: [...text, ...fileNotes].join('\n\n').trim(), attachments }
}

function resolveDshAttachmentPath(
  dshContext: CodingNsHostServices['dshContext'],
  kind: CodingNsCliAttachment['kind'],
  reference: Record<string, unknown>,
): string | undefined {
  if (dshContext === undefined || typeof reference.attachmentId !== 'string') return undefined
  try {
    const attachments = dshContext.get('attachments') as Record<string, unknown> | undefined
    const resolver = attachments?.[kind === 'image' ? 'imageHostPath' : 'fileHostPath']
    if (typeof resolver !== 'function') return undefined
    const hostPath = resolver.call(attachments, reference)
    if (typeof hostPath !== 'string' || hostPath.trim() === '') return undefined
    const fs = dshContext.get('fs') as Record<string, unknown> | undefined
    const mapper = fs?.processPathFromHostPath
    const processPath = typeof mapper === 'function' ? mapper.call(fs, hostPath) : undefined
    return typeof processPath === 'string' && processPath.trim() !== '' ? processPath : hostPath
  } catch {
    return undefined
  }
}

/**
 * 读取 DSH 会话当前生效的权限状态。
 *
 * 三个服务各自负责一部分事实，必须与 DSH 执行侧同源：
 * - `sandboxPolicy.resolve()` 给出含部署默认的生效模式；
 * - `approval.overrideOf()` 只返回会话覆盖值，缺省时用服务自身配置的默认策略补齐；
 * - `permissionPresets.current()` 只用于诊断。
 *
 * 任一服务缺失或结构不符时留空对应字段：驱动必须区分“还没读到”和“已确认无限制”，
 * 绝不能把探测失败当成 danger-full-access。
 */
function resolveSessionPermission(
  dshContext: CodingNsHostServices['dshContext'],
  sessionId: string,
): CodingNsCliPermissionState | undefined {
  if (dshContext === undefined || sessionId.trim() === '') return undefined
  const session = nativeSessionFor(dshContext, sessionId)
  if (session === undefined) return undefined
  const sandboxMode = readSandboxMode(dshContext, session)
  const approvalPolicy = readApprovalPolicy(dshContext, session)
  const preset = readPermissionPreset(dshContext, session)
  if (sandboxMode === undefined && approvalPolicy === undefined && preset === undefined) return undefined
  return {
    ...(sandboxMode === undefined ? {} : { sandboxMode }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    ...(preset === undefined ? {} : { preset }),
  }
}

/**
 * DSH 的 `agents` 注册表持有 Agent，而权限服务以 Agent 的 Session 为读取键。
 * 两者形状变化时都必须留空，不能把 Agent 直接当 Session 传进服务。
 */
function nativeSessionFor(dshContext: NonNullable<CodingNsHostServices['dshContext']>, sessionId: string): unknown {
  try {
    const agents = dshContext.get('agents') as Record<string, unknown> | undefined
    const get = agents?.get
    if (typeof get !== 'function') return undefined
    const agent = asRecord(get.call(agents, sessionId))
    return agent?.session ?? undefined
  } catch {
    return undefined
  }
}

function readSandboxMode(dshContext: NonNullable<CodingNsHostServices['dshContext']>, session: unknown): CodingNsCliSandboxMode | undefined {
  try {
    const service = dshContext.get('sandboxPolicy') as Record<string, unknown> | undefined
    const resolvePolicy = service?.resolve
    if (typeof resolvePolicy !== 'function') return undefined
    const policy = resolvePolicy.call(service, { session })
    // 先落到 unknown 再收窄：asRecord 返回的 any 属性不会触发类型谓词收窄，
    // 直接返回会退化成 boolean，无法赋给 CodingNsCliSandboxMode。
    const mode: unknown = asRecord(policy)?.mode
    return isSandboxMode(mode) ? mode : undefined
  } catch {
    return undefined
  }
}

function readApprovalPolicy(dshContext: NonNullable<CodingNsHostServices['dshContext']>, session: unknown): CodingNsCliApprovalPolicy | undefined {
  try {
    const service = dshContext.get('approval') as Record<string, unknown> | undefined
    const overrideOf = service?.overrideOf
    const override = typeof overrideOf === 'function' ? overrideOf.call(service, session) : undefined
    if (isApprovalPolicy(override)) return override
    // 没有会话覆盖时，服务自身配置的策略就是生效值；缺省与 DSH 一致按 ask 处理。
    const configured = asRecord(service?.config)?.policy
    return isApprovalPolicy(configured) ? configured : 'ask'
  } catch {
    return undefined
  }
}

function readPermissionPreset(dshContext: NonNullable<CodingNsHostServices['dshContext']>, session: unknown): string | undefined {
  try {
    const service = dshContext.get('permissionPresets') as Record<string, unknown> | undefined
    const current = service?.current
    if (typeof current !== 'function') return undefined
    const preset = current.call(service, session)
    return typeof preset === 'string' && preset.trim() !== '' ? preset.trim() : undefined
  } catch {
    return undefined
  }
}

function isSandboxMode(value: unknown): value is CodingNsCliSandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
}

function isApprovalPolicy(value: unknown): value is CodingNsCliApprovalPolicy {
  return value === 'ask' || value === 'never'
}

function resolveSessionCwd(
  nativeSessions: CodingNsHostServices['nativeSessions'],
  sessionId: string,
  value: Record<string, any> | null,
): string | undefined {
  const direct = typeof value?.cwd === 'string' && value.cwd.trim() ? value.cwd.trim() : undefined
  if (direct !== undefined) return direct
  if (nativeSessions === undefined || sessionId.trim() === '') return undefined
  const session = nativeSessions.get(sessionId)
  const record = asRecord(session)
  const header = asRecord(record?.header)
  const meta = asRecord(record?.meta)
  const directCwd = [header?.cwd, meta?.cwd, record?.cwd].find((item): item is string => typeof item === 'string' && item.trim() !== '')
  if (directCwd !== undefined) return directCwd.trim()
  const snapshot = record?.snapshotEvents
  if (typeof snapshot === 'function') {
    try {
      const events = snapshot.call(session)
      const eventCwd = findCwdInValue(events, 0)
      if (eventCwd !== undefined) return eventCwd
    } catch { /* 原生会话快照不可读时继续使用未解析状态。 */ }
  }
  return findCwdInValue(record, 0)
}

/** DSH 的 cwd 可能只存在 request/header.data.header 或事件 data.cwd 中。 */
function findCwdInValue(value: unknown, depth: number): string | undefined {
  if (depth > 6 || value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCwdInValue(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  for (const key of ['cwd', 'workingDirectory']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  for (const key of ['header', 'request', 'context', 'data', 'meta', 'session']) {
    const found = findCwdInValue(record[key], depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function asRecord(value: unknown): Record<string, any> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null }
function isRecord(value: unknown): value is Record<string, any> { return asRecord(value) !== null }
function nativeSessionId(value: unknown): string | undefined {
  const record = asRecord(value)
  return typeof record?.id === 'string' && record.id.trim() ? record.id.trim() : typeof record?.sessionId === 'string' && record.sessionId.trim() ? record.sessionId.trim() : undefined
}
function nativeEventType(value: unknown): string | undefined {
  const record = asRecord(value)
  return typeof record?.type === 'string' ? record.type : undefined
}
function isMessage(value: unknown): value is CodingNsCliMessage { const record = asRecord(value); return (record?.role === 'user' || record?.role === 'assistant' || record?.role === 'system') && 'content' in record }
function isAbortSignal(value: unknown): value is AbortSignal { return asRecord(value)?.aborted === true || (asRecord(value)?.addEventListener instanceof Function) }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) }

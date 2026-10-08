import assert from 'node:assert/strict'
import { memoryAssistantConversationStorage } from './assistant-fixtures.js'
import { setImmediate } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import test, { type TestContext } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FeatureRegistry } from '../data/build/dist/features/index.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { registerCodingNsRpc } from '../data/build/dist/host/rpc.js'
import { createGlobalVoiceRpcFeature } from '../data/build/dist/host/features/global-voice-rpc.js'
import { createAssistantLlmAdapter } from '../src/dsh-capabilities/host/assistant-llm-adapter.js'
import { AssistantAgentAdapter } from '../src/dsh-capabilities/host/assistant-agent-adapter.js'
import { AssistantDebugDialog, AssistantDebugSnapshotView, AssistantScopeSessionsView, AssistantIndexRecordsView, AssistantChatMessagesView, AssistantPromptEditor, mergeDebugWorkspaces } from '../data/build/dist/client/features/assistant-debug-dialog.js'
import { DEFAULT_ASSISTANT_PROMPTS, type AssistantPromptSettings } from '../data/build/dist/shared/assistant-prompts.js'
import { VoiceConversationDialog } from '../data/build/dist/client/features/voice-conversation-dialog.js'
import { resolveCodingNsTranslator } from '../data/build/dist/client/locale.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../data/build/dist/shared/contracts/config.js'
import { SherpaWorkerRuntime as SherpaVoiceRuntime } from '../src/host/features/sherpa-worker-runtime.js'
import type { AssistantDebugSnapshot } from '../data/build/dist/shared/contracts/assistant.js'
import type { CodingNsHostServices } from '../data/build/dist/host/features/types.js'

async function fixture(t: TestContext, options: { unmapped?: boolean; gatewayFailure?: boolean; readFailure?: boolean; llm?: unknown; nativeMetadata?: boolean; readGate?: Promise<void>; idle?: boolean; voice?: boolean; nativeAgents?: unknown } = {}) {
  const rpc = new CodingNsRpcTable()
  let managed = ['w1']
  let prefixPrompts: AssistantPromptSettings = DEFAULT_ASSISTANT_PROMPTS
  const reads: string[] = []
  const prompts: unknown[] = []
  let watch: (() => void) | undefined
  const listeners = new Map<string, () => void>()
  let sessions = [
    { sessionId: 's1', workspaceId: 'w1', title: '登录检查', state: 'running' },
    { sessionId: 's2', workspaceId: 'w2', title: '范围外会话', state: 'completed' },
    { sessionId: 's3', workspaceId: 'w1', title: '归档会话', state: 'completed' },
    { sessionId: 's4', workspaceId: 'w1', title: '待回答', waiting: 'question' },
    ...(options.unmapped ? [{ sessionId: 'orphan', title: '无法归属', state: 'running' }] : []),
  ]
  if (options.idle) sessions = sessions.map((entry) => ({ ...entry, state: 'completed', waiting: undefined }))
  const services = {
    rpc,
    dshVersion: '0.2.1-alpha.1',
    events: { on: (name: string, listener: () => void) => { listeners.set(name, listener); return () => listeners.delete(name) } },
    ...(options.gatewayFailure ? { assistantGateway: { list: async () => { throw new Error('远端 RPC 失败 token: private-token') } } } : {}),
    settings: { get: () => ({ ...DEFAULT_CODINGNS_SETTINGS, assistant: { ...DEFAULT_CODINGNS_SETTINGS.assistant, profile: { name: '测试助理', initialized: true, createdAt: 1 }, managedWorkspaceIds: managed, prompts: prefixPrompts, ...(options.voice ? { model: { provider: 'api', model: 'selected' }, voice: { ...DEFAULT_CODINGNS_SETTINGS.assistant.voice, initialized: true, provider: 'sherpa-onnx', asrEncoder: '/fixture/encoder', asrDecoder: '/fixture/decoder', asrJoiner: '/fixture/joiner', asrTokens: '/fixture/tokens' } } : {}) } }), watch: (listener: () => void) => { watch = listener; return () => { watch = undefined } } },
    dshContext: { get(name: string) {
      if (options.nativeAgents !== undefined) {
        if (name === 'agents') return options.nativeAgents
        if (name === 'tools') return { register() {}, restrict() {}, guard() {}, presentAs() {} }
        if (name === 'systemPrompt') return { section() {}, suppressRuntimeContext() {} }
        if (name === 'on') return () => {}
      }
      if (name === 'llm') return options.llm
      if (name === 'workspaceRegistry') return { archivedSessionIds: ['s3'], list: () => [
        { id: 'w1', displayName: '项目一', path: '/project/one', sessionIds: ['s1', 's3', 's4'], archivedSessionIds: ['s3'] },
        { id: 'w2', displayName: '项目二', path: '/project/two', sessionIds: ['s2'] },
      ] }
      if (name === 'sessionQuery') return { listSessions: () => sessions, readSurface: async (id: string) => { reads.push(id); await options.readGate; if (options.readFailure && id === 's1') throw new Error('正文读取失败 token: hidden'); return `正文-${id}` } }
      if (name === 'sessionController') return { prompt: async (request: unknown) => { prompts.push(request) }, ...(options.nativeMetadata ? { list: () => ({ items: sessions.map((entry) => ({ ...entry, blank: false, origin: undefined, running: entry.state === 'running', updatedAt: 123456789 })) }) } : {}) }
      return undefined
    } },
  } as unknown as CodingNsHostServices
  const registry = new FeatureRegistry(services)
  registry.register(createGlobalVoiceRpcFeature({ conversationStorage: memoryAssistantConversationStorage(), ...(options.nativeAgents === undefined ? { conversationAdapter: createAssistantLlmAdapter(services.dshContext, '0.2.1-alpha.1') } : {}) }))
  await registry.reconcile(['globalVoiceRpc'])
  t.after(() => registry.reconcile([]))
  const call = async (endpoint: string, payload: unknown = {}) => {
    const target = rpc.resolve(endpoint)!
    return target.handler(target.action, payload)
  }
  return { call, reads, prompts, emit: (name: string, ...args: unknown[]) => (listeners.get(name) as ((...values: unknown[]) => void) | undefined)?.(...args), setManaged: (value: string[]) => { managed = value; watch?.() }, setPrompts: (value: AssistantPromptSettings) => { prefixPrompts = value; watch?.() }, complete: () => { sessions = sessions.map((entry) => entry.sessionId === 's1' ? { ...entry, state: 'completed' } : entry) } }
}

/** 重现 Stage0：103 个归档根会话、44 个子代理、3 个空白占位、2 个普通会话。 */
async function nativeScopeFixture(t: TestContext) {
  const rpc = new CodingNsRpcTable()
  const reads: string[] = []
  const titles: string[] = []
  let historyListCalls = 0
  let listMode: 'normal' | 'empty' | 'failed' = 'normal'
  const archived = Array.from({ length: 103 }, (_, index) => `archived-${index}`)
  const rows = [
    ...['active-1', 'active-2'].map((sessionId) => ({ sessionId, blank: false })),
    { sessionId: 'codingns-assistant-private-runtime', blank: false },
    ...['blank-1', 'blank-2', 'blank-3'].map((sessionId) => ({ sessionId, blank: true })),
    ...archived.map((sessionId) => ({ sessionId, blank: false })),
    ...Array.from({ length: 44 }, (_, index) => ({ sessionId: `child-${index}`, blank: false, origin: 'subagent', parentSessionId: index % 2 ? 'active-1' : 'archived-0' })),
  ] as { sessionId: string; blank: boolean; origin?: string; parentSessionId?: string; cwd?: string; workspaceId?: string }[]
  let members = rows.filter((entry) => entry.origin !== 'subagent').map((entry) => entry.sessionId)
  const listeners = new Map<string, () => void>()
  const services = {
    rpc,
    dshVersion: '0.2.1-alpha.1',
    events: { on: (name: string, listener: () => void) => { listeners.set(name, listener); return () => listeners.delete(name) } },
    settings: { get: () => ({ ...DEFAULT_CODINGNS_SETTINGS, assistant: { ...DEFAULT_CODINGNS_SETTINGS.assistant, profile: { name: '测试助理', initialized: true, createdAt: 1 }, managedWorkspaceIds: ['test'] } }) },
    dshContext: { get(name: string) {
      if (name === 'workspaceRegistry') return { archivedSessionIds: archived, list: () => [{ id: 'test', displayName: 'TEST', path: '/project/test', sessionIds: members }] }
      if (name === 'sessionController') return { list: () => {
        if (listMode === 'failed') throw new Error('模拟原生列表失败')
        return { items: listMode === 'empty' ? [] : rows.map((entry) => ({ cwd: '/project/test', ...entry, running: false, updatedAt: 123456789 })) }
      } }
      if (name === 'sessionQuery') return {
        listSessions: () => { historyListCalls += 1; return rows.map((entry) => ({ header: { id: entry.sessionId, cwd: entry.cwd ?? '/project/test', origin: entry.origin, parentSession: entry.parentSessionId }, live: false, persisted: true })) },
        readTitle: async (id: string) => { titles.push(id); return `标题-${id}` },
        readSurface: async (id: string) => { reads.push(id); return `正文-${id}` },
      }
      return undefined
    } },
  } as unknown as CodingNsHostServices
  const registry = new FeatureRegistry(services)
  registry.register(createGlobalVoiceRpcFeature({ conversationStorage: memoryAssistantConversationStorage() }))
  await registry.reconcile(['globalVoiceRpc'])
  t.after(() => registry.reconcile([]))
  return {
    call: (endpoint: string, payload: unknown = {}) => { const target = rpc.resolve(endpoint)!; return target.handler(target.action, payload) },
    reads, titles,
    historyCalls: () => historyListCalls,
    setListMode: (mode: typeof listMode) => { listMode = mode },
    add: (row: typeof rows[number], registered: boolean) => { rows.push(row); if (registered) members = [...members, row.sessionId] },
    archive: (id: string) => { archived.push(id) },
    unarchive: (id: string) => { archived.splice(archived.indexOf(id), 1); listeners.get('workspace/unarchive')?.() },
  }
}

test('Stage0 原生成员与侧栏可见性口径一致：49 条历史仅纳入 2 个会话', async (t) => {
  const f = await nativeScopeFixture(t)
  const initial = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.deepEqual(initial.scopeSessions.map((entry) => entry.sessionId), ['active-1', 'active-2'])
  assert.equal(initial.index.excludedTargets?.length, 103)
  assert.ok(initial.index.excludedTargets?.every((entry) => entry.archived))
  assert.equal(f.historyCalls(), 0, '原生列表可用时不扫描全部日志目录')
  assert.deepEqual(f.reads, [])
  await f.call('assistant/index/rebuild')
  const indexed = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(indexed.indexState, 'incomplete', '此成员过滤测试未接入 LLM，只有原始索引材料')
  assert.equal(indexed.records[0]?.included, 2)
  assert.deepEqual(f.reads, ['active-1', 'active-2'])
  assert.ok(f.titles.every((id) => id === 'active-1' || id === 'active-2'))
  const markup = renderToStaticMarkup(createElement(AssistantScopeSessionsView, { snapshot: indexed, managedIds: ['test'], t: resolveCodingNsTranslator() }))
  assert.match(markup, /TEST.*2 个未归档会话/u)
  for (const hidden of ['child-0', 'blank-1', 'archived-0']) assert.ok(!markup.includes(hidden))
})

test('cwd 相同、子目录或伪造 workspaceId 不增加成员，独立 fork 仍可纳入', async (t) => {
  const f = await nativeScopeFixture(t)
  f.add({ sessionId: 'loose', blank: false, workspaceId: 'test' }, false)
  f.add({ sessionId: 'nested', blank: false, cwd: '/project/test/child' }, false)
  f.add({ sessionId: 'registered-child', blank: false, origin: 'subagent', parentSessionId: 'archived-0' }, true)
  f.add({ sessionId: 'independent-fork', blank: false, parentSessionId: 'archived-0' }, true)
  const snapshot = await f.call('assistant/index/rebuild') as AssistantDebugSnapshot['index']
  assert.deepEqual(snapshot.entries.map((entry) => entry.sessionId), ['active-1', 'active-2', 'independent-fork'])
  assert.deepEqual(f.reads, ['active-1', 'active-2', 'independent-fork'])
})

test('原生列表为空或失败时不回退到全量日志，归档元数据仍能解释排除原因', async (t) => {
  const f = await nativeScopeFixture(t)
  for (const mode of ['empty', 'failed'] as const) {
    f.setListMode(mode)
    const snapshot = await f.call('assistant/debug', { refresh: true }) as AssistantDebugSnapshot
    assert.equal(snapshot.scopeSessions.length, 0)
    assert.equal(snapshot.index.excludedTargets?.length, 103)
    assert.equal(snapshot.warnings.length, mode === 'failed' ? 1 : 0)
    assert.equal(f.historyCalls(), 0)
    assert.deepEqual(f.reads, [])
  }
})

test('归档改变当前成员后，调试页不继续展示旧索引正文，取消归档可重新索引', async (t) => {
  const f = await nativeScopeFixture(t)
  await f.call('assistant/index/rebuild')
  f.reads.length = 0
  // 即使归档事件未送达，刷新元数据也应识别旧结果已经不适用。
  f.archive('active-1')
  const archived = await f.call('assistant/debug', { refresh: true }) as AssistantDebugSnapshot
  assert.equal(archived.indexState, 'stale')
  assert.equal(archived.indexedAt, null)
  assert.deepEqual(archived.scopeSessions.map((entry) => entry.sessionId), ['active-2'])
  assert.deepEqual(archived.index.entries.map((entry) => [entry.sessionId, entry.summary]), [['active-2', null]])
  assert.deepEqual(f.reads, [])
  await assert.rejects(f.call('assistant/chat/start'), /索引尚未生成或已经过期/u)
  await f.call('assistant/index/rebuild')
  assert.deepEqual(f.reads, [], '未变化会话复用原始材料')
  f.unarchive('active-1')
  await f.call('assistant/index/rebuild')
  const restored = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(restored.indexState, 'incomplete', '取消归档后原始索引恢复，但此测试未接入 LLM')
  assert.deepEqual(restored.index.entries.map((entry) => entry.sessionId), ['active-1', 'active-2'])
  assert.equal(restored.records.length, 3)
})

test('查看面板不执行索引；手动索引保存记录，范围外和归档正文不会被读取', async (t) => {
  const f = await fixture(t)
  const initial = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(initial.indexState, 'not-built')
  assert.equal(initial.records.length, 0)
  assert.deepEqual(initial.scopeSessions.map((entry) => entry.sessionId), ['s1', 's4'])
  assert.deepEqual(f.reads, [])
  await f.call('assistant/index/rebuild')
  const first = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(first.indexState, 'incomplete', '无模型时明确区分原始材料与完整结构化索引')
  assert.equal(first.records[0]?.trigger, 'manual')
  assert.equal(first.records[0]?.state, 'completed')
  assert.deepEqual(first.index.entries.map((entry) => entry.sessionId), ['s1', 's4'])
  assert.deepEqual(first.index.excludedTargets?.map((entry) => [entry.sessionId, entry.archived]), [['s2', false], ['s3', true]])
  assert.deepEqual(f.reads, [], '运行中和等待回答的会话不读取索引正文')
  assert.equal(first.workspaces.length, 2)
  assert.deepEqual(first.services, { workspaceList: true, sessionList: true, summaryRead: true, taskDispatch: true, remoteGateway: false })
  assert.equal(first.index.entries[1]?.waiting, 'question')
  assert.match(first.summary.speechText, /等待回答/u)
  assert.equal('cliSessions' in first, false)
  f.complete()
  await f.call('assistant/index/rebuild')
  const second = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.ok(second.index.generation > first.index.generation)
  assert.equal(second.index.entries[0]?.status, 'completed')
  f.setManaged([])
  f.reads.length = 0
  const empty = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(empty.index.scope.status, 'empty')
  assert.match(empty.summary.speechText, /尚未选择任何工作区/u)
  assert.equal(empty.index.entries.length, 0)
  assert.equal(empty.index.excludedTargets?.length, 4)
  assert.deepEqual(f.reads, [])
})

test('远端读取失败和会话归属缺失显示诊断，错误中的凭据不进入快照', async (t) => {
  const f = await fixture(t, { unmapped: true, gatewayFailure: true })
  const snapshot = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(snapshot.services.remoteGateway, true)
  assert.equal(snapshot.warnings.length, 2)
  assert.match(snapshot.warnings[0]!, /远端 Host 状态读取失败/u)
  assert.match(snapshot.warnings[1]!, /有1个会话无法确定所属工作区/u)
  assert.ok(!JSON.stringify(snapshot).includes('private-token'))
  assert.deepEqual(f.reads, [])
  const markup = renderToStaticMarkup(createElement(AssistantDebugSnapshotView, { snapshot, t: resolveCodingNsTranslator() }))
  assert.ok(markup.includes('远端 RPC 失败'))
})

test('文字预览无派发副作用，执行复用受管目标校验与请求去重', async (t) => {
  const f = await fixture(t)
  const command = { text: '让登录检查检查登录问题', requestId: 'debug-command' }
  const preview = await f.call('assistant/preview', command) as { intent: { kind: string; target: { sessionId: string } } }
  assert.equal(preview.intent.kind, 'dispatch')
  assert.equal(preview.intent.target.sessionId, 's1')
  assert.equal(f.prompts.length, 0)
  const result = await f.call('assistant/turn', command) as { kind: string }
  assert.equal(result.kind, 'dispatch')
  await f.call('assistant/turn', command)
  assert.equal(f.prompts.length, 1)
  const rejected = await f.call('assistant/preview', { text: '让范围外会话检查登录问题', requestId: 'outside' }) as { intent: { kind: string; reason: string } }
  assert.equal(rejected.intent.kind, 'clarify')
  assert.match(rejected.intent.reason, /不在助理受管范围/u)
})

test('调试视图展示未知、等待、排除原因和完整快照，合并远端及失效工作区', async (t) => {
  const f = await fixture(t)
  f.complete()
  await f.call('assistant/index/rebuild')
  const snapshot = await f.call('assistant/debug') as AssistantDebugSnapshot
  const workspaces = mergeDebugWorkspaces(snapshot, [{ workspaceId: 'remote', title: '远端项目', sessionIds: [] }], ['w1', 'missing'])
  assert.deepEqual(workspaces.map((entry) => entry.workspaceId), ['w1', 'w2', 'remote', 'missing'])
  assert.equal(workspaces.at(-1)?.available, false)
  const tzh = resolveCodingNsTranslator()
  const unknown = { ...snapshot, index: { ...snapshot.index, entries: [...snapshot.index.entries, { ...snapshot.index.entries[0]!, sessionId: 'unknown', status: 'unknown' as const }] } }
  const markup = renderToStaticMarkup(createElement(AssistantDebugSnapshotView, { snapshot: unknown, t: tzh }))
  for (const text of ['状态未知', '等待回答', '工作区未纳入管理', '已归档', '正文-s1', '原始状态快照']) assert.ok(markup.includes(text), text)
})

test('读取失败计入每次索引记录，范围变化后不返回旧范围正文', async (t) => {
  const f = await fixture(t, { readFailure: true, idle: true })
  await f.call('assistant/index/rebuild')
  const first = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(first.records[0]?.unreadable, 1)
  assert.equal(first.records[0]?.sessions[0]?.result, 'failed')
  assert.ok(!first.records[0]?.sessions[0]?.error?.includes('hidden'))
  assert.equal(first.records[0]?.sessions[1]?.result, 'read')
  const records = renderToStaticMarkup(createElement(AssistantIndexRecordsView, { snapshot: first, t: resolveCodingNsTranslator() }))
  assert.ok(records.includes('正文读取失败'))
  f.setManaged(['w2'])
  const changed = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(changed.indexState, 'stale')
  assert.equal(changed.indexedAt, null)
  assert.ok(changed.index.entries.every((entry) => entry.summary === null))
  const scope = renderToStaticMarkup(createElement(AssistantScopeSessionsView, { snapshot: changed, managedIds: ['w2'], t: resolveCodingNsTranslator() }))
  assert.ok(scope.includes('项目二'))
  assert.ok(scope.includes('范围外会话'))
  assert.ok(!scope.includes('登录检查'))
})

test('范围会话标题直接显示执行状态与索引状态，索引标签无需展开', async (t) => {
  const f = await nativeScopeFixture(t)
  const snapshot = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.ok(snapshot.scopeSessions.every((entry) => entry.status === 'completed'))
  const tzh = resolveCodingNsTranslator()
  for (const [state, label] of [
    ['pending', '尚未索引'], ['waiting', '等待本轮完成后索引'], ['queued', '索引排队中'],
    ['running', '索引中'], ['completed', '索引已完成'], ['stale', '索引待更新'],
    ['failed', '索引失败'], ['cancelled', '索引已停止'],
  ] as const) {
    const scopeSessions = [{ ...snapshot.scopeSessions[0]!, indexState: state }]
    const markup = renderToStaticMarkup(createElement(AssistantScopeSessionsView, { snapshot: { ...snapshot, scopeSessions }, managedIds: ['test'], t: tzh }))
    assert.match(markup, new RegExp(`<summary[^>]*>.*已完成.*${label}.*</summary>`, 'u'))
    assert.ok(markup.includes('本轮执行结束'))
  }
  for (const [change, label] of [
    [{ activity: 'unknown' as const, status: 'unknown' as const }, '等待会话状态同步'],
    [{ waiting: 'approval' as const, status: 'waiting' as const }, '等待用户处理后索引'],
  ] as const) {
    const scopeSessions = [{ ...snapshot.scopeSessions[0]!, ...change, indexState: 'waiting' as const }]
    const markup = renderToStaticMarkup(createElement(AssistantScopeSessionsView, { snapshot: { ...snapshot, scopeSessions }, managedIds: ['test'], t: tzh }))
    assert.ok(markup.includes(label))
  }
})

test('面板有五个明确步骤，文字对话显示用户和 LLM 回复', () => {
  const services = { rpc: { call: async () => { assert.fail('静态渲染不得发起 RPC') } }, locale: { getSnapshot: () => ({ revision: 0 }), bind: () => resolveCodingNsTranslator(), subscribe: () => () => {} }, settings: { getSnapshot: () => ({ status: 'ready', writable: true, value: DEFAULT_CODINGNS_SETTINGS }) } }
  const markup = renderToStaticMarkup(createElement(AssistantDebugDialog, { services: services as any, onClose() {} }))
  for (const text of ['1. 设置索引范围', '2. 范围内工作区和会话', '3. 当前索引结果', '4. 索引记录', '5. LLM 文本对话', '执行索引']) assert.ok(markup.includes(text), text)
  assert.equal((markup.match(/role="tab"/gu) ?? []).length, 5)
  const chat = renderToStaticMarkup(createElement(AssistantChatMessagesView, { history: [{ role: 'user', text: '项目在做什么？' }, { role: 'assistant', text: '正在检查登录。' }], submitted: '', run: undefined, t: resolveCodingNsTranslator() }))
  for (const text of ['项目在做什么？', '正在检查登录。', '全局助理']) assert.ok(chat.includes(text))
})

/** 模型测试替身按系统消息里的真实范围输出结构，不依赖固定会话数量。 */
function structuredReply(options: Record<string, any>): string {
  const facts = JSON.parse(options.system.split('<索引事实>\n')[1].split('\n</索引事实>')[0])
  return JSON.stringify({ schemaVersion: 1, sessions: facts.sessions.map((entry: any) => ({
    hostId: entry.hostId, sessionId: entry.sessionId, objective: entry.title ? { text: entry.title, evidence: [{ source: 'title', quote: entry.title }] } : null,
    progress: entry.summary ? [{ text: '当前会话摘录已读取。', evidence: [{ source: 'summary', quote: entry.summary }] }] : [],
    blockers: [], pendingTasks: [], nextActions: entry.summary ? [{ action: '核对当前会话的验证记录', kind: 'suggested', priority: 'normal', reason: '当前摘录缺少具体验证结果', evidence: [{ source: 'summary', quote: entry.summary }] }] : [],
    openQuestions: ['这次工作的验证结果是什么？'],
  })) })
}

test('LLM RPC 不依赖语音，拒绝未建索引；调用原生模型且不派发任何项目任务', async (t) => {
  const wire: Record<string, any>[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const llm = { listProviders: () => [{ id: 'api', name: 'API' }], listModels: async () => [{ id: 'chat', name: 'Chat' }], async *stream(options: Record<string, any>) {
    if (options.system.includes('供助理检索的结构化索引')) { yield { type: 'text-delta', index: 0, text: structuredReply(options) }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    wire.push(options); yield { type: 'text-delta', index: 0, text: '项目一正在检查' }; await gate; yield { type: 'text-delta', index: 0, text: '登录。' }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const f = await fixture(t, { llm, nativeMetadata: true, idle: true })
  const payload = { requestId: 'llm-rpc', provider: 'api', model: 'chat', generation: 1, messages: [{ role: 'user', text: '项目进展怎么样？' }] }
  await assert.rejects(f.call('assistant/chat/start', payload), /自动更新索引/u)
  await f.call('assistant/index/rebuild')
  await setImmediate()
  const snapshot = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(snapshot.index.entries[0]?.updatedAt, 123456789)
  await f.call('assistant/chat/start', payload)
  await setImmediate()
  const partial = await f.call('assistant/chat/read', { requestId: 'llm-rpc' }) as { state: string; text: string }
  assert.equal(partial.state, 'running')
  assert.equal(partial.text, '项目一正在检查')
  release(); await setImmediate()
  const completed = await f.call('assistant/chat/read', { requestId: 'llm-rpc' }) as { state: string; text: string }
  assert.equal(completed.state, 'completed')
  assert.equal(completed.text, '项目一正在检查登录。')
  assert.equal(wire.length, 1)
  assert.ok(wire[0]!.system.includes('正文-s1'))
  assert.ok(!wire[0]!.system.includes('范围外会话'))
  assert.ok(!wire[0]!.system.includes('归档会话'))
  assert.deepEqual(f.prompts, [])
  f.setManaged(['w2'])
  await assert.rejects(f.call('assistant/chat/start', { ...payload, requestId: 'new-scope' }), /自动更新索引/u)
})

test('手动索引真实调用所选 LLM，分阶段回显总结并保留原始证据，刷新不重复调用', async (t) => {
  const wire: Record<string, any>[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const llm = { listProviders: () => [{ id: 'api', name: 'API' }], listModels: async () => [{ id: 'default', name: 'Default' }, { id: 'selected', name: 'Selected' }], resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }), async *stream(options: Record<string, any>) {
    wire.push(options)
    if (!options.system.includes('供助理检索的结构化索引')) { yield { type: 'text-delta', index: 0, text: '建议核对验证记录。' }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    const json = structuredReply(options)
    yield { type: 'text-delta', index: 0, text: json.slice(0, 20) }
    await gate
    yield { type: 'text-delta', index: 0, text: json.slice(20) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const f = await fixture(t, { llm, idle: true })
  f.setPrompts({ index: '索引只说三句话。', chat: '对话只说一句话。' })
  await f.call('assistant/summary')
  assert.equal(wire.length, 0, '语音按需索引不会自动产生模型调用')
  const initial = await f.call('assistant/index/rebuild', { provider: 'api', model: 'selected' }) as AssistantDebugSnapshot['index']
  assert.equal(initial.analysis?.state, 'running')
  await setImmediate()
  const partial = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(partial.indexState, 'building')
  assert.match(partial.index.analysis?.tasks?.[0]?.text ?? '', /^\{"schemaVersion":1,/u)
  assert.equal(partial.index.analysis?.tasks?.length, 2)
  assert.equal(wire.length, 2, '每个会话一个独立模型请求')
  assert.equal(partial.index.analysis?.result, undefined, '流式半截 JSON 不能作为有效结果')
  assert.equal(wire[0]?.model, 'selected')
  assert.equal(wire[0]?.maxTokens, 8192)
  assert.equal(wire.every((request) => request.reasoningEffort === 'off'), true)
  assert.ok(wire[0]?.system.startsWith('索引只说三句话。'))
  const facts = JSON.parse(wire[0]?.system.split('<索引事实>\n')[1].split('\n</索引事实>')[0])
  assert.ok(!JSON.stringify(facts).includes('范围外会话'))
  assert.ok(!wire[0]?.system.includes('归档会话'))
  await assert.rejects(f.call('assistant/chat/start', { requestId: 'early', provider: 'api', model: 'selected', generation: initial.generation, messages: [{ role: 'user', text: '下一步？' }] }), /总结正在生成/u)
  release(); await setImmediate()
  const completed = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(completed.indexState, 'ready')
  assert.equal(completed.index.analysis?.state, 'completed')
  assert.ok(completed.summary.speechText.includes('建议核对当前会话的验证记录'))
  assert.ok(!completed.summary.speechText.includes('schemaVersion'))
  assert.equal(completed.index.analysis?.result?.sessions.length, 2)
  assert.equal(completed.index.analysis?.result?.sessions[1]?.sourceStatus, 'completed')
  assert.equal(completed.index.entries[0]?.summary, '正文-s1')
  assert.equal(completed.index.entries[1]?.status, 'completed')
  assert.equal(completed.records[0]?.analysis?.state, 'completed')
  assert.equal(completed.records[0]?.analysis?.tasks?.every((task) => task.state === 'completed' && task.thinking === 'disabled'), true)
  assert.ok(completed.records[0]?.analysis?.tasks?.every((task) => !('text' in task)))
  assert.ok(!JSON.stringify(completed.records).includes('nextActions'))
  await f.call('assistant/debug')
  assert.equal(wire.length, 2)
  const html = renderToStaticMarkup(createElement(AssistantDebugSnapshotView, { snapshot: completed, t: resolveCodingNsTranslator() }))
  for (const value of ['LLM 结构化会话索引', '总结已生成', '工作目标', '已有进展与验证结果', '当前阻碍', '已提出的待办', '下一步行动', '需要补充的信息', '查看来源证据', '建议（未安排）', '原始会话摘录']) assert.ok(html.includes(value), value)
  assert.ok(html.includes('已传入关闭思考参数'))
  const recordsHtml = renderToStaticMarkup(createElement(AssistantIndexRecordsView, { snapshot: completed, t: resolveCodingNsTranslator() }))
  assert.ok(recordsHtml.includes('已传入关闭思考参数'))
  f.setPrompts({ index: '索引只说三句话。', chat: '换一个对话提示词。' })
  const stillReady = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(stillReady.indexState, 'ready', '只改对话提示词不要求重建索引')
  await f.call('assistant/chat/start', { requestId: 'new-prompt', provider: 'api', model: 'selected', generation: initial.generation, messages: [{ role: 'user', text: '下一步？' }] })
  await setImmediate()
  assert.ok(wire[2]?.system.startsWith('换一个对话提示词。'))
  assert.ok(wire[2]?.system.includes('"nextActions"'))
  assert.ok(wire[2]?.system.includes('"sourceStatus":"completed"'))
  assert.equal(wire[2]?.maxTokens, 2048)
  assert.equal('reasoningEffort' in wire[2]!, false, '索引关闭思考不改变文字对话参数')
  assert.deepEqual(f.prompts, [])
})

test('索引模型返回普通段落时失败并保留来源，禁止作为成功索引继续问答', async (t) => {
  let calls = 0
  const llm = { listProviders: () => [{ id: 'api', name: 'API' }], listModels: async () => [{ id: 'chat', name: 'Chat' }], async *stream() {
    calls += 1
    yield { type: 'text-delta', index: 0, text: '目前有两个会话，建议检查权限。' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const f = await fixture(t, { llm, idle: true })
  await f.call('assistant/index/rebuild'); await setImmediate()
  const failed = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(failed.index.analysis?.state, 'failed')
  assert.match(failed.index.analysis?.error ?? '', /格式校验失败/u)
  assert.equal(failed.indexState, 'incomplete')
  assert.equal(failed.index.analysis?.result, undefined)
  assert.equal(failed.index.entries[0]?.summary, '正文-s1')
  assert.ok(!failed.summary.speechText.includes('建议检查权限'))
  assert.equal(failed.records[0]?.analysis?.state, 'failed')
  await assert.rejects(f.call('assistant/chat/start', { requestId: 'invalid-index', provider: 'api', model: 'chat', generation: failed.index.generation, messages: [{ role: 'user', text: '下一步？' }] }), /结构化索引未生成/u)
  assert.equal(calls, 6, '两个会话各自达到三次调用上限')
  assert.equal(failed.index.analysis?.tasks?.every((task) => task.attempt === 3), true)
  await f.call('assistant/debug')
  assert.equal(calls, 6, '面板刷新不重置已失败版本的调用预算')
  // 其他会话触发新批次时，缓存失败的前次用量仍应可见，但不能冒充本次调用。
  const reused = { ...failed, index: { ...failed.index, analysis: { ...failed.index.analysis!, tasks: failed.index.analysis!.tasks!.map((task) => ({ ...task, reused: true })) } } }
  const html = renderToStaticMarkup(createElement(AssistantDebugSnapshotView, { snapshot: reused, t: resolveCodingNsTranslator() }))
  assert.ok(html.includes('前次模型调用：3/3 次（含首次调用）'))
  assert.ok(html.includes('沿用上次结果，本次未调用模型'))
})

test('单会话限流等待在调试页与记录中可见，自动恢复并复用其他成功会话', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  t.mock.method(Math, 'random', () => 0.5)
  const counts = new Map<string, number>()
  const llm = { listProviders: () => [{ id: 'api', name: 'API' }], listModels: async () => [{ id: 'chat', name: 'Chat' }], async *stream(options: Record<string, any>) {
    const facts = JSON.parse(options.system.split('<索引事实>\n')[1].split('\n</索引事实>')[0])
    const id = facts.sessions[0].sessionId
    const count = (counts.get(id) ?? 0) + 1; counts.set(id, count)
    if (id === 's1' && count === 1) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '请求过于频繁', code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 12_000 } } }
      return
    }
    yield { type: 'text-delta', index: 0, text: structuredReply(options) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const f = await fixture(t, { llm, idle: true })
  await f.call('assistant/index/rebuild'); await setImmediate()
  const pending = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(pending.indexState, 'building')
  assert.equal(pending.index.analysis?.tasks?.[0]?.attempt, 1)
  assert.equal(pending.index.analysis?.tasks?.[0]?.nextRetryAt, Date.now() + 12_000)
  assert.equal(pending.index.analysis?.tasks?.[1]?.state, 'completed')
  assert.equal(pending.records[0]?.analysis?.tasks?.[0]?.nextRetryAt, Date.now() + 12_000)
  for (const View of [AssistantDebugSnapshotView, AssistantIndexRecordsView]) {
    const html = renderToStaticMarkup(createElement(View, { snapshot: pending, t: resolveCodingNsTranslator() }))
    assert.ok(html.includes('模型调用：1/3 次（含首次调用）'))
    assert.ok(html.includes('等待自动重试：第 2 次调用，约 12 秒后开始'))
  }
  t.mock.timers.tick(11_999); await setImmediate()
  assert.equal(counts.get('s1'), 1)
  t.mock.timers.tick(1); await setImmediate()
  const done = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(done.indexState, 'ready')
  assert.equal(counts.get('s1'), 2); assert.equal(counts.get('s4'), 1)
  assert.equal(done.scopeSessions.every((session) => session.indexState === 'completed'), true)
  assert.equal(done.records[0]?.analysis?.tasks?.[0]?.attempt, 2)
  assert.equal(done.records[0]?.analysis?.tasks?.[0]?.nextRetryAt, null)
})

test('索引模型失败或中止都有明确状态，模型晚到结果不能覆盖取消与范围变更', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let mode: 'failed' | 'slow' = 'failed'
  let signal!: AbortSignal
  const llm = { listProviders: () => [{ id: 'api', name: 'API' }], listModels: async () => [{ id: 'chat', name: 'Chat' }], async *stream(options: Record<string, any>) {
    signal = options.signal
    if (mode === 'failed') throw new Error('模型失败 token: private-key')
    const json = structuredReply(options)
    yield { type: 'text-delta', index: 0, text: json.slice(0, 20) }
    await gate
    yield { type: 'text-delta', index: 0, text: json.slice(20) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const f = await fixture(t, { llm, idle: true })
  await f.call('assistant/index/rebuild'); await setImmediate()
  const failed = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(failed.index.analysis?.state, 'failed')
  assert.equal(failed.index.entries[0]?.summary, '正文-s1')
  assert.ok(!failed.index.analysis?.error?.includes('private-key'))
  mode = 'slow'
  await f.call('assistant/index/rebuild'); await setImmediate()
  const partial = await f.call('assistant/debug') as AssistantDebugSnapshot
  await f.call('assistant/index/cancel', { requestId: partial.index.analysis!.requestId })
  assert.equal(signal.aborted, true)
  const stopped = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(stopped.index.analysis?.state, 'cancelled')
  assert.equal(stopped.records[0]?.analysis?.state, 'cancelled')
  f.setManaged(['w2'])
  const changed = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(changed.index.analysis, undefined)
  assert.ok(changed.index.entries.every((entry) => entry.summary === null))
  release(); await setImmediate()
  const late = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(late.index.analysis, undefined)
  assert.equal(late.records[0]?.analysis?.state, 'cancelled')
})

test('口语化提示词编辑器提供独立保存、恢复默认和只读控件', () => {
  for (const kind of ['index', 'chat'] as const) {
    const html = renderToStaticMarkup(createElement(AssistantPromptEditor, { kind, value: DEFAULT_ASSISTANT_PROMPTS[kind], disabled: true, onSave: async () => {}, t: resolveCodingNsTranslator() }))
    assert.ok(html.includes(kind === 'index' ? '索引总结前置提示词' : '对话前置提示词'))
    assert.ok(html.includes('口语'))
    assert.ok(html.includes('保存提示词'))
    assert.ok(html.includes('填入默认提示词'))
    assert.match(html, /<textarea[^>]*disabled/u)
  }
})

test('构建期间源数据变化，结果和记录保留但标记过期，不能启动 LLM 问答', async (t) => {
  let release!: () => void
  const readGate = new Promise<void>((resolve) => { release = resolve })
  const f = await fixture(t, { readGate, idle: true })
  const indexing = f.call('assistant/index/rebuild')
  await setImmediate()
  const during = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(during.indexState, 'building')
  assert.equal(during.records[0]?.state, 'running')
  f.emit('session/update', 's1'); release(); await indexing
  const after = await f.call('assistant/debug') as AssistantDebugSnapshot
  assert.equal(after.indexState, 'stale')
  assert.equal(after.records[0]?.state, 'completed')
  assert.ok(after.index.entries[0]?.summary)
  await assert.rejects(f.call('assistant/chat/start'), /自动更新索引/u)
})

test('旧 HTTP 入口完整登记索引和 LLM 调试端点并复用命名空间处理器', async () => {
  const table = new CodingNsRpcTable()
  table.register('assistant', (action, payload) => ({ action, payload }))
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  let dispose!: () => Promise<void>
  const context = {
    webServer: { register: () => () => {} },
    connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Promise<Response> }) { routes.set(route.path, route.fetch); return () => routes.delete(route.path) } } },
    effect: (effect: () => () => Promise<void>) => { dispose = effect() },
  } as unknown as Context
  registerCodingNsRpc(context, table)
  try {
    for (const action of ['debug', 'index/rebuild', 'index/configure', 'index/cancel', 'chat/models', 'chat/start', 'chat/read', 'chat/cancel', 'voice/chat/start', 'voice/chat/read', 'voice/chat/cancel', 'voice/chat/clear', 'lifecycle/read', 'lifecycle/configure', 'lifecycle/reset', 'conversation/start', 'conversation/preview', 'conversation/read', 'conversation/cancel', 'conversation/clear', 'conversation/compress']) {
      const method = `assistant/${action}`
      const path = `/api/codingns/${method}`
      const route = routes.get(path)
      assert.ok(route, method)
      const response = await route(new Request(`https://debug.test${path}`, { method: 'POST', body: JSON.stringify({ rpcId: 'r', method, payload: { requestId: 'probe' } }) }))
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'r', result: { ok: true, value: { action, payload: { requestId: 'probe' } } } })
    }
  } finally { await dispose() }
  assert.equal(routes.size, 0)
})

test('真实语音 RPC 接入所选原生 LLM、结构化索引和多轮历史，清理删除对话而停止保留对话', async (t) => {
  // 只替换收音运行时，不加载模型、启动服务或操作真实设备。
  t.mock.method(SherpaVoiceRuntime.prototype, 'start', async function () { (this as any).started = true })
  t.mock.method(SherpaVoiceRuntime.prototype, 'stop', async function () { (this as any).started = false })
  const wire: Record<string, any>[] = []
  const llm = { listProviders: () => [{ id: 'api', name: 'API' }], listModels: async () => [{ id: 'default', name: '默认' }, { id: 'selected', name: '所选' }], async *stream(options: Record<string, any>) {
    const indexing = options.system.includes('供助理检索的结构化索引')
    if (!indexing) wire.push(options)
    yield { type: 'text-delta', index: 0, text: indexing ? structuredReply(options) : '先核对登录验证记录。' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const f = await fixture(t, { llm, voice: true, idle: true, nativeMetadata: true })
  const lease = await f.call('assistant/voice/start', { ownerId: 'page' }) as { epoch: number; active: boolean }
  assert.equal(lease.active, true)
  const input = { ownerId: 'page', epoch: lease.epoch, requestId: 'voice-1', text: '哪些会话需要我处理？' }
  await f.call('assistant/voice/chat/start', { ...input, requestId: 'intro', sequence: 1 })
  await setImmediate()
  assert.match(wire[0]!.system, /不得.*历史.*项目|没有.*有效.*索引/u)
  await f.call('assistant/voice/chat/clear', input)
  wire.length = 0
  await f.call('assistant/index/rebuild', { provider: 'api', model: 'selected' }); await setImmediate()
  await assert.rejects(f.call('assistant/voice/chat/start', { ...input, ownerId: 'other' }), /没有全局语音租约/u)
  await assert.rejects(f.call('assistant/voice/chat/start', { ...input, epoch: lease.epoch - 1 }), /已失效/u)
  for (let round = 1; round <= 3; round++) {
    await f.call('assistant/voice/chat/start', { ...input, requestId: `voice-${round}`, sequence: round + 1, text: round === 1 ? input.text : '它需要什么处理？' })
    await setImmediate()
    const run = await f.call('assistant/voice/chat/read', { ...input, requestId: `voice-${round}` }) as { state: string; text: string }
    assert.equal(run.state, 'completed')
    assert.equal(run.text, '先核对登录验证记录。')
  }
  assert.equal(wire.length, 3)
  assert.equal(wire[2]!.messages.length, 5)
  assert.equal(wire.every((options) => options.model === 'selected'), true)
  assert.deepEqual(wire[1]!.messages[1].content, [{ type: 'text', text: '先核对登录验证记录。' }])
  const facts = JSON.parse(wire[0]!.system.split('<索引事实>\n')[1].split('\n</索引事实>')[0])
  assert.equal(facts.analysis.sessions.length, 2)
  assert.match(wire[0]!.system, /一到两个短句.*100字/u)
  assert.ok(!wire[0]!.system.includes('范围外会话'))
  assert.ok(!wire[0]!.system.includes('归档会话'))
  assert.deepEqual(f.prompts, [], '自然语音不再按关键词自动派发项目任务')
  await f.call('assistant/voice/event', { ownerId: 'page', event: { type: 'state', state: 'thinking', epoch: lease.epoch } })
  await f.call('assistant/voice/chat/clear', input)
  await f.call('assistant/voice/chat/start', { ...input, requestId: 'after-clear', sequence: 5 })
  await setImmediate()
  assert.equal(wire.at(-1)!.messages.length, 1)
  await f.call('assistant/voice/stop', input)
  const nextLease = await f.call('assistant/voice/start', { ownerId: 'page' }) as { epoch: number }
  await f.call('assistant/voice/chat/start', { ...input, epoch: nextLease.epoch, requestId: 'after-stop' }); await setImmediate()
  assert.equal(wire.at(-1)!.messages.length, 3)
  f.setManaged(['w2'])
  await f.call('assistant/voice/chat/start', { ...input, epoch: nextLease.epoch, requestId: 'outdated' }); await setImmediate()
  assert.equal(wire.at(-1)!.messages.length, 1, '更换范围后保留可见记录，但不携带旧范围上下文')
})

test('正式文字和语音 RPC 共用管理根 Agent，实际查询与排队跟进接通，索引缺失仍可查询', async (t) => {
  t.mock.method(AssistantAgentAdapter.prototype as any, 'prepareWorkspace', async () => {})
  t.mock.method(SherpaVoiceRuntime.prototype, 'start', async function () { (this as any).started = true })
  t.mock.method(SherpaVoiceRuntime.prototype, 'stop', async function () { (this as any).started = false })
  const created: any[] = []
  const messages: any[] = []
  const nativeAgents = { async create(options: any) {
    const listeners = new Map<string, (...args: any[]) => any>()
    const tools = new Map<string, any>()
    let guard!: (exec: any) => string | undefined
    const ctx = { tools: { presentAs() {}, restrict() {}, register(tool: any) { tools.set(tool.name, tool) }, guard(value: typeof guard) { guard = value } },
      systemPrompt: { section() {}, suppressRuntimeContext() {} }, on(name: string, listener: (...args: any[]) => any) { listeners.set(name, listener) } }
    let idle = Promise.resolve()
    const agent = { id: options.sessionId, session: { append() {} }, cancel() {}, whenIdle: () => idle, followup(message: any) {
      messages.push(message)
      idle = (async () => {
        await listeners.get('agent/pre-step')!({}, async () => ({ kind: 'enter' }))
        if (messages.length === 1) {
          const execute = async (name: string, args: unknown) => { assert.equal(guard({ name }), undefined); return tools.get(name).execute(args, { callId: name, signal: new AbortController().signal }) }
          assert.deepEqual((await execute('assistant_list_workspaces', {})).workspaces.map((item: any) => item.workspaceId), ['w1'])
          const list = await execute('assistant_list_sessions', {})
          const target = list.sessions.find((item: any) => item.sessionId === 's1')
          const read = await execute('assistant_read_session', target)
          assert.equal(read.summary, '正文-s1')
          const sent = await execute('assistant_follow_up_session', { ...target, generation: list.generation, message: '请汇报当前阻碍。' })
          assert.equal(sent.accepted, true); assert.equal(sent.completed, false)
        }
        const stream = listeners.get('agent/assistant-stream')!
        stream({ frame: { type: 'start', attemptId: 'reply' } })
        stream({ frame: { type: 'chunk', attemptId: 'reply', chunk: { type: 'text-delta', index: 0, text: '已排队跟进。' } } })
        stream({ frame: { type: 'chunk', attemptId: 'reply', chunk: { type: 'finish', reason: { kind: 'stop' } } } })
      })().catch((error) => { listeners.get('agent/error')!({ error }) })
    } }
    await options.setup(ctx, agent)
    created.push(options)
    return { agent, async dispose() { await idle } }
  } }
  const llm = { listProviders: () => [{ id: 'api', name: 'API' }], listModels: async () => [{ id: 'selected', name: '所选' }], resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }), stream: () => assert.fail('正式对话必须经过 Agent') }
  const f = await fixture(t, { nativeAgents, llm, voice: true, nativeMetadata: true, idle: true })
  await f.call('assistant/conversation/start', { requestId: 'managed-text', text: '请跟进登录检查会话' })
  await setImmediate()
  const result: any = await f.call('assistant/conversation/read', { requestId: 'managed-text' })
  assert.equal(result.state, 'completed')
  assert.equal(f.prompts.length, 1)
  assert.equal((f.prompts[0] as any).sessionId, 's1')
  assert.equal((f.prompts[0] as any).mode, 'queue')
  assert.equal('hostId' in (f.prompts[0] as any), false, '本地原生入口只接收 SessionPromptRequest 字段')
  const lease: any = await f.call('assistant/voice/start', { ownerId: 'page' })
  await f.call('assistant/voice/chat/start', { ownerId: 'page', epoch: lease.epoch, requestId: 'managed-voice', sequence: 1, text: '刚才跟进的是什么？' })
  await setImmediate()
  assert.equal((await f.call('assistant/voice/chat/read', { ownerId: 'page', requestId: 'managed-voice' }) as any).state, 'completed')
  assert.equal(created.length, 1)
  assert.equal(messages.length, 2)
  assert.equal(created[0].agentOptions.reasoningEffort, 'off')
  assert.equal(created[0].parentAgent, undefined)
  assert.equal(f.prompts.length, 1, '普通追问不自主继续派发')
})

test('语音模态框按角色显示识别文字与助理回复，展示思考与播报状态', () => {
  for (const [state, label] of [['thinking', '正在思考'], ['speaking', '正在播报']]) {
    const markup = renderToStaticMarkup(createElement(VoiceConversationDialog, { t: resolveCodingNsTranslator(), active: true, pending: false, state, partialText: '实时识别', transcript: [{ id: 'u', role: 'user', text: '下一步？' }, { id: 'a', role: 'assistant', text: '先检查权限。' }], realtimeAvailable: true, onStart() {}, onStop() {}, onClose() {}, onClear() {}, onConfigure() {}, onDebug() {} }))
    for (const text of ['全局助理', '下一步？', '先检查权限。', '实时识别', '清空对话', label!]) assert.ok(markup.includes(text), text)
  }
})

test('未配置语音时，助理窗口仍提供可用调试入口，打开窗口不会启动麦克风', () => {
  let started = 0
  let opened = 0
  const markup = renderToStaticMarkup(createElement(VoiceConversationDialog, { t: resolveCodingNsTranslator(), active: false, pending: false, partialText: '', transcript: [], realtimeAvailable: false, onStart: () => { started += 1 }, onStop() {}, onClose() {}, onClear() {}, onConfigure() {}, onDebug: () => { opened += 1 } }))
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>全局项目状态调试<\/button>/u)
  assert.equal(opened, 0)
  assert.equal(started, 0)
})

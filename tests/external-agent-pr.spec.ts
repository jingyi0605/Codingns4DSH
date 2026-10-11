import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MiniMaxCodeDriver } from '../data/build/dist/host/cli-adapters/mcode-driver.js'
import { ZcodeAppServerDriver } from '../data/build/dist/host/cli-adapters/zcode-driver.js'
import { createAgentSubagentTool } from '../data/build/dist/host/cli-adapters/subagent-tool.js'
import { nativeSubagentTaskKey } from '../data/build/dist/host/cli-adapters/native-subagent-dispatch.js'
import { guardNativeSubagentParentTurn, markNativeSubagentParentTurnStarted, waitNativeSubagentLifecycle } from '../data/build/dist/host/cli-adapters/native-subagent-dispatch.js'
import { setNativeSubagents } from '../data/build/dist/host/cli-adapters/native-subagent-holder.js'
import { registerNativeTeamSubagentProviders, withTeamSubagentSelection } from '../data/build/dist/host/cli-adapters/native-team-subagent.js'
import { setAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry-holder.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'

function fakeRpcSpawn(onRequest: (request: Record<string, unknown>, stdout: PassThrough) => void) {
  return (() => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = {
      write(data: string): void {
        onRequest(JSON.parse(data) as Record<string, unknown>, stdout)
      },
    }
    return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
  }) as never
}

test('子代理任务去重不会把公共 AGENTS.md 当成并行任务目标', () => {
  const first = nativeSubagentTaskKey('请先阅读 AGENTS.md，然后检查 ACP 适配器并修复 Gemini。')
  const second = nativeSubagentTaskKey('请先阅读 AGENTS.md，然后检查 JSON-RPC 适配器并修复 Codex。')
  assert.notEqual(first, second)
  assert.match(first, /^prompt:/u)
  assert.match(second, /^prompt:/u)
})

test('MiniMax Code ACP 传递附件、绑定会话并转换文本终态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-mcode-'))
  const file = join(root, '说明.txt')
  await writeFile(file, '附件内容', 'utf8')
  let prompt: unknown
  const driver = new MiniMaxCodeDriver({
    binaries: ['fake-mcode'],
    spawnSync: (() => ({ status: 0, stdout: 'mcode 1.0.0', stderr: '' })) as never,
    spawn: fakeRpcSpawn((request, stdout) => {
      const method = request.method
      if (method === 'initialize') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } else if (method === 'session/new') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'mvs-1' } })}\n`)
      } else if (method === 'session/prompt') {
        prompt = request.params
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: '完成' } } } })}\n`)
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
      }
    }),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({
    sessionId: 'dsh-mcode',
    messages: [],
    prompt: '请处理附件',
    attachments: [{ kind: 'file', path: file, name: '说明.txt', mimeType: 'text/plain' }],
  })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'mvs-1' },
    { type: 'text-delta', text: '完成' },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual((prompt as { prompt: Array<Record<string, unknown>> }).prompt[1], {
    type: 'resource_link',
    uri: pathToFileURL(file).href,
    name: '说明.txt',
    mimeType: 'text/plain',
    size: 12,
  })
  driver.dispose()
})

test('MiniMax Code ACP 权限请求进入统一事件并回传 Provider 选项', async () => {
  let promptId: number | string = 0
  let reply: Record<string, unknown> | undefined
  const driver = new MiniMaxCodeDriver({
    binaries: ['fake-mcode'],
    spawnSync: (() => ({ status: 0, stdout: 'mcode 1.0.0', stderr: '' })) as never,
    spawn: fakeRpcSpawn((request, stdout) => {
      if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      else if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'mvs-permission' } })}\n`)
      else if (request.method === 'session/prompt') {
        promptId = request.id as number | string
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 19, method: 'session/request_permission', params: { options: [{ optionId: 'allow-custom', kind: 'allow_once' }, { optionId: 'deny-custom', kind: 'reject_once' }], toolCall: { title: 'shell', toolCallId: 'shell-1' }, detail: '执行命令' } })}\n`)
      } else if (request.id === 19) {
        reply = request
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } })}\n`)
      }
    }),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-mcode-permission', messages: [], prompt: '执行' })) {
    chunks.push(chunk)
    if (chunk.type === 'permission-request') driver.respondPermission('dsh-mcode-permission', { requestId: chunk.requestId, approved: true })
  }
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'mvs-permission' },
    { type: 'permission-request', requestId: '19', kind: 'shell', toolName: 'shell', callId: 'shell-1', detail: '执行命令' },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 19, result: { outcome: { outcome: 'selected', optionId: 'allow-custom' } } })
  driver.dispose()
})

test('ZCode 裸信封完成创建、发送、正文和用量事件', async () => {
  let spawnCount = 0
  const driver = new ZcodeAppServerDriver({
    binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 0, stdout: 'zcode 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      spawnCount += 1
      return fakeRpcSpawn((request, stdout) => {
        if (request.method === 'session/create') {
          stdout.write(`${JSON.stringify({ id: request.id, result: { session: { sessionId: 'sess-1' } } })}\n`)
          return
        }
        if (request.method === 'session/subscribe') {
          stdout.write(`${JSON.stringify({ id: request.id, result: { sessionId: 'sess-1', eventSeq: 0, events: [] } })}\n`)
          return
        }
        if (request.method === 'session/setMode') {
          stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`)
          return
        }
        if (request.method === 'session/send') {
          stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`)
          stdout.write(`${JSON.stringify({ method: 'state.updated', params: { reason: 'prompt_started', patch: { status: 'running' } } })}\n`)
          stdout.write(`${JSON.stringify({ method: 'message.delta', params: { delta: 'ZCode 完成' } })}\n`)
          stdout.write(`${JSON.stringify({ method: 'state.updated', params: { patch: { status: 'idle' } } })}\n`)
        } else if (request.method === 'session/usage') {
          stdout.write(`${JSON.stringify({ id: request.id, result: { inputTokens: 2, outputTokens: 3 } })}\n`)
        }
      })()
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-zcode', messages: [], prompt: '执行' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'sess-1' },
    { type: 'text-delta', text: 'ZCode 完成' },
    { type: 'usage', inputTokens: 2, outputTokens: 3 },
    { type: 'finish', reason: 'stop' },
  ])
  assert.equal(spawnCount, 1)
  driver.dispose()
})

test('ZCode 订阅 desktop-continuous 事件并转换 session/event 正文', async () => {
  const calls: string[] = []
  const driver = new ZcodeAppServerDriver({
    binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 0, stdout: 'zcode 1.0.0', stderr: '' })) as never,
    spawn: fakeRpcSpawn((request, stdout) => {
      calls.push(String(request.method))
      if (request.method === 'session/create') {
        stdout.write(`${JSON.stringify({ id: request.id, result: { session: { sessionId: 'sess-event' } } })}\n`)
      } else if (request.method === 'session/subscribe') {
        stdout.write(`${JSON.stringify({ id: request.id, result: { sessionId: 'sess-event', eventSeq: 0, events: [] } })}\n`)
      } else if (request.method === 'session/setMode') {
        stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`)
      } else if (request.method === 'session/send') {
        stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`)
        stdout.write(`${JSON.stringify({ method: 'state.updated', params: { reason: 'prompt_started', patch: { status: 'running' } } })}\n`)
        stdout.write(`${JSON.stringify({ method: 'session/event', params: { type: 'model.streaming', payload: { kind: 'reasoning_delta', assistantMessageId: 'msg-1', delta: '思考' } } })}\n`)
        stdout.write(`${JSON.stringify({ method: 'session/event', params: { type: 'model.streaming', payload: { kind: 'text_delta', assistantMessageId: 'msg-1', delta: '完成' } } })}\n`)
        stdout.write(`${JSON.stringify({ method: 'computer-use/operation-event', params: { kind: 'turn-completed' } })}\n`)
      } else if (request.method === 'session/usage') {
        stdout.write(`${JSON.stringify({ id: request.id, result: { inputTokens: 2, outputTokens: 3 } })}\n`)
      }
    }),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-zcode-event', messages: [], prompt: '执行' })) chunks.push(chunk)
  assert.deepEqual(calls.slice(0, 4), ['session/create', 'session/setMode', 'session/subscribe', 'session/send'])
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'sess-event' },
    { type: 'reasoning-delta', text: '思考', messageId: 'msg-1' },
    { type: 'text-delta', text: '完成', messageId: 'msg-1' },
    { type: 'usage', inputTokens: 2, outputTokens: 3 },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('ZCode 在正文增量缺失时使用 turn.completed 快照收尾', async () => {
  const driver = new ZcodeAppServerDriver({
    binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 0, stdout: 'zcode 1.0.0', stderr: '' })) as never,
    spawn: fakeRpcSpawn((request, stdout) => {
      if (request.method === 'session/create') {
        stdout.write(`${JSON.stringify({ id: request.id, result: { session: { sessionId: 'sess-snapshot' } } })}\n`)
      } else if (request.method === 'session/subscribe') {
        stdout.write(`${JSON.stringify({ id: request.id, result: { sessionId: 'sess-snapshot', eventSeq: 0, events: [] } })}\n`)
      } else if (request.method === 'session/setMode') {
        stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`)
      } else if (request.method === 'session/send') {
        stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`)
        stdout.write(`${JSON.stringify({ method: 'state.updated', params: { reason: 'prompt_started', patch: { status: 'running' } } })}\n`)
        stdout.write(`${JSON.stringify({ method: 'computer-use/operation-event', params: { kind: 'turn-completed' } })}\n`)
        stdout.write(`${JSON.stringify({ method: 'session/event', params: { type: 'turn.completed', payload: { response: '快照完成' } } })}\n`)
      } else if (request.method === 'session/usage') {
        stdout.write(`${JSON.stringify({ id: request.id, result: { inputTokens: 1, outputTokens: 1 } })}\n`)
      }
    }),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-zcode-snapshot', messages: [], prompt: '执行' })) chunks.push(chunk)
  assert.equal(chunks.some((chunk) => chunk.type === 'text-snapshot' && chunk.text === '快照完成'), true)
  assert.equal(chunks.at(-1)?.type, 'finish')
  driver.dispose()
})

test('ZCode 设置选择普通套餐时不被同时存在的 Start Plan JWT 遮蔽', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-zcode-provider-selection-'))
  const settingsPath = join(root, '.zcode', 'v2', 'setting.json')
  const credentialsPath = join(root, '.zcode', 'v2', 'credentials.json')
  const builtinPath = join(root, 'zcode-builtin.json')
  const previousHome = process.env.HOME
  const rules = [
    {
      providerId: 'account:bigmodel-individual-coding-plan',
      config: { access: { mode: 'individual-coding-plan' }, builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'] },
    },
    {
      providerId: 'account:bigmodel-start-plan',
      config: { access: { mode: 'start-plan' }, builtinModelIds: ['GLM-5.3-Flash'] },
    },
  ]
  await mkdir(join(root, '.zcode', 'v2'), { recursive: true })
  writeFileSync(credentialsPath, JSON.stringify({
    zcodejwttoken: 'jwt-token',
    'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:test:api-key': 'coding-plan-key',
  }), 'utf8')
  writeFileSync(settingsPath, JSON.stringify({ providerFamilyConnectionSelections: { bigmodel: { kind: 'individual-coding-plan' } } }), 'utf8')
  writeFileSync(builtinPath, JSON.stringify({ revision: 1, config: { providerConfigRules: { providerRules: rules } } }), 'utf8')
  process.env.HOME = root
  const updates: Record<string, any>[] = []
  const runtime = {
    appId: 'zcode', appName: 'ZCode', installRoot: root, entry: '/tmp/zcode.cjs', appVersion: '3.14.4',
    env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath },
  }
  const driver = new ZcodeAppServerDriver({
    binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 1, stdout: '', stderr: '' })) as never,
    spawn: fakeRpcSpawn((request, stdout) => {
      if (request.method === 'provider/updateAccountConfig') {
        updates.push(request.params as Record<string, any>)
        stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`)
      } else if (request.method === 'session/create') {
        stdout.write(`${JSON.stringify({ id: request.id, result: {
          session: { sessionId: 'selection-session' },
          settings: { model: {
            available: [
              { ref: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3' }, providerLabel: 'BigModel Individual', label: 'GLM-5.3', reasoning: { levels: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] } },
              { ref: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash' }, providerLabel: 'BigModel Start', label: 'GLM-5.3-Flash', reasoning: { levels: [{ value: 'low' }] } },
            ],
            current: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3', options: { reasoningLevel: 'max' } },
          } },
        } })}\n`)
      }
    }),
  })
  ;(driver as unknown as { resolveRuntime: () => typeof runtime }).resolveRuntime = () => runtime
  try {
    const catalog = await driver.listModels()
    assert.equal(catalog.currentModel, 'account:bigmodel-individual-coding-plan/GLM-5.3')
    assert.deepEqual(catalog.groups.map((group) => group.id), [
      'account:bigmodel-individual-coding-plan',
      'account:bigmodel-start-plan',
    ])
    assert.equal(updates.length, 1)
    assert.equal((updates[0]?.states as Record<string, any>)['account:bigmodel-individual-coding-plan'].current, true)
    assert.equal((updates[0]?.states as Record<string, any>)['account:bigmodel-individual-coding-plan'].entitled, true)
    assert.equal((updates[0]?.states as Record<string, any>)['account:bigmodel-start-plan'].current, false)
  } finally {
    driver.dispose()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})

test('MiniMax Code 过滤同进程内其他会话的通知，避免跨会话串扰', async () => {
  const driver = new MiniMaxCodeDriver({
    binaries: ['fake-mcode'],
    spawnSync: (() => ({ status: 0, stdout: 'mcode 1.0.0', stderr: '' })) as never,
    spawn: fakeRpcSpawn((request, stdout) => {
      const method = request.method
      if (method === 'initialize') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } else if (method === 'session/new') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'mvs-a' } })}\n`)
      } else if (method === 'session/prompt') {
        // 同一 ACP 进程上另一个会话的迟到通知必须被丢弃。
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'mvs-other', update: { sessionUpdate: 'agent_message_chunk', content: { text: '别的会话' } } } })}\n`)
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'mvs-a', update: { sessionUpdate: 'agent_message_chunk', content: { text: '本会话' } } } })}\n`)
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
      }
    }),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-mcode', messages: [], prompt: '执行' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'mvs-a' },
    { type: 'text-delta', text: '本会话' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

// DSH 的 SessionEvent 形状是 `{ type, seq, time, data }`：判别字段在顶层。
// 夹具必须保持这个形状，否则测的是实现里的读取错误而不是真实契约。
function nativeEvent(type: string, seq: number, data: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, seq, time: 1_700_000_000_000 + seq, data }
}

test('原生 Subagent 首轮已在订阅前结束时从快照补齐（真实 DSH 事件形状）', async () => {
  let handlers: { onEvent?: (session: unknown, event: unknown) => void } | undefined
  const child = { header: { id: 'child-1' }, snapshotEvents: () => [
    nativeEvent('assistant/message', 1, { turn: 1, step: 1, message: { content: [{ type: 'text', text: '快照结果' }] } }),
    nativeEvent('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
  ] }
  const sessions = {
    get: (id: string) => id === 'child-1' ? child : undefined,
    subscribe: (value: { onEvent?: (session: unknown, event: unknown) => void }) => { handlers = value; return () => { handlers = undefined } },
  } as never
  setNativeSubagents({
    registerProvider: () => undefined,
    startContinuable: async () => ({ childId: 'child-1', messageId: 'message-1' }),
  })
  const tool = createAgentSubagentTool({ nativeSessions: sessions })
  const result = await (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
    { agent: 'mcode', prompt: '执行子任务', run_in_background: false },
    { agent: { id: 'parent-1', options: { subagentDepth: 0 }, session: { header: { id: 'parent-1' } } } },
  )
  assert.deepEqual(result, {
    agent: 'mcode', childSessionId: 'child-1', providerSessionId: 'child-1', ok: true, completed: true, status: 'completed', result: '快照结果', toolCalls: 0,
  })
  assert.equal(handlers, undefined)
  setNativeSubagents(undefined)
})

test('原生 Subagent 同步等待能消费订阅期间的实时事件并正常收尾', async () => {
  let handlers: { onEvent?: (session: unknown, event: unknown) => void } | undefined
  const child = { header: { id: 'child-live' }, snapshotEvents: () => [] }
  const sessions = {
    get: (id: string) => id === 'child-live' ? child : undefined,
    subscribe: (value: { onEvent?: (session: unknown, event: unknown) => void }) => { handlers = value; return () => { handlers = undefined } },
  } as never
  setNativeSubagents({
    registerProvider: () => undefined,
    startContinuable: async () => ({ childId: 'child-live', messageId: 'message-live' }),
  })
  const tool = createAgentSubagentTool({ nativeSessions: sessions })
  const pending = (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
    { agent: 'mcode', prompt: '执行子任务', run_in_background: false },
    { agent: { id: 'parent-live', options: { subagentDepth: 0 }, session: { header: { id: 'parent-live' } } } },
  )
  // 订阅在 startContinuable 之后建立，等它就绪再投递事件。
  for (let i = 0; i < 50 && handlers === undefined; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.notEqual(handlers, undefined)
  handlers!.onEvent?.(child, nativeEvent('assistant/message', 1, { turn: 1, step: 1, message: { content: [{ type: 'text', text: '实时结果' }] } }))
  handlers!.onEvent?.(child, nativeEvent('tool/result', 2, { turn: 1, step: 1, callId: 'c1', name: 'read', content: 'x' }))
  handlers!.onEvent?.(child, nativeEvent('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }))
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 3_000)),
  ])
  assert.deepEqual(result, {
    agent: 'mcode', childSessionId: 'child-live', providerSessionId: 'child-live', ok: true, completed: true, status: 'completed', result: '实时结果', toolCalls: 1,
  })
  setNativeSubagents(undefined)
})

test('原生 Subagent 只有收到 turn/end 才完成，并透传终态真实错误', async () => {
  let handlers: { onEvent?: (session: unknown, event: unknown) => void } | undefined
  const child = { header: { id: 'child-error' }, snapshotEvents: () => [] }
  const injected: string[] = []
  const sessions = {
    get: (id: string) => id === 'child-error' ? child : undefined,
    subscribe: (value: { onEvent?: (session: unknown, event: unknown) => void }) => { handlers = value; return () => { handlers = undefined } },
    injectNextStep: (sessionId: string, summary?: string) => { injected.push(`${sessionId}:${summary ?? ''}`); return true },
  } as never
  setNativeSubagents({ registerProvider: () => undefined, startContinuable: async () => ({ childId: 'child-error', messageId: 'message-error' }) })
  const tool = createAgentSubagentTool({ nativeSessions: sessions })
  const controller = new AbortController()
  const pending = (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
    { agent: 'mcode', prompt: '失败任务', run_in_background: false },
    { agent: { id: 'parent-error', options: { subagentDepth: 0 }, session: { header: { id: 'parent-error' } } }, signal: controller.signal },
  )
  for (let i = 0; i < 50 && handlers === undefined; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.notEqual(handlers, undefined)
  handlers!.onEvent?.(child, nativeEvent('assistant/message', 1, { message: { content: [{ type: 'text', text: '失败前的片段' }] } }))
  const beforeEnd = Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 20))])
  assert.deepEqual(await beforeEnd, { timedOut: true })
  handlers!.onEvent?.(child, nativeEvent('turn/end', 2, { reason: { kind: 'error', error: { message: '上游真实失败：额度不足' } } }))
  const result = await pending
  assert.deepEqual(result, {
    agent: 'mcode', childSessionId: 'child-error', providerSessionId: 'child-error', ok: false, completed: true, status: 'failed',
    result: '失败前的片段', toolCalls: 0, error: '上游真实失败：额度不足', failureReviewed: false,
    failureReviewRequired: true,
    failureGuidance: '请评估是否需要 action=start 重新创建子代理，或用 action=send 接管并继续；确认无需继续后才能结束主任务。',
  })
  const blocked = guardNativeSubagentParentTurn(sessions, 'parent-error')
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.injected, true)
  assert.match(injected[0]!, /failed/u)
  const reviewed = await (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
    { action: 'read', child_session_id: 'child-error' },
    { agent: { id: 'parent-error', options: { subagentDepth: 0 }, session: { header: { id: 'parent-error' } } } },
  )
  assert.equal(reviewed.failureReviewed, true)
  assert.equal(reviewed.failureReviewRequired, false)
  assert.match(String(reviewed.failureGuidance), /重新创建|接管/u)
  assert.equal(guardNativeSubagentParentTurn(sessions, 'parent-error').blocked, false)
  setNativeSubagents(undefined)
})

test('agent_subagent 工具定义满足 dsh-tools 注册契约且向 startContinuable 传真实 parent', async () => {
  const tool = createAgentSubagentTool({ nativeSessions: {} as never })
  // dsh-tools 的 tools.register 要求 output.render 是函数，否则抛 TypeError。
  assert.equal(typeof (tool.output as { render?: unknown } | undefined)?.render, 'function')
  assert.equal((tool.output as { schema?: unknown }).schema !== undefined, true)
  assert.equal(tool.name, 'agent_subagent')

  let received: Record<string, any> | undefined
  const parentAgent = { id: 'parent-real', options: { subagentDepth: 0 }, session: { header: { id: 'parent-real' } } }
  setNativeSubagents({
    registerProvider: () => undefined,
    startContinuable: async (spec) => { received = spec as Record<string, any>; return { childId: 'child-real', messageId: 'm1' } },
  })
  const sessions = { get: () => undefined, subscribe: () => () => undefined } as never
  const result = await (createAgentSubagentTool({ nativeSessions: sessions }).execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
    { agent: 'mcode', prompt: '后台执行', run_in_background: true },
    { agent: parentAgent },
  )
  // parent 必须是真实 Agent：startContinuable 会读 parent.options.subagentDepth。
  assert.equal(received?.request?.parent, parentAgent)
  assert.equal(received?.request?.parent?.options?.subagentDepth, 0)
  assert.deepEqual(result, {
    agent: 'mcode', childSessionId: 'child-real', providerSessionId: 'child-real', ok: true, completed: false, status: 'running', background: true, result: '子代理已启动，等待首轮 turn/end。',
  })
  setNativeSubagents(undefined)
})

test('agent_subagent 默认后台返回并允许同一父会话并发创建', async () => {
  let started = 0
  setNativeSubagents({
    registerProvider: () => undefined,
    startContinuable: async () => {
      started += 1
      return { childId: `child-default-${String(started)}`, messageId: `message-default-${String(started)}` }
    },
  })
  const tool = createAgentSubagentTool({ nativeSessions: { get: () => undefined, subscribe: () => () => undefined } as never })
  const exec = { agent: { id: 'parent-default', options: { subagentDepth: 0 }, session: { header: { id: 'parent-default' } } } }
  try {
    const results = await Promise.all([
      (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
        { agent: 'mcode', prompt: '默认后台任务一' }, exec,
      ),
      (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
        { agent: 'mcode', prompt: '默认后台任务二' }, exec,
      ),
    ])
    assert.equal(started, 2)
    assert.deepEqual(results.map((result) => result.status), ['running', 'running'])
    assert.deepEqual(results.map((result) => result.background), [true, true])
  } finally {
    setNativeSubagents(undefined)
  }
})

test('子代理完整生命周期：创建、读取、发送报告、结束，并阻止父会话提前收尾', async () => {
  let handler: { onEvent?: (session: unknown, event: unknown) => void } | undefined
  const child = { header: { id: 'child-lifecycle', origin: 'subagent', parentSession: 'parent-lifecycle' }, snapshotEvents: () => [] }
  const injected: string[] = []
  const sentMessages: Array<{ targetId: string; text: string }> = []
  const parentReports: Array<{ targetId: string; text: string }> = []
  const sessions = {
    get: (id: string) => id === 'child-lifecycle' ? child : undefined,
    subscribe: (value: { onEvent?: (session: unknown, event: unknown) => void }) => {
      handler = value
      return () => { handler = undefined }
    },
    injectNextStep: (sessionId: string, summary?: string) => {
      injected.push(`${sessionId}:${summary ?? ''}`)
      return true
    },
    injectMessage: (sessionId: string, message: string) => {
      parentReports.push({ targetId: sessionId, text: message })
      return true
    },
  } as never
  setNativeSubagents({
    registerProvider: () => undefined,
    startContinuable: async () => ({ childId: 'child-lifecycle', messageId: 'message-lifecycle' }),
    sendMessage: async (_sender, targetId, content) => {
      sentMessages.push({ targetId, text: content[0]?.text ?? '' })
      return 'message-follow-up'
    },
  })
  const tool = createAgentSubagentTool({ nativeSessions: sessions })
  const exec = { agent: { id: 'parent-lifecycle', options: { subagentDepth: 0 }, session: { header: { id: 'parent-lifecycle' } } } }
  try {
    const started = await (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
      { agent: 'mcode', prompt: '执行完整生命周期模拟' }, exec,
    )
    assert.equal(started.status, 'running')
    const childId = String(started.childSessionId)
    const childExec = { agent: { id: childId, options: { subagentDepth: 1 }, session: { header: { id: childId } } } }
    const report = await (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
      { action: 'send', child_session_id: 'parent-lifecycle', message: '子代理报告：实现已完成，测试通过。' }, childExec,
    )
    assert.equal(report.ok, true)
    assert.equal(report.parentSessionId, 'parent-lifecycle')
    assert.deepEqual(parentReports, [{ targetId: 'parent-lifecycle', text: '子代理报告：实现已完成，测试通过。' }])
    const running = await (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
      { action: 'read', child_session_id: childId }, exec,
    )
    assert.equal(running.status, 'running')
    const sent = await (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
      { action: 'send', child_session_id: childId, message: '请补充最终报告' }, exec,
    )
    assert.equal(sent.ok, true)
    assert.equal(sent.messageId, 'message-follow-up')
    assert.deepEqual(sentMessages, [{ targetId: childId, text: '请补充最终报告' }])

    // 父会话尝试 turn/end 时必须被屏障拦截，并注入下一步等待指令。
    const blocked = guardNativeSubagentParentTurn(sessions, 'parent-lifecycle')
    assert.equal(blocked.blocked, true)
    assert.equal(blocked.injected, true)
    assert.equal(injected.length, 1)
    assert.match(injected[0]!, /child-lifecycle/u)
    // 同一父轮次只注入一次，避免重复消息造成父 Agent 自激循环。
    assert.equal(guardNativeSubagentParentTurn(sessions, 'parent-lifecycle').injected, false)

    // 子代理发送报告文本与工具结果，最后以 turn/end 结束。
    handler?.onEvent?.(child, nativeEvent('assistant/message', 1, { message: { content: [{ type: 'text', text: '子代理报告：模拟完成' }] } }))
    handler?.onEvent?.(child, nativeEvent('tool/result', 2, { name: 'report', content: '报告已发送' }))
    handler?.onEvent?.(child, nativeEvent('turn/end', 3, { reason: { kind: 'completed' } }))
    const finished = await waitNativeSubagentLifecycle(childId, 2_000)
    assert.equal(finished?.status, 'completed')
    assert.equal(finished?.completed, true)
    assert.equal(finished?.text, '子代理报告：模拟完成')
    assert.equal(finished?.toolCalls, 1)

    // 终态后父会话屏障放行；下一轮开始时清除上一轮的 guard。
    markNativeSubagentParentTurnStarted('parent-lifecycle')
    const allowed = guardNativeSubagentParentTurn(sessions, 'parent-lifecycle')
    assert.equal(allowed.blocked, false)
  } finally {
    setNativeSubagents(undefined)
  }
})

test('agent_subagent 支持等待/读取后台子会话，并阻止依赖步骤提前启动', async () => {
  let handlers: { onEvent?: (session: unknown, event: unknown) => void } | undefined
  const children = new Map<string, { header: { id: string }; snapshotEvents: () => readonly unknown[] }>()
  const sessions = {
    get: (id: string) => children.get(id),
    subscribe: (value: { onEvent?: (session: unknown, event: unknown) => void }) => { handlers = value; return () => { handlers = undefined } },
  } as never
  let sequence = 0
  setNativeSubagents({
    registerProvider: () => undefined,
    startContinuable: async () => {
      sequence += 1
      const id = `child-m2-${sequence}`
      children.set(id, { header: { id }, snapshotEvents: () => [] })
      return { childId: id, messageId: `message-${sequence}` }
    },
  })
  const tool = createAgentSubagentTool({ nativeSessions: sessions })
  const exec = { agent: { id: 'parent-m2', options: { subagentDepth: 0 }, session: { header: { id: 'parent-m2' } } } }
  try {
    const started = await (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
      { agent: 'mcode', prompt: '先实现', run_in_background: true }, exec,
    )
    assert.equal(started.status, 'running')
    const childId = String(started.childSessionId)
    const blocked = await (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
      { agent: 'mcode', prompt: '后续测试', depends_on: [childId] }, exec,
    )
    assert.equal(blocked.ok, false)
    assert.match(String(blocked.error), /DELEGATE_DEPENDENCY_NOT_READY/u)
    const waiting = (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
      { action: 'wait', child_session_id: childId, timeout_ms: 2_000 }, exec,
    )
    for (let index = 0; index < 50 && handlers === undefined; index += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    handlers?.onEvent?.(children.get(childId), nativeEvent('assistant/message', 1, { message: { content: [{ type: 'text', text: '实现完成' }] } }))
    handlers?.onEvent?.(children.get(childId), nativeEvent('turn/end', 2, { reason: { kind: 'completed' } }))
    const waited = await waiting
    assert.equal(waited.status, 'completed')
    assert.equal(waited.completed, true)
    const read = await (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
      { action: 'read', child_session_id: childId }, exec,
    )
    assert.equal(read.status, 'completed')
    const otherParent = { agent: { id: 'parent-m2-other', options: { subagentDepth: 0 }, session: { header: { id: 'parent-m2-other' } } } }
    const crossParentRead = await (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
      { action: 'read', child_session_id: childId }, otherParent,
    )
    assert.equal(crossParentRead.ok, false)
    assert.match(String(crossParentRead.error), /找不到父会话下的子会话/u)
    const crossParentWait = await (tool.execute as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>)(
      { action: 'wait', child_session_id: childId, timeout_ms: 1 }, otherParent,
    )
    assert.equal(crossParentWait.ok, false)
    assert.match(String(crossParentWait.error), /找不到父会话下的子会话/u)
  } finally {
    setNativeSubagents(undefined)
  }
})

/** 只替换外部驱动，保留真实注册表的首次检测、缓存与会话绑定契约。 */
function nativeProviderTestRegistry(): CodingNsCliAdapterRegistry {
  return new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'mcode', name: 'MiniMax Code' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake-mcode' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() { assert.fail('Provider 准备阶段不应启动模型执行') },
  }])
}

test('原生 Provider 注册可去重并在释放后重新装配', async () => {
  const providers: Array<{ name: string; inheritsParentContext?: boolean; prepareContinuable: (request: any) => Promise<unknown> }> = []
  const registry = nativeProviderTestRegistry()
  setAdapterRegistry(registry)
  const service = {
    registerProvider: (provider: any) => { providers.push(provider); return () => undefined },
  }
  let dispose = registerNativeTeamSubagentProviders(service as never)
  try {
    registerNativeTeamSubagentProviders(service as never)
    assert.equal(providers.length, 10)
    assert.equal(providers.find((provider) => provider.name === 'codingns-external-mcode')?.inheritsParentContext, true)
    assert.equal((await registry.catalog())[0]?.detectionState, 'pending')
    await providers.find((provider) => provider.name === 'codingns-external-mcode')!.prepareContinuable({ sessionId: 'child-2', parent: { id: 'parent-2' }, signal: new AbortController().signal })
    assert.equal((await registry.catalog())[0]?.detectionState, 'ready')
    assert.deepEqual(registry.getSession('child-2'), { adapterId: 'mcode', parentSessionId: 'parent-2', origin: 'subagent' })
    dispose()
    dispose = registerNativeTeamSubagentProviders(service as never)
    assert.equal(providers.length, 20)
  } finally {
    dispose()
    setAdapterRegistry(undefined)
    await registry.dispose()
  }
})

test('子代理 Provider 在 Agent id 与会话 id 不同的宿主中仍传递授权模型', async () => {
  const providers: Array<{ name: string; prepareContinuable: (request: any) => Promise<unknown> }> = []
  const registry = nativeProviderTestRegistry()
  setAdapterRegistry(registry)
  const dispose = registerNativeTeamSubagentProviders({ registerProvider: (provider: any) => { providers.push(provider); return () => undefined } } as never)
  try {
    await withTeamSubagentSelection('session-parent', 'mcode', 'model-explicit', async () => {
      await providers.find((provider) => provider.name === 'codingns-external-mcode')!.prepareContinuable({
        sessionId: 'child-model',
        parent: { id: 'agent-parent', session: { header: { id: 'session-parent' } } },
        signal: new AbortController().signal,
      })
    })
    assert.deepEqual(registry.getSession('child-model'), { adapterId: 'mcode', parentSessionId: 'session-parent', origin: 'subagent', modelId: 'model-explicit' })
  } finally {
    dispose()
    setAdapterRegistry(undefined)
    await registry.dispose()
  }
})

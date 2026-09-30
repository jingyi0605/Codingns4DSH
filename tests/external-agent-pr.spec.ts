import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MiniMaxCodeDriver } from '../data/build/dist/host/cli-adapters/mcode-driver.js'
import { ZcodeAppServerDriver } from '../data/build/dist/host/cli-adapters/zcode-driver.js'
import { createAgentSubagentTool } from '../data/build/dist/host/cli-adapters/subagent-tool.js'
import { setNativeSubagents } from '../data/build/dist/host/cli-adapters/native-subagent-holder.js'
import { registerNativeTeamSubagentProviders } from '../data/build/dist/host/cli-adapters/native-team-subagent.js'
import { setAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry-holder.js'

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
    { agent: 'mcode', prompt: '执行子任务' },
    { agent: { id: 'parent-1', options: { subagentDepth: 0 }, session: { header: { id: 'parent-1' } } } },
  )
  assert.deepEqual(result, {
    agent: 'mcode', childSessionId: 'child-1', providerSessionId: 'child-1', ok: true, result: '快照结果', toolCalls: 0,
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
    { agent: 'mcode', prompt: '执行子任务' },
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
    agent: 'mcode', childSessionId: 'child-live', providerSessionId: 'child-live', ok: true, result: '实时结果', toolCalls: 1,
  })
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
    agent: 'mcode', childSessionId: 'child-real', providerSessionId: 'child-real', ok: true, background: true, result: '子代理已在原生子智能体会话中启动。',
  })
  setNativeSubagents(undefined)
})

test('原生 Provider 注册可去重并在释放后重新装配', async () => {
  const providers: Array<{ name: string; prepareContinuable: (request: any) => Promise<unknown> }> = []
  const registry = {
    catalog: async () => [{ id: 'mcode', installed: true, enabled: true }],
    setSession: (sessionId: string, config: unknown) => { assert.equal(sessionId, 'child-2'); assert.deepEqual(config, { adapterId: 'mcode', parentSessionId: 'parent-2', origin: 'subagent' }) },
    flushSessionBindings: async () => undefined,
  }
  setAdapterRegistry(registry as never)
  const service = {
    registerProvider: (provider: any) => { providers.push(provider); return () => undefined },
  }
  const dispose = registerNativeTeamSubagentProviders(service as never)
  registerNativeTeamSubagentProviders(service as never)
  assert.equal(providers.length, 10)
  await providers.find((provider) => provider.name === 'codingns-external-mcode')!.prepareContinuable({ sessionId: 'child-2', parent: { id: 'parent-2' }, signal: new AbortController().signal })
  dispose()
  registerNativeTeamSubagentProviders(service as never)
  assert.equal(providers.length, 20)
  setAdapterRegistry(undefined)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { CodexAppServerDriver } from '../dist/host/cli-adapters/codex-driver.js'
import { GrokBuildDriver } from '../dist/host/cli-adapters/grok-driver.js'
import { PiAgentDriver } from '../dist/host/cli-adapters/pi-driver.js'

test('三个 RPC 驱动按各自协议完成握手并转换文本事件', async () => {
  for (const [Driver, expectedArgs] of [
    [PiAgentDriver, ['--mode', 'rpc']],
    [CodexAppServerDriver, ['app-server']],
    [GrokBuildDriver, ['--acp']],
  ] as const) {
    const calls: string[][] = []
    let killed = false
    const driver = new Driver({
      binaries: ['fake-agent'],
      spawnSync: (() => ({ status: 0, stdout: 'fake-agent 1.2.3', stderr: '' })) as never,
      spawn: ((command: string, args: string[]) => {
        calls.push([command, ...args])
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const stdin = {
          write(data: string): void {
            const request = JSON.parse(data) as { id: number; method: string }
            let result: Record<string, unknown> = {}
            if (request.method === 'thread/start') result = { threadId: 'thread-1' }
            if (request.method === 'session/new') result = { sessionId: 'session-1' }
            if (request.method === 'prompt') {
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'message_update', params: { type: 'text_delta', delta: '完成' } })}\n`)
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
              setImmediate(() => stdout.write(`${JSON.stringify({ type: 'agent_settled' })}\n`))
              return
            }
            if (request.method === 'session/prompt') {
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'message_update', params: { type: 'text_delta', delta: '完成' } })}\n`)
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
              return
            }
            if (request.method === 'turn/start') {
              result = { turn: { id: 'turn-1', status: 'inProgress' } }
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
              setImmediate(() => {
                stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: '完成' } })}\n`)
                stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })}\n`)
              })
            } else {
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
            }
          },
        }
        return { stdout, stderr, stdin, kill() { killed = true; stdout.end(); stderr.end(); return true } }
      }) as never,
    })
    const chunks = []
    for await (const chunk of driver.executeTurn({ sessionId: 's1', messages: [], prompt: '你好' })) chunks.push(chunk)
    assert.deepEqual(calls[0], ['fake-agent', ...expectedArgs])
    driver.dispose()
    assert.deepEqual(chunks.filter((chunk) => chunk.type !== 'session-binding'), [{ type: 'text-delta', text: '完成' }, { type: 'finish', reason: 'stop' }])
    assert.equal(killed, true)
  }
})

test('RPC 驱动在命令不存在时返回未安装和空模型目录', async () => {
  const driver = new PiAgentDriver({ binaries: ['missing-agent'], spawnSync: (() => ({ status: 127, stdout: '', stderr: '' })) as never })
  assert.deepEqual(await driver.detect(), { installed: false, version: null, command: null })
  assert.deepEqual(await driver.listModels(), { groups: [], currentModel: null, currentEffort: null })
})

test('Pi 读取真实 --list-models 表格并生成思维强度列表', async () => {
  const driver = new PiAgentDriver({
    binaries: ['fake-pi'],
    spawnSync: ((command: string, args: string[]) => {
      assert.equal(command, 'fake-pi')
      if (args[0] === '--version') return { status: 0, stdout: 'pi 0.85.1', stderr: '' }
      return { status: 0, stdout: 'provider  model  context  max-out  thinking  images\nopenai  gpt-5.5  1M  128K  yes  no\n', stderr: '' }
    }) as never,
    spawn: (() => { throw new Error('不应回退到 RPC') }) as never,
  })
  const catalog = await driver.listModels()
  assert.deepEqual(catalog.groups[0]?.models[0], {
    id: 'openai/gpt-5.5', name: 'gpt-5.5', efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  })
})

test('Pi 优先使用 RPC thinkingLevelMap 返回模型真实思维强度', async () => {
  const driver = new PiAgentDriver({
    binaries: ['fake-pi'],
    spawnSync: (() => ({ status: 0, stdout: 'pi 0.85.1', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; type: string }
        assert.equal(request.type, 'get_available_models')
        stdout.write(`${JSON.stringify({
          id: request.id,
          type: 'response',
          success: true,
          data: {
            models: [{
              provider: 'deepseek',
              id: 'deepseek-flash',
              name: 'DeepSeek V4.1 Flash',
              reasoning: true,
              thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
            }],
          },
        })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  assert.deepEqual((await driver.listModels()).groups[0]?.models[0], {
    id: 'deepseek/deepseek-flash',
    name: 'DeepSeek V4.1 Flash',
    efforts: ['low', 'high', 'max'],
  })
})

test('Codex app-server 读取 model/list 的模型和思维强度元数据', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 0.154.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      return {
        stdout,
        stderr,
        stdin: { write(data: string): void {
          const request = JSON.parse(data) as { id: number; method: string }
          const result = request.method === 'model/list'
            ? { models: [{ model: 'gpt-5.5', displayName: 'GPT-5.5', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }, { reasoningEffort: 'high', description: 'High' }], isDefault: true }] }
            : {}
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
        } },
        kill() { stdout.end(); stderr.end(); return true },
      }
    }) as never,
  })
  assert.deepEqual(await driver.listModels(), {
    groups: [{ id: 'codex', name: 'Codex', models: [{ id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low', 'high'] }] }],
    currentModel: null,
    currentEffort: null,
  })
})

test('RPC 执行收到取消信号时结束为 cancel 并清理进程', async () => {
  let killed = false
  const driver = new PiAgentDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'fake-agent 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method !== 'prompt') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { killed = true; stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const controller = new AbortController()
  const chunks: unknown[] = []
  const running = (async () => {
    for await (const chunk of driver.executeTurn({ sessionId: 's1', messages: [], prompt: '等待', signal: controller.signal })) chunks.push(chunk)
  })()
  setTimeout(() => controller.abort(), 10)
  await running
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'cancel' })
  driver.dispose()
  assert.equal(killed, true)
})

test('Grok ACP 权限请求保留原始 request id 并接受标准回复', async () => {
  let promptRequestId = 0
  let permissionReply: Record<string, unknown> | null = null
  const driver = new GrokBuildDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'fake-agent 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id?: number; method: string; result?: unknown }
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'grok-session' } })}\n`)
        else if (request.method === 'session/prompt') {
          promptRequestId = request.id ?? 0
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { kind: 'terminal', detail: '运行命令' } })}\n`)
        } else if (request.id === 99) {
          permissionReply = request as unknown as Record<string, unknown>
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'message_update', params: { type: 'text_delta', delta: '完成' } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptRequestId, result: {} })}\n`)
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks: unknown[] = []
  for await (const chunk of driver.executeTurn({ sessionId: 'coding-session', messages: [], prompt: '执行' })) {
    chunks.push(chunk)
    if (chunk.type === 'permission-request') driver.respondPermission('coding-session', { requestId: chunk.requestId, approved: true })
  }
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'grok-session' },
    { type: 'permission-request', requestId: '99', kind: 'terminal', detail: '运行命令' },
    { type: 'text-delta', text: '完成' },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(permissionReply, { jsonrpc: '2.0', id: 99, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
  driver.dispose()
})

test('Pi 同一 sessionId 跨轮复用 RPC 进程，并在 dispose 时统一回收', async () => {
  let spawnCount = 0
  let killed = 0
  const driver = new PiAgentDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'fake-agent 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      spawnCount += 1
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'prompt') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'message_update', params: { type: 'text_delta', delta: 'ok' } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          setImmediate(() => stdout.write(`${JSON.stringify({ type: 'agent_settled' })}\n`))
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { killed += 1; stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  for (let index = 0; index < 2; index += 1) {
    const chunks = []
    for await (const chunk of driver.executeTurn({ sessionId: 'same', messages: [], prompt: `第${index}轮` })) chunks.push(chunk)
    assert.equal(chunks.some((chunk) => chunk.type === 'text-delta'), true)
  }
  assert.equal(spawnCount, 1)
  driver.dispose()
  assert.equal(killed, 1)
})

test('Codex 原生权限请求转换为标准事件并可回传审批结果', async () => {
  let approved: unknown = null
  const driver = new CodexAppServerDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string; result?: unknown }
        if (request.method === 'thread/start') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'thread-1' } } })}\n`)
        else if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'turn-1' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'item/commandExecution/requestApproval', params: { kind: 'command', command: 'echo hidden' } })}\n`)
        } else if (request.id === 77) {
          approved = request.result
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })}\n`)
        } else stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks: unknown[] = []
  const running = (async () => {
    for await (const chunk of driver.executeTurn({ sessionId: 'codex-session', messages: [], prompt: '执行命令' })) {
      chunks.push(chunk)
      if (chunk.type === 'permission-request') driver.respondToPermission('codex-session', chunk.requestId, true)
    }
  })()
  await running
  assert.deepEqual(chunks.find((chunk) => (chunk as { type?: string }).type === 'permission-request'), { type: 'permission-request', requestId: '77', kind: 'command', detail: 'echo hidden' })
  assert.deepEqual(approved, { approved: true })
  driver.dispose()
})

test('Pi 在 prompt 响应先到时继续等待文本和 agent_settled', async () => {
  const driver = new PiAgentDriver({
    binaries: ['fake-pi'],
    spawnSync: (() => ({ status: 0, stdout: 'pi 0.85.1', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method !== 'prompt') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { accepted: true } })}\n`)
        setImmediate(() => {
          stdout.write(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '延迟回复' } })}\n`)
          stdout.write(`${JSON.stringify({ type: 'agent_settled' })}\n`)
        })
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'pi-late', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'pi-late' },
    { type: 'text-delta', text: '延迟回复' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Pi prompt 被拒绝时结束为 error', async () => {
  const driver = new PiAgentDriver({
    binaries: ['fake-pi'],
    spawnSync: (() => ({ status: 0, stdout: 'pi 0.85.1', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: '拒绝' } })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'pi-error', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'error' })
  driver.dispose()
})

test('Grok 在 prompt 响应后排空延迟到达的文本和完成通知', async () => {
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'],
    spawnSync: (() => ({ status: 0, stdout: 'grok 1.0.40', stderr: '' })) as never,
    spawn: createGrokTimingSpawn('response-first'),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'grok-late', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'grok-session' },
    { type: 'text-delta', text: '延迟回复' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Grok 只有终态通知而没有 prompt 响应时仍能完成', async () => {
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'],
    spawnSync: (() => ({ status: 0, stdout: 'grok 1.0.40', stderr: '' })) as never,
    spawn: createGrokTimingSpawn('terminal-only'),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'grok-terminal', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'stop' })
  driver.dispose()
})

test('Grok 延迟错误通知覆盖先到的 prompt 响应', async () => {
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'],
    spawnSync: (() => ({ status: 0, stdout: 'grok 1.0.40', stderr: '' })) as never,
    spawn: createGrokTimingSpawn('terminal-error'),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'grok-error', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'error' })
  driver.dispose()
})

function createGrokTimingSpawn(mode: 'response-first' | 'terminal-only' | 'terminal-error') {
  return (() => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = { write(data: string): void {
      const request = JSON.parse(data) as { id?: number; method?: string }
      if (request.method === 'initialize') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        return
      }
      if (request.method === 'session/new') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'grok-session' } })}\n`)
        return
      }
      if (request.method !== 'session/prompt') return
      if (mode !== 'terminal-only') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: mode === 'response-first' ? { stopReason: 'end_turn' } : {} })}\n`)
      }
      setTimeout(() => {
        if (mode === 'response-first') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', text: '延迟回复' } } })}\n`)
        }
        const sessionUpdate = mode === 'terminal-error' ? 'turn_failed' : 'turn_completed'
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate } } })}\n`)
      }, 10)
    } }
    return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
  }) as never
}

test('Codex 在 turn/start 响应先到时继续等待文本和完成通知', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'thread/start') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'thread-late' } } })}\n`)
        else if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'turn-late', status: 'inProgress' } } })}\n`)
          setImmediate(() => {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-late', turnId: 'turn-late', itemId: 'message-late', delta: '延迟回复' } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-late', turn: { id: 'turn-late', status: 'completed' } } })}\n`)
          })
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-late', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'thread-late' },
    { type: 'text-delta', text: '延迟回复' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Codex 取消时使用 turn/start 响应中的 turnId 中断当前轮次', async () => {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = []
  const controller = new AbortController()
  const driver = new CodexAppServerDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> }
        requests.push(request)
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'thread/start') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'thread-cancel' } } })}\n`)
        else if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'turn-cancel', status: 'inProgress' } } })}\n`)
          setImmediate(() => controller.abort())
        } else if (request.method === 'turn/interrupt') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-cancel', messages: [], prompt: '等待', signal: controller.signal })) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'cancel' })
  assert.deepEqual(requests.find((request) => request.method === 'turn/interrupt')?.params, { threadId: 'thread-cancel', turnId: 'turn-cancel' })
  driver.dispose()
})

test('Codex 仅在失败终止通知到达后结束为 error', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'thread/start') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'thread-failed' } } })}\n`)
        else if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'turn-failed', status: 'inProgress' } } })}\n`)
          setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-failed', turn: { id: 'turn-failed', status: 'failed', error: { message: '模型调用失败' } } } })}\n`))
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-failed', messages: [], prompt: '执行' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'thread-failed' },
    { type: 'finish', reason: 'error' },
  ])
  driver.dispose()
})

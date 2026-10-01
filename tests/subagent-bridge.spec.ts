import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { Readable, PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { createSubagentBridgeRuntime, setSubagentBridge } from '../data/build/dist/host/cli-bridge/bridge-holder.js'
import { startSubagentBridgeServer } from '../data/build/dist/host/cli-bridge/bridge-server.js'
import {
  acpBridgeMcpServers,
  bridgeMcpEntryPath,
  claudeBridgeArgs,
  codexBridgeArgs,
  codexBridgeDeveloperInstructions,
  commandCodeBridgeArgs,
  commandCodeBridgeEnvironment,
} from '../data/build/dist/host/cli-bridge/injections.js'
import { dispatchBridgeSubagent } from '../data/build/dist/host/cli-bridge/dispatch.js'
import { setNativeSubagents } from '../data/build/dist/host/cli-adapters/native-subagent-holder.js'
import { registerNativeTeamSubagentProviders } from '../data/build/dist/host/cli-adapters/native-team-subagent.js'
import { setAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry-holder.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsCliSessionStore } from '../data/build/dist/host/cli-adapters/session-store.js'
import { CommandCodeDriver } from '../data/build/dist/host/cli-adapters/command-code-driver.js'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'
import { MiniMaxCodeDriver } from '../data/build/dist/host/cli-adapters/mcode-driver.js'

const ACTIVE_RUNTIME = { baseUrl: 'http://127.0.0.1:45999', token: 'secret-token' }

function enableBridge(): ReturnType<typeof createSubagentBridgeRuntime> {
  const runtime = createSubagentBridgeRuntime(ACTIVE_RUNTIME)
  setSubagentBridge(runtime)
  return runtime
}

test('子代理桥接注入：开启时产出各适配器扩展面，关闭时全部为空', () => {
  try {
    assert.deepEqual(commandCodeBridgeArgs('s1'), [])
    assert.deepEqual(commandCodeBridgeEnvironment('s1', 'command-code'), {})
    assert.deepEqual(claudeBridgeArgs('s1', 'claude-code'), [])
    assert.deepEqual(acpBridgeMcpServers('s1', 'gemini'), [])
    assert.deepEqual(codexBridgeArgs('s1', 'codex'), [])
    assert.equal(codexBridgeDeveloperInstructions('s1'), undefined)

    enableBridge()
    const modArgs = commandCodeBridgeArgs('s1')
    assert.equal(modArgs[0], '--mod')
    assert.ok(modArgs[1]!.endsWith('command-code-mod.js'))
    assert.ok(existsSync(modArgs[1]!))

    const env = commandCodeBridgeEnvironment('s1', 'command-code')
    assert.equal(env.CODINGNS_BRIDGE_URL, ACTIVE_RUNTIME.baseUrl)
    assert.equal(env.CODINGNS_BRIDGE_TOKEN, ACTIVE_RUNTIME.token)
    assert.equal(env.CODINGNS_DSH_SESSION_ID, 's1')
    assert.equal(env.CODINGNS_ADAPTER_ID, 'command-code')

    const claude = claudeBridgeArgs('s1', 'claude-code')
    const configIndex = claude.indexOf('--mcp-config')
    assert.ok(configIndex >= 0)
    const config = JSON.parse(claude[configIndex + 1]!)
    assert.equal(config.mcpServers.codingns.env.CODINGNS_BRIDGE_TOKEN, ACTIVE_RUNTIME.token)
    assert.ok(String(config.mcpServers.codingns.args[0]).endsWith('mcp-stdio-entry.js'))
    assert.deepEqual(claude.slice(configIndex + 2, configIndex + 5), ['--append-system-prompt', claude[configIndex + 3], '--disallowedTools'])
    assert.equal(claude.at(-1), 'Task')
    assert.ok(existsSync(bridgeMcpEntryPath()))

    const acp = acpBridgeMcpServers('s1', 'gemini')
    assert.equal(acp.length, 1)
    assert.equal(acp[0].name, 'codingns')
    assert.equal(acp[0].command, process.execPath)
    assert.deepEqual(acp[0].env.find((item: { name: string }) => item.name === 'CODINGNS_ADAPTER_ID'), { name: 'CODINGNS_ADAPTER_ID', value: 'gemini' })

    const codex = codexBridgeArgs('s1', 'codex')
    assert.ok(codex.includes(`mcp_servers.codingns.command=${JSON.stringify(process.execPath)}`))
    assert.ok(codex.join(' ').includes('CODINGNS_BRIDGE_TOKEN="secret-token"'))
    // Codex 对 MCP 工具强制审批；必须固定自动批准，否则 approvalPolicy=never 的会话直接失败。
    assert.ok(codex.includes('mcp_servers.codingns.default_tools_approval_mode="approve"'))
    // Codex 不会自发使用注入的 MCP 工具，必须带线程级指令引导。
    const codexInstructions = codexBridgeDeveloperInstructions('s1')
    assert.ok(codexInstructions !== undefined)
    assert.ok(codexInstructions.includes('codingns.agent_subagent'))
  } finally {
    setSubagentBridge(undefined)
  }
})

test('子代理会话不再注入桥接，避免嵌套托管递归', () => {
  const store = new CodingNsCliSessionStore()
  store.upsert('child-1', { adapterId: 'command-code', origin: 'subagent', parentSessionId: 'parent-1' })
  const registry = new CodingNsCliAdapterRegistry([], undefined, { sessionStore: store })
  setAdapterRegistry(registry)
  enableBridge()
  try {
    assert.deepEqual(commandCodeBridgeArgs('child-1'), [])
    assert.deepEqual(commandCodeBridgeEnvironment('child-1', 'command-code'), {})
    assert.deepEqual(claudeBridgeArgs('child-1', 'claude-code'), [])
    assert.equal(codexBridgeDeveloperInstructions('child-1'), undefined)
    // 普通会话仍然注入。
    assert.equal(commandCodeBridgeArgs('user-1').length, 2)
  } finally {
    setSubagentBridge(undefined)
    setAdapterRegistry(undefined)
  }
})

test('桥接服务：令牌校验、状态查询与派发响应', async () => {
  const requests: Array<Record<string, unknown>> = []
  const server = await startSubagentBridgeServer({
    dispatch: async (request) => {
      requests.push({ ...request })
      return { ok: true, text: '子代理结果', childSessionId: 'child-1' }
    },
  })
  try {
    const status = await fetch(`${server.runtime.baseUrl}/v1/status`)
    assert.equal(status.status, 200)
    assert.deepEqual(await status.json(), { ok: true, service: 'codingns-subagent-bridge' })

    const unauthorized = await fetch(`${server.runtime.baseUrl}/v1/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', prompt: '分析' }),
    })
    assert.equal(unauthorized.status, 401)

    const authorized = await fetch(`${server.runtime.baseUrl}/v1/dispatch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.runtime.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', prompt: '分析', toolCallId: 'call_1', description: '标题' }),
    })
    assert.equal(authorized.status, 200)
    assert.deepEqual(await authorized.json(), { ok: true, text: '子代理结果', childSessionId: 'child-1' })
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.toolCallId, 'call_1')
    assert.equal(requests[0]!.description, '标题')

    const invalid = await fetch(`${server.runtime.baseUrl}/v1/dispatch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.runtime.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '', prompt: '' }),
    })
    assert.equal(invalid.status, 400)
  } finally {
    await server.close()
  }
})

test('MCP 入口：initialize / tools/list / tools/call 端到端经过桥接', async () => {
  const server = await startSubagentBridgeServer({
    dispatch: async () => ({ ok: true, text: '子代理完成', childSessionId: 'child-9' }),
  })
  const child = spawn(process.execPath, [bridgeMcpEntryPath()], {
    env: {
      ...process.env,
      CODINGNS_BRIDGE_URL: server.runtime.baseUrl,
      CODINGNS_BRIDGE_TOKEN: server.runtime.token,
      CODINGNS_DSH_SESSION_ID: 's1',
      CODINGNS_ADAPTER_ID: 'command-code',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const responses = new Map<unknown, any>()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line !== '') {
        const message = JSON.parse(line)
        responses.set(message.id, message)
      }
      index = buffer.indexOf('\n')
    }
  })
  const send = (message: Record<string, unknown>): void => { child.stdin.write(`${JSON.stringify(message)}\n`) }
  const waitFor = async (id: unknown): Promise<any> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (responses.has(id)) return responses.get(id)
      await delay(50)
    }
    throw new Error(`MCP 响应超时: ${String(id)}`)
  }
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agent_subagent', arguments: { prompt: '分析 src' } } })

    const initialized = await waitFor(1)
    assert.equal(initialized.result.serverInfo.name, 'codingns-subagent-bridge')
    assert.equal(initialized.result.protocolVersion, '2024-11-05')
    const tools = await waitFor(2)
    assert.equal(tools.result.tools.length, 1)
    assert.equal(tools.result.tools[0].name, 'agent_subagent')
    const call = await waitFor(3)
    assert.equal(call.result.isError, undefined)
    assert.deepEqual(call.result.content, [{ type: 'text', text: '子代理完成' }])
  } finally {
    child.kill()
    await server.close()
  }
})

test('桥接派发：解析父会话并把子代理绑定为原生可续子会话', async () => {
  const started: Array<Record<string, any>> = []
  const service = {
    registerProvider: () => () => undefined,
    startContinuable: async (spec: Record<string, any>) => {
      started.push(spec)
      return { childId: 'child-77', messageId: 'm1' }
    },
  }
  const events = [
    { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '子代理输出' }] } } },
    { type: 'tool/result', seq: 2, data: {} },
    { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } },
  ]
  const sessions = {
    available: true,
    get: (id: string) => (id === 'child-77' ? { snapshotEvents: () => events } : undefined),
    subscribe: () => () => undefined,
    list: () => [],
  }
  const driver = {
    descriptor: { id: 'command-code', name: 'Command Code', protocol: 'command', capabilities: [] },
    detect: async () => ({ installed: true, version: '1.0.0', command: '/fake/command-code' }),
    listModels: async () => ({ groups: [], currentModel: null, currentEffort: null }),
    executeTurn: async function* () { /* 桥接派发不经过普通轮次 */ },
  }
  const registry = new CodingNsCliAdapterRegistry([driver as never])
  registry.setSession('s1', { adapterId: 'command-code' })
  setNativeSubagents(service as never)
  setAdapterRegistry(registry)
  try {
    const result = await dispatchBridgeSubagent(
      { sessionId: 's1', prompt: '分析当前项目' },
      {
        agents: { get: (id: string) => (id === 's1' ? { id: 'agent-s1', session: { header: { id: 's1' } } } : undefined) },
        nativeSessions: sessions as never,
      },
    )
    assert.equal(result.ok, true)
    assert.equal(result.childSessionId, 'child-77')
    assert.equal(result.text, '子代理输出')
    assert.equal(result.toolCalls, 1)
    assert.equal(started.length, 1)
    assert.equal(started[0]!.provider, 'codingns-external-command-code')
    assert.equal(started[0]!.request.parent.id, 'agent-s1')
    // DSH 会把 signal 原样转发给 Provider；缺省时必须兜底，否则 prepareContinuable 直接崩溃。
    assert.ok(started[0]!.signal instanceof AbortSignal)
  } finally {
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})

test('子代理 Provider：缺省 signal 时 prepareContinuable 仍能绑定子会话', async () => {
  const store = new CodingNsCliSessionStore()
  const driver = {
    descriptor: { id: 'command-code', name: 'Command Code', protocol: 'command', capabilities: [] },
    detect: async () => ({ installed: true, version: '1.0.0', command: '/fake/command-code' }),
    listModels: async () => ({ groups: [], currentModel: null, currentEffort: null }),
    executeTurn: async function* () { /* 绑定阶段不驱动轮次 */ },
  }
  const registry = new CodingNsCliAdapterRegistry([driver as never], undefined, { sessionStore: store })
  setAdapterRegistry(registry)
  const providers = new Map<string, any>()
  const dispose = registerNativeTeamSubagentProviders({
    registerProvider: (provider: any) => { providers.set(provider.name, provider); return () => undefined },
  } as never)
  try {
    const provider = providers.get('codingns-external-command-code')
    assert.ok(provider !== undefined)
    await provider.prepareContinuable({ sessionId: 'child-live', parent: { id: 'parent-live' }, signal: undefined })
    assert.equal(store.get('child-live')?.origin, 'subagent')
    assert.equal(store.get('child-live')?.adapterId, 'command-code')
    assert.equal(store.get('child-live')?.parentSessionId, 'parent-live')
  } finally {
    dispose()
    setAdapterRegistry(undefined)
  }
})

test('桥接派发：缺少原生 Subagent 能力时返回可读错误', async () => {
  setNativeSubagents(undefined)
  const result = await dispatchBridgeSubagent(
    { sessionId: 's1', prompt: '分析' },
    { agents: { get: () => undefined }, nativeSessions: { available: true, get: () => undefined, subscribe: () => () => undefined, list: () => [] } as never },
  )
  assert.equal(result.ok, false)
  assert.match(String(result.error), /原生 Subagent 能力不可用/)
})

test('Command Code 转投：hook_blocked 命中桥接记录时投影为完成并保留结果', async () => {
  const runtime = enableBridge()
  runtime.recordRedirect('s-cc', 'call_00', { childSessionId: 'child-1', ok: true, toolCalls: 0 })
  const received: Array<{ args: string[]; env: Record<string, string | undefined> }> = []
  const driver = new CommandCodeDriver({
    binaries: ['command-code'],
    spawnSync: ((command: string, args: string[]) => args[0] === '--version'
      ? { status: 0, stdout: 'command-code 1.69.0', stderr: '' }
      : { status: 0, stdout: '', stderr: '' }) as never,
    spawn: ((command: string, args: string[], options: { env: Record<string, string | undefined> }) => {
      received.push({ args, env: options.env })
      return {
        stdout: Readable.from([
          `${JSON.stringify({ type: 'event', event: { type: 'tool_queued', toolCallId: 'call_00', toolName: 'agent', input: { prompt: '分析' } } })}\n`,
          `${JSON.stringify({ type: 'event', event: { type: 'tool_hook_blocked', toolCallId: 'call_00', toolName: 'agent', hookOutput: '子代理结果文本' } })}\n`,
          `${JSON.stringify({ type: 'event', event: { type: 'result', subtype: 'success', stopReason: 'end_turn', finalText: '完成' } })}\n`,
        ]),
        stderr: { on() { return this } },
        kill() { return true },
      }
    }) as never,
  })
  try {
    const chunks = []
    for await (const chunk of driver.executeTurn({ sessionId: 's-cc', messages: [], prompt: '分析当前项目' })) chunks.push(chunk)
    assert.deepEqual(chunks, [
      { type: 'tool-event', toolName: 'agent', callId: 'call_00', input: '{"prompt":"分析"}', status: 'started' },
      { type: 'tool-event', toolName: 'agent', callId: 'call_00', output: '子代理结果文本', outputMode: 'snapshot', status: 'completed' },
      { type: 'text-delta', text: '完成', messageId: 'command-code-message-1' },
      { type: 'finish', reason: 'stop' },
    ])
    assert.ok(received[0]!.args.includes('--mod'))
    assert.equal(received[0]!.env.CODINGNS_DSH_SESSION_ID, 's-cc')
    assert.equal(received[0]!.env.CODINGNS_BRIDGE_TOKEN, ACTIVE_RUNTIME.token)
  } finally {
    driver.dispose()
    setSubagentBridge(undefined)
  }
})

test('Command Code 未命中的 hook_blocked 仍按失败投影', async () => {
  enableBridge()
  const driver = new CommandCodeDriver({
    binaries: ['command-code'],
    spawnSync: ((command: string, args: string[]) => args[0] === '--version'
      ? { status: 0, stdout: 'command-code 1.69.0', stderr: '' }
      : { status: 0, stdout: '', stderr: '' }) as never,
    spawn: (() => ({
      stdout: Readable.from([
        `${JSON.stringify({ type: 'event', event: { type: 'tool_hook_blocked', toolCallId: 'call_1', toolName: 'agent', hookOutput: '被其他 mod 拦截' } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'result', subtype: 'success', stopReason: 'end_turn', finalText: '完成' } })}\n`,
      ]),
      stderr: { on() { return this } },
      kill() { return true },
    })) as never,
  })
  try {
    const chunks = []
    for await (const chunk of driver.executeTurn({ sessionId: 's-cc-2', messages: [], prompt: '分析' })) chunks.push(chunk)
    assert.deepEqual(chunks[0], { type: 'tool-event', toolName: 'agent', callId: 'call_1', output: '被其他 mod 拦截', outputMode: 'snapshot', status: 'failed' })
  } finally {
    driver.dispose()
    setSubagentBridge(undefined)
  }
})

test('Claude Code 参数注入：托管开启时携带 MCP 替身与禁用的 Task', () => {
  const build = (sessionId: string): readonly string[] => (new ClaudeCodeDriver({ binaries: ['fake-claude'] }) as unknown as {
    buildArgs(input: Record<string, unknown>): readonly string[]
  }).buildArgs({ sessionId, messages: [], prompt: 'hi' })
  try {
    assert.deepEqual(build('s-claude'), ['-p', 'hi', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'])
    enableBridge()
    const args = build('s-claude')
    assert.ok(args.includes('--mcp-config'))
    assert.ok(args.includes('--disallowedTools'))
    assert.equal(args.at(-1), 'Task')
  } finally {
    setSubagentBridge(undefined)
  }
})

test('MiniMax Code ACP：session/new 携带桥接 MCP server', async () => {
  let sessionNewParams: Record<string, unknown> | undefined
  const driver = new MiniMaxCodeDriver({
    binaries: ['fake-mcode'],
    spawnSync: (() => ({ status: 0, stdout: 'mcode 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = {
        write(data: string): void {
          const request = JSON.parse(data) as Record<string, unknown>
          const method = request.method
          if (method === 'initialize') {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          } else if (method === 'session/new') {
            sessionNewParams = request.params as Record<string, unknown>
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'mvs-1' } })}\n`)
          } else if (method === 'session/prompt') {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: '完成' } } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
          }
        },
      }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  try {
    enableBridge()
    const chunks = []
    for await (const chunk of driver.executeTurn({ sessionId: 's-mcode', messages: [], prompt: '请分析' })) chunks.push(chunk)
    assert.equal(chunks.at(-1)!.type, 'finish')
    assert.equal((sessionNewParams!.mcpServers as unknown[]).length, 1)
    assert.equal((sessionNewParams!.mcpServers as Array<Record<string, unknown>>)[0]!.name, 'codingns')
    driver.dispose()
    setSubagentBridge(undefined)

    const offDriver = new MiniMaxCodeDriver({
      binaries: ['fake-mcode'],
      spawnSync: (() => ({ status: 0, stdout: 'mcode 1.0.0', stderr: '' })) as never,
      spawn: (() => {
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const stdin = {
          write(data: string): void {
            const request = JSON.parse(data) as Record<string, unknown>
            if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
            else if (request.method === 'session/new') {
              sessionNewParams = request.params as Record<string, unknown>
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'mvs-2' } })}\n`)
            } else if (request.method === 'session/prompt') {
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
            }
          },
        }
        return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
      }) as never,
    })
    for await (const _chunk of offDriver.executeTurn({ sessionId: 's-mcode-2', messages: [], prompt: '请分析' })) { /* 只需触发 session/new */ }
    assert.deepEqual(sessionNewParams!.mcpServers, [])
    offDriver.dispose()
  } finally {
    setSubagentBridge(undefined)
  }
})

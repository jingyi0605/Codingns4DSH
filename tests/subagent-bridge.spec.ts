import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { Readable, PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { createSubagentBridgeRuntime, setSubagentBridge } from '../data/build/dist/host/cli-bridge/bridge-holder.js'
import { startSubagentBridgeServer } from '../data/build/dist/host/cli-bridge/bridge-server.js'
import {
  acpBridgeMcpServers,
  bridgeMcpEntryPath,
  claudeBridgeArgs,
  codexConfigOverride,
  codexBridgeArgs,
  codexBridgeDeveloperInstructions,
  commandCodeBridgeArgs,
  commandCodeBridgeEnvironment,
} from '../data/build/dist/host/cli-bridge/injections.js'
import { dispatchBridgeSubagent } from '../data/build/dist/host/cli-bridge/dispatch.js'
import { setNativeSubagents } from '../data/build/dist/host/cli-adapters/native-subagent-holder.js'
import { registerNativeTeamSubagentProviders } from '../data/build/dist/host/cli-adapters/native-team-subagent.js'
import { setAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry-holder.js'
import { setDelegationAuthorization } from '../data/build/dist/host/cli-adapters/delegation-authorization.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsCliSessionStore } from '../data/build/dist/host/cli-adapters/session-store.js'
import { CommandCodeDriver } from '../data/build/dist/host/cli-adapters/command-code-driver.js'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'
import { MiniMaxCodeDriver } from '../data/build/dist/host/cli-adapters/mcode-driver.js'
import { windowsShellInvocation } from '../data/build/dist/host/cli-adapters/process-utils.js'

const ACTIVE_RUNTIME = { baseUrl: 'http://127.0.0.1:45999', token: 'secret-token' }

/** 源码回归不构建产物；子进程也使用同一个内存源码加载器。 */
function sourceEntry(path: string): string {
  return existsSync(path) ? path : path.replace(/\.js$/u, '.ts')
}
function bridgeEntryArgs(): string[] {
  return ['--import', fileURLToPath(new URL('./register-source-loader.mjs', import.meta.url)), sourceEntry(bridgeMcpEntryPath())]
}

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
    assert.ok(existsSync(sourceEntry(modArgs[1]!)))

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
    assert.ok(existsSync(sourceEntry(bridgeMcpEntryPath())))

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

    // Windows 的 JsonRpcProcess 通过显式 cmd.exe `/c` 命令启动 `.cmd` 包装器；
    // 注入层只返回真实 argv，shell 转义由进程层统一完成，MCP args 继续是 TOML 数组。
    const windowsCodex = codexBridgeArgs('s1', 'codex', 'win32')
    const windowsArgsOverride = windowsCodex[windowsCodex.indexOf('-c', 2) + 1] ?? ''
    assert.equal(windowsArgsOverride, `mcp_servers.codingns.args=['${bridgeMcpEntryPath()}']`)
    assert.doesNotMatch(windowsArgsOverride, /=\["/u)
    assert.equal(codexConfigOverride('mcp_servers.codingns.args', "['C:\\Program Files\\codingns\\mcp-stdio-entry.js']"), "mcp_servers.codingns.args=['C:\\Program Files\\codingns\\mcp-stdio-entry.js']")
    const invocation = windowsShellInvocation('codex.cmd', ['app-server', '-c', "mcp_servers.codingns.args=['C:\\Program Files\\codingns\\mcp-stdio-entry.js']"], 'win32', 'C:\\Windows\\System32\\cmd.exe')
    assert.deepEqual(invocation, {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', "\"codex.cmd app-server -c \"mcp_servers.codingns.args=['C:\\Program Files\\codingns\\mcp-stdio-entry.js']\"\""],
    })
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
  const dispatched: Array<Record<string, unknown>> = []
  const server = await startSubagentBridgeServer({
    dispatch: async (request) => {
      dispatched.push({ ...request })
      return request.action === 'wait'
        ? { ok: false, status: 'running', completed: false, text: '子代理仍在运行。', childSessionId: 'child-9' }
        : request.action === 'send'
          ? { ok: true, status: 'running', completed: false, text: '后续消息已发送给子代理。', childSessionId: 'child-9', messageId: 'message-9' }
        : { ok: true, status: 'running', completed: false, text: '子代理已启动，等待首轮 turn/end。', childSessionId: 'child-9' }
    },
  })
  const child = spawn(process.execPath, bridgeEntryArgs(), {
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
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agent_subagent', arguments: { action: 'wait', child_session_id: 'child-9', timeout_ms: 1 } } })
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'agent_subagent', arguments: { action: 'send', child_session_id: 'child-9', message: '请补充报告' } } })

    const initialized = await waitFor(1)
    assert.equal(initialized.result.serverInfo.name, 'codingns-subagent-bridge')
    assert.equal(initialized.result.protocolVersion, '2024-11-05')
    const tools = await waitFor(2)
    assert.equal(tools.result.tools.length, 1)
    assert.equal(tools.result.tools[0].name, 'agent_subagent')
    assert.match(String(tools.result.tools[0].description), /returns immediately/u)
    const call = await waitFor(3)
    assert.equal(call.result.isError, undefined)
    assert.deepEqual(call.result.content, [{ type: 'text', text: JSON.stringify({ ok: true, status: 'running', completed: false, childSessionId: 'child-9', text: '子代理已启动，等待首轮 turn/end。' }) }])
    assert.equal(dispatched.find((request) => request.action === 'start')?.runInBackground, true)
    const waiting = await waitFor(4)
    assert.equal(waiting.result.isError, undefined)
    assert.match(String(waiting.result.content?.[0]?.text), /"status":"running"/u)
    const sent = await waitFor(5)
    assert.equal(sent.result.isError, undefined)
    assert.match(String(sent.result.content?.[0]?.text), /"messageId":"message-9"/u)
    assert.equal(dispatched.find((request) => request.action === 'send')?.message, '请补充报告')
  } finally {
    child.kill()
    await server.close()
  }
})

test('MCP 入口：独立 start 请求并行处理，不串行等待前一个子代理', async () => {
  let active = 0
  let maxActive = 0
  const server = await startSubagentBridgeServer({
    dispatch: async (request) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(40)
      active -= 1
      return {
        ok: true,
        status: 'running' as const,
        completed: false,
        text: '子代理已启动。',
        childSessionId: `child-${request.prompt}`,
      }
    },
  })
  const child = spawn(process.execPath, bridgeEntryArgs(), {
    env: {
      ...process.env,
      CODINGNS_BRIDGE_URL: server.runtime.baseUrl,
      CODINGNS_BRIDGE_TOKEN: server.runtime.token,
      CODINGNS_DSH_SESSION_ID: 's-parallel',
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
  const send = (id: number, prompt: string): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'agent_subagent', arguments: { prompt } } })}\n`)
  }
  const waitFor = async (id: number): Promise<any> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (responses.has(id)) return responses.get(id)
      await delay(20)
    }
    throw new Error(`MCP 并行响应超时: ${String(id)}`)
  }
  try {
    send(1, '任务一')
    send(2, '任务二')
    const [first, second] = await Promise.all([waitFor(1), waitFor(2)])
    assert.equal(first.result.isError, undefined)
    assert.equal(second.result.isError, undefined)
    assert.equal(maxActive, 2)
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
    sendMessage: async (_sender: unknown, targetId: string, content: readonly { type: 'text'; text: string }[]) => {
      assert.equal(targetId, 'child-77')
      assert.equal(content[0]?.text, '请补充报告')
      return 'm2'
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
    const deps = {
      agents: { get: (id: string) => (id === 's1' ? { id: 'agent-s1', session: { header: { id: 's1' } } } : undefined) },
      nativeSessions: sessions as never,
    }
    const read = await dispatchBridgeSubagent({ sessionId: 's1', action: 'read', childSessionId: 'child-77' }, deps)
    assert.equal(read.status, 'completed')
    assert.equal(read.completed, true)
    const waited = await dispatchBridgeSubagent({ sessionId: 's1', action: 'wait', childSessionId: 'child-77', timeoutMs: 1 }, deps)
    assert.equal(waited.status, 'completed')
    const followup = await dispatchBridgeSubagent({ sessionId: 's1', action: 'send', childSessionId: 'child-77', message: '请补充报告' }, deps)
    assert.equal(followup.ok, true)
    assert.equal(followup.status, 'running')
    assert.equal(followup.completed, false)
    assert.equal(followup.messageId, 'm2')
    // 后续追踪从发送前的事件游标开始，旧首轮 turn/end 不能立即把 follow-up 标记为完成。
    const followupState = await dispatchBridgeSubagent({ sessionId: 's1', action: 'read', childSessionId: 'child-77' }, deps)
    assert.equal(followupState.status, 'running')
    const crossParent = await dispatchBridgeSubagent({ sessionId: 's2', action: 'read', childSessionId: 'child-77' }, {
      ...deps,
      agents: { get: (id: string) => (id === 's2' ? { id: 'agent-s2', session: { header: { id: 's2' } } } : undefined) },
    })
    assert.equal(crossParent.ok, false)
    assert.match(String(crossParent.error), /找不到父会话下的子会话/u)
  } finally {
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})

test('桥接失败状态：父 Agent 必须先 read/wait 复核后才能继续收尾', async () => {
  const service = {
    registerProvider: () => () => undefined,
    startContinuable: async () => ({ childId: 'child-bridge-error', messageId: 'm-error' }),
  }
  const sessions = {
    get: (id: string) => id === 'child-bridge-error'
      ? {
          snapshotEvents: () => [
            { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '失败前报告' }] } } },
            { type: 'turn/end', seq: 2, data: { reason: { kind: 'error', error: { message: '子代理额度不足' } } } },
          ],
        }
      : undefined,
    subscribe: () => () => undefined,
    list: () => [],
  }
  const driver = {
    descriptor: { id: 'command-code', name: 'Command Code', protocol: 'command', capabilities: [] },
    detect: async () => ({ installed: true, version: '1.0.0', command: '/fake/command-code' }),
    listModels: async () => ({ groups: [], currentModel: null, currentEffort: null }),
    executeTurn: async function* () { /* 失败复核测试不经过普通轮次 */ },
  }
  const registry = new CodingNsCliAdapterRegistry([driver as never])
  registry.setSession('s-bridge-error', { adapterId: 'command-code' })
  setNativeSubagents(service as never)
  setAdapterRegistry(registry)
  const deps = {
    agents: { get: (id: string) => (id === 's-bridge-error' ? { id: 'agent-bridge-error', session: { header: { id: 's-bridge-error' } } } : undefined) },
    nativeSessions: sessions as never,
  }
  try {
    const failed = await dispatchBridgeSubagent({ sessionId: 's-bridge-error', prompt: '模拟失败', runInBackground: false }, deps)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.failureReviewed, false)
    assert.equal(failed.failureReviewRequired, true)
    assert.match(String(failed.failureGuidance), /重新创建|接管/u)
    const reviewed = await dispatchBridgeSubagent({ sessionId: 's-bridge-error', action: 'read', childSessionId: 'child-bridge-error' }, deps)
    assert.equal(reviewed.failureReviewed, true)
    assert.equal(reviewed.failureReviewRequired, false)
    assert.match(String(reviewed.error), /额度不足/u)
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
    assert.deepEqual(chunks.filter(({ type }) => type !== 'session-binding'), [
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

test('Command Code 后台转投：hook_blocked 投影为 running，不能伪装成完成', async () => {
  const runtime = enableBridge()
  runtime.recordRedirect('s-cc-running', 'call_running', {
    childSessionId: 'child-running',
    ok: true,
    completed: false,
    status: 'running',
    toolCalls: 0,
  })
  const driver = new CommandCodeDriver({
    binaries: ['command-code'],
    spawnSync: ((command: string, args: string[]) => args[0] === '--version'
      ? { status: 0, stdout: 'command-code 1.69.0', stderr: '' }
      : { status: 0, stdout: '', stderr: '' }) as never,
    spawn: (() => ({
      stdout: Readable.from([
        `${JSON.stringify({ type: 'event', event: { type: 'tool_hook_blocked', toolCallId: 'call_running', toolName: 'agent', hookOutput: '{"status":"running","childSessionId":"child-running"}' } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'result', subtype: 'success', stopReason: 'end_turn', finalText: '继续等待' } })}\n`,
      ]),
      stderr: { on() { return this } },
      kill() { return true },
    })) as never,
  })
  try {
    const chunks = []
    for await (const chunk of driver.executeTurn({ sessionId: 's-cc-running', messages: [], prompt: '并行分析' })) chunks.push(chunk)
    const tool = chunks.find((chunk) => chunk.type === 'tool-event')
    assert.equal(tool?.status, 'running')
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
    assert.deepEqual(chunks.filter(({ type }) => type !== 'session-binding')[0], { type: 'tool-event', toolName: 'agent', callId: 'call_1', output: '被其他 mod 拦截', outputMode: 'snapshot', status: 'failed' })
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
    // 原生权限与提问使用 stdio 处理器，托管开关不能把协议入口退回旧的 host 参数。
    const baseArgs = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--include-partial-messages', '--verbose']
    assert.deepEqual(build('s-claude'), baseArgs)
    enableBridge()
    const args = build('s-claude')
    assert.deepEqual(args.slice(0, baseArgs.length), baseArgs)
    assert.ok(args.includes('--mcp-config'))
    assert.ok(args.includes('--disallowedTools'))
    assert.equal(args.at(-1), 'Task')
  } finally {
    setSubagentBridge(undefined)
  }
})

test('桥接派发：成功转投登记重定向，供驱动把 hook_blocked 投影为完成态', async () => {
  const runtime = enableBridge()
  const service = {
    registerProvider: () => () => undefined,
    startContinuable: async () => ({ childId: 'child-redirect', messageId: 'm1' }),
  }
  const events = [
    { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '子代理输出' }] } } },
    { type: 'tool/result', seq: 2, data: {} },
    { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } },
  ]
  const sessions = {
    available: true,
    get: (id: string) => (id === 'child-redirect' ? { snapshotEvents: () => events } : undefined),
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
  registry.setSession('s-redirect', { adapterId: 'command-code' })
  setNativeSubagents(service as never)
  setAdapterRegistry(registry)
  try {
    const result = await dispatchBridgeSubagent(
      { sessionId: 's-redirect', prompt: '分析当前项目', toolCallId: 'call_redirect_1' },
      {
        agents: { get: (id: string) => (id === 's-redirect' ? { id: 'agent-redirect', session: { header: { id: 's-redirect' } } } : undefined) },
        nativeSessions: sessions as never,
      },
    )
    assert.equal(result.ok, true)
    // 不登记重定向时，CLI 的 tool_hook_blocked 会被投影成失败工具调用，
    // 用户看到的是「子代理失败」，即使派发本身成功。
    const redirect = runtime.consumeRedirect('s-redirect', 'call_redirect_1')
    assert.ok(redirect !== undefined)
    assert.equal(redirect.childSessionId, 'child-redirect')
    assert.equal(redirect.ok, true)
    // 同一 toolCallId 只消费一次，避免重复投影。
    assert.equal(runtime.consumeRedirect('s-redirect', 'call_redirect_1'), undefined)
  } finally {
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
    setSubagentBridge(undefined)
  }
})

test('Command Code 父会话的单目标授权优先路由到所选 Claude Code', async () => {
  const started: Array<{ provider: string }> = []
  const service = {
    registerProvider: () => () => undefined,
    startContinuable: async (spec: { provider: string }) => {
      started.push({ provider: spec.provider })
      return { childId: 'child-claude', messageId: 'm-claude' }
    },
  }
  const events = [
    { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'Claude 输出' }] } } },
    { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } },
  ]
  const sessions = {
    available: true,
    get: (id: string) => (id === 'child-claude' ? { snapshotEvents: () => events } : undefined),
    subscribe: () => () => undefined,
    list: () => [],
  }
  const makeDriver = (id: string) => ({
    descriptor: { id, name: id, protocol: 'command', capabilities: [] },
    detect: async () => ({ installed: true, version: '1.0.0', command: `/fake/${id}` }),
    listModels: async () => ({ groups: [], currentModel: null, currentEffort: null }),
    executeTurn: async function* () {},
  })
  const registry = new CodingNsCliAdapterRegistry([makeDriver('command-code') as never, makeDriver('claude-code') as never])
  registry.setSession('s-claude-route', { adapterId: 'command-code' })
  setDelegationAuthorization('s-claude-route', [{ adapterId: 'claude-code' }])
  setNativeSubagents(service as never)
  setAdapterRegistry(registry)
  try {
    const result = await dispatchBridgeSubagent(
      { sessionId: 's-claude-route', prompt: '点评文件', toolCallId: 'call-claude-route' },
      {
        agents: { get: (id: string) => (id === 's-claude-route' ? { id: 'agent-claude-route', session: { header: { id: 's-claude-route' } } } : undefined) },
        nativeSessions: sessions as never,
      },
    )
    assert.equal(result.ok, true)
    assert.deepEqual(started, [{ provider: 'codingns-external-claude-code' }])
  } finally {
    setDelegationAuthorization('s-claude-route', [])
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})

test('桥接派发：派发失败时不登记重定向，失败必须保持可见', async () => {
  const runtime = enableBridge()
  // 缺少原生 Subagent 能力：派发必然失败。
  setNativeSubagents(undefined)
  try {
    const result = await dispatchBridgeSubagent(
      { sessionId: 's-fail', prompt: '分析当前项目', toolCallId: 'call_fail_1' },
      {
        agents: { get: () => ({ id: 'agent-fail', session: { header: { id: 's-fail' } } }) },
        nativeSessions: { available: true, get: () => undefined, subscribe: () => () => undefined, list: () => [] } as never,
      },
    )
    assert.equal(result.ok, false)
    assert.match(String(result.error), /原生 Subagent 能力不可用/)
    // 失败绝不能伪装成「已由 DSH 子代理完成」，否则工具态会显示成功。
    assert.equal(runtime.consumeRedirect('s-fail', 'call_fail_1'), undefined)
  } finally {
    setSubagentBridge(undefined)
  }
})

test('Command Code 托管 mod：桥接失败时 block 并给出可读原因，不回退内建子代理', async () => {
  const mod = await import('../data/build/dist/host/cli-bridge/command-code-mod.js')
  const hooks: Array<Record<string, unknown>> = []
  const previous = { ...process.env }
  // 指向必然不可达的端口：fetch 立刻失败。
  process.env.CODINGNS_BRIDGE_URL = 'http://127.0.0.1:1'
  process.env.CODINGNS_BRIDGE_TOKEN = 'token'
  process.env.CODINGNS_DSH_SESSION_ID = 's-mod'
  try {
    ;(mod.default as (api: unknown) => void)({
      hooks: (value: Record<string, unknown>) => { hooks.push(value) },
    })
    assert.equal(hooks.length, 1)
    const beforeToolCall = hooks[0]!.beforeToolCall as (context: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>
    const outcome = await beforeToolCall({ toolName: 'agent', toolCallId: 'call_mod_1', input: { prompt: '分析当前项目' } })
    // 过去这里返回 undefined，CLI 会悄悄改用内建子代理；必须改为 block 让失败可见。
    assert.equal(outcome?.block, true)
    const context = String(outcome?.additionalContext ?? '')
    assert.match(context, /子代理托管派发失败/u)
    assert.match(context, /没有回退到 Command Code 内建子代理/u)
    // 非 agent 工具与空提示词仍然不接管，保持 CLI 原生行为。
    assert.equal(await beforeToolCall({ toolName: 'bash', toolCallId: 'call_mod_2', input: { command: 'ls' } }), undefined)
    assert.equal(await beforeToolCall({ toolName: 'agent', toolCallId: 'call_mod_3', input: { prompt: '   ' } }), undefined)
  } finally {
    process.env = previous
  }
})

test('Command Code 托管 mod：未注入桥接配置时不注册任何 hook', async () => {
  const mod = await import('../data/build/dist/host/cli-bridge/command-code-mod.js')
  const hooks: Array<Record<string, unknown>> = []
  const previous = { ...process.env }
  delete process.env.CODINGNS_BRIDGE_URL
  delete process.env.CODINGNS_BRIDGE_TOKEN
  delete process.env.CODINGNS_DSH_SESSION_ID
  try {
    ;(mod.default as (api: unknown) => void)({ hooks: (value: Record<string, unknown>) => { hooks.push(value) } })
    // 托管关闭时驱动不注入配置：内建子代理必须照常工作。
    assert.equal(hooks.length, 0)
  } finally {
    process.env = previous
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

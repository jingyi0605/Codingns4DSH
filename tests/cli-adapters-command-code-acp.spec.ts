import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CommandCodeDriver } from '../data/build/dist/host/cli-adapters/command-code-driver.js'
import { CommandCodeUsageTail } from '../data/build/dist/host/cli-adapters/command-code-history.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'
import { load as loadCommandCodeAcpLoader } from '../data/build/dist/host/cli-adapters/command-code-acp-loader.js'
import { readCommandCodeApiKey } from '../data/build/dist/host/cli-adapters/command-code-subscription.js'
import { createSubagentBridgeRuntime, setSubagentBridge } from '../data/build/dist/host/cli-bridge/bridge-holder.js'

test('Command Code ACP initializes the managed Mod before loading its host', async () => {
  const source = 'let paths=[];function setModPathsOverride(value){paths=value}async function loadCommandModHost(){return paths}async function runAcp(){return await loadCommandModHost()}export{runAcp}'
  const loaded = await loadCommandCodeAcpLoader('file:///tmp/node_modules/command-code/dist/cli.mjs',
    { format: 'module' }, async () => ({ format: 'module', source }))
  const module = await import(`data:text/javascript;base64,${Buffer.from(String(loaded.source)).toString('base64')}`)
  const previous = process.env.CODINGNS_DISABLE_NATIVE_AGENT
  try {
    process.env.CODINGNS_DISABLE_NATIVE_AGENT = '1'
    const paths = await module.runAcp()
    assert.equal(paths.length, 1)
    assert.ok(paths[0].endsWith('/cli-bridge/command-code-mod.js'))
  } finally {
    if (previous === undefined) delete process.env.CODINGNS_DISABLE_NATIVE_AGENT
    else process.env.CODINGNS_DISABLE_NATIVE_AGENT = previous
  }
})

test('Command Code ACP Mod initialization preserves standalone and unknown upstream entrypoints', async () => {
  const source = 'function setModPathsOverride(){throw new Error("Must not run")}async function runAcp(){return "standalone"}export{runAcp}'
  const loaded = await loadCommandCodeAcpLoader('file:///tmp/node_modules/command-code/dist/cli.mjs',
    { format: 'module' }, async () => ({ format: 'module', source }))
  const previous = process.env.CODINGNS_DISABLE_NATIVE_AGENT
  delete process.env.CODINGNS_DISABLE_NATIVE_AGENT
  try {
    const module = await import(`data:text/javascript;base64,${Buffer.from(String(loaded.source)).toString('base64')}`)
    assert.equal(await module.runAcp(), 'standalone')
    const unknown = 'async function startAcp(){return 1}'
    const unknownLoaded = await loadCommandCodeAcpLoader('file:///tmp/node_modules/command-code/dist/cli.mjs',
      { format: 'module' }, async () => ({ format: 'module', source: unknown }))
    assert.ok(String(unknownLoaded.source).includes(unknown))
    assert.ok(String(unknownLoaded.source).includes('__codingNsMagpieSession'))
  } finally { if (previous !== undefined) process.env.CODINGNS_DISABLE_NATIVE_AGENT = previous }
})

test('Command Code ACP attaches its session ID to loopback Magpie model requests across minified versions', async () => {
  // 1.86.3 and 1.87.1 use different minified names for the same header; the
  // structural patch must not depend on either of them.
  const versions = [
    { header: 'NT', hostSet: 'FT' },
    { header: 'FT', hostSet: '_T' },
  ]
  for (const { header, hostSet } of versions) {
    const source = [
      `const ${header}="x-opencode-session",${hostSet}=new Set(["opencode.ai"]);`,
      `function isSessionRoutedHost(e){try{return ${hostSet}.has(new URL(e).hostname)}catch{return false}}`,
      `function sessionRoutingHeaders(e){return e.threadId&&isSessionRoutedHost(e.baseURL)?Object.keys(e.headers??{}).some(e=>e.toLowerCase()===${header})?{}:{[${header}]:e.threadId}:{}}`,
      'export{sessionRoutingHeaders}',
    ].join('')
    const loaded = await loadCommandCodeAcpLoader('file:///tmp/node_modules/command-code/dist/cli.mjs',
      { format: 'module' }, async () => ({ format: 'module', source }))
    const module = await import(`data:text/javascript;base64,${Buffer.from(String(loaded.source)).toString('base64')}`)
    assert.deepEqual(module.sessionRoutingHeaders({ baseURL: 'http://127.0.0.1:3425/v1', headers: {}, threadId: 'command-session' }), {
      'x-magpie-session': 'command-session',
    })
    assert.deepEqual(module.sessionRoutingHeaders({ baseURL: 'http://127.0.0.1:3425/v1', headers: {}, threadId: undefined }), {})
    assert.deepEqual(module.sessionRoutingHeaders({ baseURL: 'https://opencode.ai/v1', headers: {}, threadId: 'open-code-session' }), {
      'x-opencode-session': 'open-code-session',
    })
    assert.deepEqual(module.sessionRoutingHeaders({ baseURL: 'http://127.0.0.1:3425/v1', headers: { 'X-Magpie-Session': 'configured' }, threadId: 'command-session' }), {})
  }
})

test('Command Code ACP structural fallback uses the Host session ID when present', async () => {
  // The fetch prefix is the primary path, but the structural wrapper must agree
  // with it: both must use the Host-injected DSH session ID, not the ACP ID.
  const source = [
    'const FT="x-opencode-session",_T=new Set(["opencode.ai"]);',
    'function isSessionRoutedHost(e){try{return _T.has(new URL(e).hostname)}catch{return false}}',
    'function sessionRoutingHeaders(e){return e.threadId&&isSessionRoutedHost(e.baseURL)?Object.keys(e.headers??{}).some(e=>e.toLowerCase()===FT)?{}:{[FT]:e.threadId}:{}}',
    'export{sessionRoutingHeaders}',
  ].join('')
  const previous = process.env.CODINGNS_MAGPIE_SESSION
  try {
    process.env.CODINGNS_MAGPIE_SESSION = 'dsh-session'
    const loaded = await loadCommandCodeAcpLoader('file:///tmp/node_modules/command-code/dist/cli.mjs',
      { format: 'module' }, async () => ({ format: 'module', source }))
    const module = await import(`data:text/javascript;base64,${Buffer.from(String(loaded.source)).toString('base64')}`)
    assert.deepEqual(module.sessionRoutingHeaders({ baseURL: 'http://127.0.0.1:3425/v1', headers: {}, threadId: 'acp-session' }), {
      'x-magpie-session': 'dsh-session',
    })
  } finally {
    if (previous === undefined) delete process.env.CODINGNS_MAGPIE_SESSION
    else process.env.CODINGNS_MAGPIE_SESSION = previous
  }
})

test('Command Code ACP tags Magpie requests through a version-independent fetch wrapper', async () => {
  const originalFetch = globalThis.fetch
  const previous = process.env.CODINGNS_MAGPIE_SESSION
  const calls: Array<{ readonly url: string; readonly magpie: string | null }> = []
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    calls.push({ url: input instanceof Request ? input.url : String(input), magpie: headers.get('x-magpie-session') })
    return Response.json({ ok: true })
  }) as typeof fetch
  try {
    process.env.CODINGNS_MAGPIE_SESSION = 'dsh-session-1'
    const source = 'export async function call(url, init){return fetch(url, init)}'
    const loaded = await loadCommandCodeAcpLoader('file:///tmp/node_modules/command-code/dist/cli.mjs',
      { format: 'module' }, async () => ({ format: 'module', source }))
    const module = await import(`data:text/javascript;base64,${Buffer.from(String(loaded.source)).toString('base64')}`)
    await module.call('http://127.0.0.1:3425/v1/chat/completions', { method: 'POST' })
    await module.call('https://api.example.test/v1/chat/completions')
    await module.call('http://127.0.0.1:3425/v1/chat/completions', { headers: { 'X-Magpie-Session': 'existing' } })
    await module.call(new Request('http://127.0.0.1:3425/v1/chat/completions', { method: 'POST' }))
  } finally {
    if (previous === undefined) delete process.env.CODINGNS_MAGPIE_SESSION
    else process.env.CODINGNS_MAGPIE_SESSION = previous
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(calls, [
    { url: 'http://127.0.0.1:3425/v1/chat/completions', magpie: 'dsh-session-1' },
    { url: 'https://api.example.test/v1/chat/completions', magpie: null },
    { url: 'http://127.0.0.1:3425/v1/chat/completions', magpie: 'existing' },
    { url: 'http://127.0.0.1:3425/v1/chat/completions', magpie: 'dsh-session-1' },
  ])
})

test('Command Code ACP 将问题和 DSH 权限映射回传给 Provider', async () => {
  let promptId = 0
  const replies = new Map<number | string, Record<string, unknown>>()
  const calls: string[][] = []
  const sessionRequests: Array<{ method: string; params?: unknown }> = []
  const probeEnvironments: Array<Record<string, string | undefined> | undefined> = []
  let spawnEnvironment: Record<string, string | undefined> | undefined
  const driver = new CommandCodeDriver({
    enableAcp: true,
    binaries: ['fake-command-code'],
    spawnSync: ((command: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
      probeEnvironments.push(options?.env)
      return args[0] === '--version'
        ? { status: 0, stdout: 'command-code 1.2.3', stderr: '' }
        : { status: 0, stdout: '', stderr: '' }
    }) as never,
    spawn: ((command: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
      calls.push([command, ...args])
      spawnEnvironment = options?.env
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as { id?: number | string; method?: string; params?: unknown }
        if (request.method !== undefined) sessionRequests.push({ method: request.method, params: request.params })
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'command-code-acp-session' } })}\n`)
        else if (['session/set_model', 'session/set_mode', 'session/set_config_option'].includes(request.method ?? '')) stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'session/prompt') {
          promptId = request.id ?? 0
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'session/request_permission', params: {
            options: [{ optionId: 'option_0', kind: 'allow_once' }, { optionId: 'option_1', kind: 'reject_once' }],
            toolCall: { kind: 'other', rawInput: { question: '选择策略', options: ['安全', '快速'] }, toolCallId: 'question-1' },
          } })}\n`)
        } else if (request.id === 91) {
          replies.set(91, request as unknown as Record<string, unknown>)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 92, method: 'session/request_permission', params: {
            options: [{ optionId: 'option_0', kind: 'allow_once' }],
            toolCall: { kind: 'other', rawInput: { question: '补充说明', options: ['默认'] }, toolCallId: 'question-2' },
          } })}\n`)
        } else if (request.id === 92) {
          replies.set(92, request as unknown as Record<string, unknown>)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } })}\n`)
        }
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({
    sessionId: 'command-code-acp-dsh',
    messages: [],
    prompt: '执行',
    modelId: 'z-ai/glm-5.3-flash',
    effortId: 'high',
    permission: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
  })) {
    chunks.push(chunk)
    if (chunk.type === 'question-request') driver.respondQuestion('command-code-acp-dsh', chunk.questions[0]!.question === '选择策略'
      ? { requestId: chunk.requestId, answers: [{ id: chunk.questions[0]!.id, selected: ['快速'] }] }
      : { requestId: chunk.requestId, answers: [{ id: chunk.questions[0]!.id, selected: [], custom: '用户自由文本' }] })
  }
  assert.equal(driver.descriptor.capabilities.includes('permission'), true)
  assert.equal(driver.descriptor.capabilities.includes('questions'), true)
  assert.equal(calls[0]?.[1], '--mod')
  assert.ok(calls[0]?.[2]?.endsWith('command-code-mod.js'))
  assert.deepEqual(calls[0]?.slice(3), ['acp', '--permission-mode', 'accept-edits', '--model', 'z-ai/glm-5.3-flash', '--effort', 'high'])
  assert.deepEqual(sessionRequests.filter((request) => request.method.startsWith('session/')).map(({ method, params }) => ({ method, params })), [
    { method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } },
    { method: 'session/set_model', params: { sessionId: 'command-code-acp-session', modelId: 'z-ai/glm-5.3-flash' } },
    { method: 'session/set_mode', params: { sessionId: 'command-code-acp-session', modeId: 'auto-accept' } },
    { method: 'session/set_config_option', params: { sessionId: 'command-code-acp-session', configId: 'effort', value: 'high' } },
    { method: 'session/prompt', params: { sessionId: 'command-code-acp-session', prompt: [{ type: 'text', text: '执行' }] } },
  ])
  assert.equal(probeEnvironments.length > 0, true)
  for (const environment of probeEnvironments) assert.equal(environment?.NODE_OPTIONS, process.env.NODE_OPTIONS)
  assert.match(spawnEnvironment?.NODE_OPTIONS ?? '', /command-code-acp-loader\.js/u)
  assert.equal(spawnEnvironment?.CODINGNS_DISABLE_NATIVE_AGENT, '1')
  assert.equal(spawnEnvironment?.CODINGNS_MAGPIE_SESSION, 'command-code-acp-dsh')
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'command-code-acp-session' },
    { type: 'question-request', requestId: '91', questions: [{ id: 'command-code-question-91', question: '选择策略', options: [{ label: '安全' }, { label: '快速' }] }] },
    { type: 'question-request', requestId: '92', questions: [{ id: 'command-code-question-92', question: '补充说明', options: [{ label: '默认' }] }] },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(replies.get(91), { jsonrpc: '2.0', id: 91, result: { outcome: { outcome: 'selected', optionId: 'option_1' } } })
  assert.deepEqual(replies.get(92), {
    jsonrpc: '2.0',
    id: 92,
    result: {
      outcome: { outcome: 'selected', optionId: '__codingns_custom__' },
      answers: [{ questionIndex: 0, selectedOptions: ['用户自由文本'] }],
      _meta: { 'codingns/questionAnswer': '用户自由文本' },
    },
  })
  driver.dispose()
})

for (const toolName of ['agent_subagent', 'web_search', 'mcp__codingns__web_search', 'web_fetch', 'mcp__codingns__web_fetch'] as const) {
  test(`Command Code ACP 自动批准 DSH ${toolName}，不弹出重复权限请求`, async () => {
    setSubagentBridge(createSubagentBridgeRuntime({ baseUrl: 'http://127.0.0.1:45999', token: 'agent-tool-token' }))
    const replies = new Map<number | string, Record<string, unknown>>()
    let promptId: number | string = 0
    const driver = new CommandCodeDriver({
      enableAcp: true,
      binaries: ['fake-command-code'],
      spawnSync: (() => ({ status: 0, stdout: 'command-code 1.2.3', stderr: '' })) as never,
      spawn: (() => {
        const stdout = new PassThrough(); const stderr = new PassThrough()
        const stdin = { write(data: string): boolean {
          const request = JSON.parse(data) as { id?: number | string; method?: string }
          if (request.method === 'initialize' || request.method === 'session/new' || request.method === 'session/set_mode') {
            const result = request.method === 'session/new' ? { sessionId: 'command-code-agent-session' } : {}
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
          } else if (request.method === 'session/prompt') {
            promptId = request.id ?? 0
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'session/request_permission', params: {
              options: [{ optionId: 'allow-agent', kind: 'allow_once' }, { optionId: 'reject-agent', kind: 'reject_once' }],
              toolCall: { kind: 'other', title: toolName, toolCallId: 'agent-1', rawInput: toolName.includes('search') ? { queries: ['公开资料'] } : toolName.includes('fetch') ? { url: 'https://example.com/' } : { action: 'start' } },
            } })}\n`)
          } else if (request.id === 101) {
            replies.set(101, request as unknown as Record<string, unknown>)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'session/update', params: {
              update: { sessionUpdate: 'agent_message_chunk', delta: '已完成委派' },
            } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } })}\n`)
          }
          return true
        } }
        return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
      }) as never,
    })
    try {
      const chunks = []
      for await (const chunk of driver.executeTurn({
        sessionId: 'command-code-agent-parent', messages: [], prompt: '创建子智能体',
        permission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
      })) chunks.push(chunk)
      assert.deepEqual(replies.get(101), { jsonrpc: '2.0', id: 101, result: { outcome: { outcome: 'selected', optionId: 'allow-agent' } } })
      assert.equal(chunks.some((chunk) => chunk.type === 'permission-request'), false)
    } finally {
      driver.dispose()
      setSubagentBridge(undefined)
    }
  })
}

test('Command Code ACP 将 usage_update 与 prompt 响应中的 token 用量投影出来', async () => {
  const driver = new CommandCodeDriver({
    enableAcp: true,
    binaries: ['fake-command-code'],
    spawnSync: (() => ({ status: 0, stdout: 'command-code 1.2.3', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as { id?: number | string; method?: string }
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        } else if (request.method === 'session/new') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'command-code-usage-session' } })}\n`)
        } else if (request.method === 'session/prompt') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'command-code-usage-session',
            update: { sessionUpdate: 'usage_update', used: 980000, size: 1000000 },
          } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
            stopReason: 'end_turn',
            _meta: { usage: { inputTokens: 982000, outputTokens: 2048, cacheReadTokens: 980000, cacheWriteTokens: 0 } },
          } })}\n`)
        } else {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        }
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  try {
    const chunks = []
    for await (const chunk of driver.executeTurn({
      sessionId: 'command-code-usage-dsh',
      messages: [],
      prompt: '执行',
      modelId: 'deepseek/deepseek-v4.1',
      effortId: 'high',
    })) chunks.push(chunk)
    const usage = chunks.findLast((chunk) => chunk.type === 'usage')
    assert.equal(usage?.contextWindow, 1_000_000)
    assert.equal(usage?.contextTokens, 980_000)
    assert.equal(usage?.contextUsageRatio, 0.98)
    assert.equal(usage?.inputTokens, 982_000)
    assert.equal(usage?.uncachedInputTokens, 2_000)
    assert.equal(usage?.outputTokens, 2_048)
    assert.equal(chunks.at(-1)?.type, 'finish')
  } finally {
    driver.dispose()
  }
})

test('Command Code ACP 启动时注入桥接 mod、桥接环境和 DSH MCP', async () => {
  const runtime = createSubagentBridgeRuntime({ baseUrl: 'http://127.0.0.1:45999', token: 'acp-bridge-token' })
  setSubagentBridge(runtime)
  let spawnArgs: string[] | undefined
  let spawnEnvironment: Record<string, string | undefined> | undefined
  let sessionNewParams: Record<string, unknown> | undefined
  const driver = new CommandCodeDriver({
    enableAcp: true,
    binaries: ['fake-command-code'],
    spawnSync: (() => ({ status: 0, stdout: 'command-code 1.79.2', stderr: '' })) as never,
    spawn: ((command: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
      spawnArgs = [command, ...args]
      spawnEnvironment = options?.env
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as { id?: number | string; method?: string; params?: Record<string, unknown> }
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'session/new') {
          sessionNewParams = request.params
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'command-code-bridge-session' } })}\n`)
        } else if (request.method === 'session/set_mode') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        } else if (request.method === 'session/prompt') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
        }
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  try {
    for await (const _ of driver.executeTurn({ sessionId: 'command-code-bridge-parent', messages: [], prompt: '执行' })) { /* 读完启动闭环。 */ }
    assert.equal(spawnArgs?.[1], '--mod')
    assert.ok(spawnArgs?.[2]?.endsWith('command-code-mod.js'))
    assert.equal(spawnArgs?.[3], 'acp')
    assert.equal(spawnEnvironment?.CODINGNS_SUBAGENT_BRIDGE, '1')
    assert.equal(spawnEnvironment?.CODINGNS_DSH_SESSION_ID, 'command-code-bridge-parent')
    const servers = sessionNewParams?.mcpServers as Array<Record<string, unknown>>
    assert.equal(servers.length, 1)
    assert.equal(servers[0]?.name, 'codingns')
    const serverEnv = servers[0]?.env as Array<{ name: string; value: string }>
    assert.deepEqual(serverEnv.find(({ name }) => name === 'CODINGNS_BRIDGE_TOKEN'), { name: 'CODINGNS_BRIDGE_TOKEN', value: 'acp-bridge-token' })
  } finally {
    driver.dispose()
    setSubagentBridge(undefined)
  }
})

/** 只模拟 stdio 对端；故意返回旧模型，验证驱动必须在恢复后主动设置模型。 */
function createSessionFixture(failedMethod?: string) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const driver = new CommandCodeDriver({
    enableAcp: true,
    binaries: ['fake-command-code'],
    spawnSync: (() => ({ status: 0, stdout: '1.74.3', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string) {
        const request = JSON.parse(data)
        if (request.method === 'initialized') return true
        requests.push({ method: request.method, params: request.params })
        const result = request.method === 'session/load' || request.method === 'session/new'
          ? { sessionId: 'resumed', models: { currentModelId: 'old-model' }, modes: { currentModeId: 'bypass' } }
          : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
        const response = request.method === failedMethod
          ? { error: { code: -32602, message: 'Cannot apply requested session setting' } } : { result }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response })}\n`)
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  return { driver, requests }
}

test('Command Code ACP 恢复后先应用模型及各权限模式，再发送 prompt', async () => {
  const cases = [
    { permission: { sandboxMode: 'read-only', approvalPolicy: 'never' }, expectedMode: 'plan' },
    { permission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' }, expectedMode: 'auto-accept' },
    { permission: { sandboxMode: 'workspace-write', approvalPolicy: 'never' }, expectedMode: 'auto-accept' },
    { permission: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }, expectedMode: 'bypass' },
    { permission: { sandboxMode: 'danger-full-access', approvalPolicy: 'on-request' }, expectedMode: 'default' },
    { plan: true, permission: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }, expectedMode: 'plan' },
    { expectedMode: 'default' },
  ] as const
  for (const value of cases) {
    const { driver, requests } = createSessionFixture()
    try {
      for await (const _ of driver.executeTurn({ sessionId: 'dsh', providerSessionId: 'resumed', messages: [], prompt: '执行', modelId: 'deepseek/deepseek-v4.1-flash', ...value })) { /* 读完这一轮。 */ }
      assert.deepEqual(requests.map(({ method }) => method), ['initialize', 'session/load', 'session/set_model', 'session/set_mode', 'session/prompt'])
      assert.equal(requests[2]?.params.modelId, 'deepseek/deepseek-v4.1-flash')
      assert.equal(requests[3]?.params.modeId, value.expectedMode)
    } finally { driver.dispose() }
  }
})

test('Command Code ACP 模型、权限或思考强度设置失败时禁止继续对话', async () => {
  for (const method of ['session/set_model', 'session/set_mode', 'session/set_config_option']) {
    const { driver, requests } = createSessionFixture(method)
    try {
      await assert.rejects(async () => {
        for await (const _ of driver.executeTurn({ sessionId: 'dsh', messages: [], prompt: '执行', modelId: 'selected-model', effortId: 'high' })) { /* 设置失败必须中止。 */ }
      }, /Cannot apply requested session setting/u)
      assert.equal(requests.some(({ method }) => method === 'session/prompt'), false)
    } finally { driver.dispose() }
  }
})

test('Command Code 订阅凭据与 CLI 一致：原生环境变量优先于 auth.json', () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'command-code-auth-'))
  try {
    assert.equal(readCommandCodeApiKey(homeDirectory, { COMMAND_CODE_API_KEY: ' env-key ' }), 'env-key')
    writeFileSync(join(homeDirectory, 'auth.json'), JSON.stringify({ apiKey: 'file-key' }))
    assert.equal(readCommandCodeApiKey(homeDirectory, { COMMAND_CODE_API_KEY: 'env-key' }), 'env-key')
    assert.equal(readCommandCodeApiKey(homeDirectory, { COMMANDCODE_API_KEY: 'unsupported-key' }), 'file-key')
    assert.equal(readCommandCodeApiKey(homeDirectory, {}), 'file-key')
    writeFileSync(join(homeDirectory, 'auth.json'), 'invalid json')
    assert.equal(readCommandCodeApiKey(homeDirectory, {}), null)
  } finally { rmSync(homeDirectory, { recursive: true, force: true }) }
})

test('Command Code ACP 自由文本桥保留 async 语法并实际还原问题答案', async () => {
  // 夹具保留上游真实的 async/await 形状，导入并执行改写结果，避免只查字符串漏掉语法错误。
  const source = 'async function requestQuestion(e,t){const r=await askClient(e,t);if("cancelled"===r)return null;const s=Number(/^option_(\\d+)$/.exec(r.optionId)?.[1]);return t.options[s]?.label??null}async function askClient(e,t){const o=t.result?.outcome;return o&&"cancelled"!==o.outcome?{optionId:o.optionId}:"cancelled"}export{requestQuestion}'
  const loaded = await loadCommandCodeAcpLoader(
    'file:///tmp/node_modules/command-code/dist/cli.mjs',
    { format: 'module' },
    async () => ({ format: 'module', source }),
  )
  assert.equal(typeof loaded.source, 'string')
  assert.match(String(loaded.source), /codingNsQuestionAnswer/u)
  assert.match(String(loaded.source), /answers:t\.result\?\.answers/u)
  const patchedModule = await import(`data:text/javascript;base64,${Buffer.from(String(loaded.source)).toString('base64')}`)
  const custom = '第一行\n第二行：中文、"引号"与 emoji 🚀'
  const options = [{ label: '安全' }, { label: '快速' }]
  assert.equal(await patchedModule.requestQuestion({}, { options, result: {
    outcome: { outcome: 'selected', optionId: '__codingns_custom__' },
    _meta: { 'codingns/questionAnswer': custom },
  } }), custom)
  assert.equal(await patchedModule.requestQuestion({}, { options, result: {
    outcome: { outcome: 'selected', optionId: 'option_1' },
  } }), '快速')
  assert.equal(await patchedModule.requestQuestion({}, { options, result: {
    outcome: { outcome: 'cancelled' },
  } }), null)

  const unrelated = 'export const value = 1'
  const untouched = await loadCommandCodeAcpLoader(
    'file:///tmp/other.mjs',
    { format: 'module' },
    async () => ({ format: 'module', source: unrelated }),
  )
  assert.equal(untouched.source, unrelated)
  const unsupported = await loadCommandCodeAcpLoader(
    'file:///tmp/node_modules/command-code/dist/cli.mjs',
    { format: 'module' },
    async () => ({ format: 'module', source: unrelated }),
  )
  assert.ok(String(unsupported.source).includes(unrelated))
  assert.ok(String(unsupported.source).includes('__codingNsMagpieSession'))
})

test('Command Code ACP 把 providers.json 声明的 BYOK 模型并入模型目录', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'command-code-byok-catalog-'))
  const previousHome = process.env.HOME
  try {
    const providersPath = join(homeDirectory, '.commandcode', 'providers.json')
    mkdirSync(dirname(providersPath), { recursive: true })
    writeFileSync(providersPath, JSON.stringify({
      provider: {
        mcgrox: { name: 'McGrox', baseURL: 'https://www.mcgrox.top/v1', models: { 'deepseek-v4.1-flash': { contextWindow: 400000 } } },
        // 与内置目录同名的 BYOK 条目必须去重，否则同一个模型会出现在目录里两次。
        deepseek: { name: '重复内置', models: { 'deepseek-v4.1-flash': {} } },
      },
    }))
    const source = 'const RL={"deepseek/deepseek-v4.1-flash":{id:"deepseek/deepseek-v4.1-flash",name:"V4.1"}};'
      + 'function catalogModels(){return Object.values(RL).filter(e=>!e.hidden).map(e=>({id:e.id,name:e.name,description:e.description||null}))}'
      + 'export{catalogModels}'
    const loaded = await loadCommandCodeAcpLoader(
      'file:///tmp/node_modules/command-code/dist/cli.mjs',
      { format: 'module' },
      async () => ({ format: 'module', source }),
    )
    const patched = String(loaded.source)
    assert.match(patched, /codingNsByokModels/u)
    // loader 在 CLI 进程内读取 HOME 下的 providers.json，测试用临时 HOME 复现。
    process.env.HOME = homeDirectory
    const patchedModule = await import(`data:text/javascript;base64,${Buffer.from(patched).toString('base64')}`)
    const catalogIds = (): string[] => patchedModule.catalogModels().map((model: { id: string }) => model.id)
    assert.deepEqual(catalogIds(), ['deepseek/deepseek-v4.1-flash', 'mcgrox/deepseek-v4.1-flash'])
    assert.equal(patchedModule.catalogModels().at(-1).description, 'McGrox')
    // 配置损坏或缺失时目录退回内置模型，既不抛错也不阻塞 ACP 会话。
    writeFileSync(providersPath, 'not json')
    assert.deepEqual(catalogIds(), ['deepseek/deepseek-v4.1-flash'])
    rmSync(providersPath, { force: true })
    assert.deepEqual(catalogIds(), ['deepseek/deepseek-v4.1-flash'])
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(homeDirectory, { recursive: true, force: true })
  }
})

test('Command Code ACP 兼容 1.84.0 的 QD 目录并优先复用原生 BYOK 模型列表', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'command-code-native-byok-catalog-'))
  const previousHome = process.env.HOME
  try {
    process.env.HOME = homeDirectory
    // QD is the minified catalog variable used by Command Code 1.84.0; the
    // native helper shape is copied from the published bundle.
    const source = 'const QD={"deepseek/deepseek-v4.1-flash":{id:"deepseek/deepseek-v4.1-flash",name:"V4.1"}};'
      + 'function getCustomProviderModelsSync(){return[{id:"magpie",name:"Magpie",models:[{id:"auto/deepseek-v4.1-flash",name:"DeepSeek V4.1 Flash"}]}]}'
      + 'function customModelListOptions(){return getCustomProviderModelsSync().flatMap(e=>e.models.map(n=>({id:`${e.id}/${n.id}`,description:n.name})))}'
      + 'function catalogModels(){return Object.values(QD).filter(e=>!e.hidden).map(e=>({id:e.id,name:e.name,description:e.description||null}))}'
      + 'export{catalogModels}'
    const loaded = await loadCommandCodeAcpLoader(
      'file:///tmp/node_modules/command-code/dist/cli.mjs',
      { format: 'module' },
      async () => ({ format: 'module', source }),
    )
    const patched = String(loaded.source)
    assert.match(patched, /codingNsBuiltinCatalogModels/u)
    const patchedModule = await import(`data:text/javascript;base64,${Buffer.from(patched).toString('base64')}`)
    assert.deepEqual(
      patchedModule.catalogModels().map((model: { id: string }) => model.id),
      ['deepseek/deepseek-v4.1-flash', 'magpie/auto/deepseek-v4.1-flash'],
    )
    assert.equal(patchedModule.catalogModels().at(-1).description, 'DeepSeek V4.1 Flash')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(homeDirectory, { recursive: true, force: true })
  }
})

/** 按 CLI 的落盘节奏把 assistant 用量记录追加进 canonical transcript。 */
function createCommandCodeUsageFixture(homeDirectory: string, sessionId: string) {
  const transcriptPath = join(homeDirectory, 'projects', 'tmp-command-code-acp-workspace', `${sessionId}.jsonl`)
  mkdirSync(dirname(transcriptPath), { recursive: true })
  return {
    transcriptPath,
    appendRaw(text: string): void {
      appendFileSync(transcriptPath, text, 'utf8')
    },
    append(requestId: string, inputTokens: number, outputTokens: number, cacheReadTokens: number): void {
      appendFileSync(transcriptPath, `${JSON.stringify({
        type: 'message',
        id: requestId,
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: requestId }] },
        usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0 },
      })}\n`, 'utf8')
    },
  }
}

/** 一次 ACP 回合里连续跑多次模型请求；用量落盘由调用方按请求节奏驱动。 */
interface CommandCodeStepUsageScenario {
  /** 前多少次请求各自跟随一个工具调用；其余请求是收尾请求。 */
  readonly toolCallCount: number
  readonly usageUpdate: { readonly used: number; readonly size: number }
  readonly responseUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number }
}

/** 模拟在 CLI 内部连续跑多次模型请求的 ACP 回合。 */
function createCommandCodeStepUsageDriver(homeDirectory: string, sessionId: string, scenario: CommandCodeStepUsageScenario) {
  return new CommandCodeDriver({
    enableAcp: true,
    homeDirectory,
    binaries: ['fake-command-code'],
    spawnSync: (() => ({ status: 0, stdout: 'command-code 1.79.2', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as { id?: number | string; method?: string }
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        } else if (request.method === 'session/new') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId } })}\n`)
        } else if (request.method === 'session/prompt') {
          for (let index = 0; index < scenario.toolCallCount; index += 1) {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId,
              update: { sessionUpdate: 'tool_call', toolCallId: `call-${index + 1}`, title: 'shell', kind: 'execute', status: 'pending', rawInput: { command: 'pwd' } },
            } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId,
              update: { sessionUpdate: 'tool_call_update', toolCallId: `call-${index + 1}`, status: 'completed' },
            } })}\n`)
          }
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId,
            update: { sessionUpdate: 'usage_update', used: scenario.usageUpdate.used, size: scenario.usageUpdate.size },
          } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
            stopReason: 'end_turn',
            _meta: { usage: { ...scenario.responseUsage, cacheWriteTokens: 0 } },
          } })}\n`)
        } else {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        }
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
}

test('Command Code ACP 按模型请求增量投影用量，整轮累计不再冒充上下文占用', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'command-code-step-usage-'))
  const workspacePath = '/tmp/command-code-acp-workspace'
  const sessionId = 'command-code-step-usage-session'
  const fixture = createCommandCodeUsageFixture(homeDirectory, sessionId)
  const rows: ReadonlyArray<readonly [number, number, number]> = [
    [120_000, 20, 100_000],
    [150_000, 30, 140_000],
    [260_000, 40, 250_000],
  ]
  const driver = createCommandCodeStepUsageDriver(homeDirectory, sessionId, {
    toolCallCount: rows.length,
    usageUpdate: { used: 260_100, size: 1_000_000 },
    responseUsage: { inputTokens: 530_000, outputTokens: 90, cacheReadTokens: 490_000 },
  })
  try {
    const chunks: Array<Record<string, any>> = []
    for await (const chunk of driver.executeTurn({
      sessionId: 'command-code-step-usage-dsh',
      messages: [],
      prompt: '连续执行三步',
      cwd: workspacePath,
      modelId: 'deepseek/deepseek-v4.1-flash',
      splitToolSteps: true,
    })) {
      chunks.push(chunk as Record<string, any>)
      // CLI 在模型请求结束时落盘：工具开始即代表该请求已经写完，下一条工具完成
      // 通知到达时驱动才会读到这份增量。
      if (chunk.type === 'tool-event' && chunk.status === 'started') {
        const index = Number(/(\d+)$/u.exec(chunk.callId ?? '')?.[1] ?? 0) - 1
        const row = rows[index]
        if (row !== undefined) fixture.append(`request-${index + 1}`, row[0], row[1], row[2])
      }
    }
    const usages = chunks.filter((chunk) => chunk.type === 'usage')
    // 每次模型请求各投影一份增量样本；整轮累计（530000）绝不出现在样本里。
    assert.deepEqual(usages.map((usage) => [usage.inputTokens, usage.uncachedInputTokens, usage.cacheReadTokens, usage.outputTokens]), [
      [120_000, 20_000, 100_000, 20],
      [150_000, 10_000, 140_000, 30],
      [260_000, 10_000, 250_000, 40],
    ])
    assert.equal(usages.some((usage) => usage.inputTokens === 530_000), false)
    // 每个样本都带容量；最后一次请求的提示规模就是当前上下文占用（26% 而不是 100%）。
    assert.deepEqual(usages.map((usage) => usage.contextWindow), [1_000_000, 1_000_000, 1_000_000])
    assert.equal(usages[2]?.contextTokens, 260_000)
    assert.equal(usages[2]?.contextUsageRatio, 0.26)
    assert.equal(chunks.at(-1)?.type, 'finish')
    // ACP 回合交给 Registry 按工具边界挂起同一个迭代器分步；驱动自己不再声称分段。
    assert.equal(driver.supportsSegmentedTurns, false)
    assert.equal(driver.supportsToolStepSplitting, true)
  } finally {
    driver.dispose()
    rmSync(homeDirectory, { recursive: true, force: true })
  }
})

test('Command Code ACP 收尾请求在响应后结算并带上 Provider 上下文占用', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'command-code-step-final-'))
  const workspacePath = '/tmp/command-code-acp-workspace'
  const sessionId = 'command-code-step-final-session'
  const fixture = createCommandCodeUsageFixture(homeDirectory, sessionId)
  const rows: ReadonlyArray<readonly [number, number, number]> = [
    [120_000, 20, 100_000],
    [300_000, 50, 290_000],
  ]
  const driver = createCommandCodeStepUsageDriver(homeDirectory, sessionId, {
    toolCallCount: 1,
    usageUpdate: { used: 300_200, size: 1_000_000 },
    responseUsage: { inputTokens: 420_000, outputTokens: 70, cacheReadTokens: 390_000 },
  })
  try {
    const chunks: Array<Record<string, any>> = []
    for await (const chunk of driver.executeTurn({
      sessionId: 'command-code-step-final-dsh',
      messages: [],
      prompt: '执行后收尾',
      cwd: workspacePath,
      modelId: 'deepseek/deepseek-v4.1-flash',
      splitToolSteps: true,
    })) {
      chunks.push(chunk as Record<string, any>)
      if (chunk.type === 'tool-event' && chunk.status === 'started') {
        const row = rows[0]
        if (row !== undefined) fixture.append('request-1', row[0], row[1], row[2])
      }
      // 收尾请求没有工具事件：它在响应到达前落盘，由驱动的最终结算读走。
      if (chunk.type === 'tool-event' && chunk.status === 'completed') {
        const row = rows[1]
        if (row !== undefined) fixture.append('request-2', row[0], row[1], row[2])
      }
    }
    const usages = chunks.filter((chunk) => chunk.type === 'usage')
    assert.deepEqual(usages.map((usage) => [usage.inputTokens, usage.uncachedInputTokens, usage.cacheReadTokens, usage.outputTokens]), [
      [120_000, 20_000, 100_000, 20],
      [300_000, 10_000, 290_000, 50],
    ])
    // 收尾样本合并 usage_update：ContextMeter 显示 Provider 上报的真实占用。
    assert.equal(usages[1]?.contextTokens, 300_200)
    assert.equal(usages[1]?.contextWindow, 1_000_000)
    assert.equal(usages[1]?.contextUsageRatio, 0.3002)
    assert.equal(chunks.at(-1)?.type, 'finish')
  } finally {
    driver.dispose()
    rmSync(homeDirectory, { recursive: true, force: true })
  }
})

test('Command Code ACP 读不到 transcript 时退回终态累计用量', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'command-code-step-fallback-'))
  const workspacePath = '/tmp/command-code-acp-workspace'
  const driver = createCommandCodeStepUsageDriver(homeDirectory, 'command-code-step-fallback-session', {
    toolCallCount: 3,
    usageUpdate: { used: 260_100, size: 1_000_000 },
    responseUsage: { inputTokens: 530_000, outputTokens: 90, cacheReadTokens: 490_000 },
  })
  try {
    const chunks: Array<Record<string, any>> = []
    for await (const chunk of driver.executeTurn({
      sessionId: 'command-code-step-fallback-dsh',
      messages: [],
      prompt: '执行',
      cwd: workspacePath,
      modelId: 'deepseek/deepseek-v4.1-flash',
      splitToolSteps: true,
    })) chunks.push(chunk as Record<string, any>)
    const usages = chunks.filter((chunk) => chunk.type === 'usage')
    // 没有逐请求样本时必须保留 ACP 终态口径，宁可占用偏大也不能丢用量。
    assert.equal(usages.length, 1)
    assert.equal(usages[0]?.inputTokens, 530_000)
    assert.equal(usages[0]?.uncachedInputTokens, 40_000)
    assert.equal(usages[0]?.contextTokens, 260_100)
    assert.equal(usages[0]?.contextWindow, 1_000_000)
  } finally {
    driver.dispose()
    rmSync(homeDirectory, { recursive: true, force: true })
  }
})

test('Command Code 用量增量读取器按基线只返回新增请求', () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'command-code-usage-tail-'))
  const workspacePath = '/tmp/command-code-acp-workspace'
  const sessionId = 'command-code-usage-tail-session'
  const fixture = createCommandCodeUsageFixture(homeDirectory, sessionId)
  const tail = new CommandCodeUsageTail(homeDirectory)
  try {
    // begin 之前的历史用量属于上一回合，不能被算进本轮增量。
    fixture.append('history', 900_000, 1, 800_000)
    tail.begin(sessionId, workspacePath)
    assert.equal(tail.take(sessionId, workspacePath), null)
    fixture.append('request-1', 120_000, 20, 100_000)
    assert.deepEqual(tail.take(sessionId, workspacePath), {
      inputTokens: 120_000,
      outputTokens: 20,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 0,
      requests: 1,
    })
    assert.equal(tail.take(sessionId, workspacePath), null)
    // CLI 重写同一条消息时不能重复计费。
    fixture.append('request-1', 120_000, 20, 100_000)
    assert.equal(tail.take(sessionId, workspacePath), null)
    // 追加中的半行留到下一次读取，不能被当成损坏记录丢弃。
    fixture.appendRaw('{"type":"message","id":"request-2","timestamp":"2099-01-01T00:00:00.000Z","usage":{"inputTokens":10,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}')
    assert.equal(tail.take(sessionId, workspacePath), null)
    fixture.appendRaw('\n')
    assert.deepEqual(tail.take(sessionId, workspacePath), {
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      requests: 1,
    })
  } finally {
    rmSync(homeDirectory, { recursive: true, force: true })
  }
})

test('Command Code ACP 回合按工具边界切分 step，上下文分子与底栏累计同时正确', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'command-code-step-e2e-'))
  const workspacePath = '/tmp/command-code-acp-workspace'
  const sessionId = 'command-code-step-e2e-session'
  const fixture = createCommandCodeUsageFixture(homeDirectory, sessionId)
  const rows: ReadonlyArray<readonly [number, number, number]> = [
    [120_000, 20, 100_000],
    [150_000, 30, 140_000],
    [260_000, 40, 250_000],
  ]
  const driver = createCommandCodeStepUsageDriver(homeDirectory, sessionId, {
    toolCallCount: rows.length,
    usageUpdate: { used: 260_100, size: 1_000_000 },
    responseUsage: { inputTokens: 530_000, outputTokens: 90, cacheReadTokens: 490_000 },
  })
  const registry = new CodingNsCliAdapterRegistry([driver])
  const projector = new CodingNsDshMessageProjector({ adapterId: 'command-code', sessionId })
  try {
    const steps: Array<Array<Record<string, any>>> = []
    let current: Array<Record<string, any>> = []
    let finished = false
    // 模拟 DSH Agent Loop：每个 step 调一次 llm/stream，step-boundary 后继续消费同一个迭代器。
    for (let guard = 0; guard < 10 && !finished; guard += 1) {
      for await (const event of registry.execute({
        adapterId: 'command-code',
        sessionId,
        messages: [],
        prompt: '连续执行三步',
        cwd: workspacePath,
        modelId: 'deepseek/deepseek-v4.1-flash',
        splitToolSteps: true,
      })) {
        const projected = await projector.push(event)
        for (const chunk of projected) {
          if (chunk.type === 'usage') current.push(chunk.usage as Record<string, any>)
        }
        if (event.type === 'step-boundary') {
          steps.push(current)
          current = []
          continue
        }
        if (event.type === 'finish') finished = true
        if (event.type === 'tool-event' && event.status === 'started') {
          const index = Number(/(\d+)$/u.exec(event.callId ?? '')?.[1] ?? 0) - 1
          const row = rows[index]
          if (row !== undefined) fixture.append(`request-${index + 1}`, row[0], row[1], row[2])
        }
      }
    }
    if (current.length > 0) steps.push(current)
    // 工具边界把整轮切成三个 step，每个 step 只带该请求自己的用量样本。
    assert.deepEqual(steps.map((step) => step.map((usage) => [usage.inputTokens, usage.cacheReadTokens, usage.outputTokens])), [
      [[20_000, 100_000, 20]],
      [[10_000, 140_000, 30]],
      [[10_000, 250_000, 40]],
    ])
    const last = steps[2]?.[0]
    // ContextMeter 分子是最后一次请求的提示规模（26%），不是整轮累计（530000）。
    const pressure = (last?.inputTokens ?? 0) + (last?.cacheReadTokens ?? 0) + (last?.cacheWriteTokens ?? 0)
    assert.equal(pressure, 260_000)
    // 底栏累计仍是 Provider 的整轮累计，两个数字互不牺牲。
    const billed = steps.flat().reduce((sum, usage) => sum
      + (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0), 0)
    assert.equal(billed, 530_090)
  } finally {
    driver.dispose()
    rmSync(homeDirectory, { recursive: true, force: true })
  }
})

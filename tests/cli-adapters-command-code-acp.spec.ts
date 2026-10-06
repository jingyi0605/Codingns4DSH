import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandCodeDriver } from '../data/build/dist/host/cli-adapters/command-code-driver.js'
import { load as loadCommandCodeAcpLoader } from '../data/build/dist/host/cli-adapters/command-code-acp-loader.js'
import { readCommandCodeApiKey } from '../data/build/dist/host/cli-adapters/command-code-subscription.js'

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
  assert.deepEqual(calls[0], ['fake-command-code', 'acp', '--permission-mode', 'accept-edits', '--model', 'z-ai/glm-5.3-flash', '--effort', 'high'])
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
  assert.equal(unsupported.source, unrelated)
})

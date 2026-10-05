import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { QoderCliDriver, parseQoderModelList } from '../data/build/dist/host/cli-adapters/qoder-driver.js'
import { readLatestQoderQuota } from '../data/build/dist/host/cli-adapters/qoder-subscription.js'

function fakeRpcSpawn(onRequest: (request: Record<string, any>, stdout: PassThrough) => void, onOptions?: (options: Record<string, any>) => void) {
  return ((command: string, args: string[], options: Record<string, any>) => {
    assert.equal(args[0], '--acp')
    assert.equal(args[1], '--permission-mode')
    assert.equal(args[2], 'auto')
    onOptions?.(options)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = { write(data: string): boolean { onRequest(JSON.parse(data) as Record<string, any>, stdout); return true } }
    return { command, args, stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
  }) as never
}

test('Qoder ACP 在进程启动参数中下发已选思考强度', async () => {
  let args: string[] = []
  const driver = new QoderCliDriver({
    binaries: ['fake-qoder'],
    spawnSync: (() => ({ status: 0, stdout: 'qoder 1.1.65', stderr: '' })) as never,
    spawn: ((command: string, receivedArgs: string[], options: Record<string, any>) => {
      args = receivedArgs
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as Record<string, any>
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'effort-session' } })}\n`)
        else if (request.method === 'session/prompt') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
        return true
      } }
      return { command, args: receivedArgs, stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  for await (const _chunk of driver.executeTurn({ sessionId: 'effort-dsh', messages: [], prompt: '测试', effortId: 'high' })) { /* 消费终态 */ }
  assert.deepEqual(args, ['--acp', '--permission-mode', 'auto', '--reasoning-effort', 'high'])
  driver.dispose()
})

test('Qoder ACP 按 DSH 审批策略选择安全模式', async () => {
  const modes: string[] = []
  const driver = new QoderCliDriver({
    binaries: ['fake-qoder'],
    spawnSync: (() => ({ status: 0, stdout: 'qoder 1.1.65', stderr: '' })) as never,
    spawn: ((command: string, receivedArgs: string[]) => {
      modes.push(receivedArgs[receivedArgs.indexOf('--permission-mode') + 1] ?? '')
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as Record<string, any>
        if (request.method === 'initialize' || request.method === 'session/new' || request.method === 'session/prompt') {
          const result = request.method === 'session/new' ? { sessionId: `session-${modes.length}` } : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
        }
        return true
      } }
      return { command, args: receivedArgs, stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  for await (const _chunk of driver.executeTurn({ sessionId: 'qoder-mode-auto', messages: [], prompt: '只读检查' })) { /* 消费终态 */ }
  for await (const _chunk of driver.executeTurn({ sessionId: 'qoder-mode-yolo', messages: [], prompt: '完全访问', permission: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' } })) { /* 消费终态 */ }
  assert.deepEqual(modes, ['auto', 'bypass_permissions'])
  driver.dispose()
})

test('Qoder 与 Qoder CN 使用不同命令、登录票据和用户配置根', async () => {
  const detections: string[] = []
  const driver = new QoderCliDriver({
    variant: 'qoder-cn',
    binaries: ['qodercn', 'qoderclicn'],
    environment: {
      PATH: process.env.PATH,
      QODER_PERSONAL_ACCESS_TOKEN: 'global-token-must-not-leak',
      QODERCN_PERSONAL_ACCESS_TOKEN: 'cn-token',
      QODER_USER_CONFIG_DIR: '.qoder',
    },
    spawnSync: ((command: string, args: string[], options: { env?: Record<string, string | undefined> }) => {
      detections.push(command)
      assert.equal(args[0], '--version')
      assert.equal(options.env?.QODER_PERSONAL_ACCESS_TOKEN, undefined)
      assert.equal(options.env?.QODERCN_PERSONAL_ACCESS_TOKEN, 'cn-token')
      assert.equal(options.env?.QODER_USER_CONFIG_DIR, undefined)
      assert.equal(options.env?.QODERCN_USER_CONFIG_DIR, '.qoder-cn')
      return command === 'qodercn' ? { status: 0, stdout: 'qodercn 1.1.65', stderr: '' } : { status: 127, stdout: '', stderr: '' }
    }) as never,
  })
  assert.deepEqual(await driver.detect(), { installed: true, version: '1.1.65', command: 'qodercn' })
  assert.deepEqual(detections, ['qodercn'])
  driver.dispose()
})

test('Qoder ACP 创建会话、附件、工具事件和完成终态', async () => {
  const attachmentPath = join(mkdtempSync(join(tmpdir(), 'codingns-qoder-')), 'a.ts')
  writeFileSync(attachmentPath, 'const answer = 42\n', 'utf8')
  const methods: string[] = []
  let prompt: Record<string, any> | undefined
  const driver = new QoderCliDriver({
    binaries: ['fake-qoder'],
    spawnSync: (() => ({ status: 0, stdout: 'qoder 1.1.65', stderr: '' })) as never,
    spawn: fakeRpcSpawn((request, stdout) => {
      methods.push(request.method)
      if (request.method === 'initialize') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } else if (request.method === 'session/new') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'qoder-session-1' } })}\n`)
      } else if (request.method === 'session/set_model') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } else if (request.method === 'session/prompt') {
        prompt = request.params
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'qoder-session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Qoder 完成' } } } })}\n`)
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'qoder-session-1', update: { sessionUpdate: 'tool_call', toolCallId: 'qoder-call-1', title: 'read_file', status: 'running', rawInput: { path: 'a.ts' } } } })}\n`)
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'qoder-session-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'qoder-call-1', title: 'read_file', status: 'completed', rawOutput: '源码' } } })}\n`)
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
      }
    }),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({
    sessionId: 'dsh-qoder',
    messages: [],
    prompt: '查看附件',
    modelId: 'qoder-model',
    attachments: [{ kind: 'file', path: attachmentPath, name: 'a.ts', mimeType: 'text/plain' }],
  })) chunks.push(chunk)
  assert.deepEqual(methods, ['initialize', 'initialized', 'session/new', 'session/set_model', 'session/prompt'])
  assert.equal(Array.isArray(prompt?.prompt), true)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'qoder-session-1' },
    { type: 'text-delta', text: 'Qoder 完成', messageId: 'qoder-assistant-dsh-qoder-0' },
    { type: 'tool-event', toolName: 'read_file', callId: 'qoder-call-1', input: '{"path":"a.ts"}', status: 'running' },
    { type: 'tool-event', toolName: 'read_file', callId: 'qoder-call-1', output: '源码', outputMode: 'snapshot', status: 'completed' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Qoder ACP 读取 session/prompt 终态中的真实 usage 与上下文字段', async () => {
  const driver = new QoderCliDriver({
    binaries: ['fake-qoder'],
    spawnSync: (() => ({ status: 0, stdout: 'qoder 1.1.65', stderr: '' })) as never,
    spawn: fakeRpcSpawn((request, stdout) => {
      if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      else if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'usage-result-session' } })}\n`)
      else if (request.method === 'session/prompt') stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: {
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          _meta: { quota: { token_count: { input_tokens: 41, output_tokens: 5, total_tokens: 46 } } },
        },
      })}\n`)
    }),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-qoder-usage-result', messages: [], prompt: '读取用量' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'usage-result-session' },
    { type: 'usage', inputTokens: 41, outputTokens: 5, totalTokens: 46 },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Qoder ACP 在终态 token 为 0 时回读 transcript 的 credits 和上下文比例', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codingns-qoder-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'codingns-qoder-project-'))
  const projectKey = resolve(cwd).replace(/[\\/]/gu, '-')
  const transcriptDirectory = join(home, '.qoder-cn', 'projects', projectKey)
  mkdirSync(transcriptDirectory, { recursive: true })
  writeFileSync(join(transcriptDirectory, 'transcript-session.jsonl'), `${JSON.stringify({
    type: 'runtime-config',
    contextWindow: 200000,
  })}\n${JSON.stringify({
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        context_usage_ratio: 0.16062,
        credits: 0.7154040079999999,
      },
    },
  })}\n`, 'utf8')
  const driver = new QoderCliDriver({
    variant: 'qoder-cn',
    homeDirectory: home,
    binaries: ['fake-qodercn'],
    spawnSync: (() => ({ status: 0, stdout: 'qodercn 1.1.65', stderr: '' })) as never,
    spawn: fakeRpcSpawn((request, stdout) => {
      if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      else if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'transcript-session' } })}\n`)
      else if (request.method === 'session/prompt') stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: {
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          _meta: { quota: { token_count: { input_tokens: 0, output_tokens: 0 } } },
        },
      })}\n`)
    }),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-qoder-transcript', cwd, messages: [], prompt: '读取历史用量' })) chunks.push(chunk)
  assert.deepEqual(chunks.find((chunk) => chunk.type === 'usage'), {
    type: 'usage',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    providerCredits: 0.7154040079999999,
    contextUsageRatio: 0.16062,
    contextWindow: 200000,
    contextTokens: 32124,
  })
  driver.dispose()
})

test('Qoder ACP 在 runtime-config 缺失时从同会话 CLI 日志回读上下文窗口', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codingns-qoder-log-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'codingns-qoder-log-project-'))
  const projectKey = resolve(cwd).replace(/[\\/]/gu, '-')
  const transcriptDirectory = join(home, '.qoder-cn', 'projects', projectKey)
  const logsDirectory = join(home, '.qoder-cn', 'logs', 'runs', '2026-10-06T00-00-00-run')
  mkdirSync(transcriptDirectory, { recursive: true })
  mkdirSync(logsDirectory, { recursive: true })
  writeFileSync(join(transcriptDirectory, 'log-session.jsonl'), `${JSON.stringify({
    message: { role: 'assistant', usage: { input_tokens: 0, output_tokens: 0, credits: 0.5926, context_usage_ratio: 0.11753888888888889 } },
  })}\n`, 'utf8')
  writeFileSync(join(logsDirectory, 'qodercli.log'), '2026-10-06 INFO [auto-compact][session:log-session][main] threshold check: state=below, window=200000, window_source=caller\\n', 'utf8')
  const driver = new QoderCliDriver({
    variant: 'qoder-cn',
    homeDirectory: home,
    binaries: ['fake-qodercn'],
    spawnSync: (() => ({ status: 0, stdout: 'qodercn 1.1.65', stderr: '' })) as never,
    spawn: fakeRpcSpawn((request, stdout) => {
      if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      else if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'log-session' } })}\n`)
      else if (request.method === 'session/prompt') stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
      })}\n`)
    }),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-qoder-log', cwd, messages: [], prompt: '读取上下文' })) chunks.push(chunk)
  assert.deepEqual(chunks.find((chunk) => chunk.type === 'usage'), {
    type: 'usage',
    inputTokens: 0,
    outputTokens: 0,
    providerCredits: 0.5926,
    contextUsageRatio: 0.11753888888888889,
    contextWindow: 200000,
    contextTokens: 23508,
  })
  driver.dispose()
})

test('Qoder ACP 不让通知流中的不完整 usage 阻断 transcript 补全', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codingns-qoder-stream-usage-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'codingns-qoder-stream-usage-project-'))
  const projectKey = resolve(cwd).replace(/[\\/]/gu, '-')
  const transcriptDirectory = join(home, '.qoder-cn', 'projects', projectKey)
  mkdirSync(transcriptDirectory, { recursive: true })
  writeFileSync(join(transcriptDirectory, 'stream-usage-session.jsonl'), `${JSON.stringify({
    type: 'runtime-config',
    contextWindow: 200000,
  })}\n${JSON.stringify({
    message: { role: 'assistant', usage: { input_tokens: 0, output_tokens: 0, credits: 0.5926, context_usage_ratio: 0.11753888888888889 } },
  })}\n`, 'utf8')
  const driver = new QoderCliDriver({
    variant: 'qoder-cn',
    homeDirectory: home,
    binaries: ['fake-qodercn'],
    spawnSync: (() => ({ status: 0, stdout: 'qodercn 1.1.65', stderr: '' })) as never,
    spawn: fakeRpcSpawn((request, stdout) => {
      if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      else if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'stream-usage-session' } })}\n`)
      else if (request.method === 'session/prompt') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'stream-usage-session',
          update: { sessionUpdate: 'usage', usage: { input_tokens: 0, output_tokens: 0 } },
        } })}\n`)
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
      }
    }),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-qoder-stream-usage', cwd, messages: [], prompt: '读取上下文' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'stream-usage-session' },
    {
      type: 'usage',
      inputTokens: 0,
      outputTokens: 0,
      providerCredits: 0.5926,
      contextUsageRatio: 0.11753888888888889,
      contextWindow: 200000,
      contextTokens: 23508,
    },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Qoder ACP 在工具前后切换正文 messageId，并保持真实工具名', async () => {
  const driver = new QoderCliDriver({
    binaries: ['fake-qoder'],
    spawnSync: (() => ({ status: 0, stdout: 'qoder 1.1.65', stderr: '' })) as never,
    spawn: fakeRpcSpawn((request, stdout) => {
      if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      else if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'message-boundary-session' } })}\n`)
      else if (request.method === 'session/prompt') {
        const notify = (update: Record<string, any>) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'message-boundary-session', update } })}\n`)
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '工具前' } })
        notify({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'cat /tmp/a.txt', status: 'running', rawInput: { command: 'cat /tmp/a.txt' }, _meta: { qoder: { toolName: 'Bash' } } })
        notify({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: '内容' })
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '工具后' } })
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
      }
    }),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-message-boundary', messages: [], prompt: '执行命令' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'message-boundary-session' },
    { type: 'text-delta', text: '工具前', messageId: 'qoder-assistant-dsh-message-boundary-0' },
    { type: 'tool-event', toolName: 'Bash', callId: 'call-1', input: '{"command":"cat /tmp/a.txt"}', status: 'running' },
    { type: 'tool-event', toolName: 'Bash', callId: 'call-1', output: '内容', outputMode: 'snapshot', status: 'completed' },
    { type: 'text-delta', text: '工具后', messageId: 'qoder-assistant-dsh-message-boundary-1' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Qoder ACP 声明由 Registry 挂起事件流完成工具分步', () => {
  const driver = new QoderCliDriver({ binaries: ['missing-qoder'], spawnSync: (() => ({ status: 127, stdout: '', stderr: '' })) as never })
  assert.equal(driver.supportsSegmentedTurns, undefined)
  assert.equal(driver.supportsToolStepSplitting, true)
  driver.dispose()
})

test('Qoder ACP 权限请求保留 JSON-RPC id 并可回传标准批准', async () => {
  const responses: Record<string, any>[] = []
  const driver = new QoderCliDriver({
    binaries: ['fake-qoder'],
    spawnSync: (() => ({ status: 0, stdout: 'qoder 1.1.65', stderr: '' })) as never,
    spawn: fakeRpcSpawn((request, stdout) => {
      if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      else if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'permission-session' } })}\n`)
      else if (request.method === 'session/prompt') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'permission-rpc', method: 'session/request_permission', params: { sessionId: 'permission-session', options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }], toolCall: { title: '运行命令' } } })}\n`)
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
      } else if (request.id === 'permission-rpc') {
        responses.push(request)
      }
    }),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-permission', messages: [], prompt: '执行' })) {
    chunks.push(chunk)
    if (chunk.type === 'permission-request') driver.respondPermission('dsh-permission', { requestId: chunk.requestId, approved: true })
  }
  assert.equal(chunks.some((chunk) => chunk.type === 'permission-request' && chunk.requestId === 'permission-rpc' && chunk.toolName === '运行命令'), true)
  assert.deepEqual(responses, [{ jsonrpc: '2.0', id: 'permission-rpc', result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }])
  driver.dispose()
})

test('Qoder 会话探测在存储位置未知时保守返回 unknown', async () => {
  const driver = new QoderCliDriver({ binaries: ['missing-qoder'], spawnSync: (() => ({ status: 127, stdout: '', stderr: '' })) as never })
  assert.deepEqual(await driver.probeSession({ providerSessionId: 'qoder-session', rawStoreRef: 'qoder://session/qoder-session' }), {
    state: 'unknown',
    reason: 'Qoder ACP 未公开可安全读取的会话索引，无法在不改变 Provider 状态的前提下探测',
    rawStoreRef: 'qoder://session/qoder-session',
  })
})

test('Qoder 刷新模型目录不创建 ACP 会话', async () => {
  const writes: string[] = []
  const driver = new QoderCliDriver({
    binaries: ['fake-qoder'],
    spawnSync: (() => ({ status: 0, stdout: 'qoder 1.1.65', stderr: '' })) as never,
    spawn: fakeRpcSpawn((request) => { writes.push(String(request.method)) }),
  })
  assert.deepEqual(await driver.listModels(), {
    groups: [{ id: 'qoder', name: 'Qoder', models: [{ id: 'provider-default', name: '跟随 Qoder 默认模型', efforts: [] }] }],
    currentModel: null,
    currentEffort: null,
  })
  assert.deepEqual(writes, [])
  driver.dispose()
})

test('Qoder CN 从真实 --list-models 表格解析模型和思考强度', () => {
  const catalog = parseQoderModelList('MODEL\nAuto\nQwen3.8-Max\nDeepSeek-V4-Pro\n')
  assert.deepEqual(catalog.groups[0]?.models, [
    { id: 'provider-default', name: '跟随 Qoder CN 默认模型', efforts: ['low', 'medium', 'high'] },
    { id: 'qmodel_38max', name: 'Qwen3.8-Max', efforts: ['low', 'medium', 'high'] },
    { id: 'dmodel', name: 'DeepSeek-V4-Pro', efforts: ['low', 'medium', 'high'] },
  ])
})

test('Qoder CN 订阅读取器解析 CLI 日志中的 quota 余量并脱敏', () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-qoder-quota-'))
  const run = join(root, '2026-10-02T15-00-00-run')
  mkdirSync(run)
  writeFileSync(join(run, 'qodercli.log'), '[qoderApi] GET https://openapi.qoder.com.cn/api/v2/quota/usage response: {"userType":"personal_professional_trial","totalUsagePercentage":0.01,"isQuotaExceeded":false,"expiresAt":1792134942733,"userQuota":{"total":300,"used":2,"remaining":298,"unit":"credits"}}\n', 'utf8')
  const usage = readLatestQoderQuota(root)
  assert.equal(usage?.authenticated, true)
  assert.equal(usage?.planType, 'personal_professional_trial')
  assert.deepEqual(usage?.primary, {
    usedPercent: 0.01,
    remainingPercent: 99.99,
    windowDurationMins: null,
    resetsAt: 1792134942,
    remainingCredits: 298,
    totalCredits: 300,
  })
  assert.equal(usage?.credits?.balance, '298')
  assert.equal(JSON.stringify(usage).includes('token'), false)
  const internationalUsage = readLatestQoderQuota(root, 'qoder')
  assert.equal(internationalUsage?.provider?.id, 'qoder')
  assert.equal(internationalUsage?.provider?.displayName, 'Qoder')
  assert.equal(internationalUsage?.provider?.baseUrl, 'https://openapi.qoder.com')
})

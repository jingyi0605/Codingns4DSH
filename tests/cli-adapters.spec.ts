import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { createCliAdaptersFeature } from '../dist/host/cli-adapters/feature.js'
import { CommandCodeDriver } from '../dist/host/cli-adapters/command-code-driver.js'
import { CodingNsCliAdapterRegistry } from '../dist/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../dist/host/rpc-table.js'
import { FeatureRegistry } from '../dist/features/registry.js'

test('Command Code 驱动只把带版本号的候选命令视为已安装', async () => {
  const calls: string[][] = []
  const driver = new CommandCodeDriver({
    binaries: ['missing-command', 'command-code'],
    spawnSync: ((command: string, args: string[]) => {
      calls.push([command, ...args])
      return command === 'command-code'
        ? { status: 0, stdout: 'command-code 1.2.3', stderr: '' }
        : { status: 127, stdout: '', stderr: '' }
    }) as never,
  })

  assert.deepEqual(await driver.detect(), { installed: true, version: '1.2.3', command: 'command-code' })
  assert.deepEqual(calls, [['missing-command', '--version'], ['command-code', '--version']])
})

test('Command Code 驱动解析模型分组和默认思考强度', async () => {
  const driver = new CommandCodeDriver({
    homeDirectory: '/definitely/missing',
    spawnSync: ((command: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'command-code 1.2.3', stderr: '' }
      assert.equal(command, 'command-code')
      return { status: 0, stdout: 'DeepSeek\ndeepseek/deepseek-v4-pro  fast\n\nAnthropic\nclaude-sonnet-5  sonnet', stderr: '' }
    }) as never,
    binaries: ['command-code'],
  })

  assert.deepEqual(await driver.listModels(), {
    groups: [
      { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek/deepseek-v4-pro', name: 'deepseek/deepseek-v4-pro', description: 'fast', efforts: ['high', 'max'] }] },
      { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-5', name: 'claude-sonnet-5', description: 'sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }] },
    ],
    currentModel: null,
    currentEffort: null,
  })
})

test('Command Code 驱动识别完整模型目录和工具调用事件', async () => {
  const driver = new CommandCodeDriver({
    homeDirectory: '/definitely/missing',
    spawnSync: ((command: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'command-code 1.2.3', stderr: '' }
      if (args[0] === '--list-models') return {
        status: 0,
        stdout: 'OpenAI\ngpt-6-astra                            most capable\nqwen/qwen3.8-27b                       compact\n',
        stderr: '',
      }
      return { status: 0, stdout: '', stderr: '' }
    }) as never,
    binaries: ['command-code'],
  })
  const catalog = await driver.listModels()
  assert.deepEqual(catalog.groups[0]?.models, [
    { id: 'gpt-6-astra', name: 'gpt-6-astra', description: 'most capable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'qwen/qwen3.8-27b', name: 'qwen/qwen3.8-27b', description: 'compact', efforts: ['low', 'medium', 'xhigh'] },
  ])
})

test('Command Code 驱动写入历史 transcript、转换 JSON 事件并清理子进程', async () => {
  let receivedArgs: string[] = []
  let transcript = ''
  let killed = false
  const driver = new CommandCodeDriver({
    binaries: ['command-code'],
    spawnSync: ((command: string, args: string[]) => args[0] === '--version'
      ? { status: 0, stdout: 'command-code 1.2.3', stderr: '' }
      : { status: 0, stdout: '', stderr: '' }) as never,
    spawn: ((command: string, args: string[]) => {
      assert.equal(command, 'command-code')
      receivedArgs = args
      const transcriptPath = args[1]!
      transcript = readFileSync(transcriptPath, 'utf8')
      return {
        stdout: Readable.from([
          `${JSON.stringify({ type: 'event', event: { type: 'thinking_delta', delta: '思考' } })}\n`,
          `${JSON.stringify({ type: 'event', event: { type: 'text_delta', delta: '结果' } })}\n`,
          `${JSON.stringify({ type: 'event', event: { type: 'tool_use', id: 'call-1', name: 'read_directory', input: { path: '.' } } })}\n`,
          `${JSON.stringify({ type: 'result', finalText: '结果', usage: { inputTokens: 2, outputTokens: 3 } })}\n`,
        ]),
        stderr: { on() { return this } },
        kill() { killed = true; return true },
      }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({
    sessionId: 'session/1',
    messages: [{ role: 'user', content: '之前的问题' }, { role: 'assistant', content: '之前的回答' }],
    prompt: '现在的问题',
    cwd: '/workspace',
  })) chunks.push(chunk)

  assert.equal(receivedArgs[0], '--session')
  assert.equal(receivedArgs[2], '-p')
  assert.match(transcript, /之前的问题/u)
  assert.doesNotMatch(transcript, /现在的问题/u)
  assert.deepEqual(chunks, [
    { type: 'reasoning-delta', text: '思考' },
    { type: 'text-delta', text: '结果' },
    { type: 'tool-running', toolName: 'read_directory', callId: 'call-1', input: '{"path":"."}', status: 'running' },
    { type: 'usage', inputTokens: 2, outputTokens: 3 },
    { type: 'finish', reason: 'stop' },
  ])
  assert.equal(killed, true)
})

test('Agent 注册表隔离会话配置并拒绝未知 Agent', async () => {
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() { yield { type: 'finish', reason: 'stop' } },
  }])

  assert.deepEqual(registry.setSession('s1', { adapterId: 'fake', modelId: 'm1' }), { adapterId: 'fake', modelId: 'm1' })
  assert.deepEqual(registry.getSession('s1'), { adapterId: 'fake', modelId: 'm1' })
  assert.deepEqual(registry.getSession('s2'), { adapterId: 'dsh' })
  assert.throws(() => registry.setSession('s1', { adapterId: 'missing' }), /Agent 不可用/u)
})

test('Agent 注册表允许把会话切回内置 DSH Agent', () => {
  const registry = new CodingNsCliAdapterRegistry([])
  assert.deepEqual(registry.setSession('session-dsh', { adapterId: 'dsh' }), { adapterId: 'dsh' })
  assert.deepEqual(registry.getSession('session-dsh'), { adapterId: 'dsh' })
})

test('外部 Agent 可以单独停用并阻止模型目录和会话绑定', async () => {
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() { yield { type: 'finish', reason: 'stop' } },
  }])

  assert.equal((await registry.catalog())[0]?.enabled, true)
  registry.setEnabled('fake', false)
  assert.equal((await registry.catalog())[0]?.enabled, false)
  await assert.rejects(registry.models('fake'), /Agent 已停用/u)
  assert.throws(() => registry.setSession('disabled-agent', { adapterId: 'fake' }), /Agent 已停用/u)
  assert.deepEqual(registry.getSession('disabled-agent'), { adapterId: 'dsh' })
})

test('CLI 功能模块登记 cli RPC，停用后注销命名空间', async () => {
  const table = new CodingNsRpcTable()
  const registry = new CodingNsCliAdapterRegistry([])
  const features = new FeatureRegistry({ rpc: table })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  assert.deepEqual(table.namespaces(), ['cli'])
  assert.deepEqual(await table.resolve('cli/catalog')?.handler('catalog', {}), [])
  await features.disable('cliAdapters')
  assert.deepEqual(table.namespaces(), [])
})

test('CLI 功能模块按会话配置接管 llm/stream，并保留默认 DSH 流的旁路行为', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() {
      yield { type: 'text-delta', text: '来自 CLI' }
      yield { type: 'finish', reason: 'stop' }
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({ rpc: table, events })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 's1', adapterId: 'fake' })
  assert.notEqual(listener, undefined)

  const chunks = []
  for await (const chunk of listener!({ sessionId: 's1', messages: [{ role: 'user', content: '你好' }] }, async function* () { yield { type: 'text-delta', text: '默认' } })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'text-delta', index: 1, text: '来自 CLI' },
    { type: 'finish', reason: 'stop' },
  ])

  const passthrough = []
  for await (const chunk of listener!({ sessionId: 'unknown', messages: [] }, async function* () { yield { type: 'text-delta', text: '默认' } })) passthrough.push(chunk)
  assert.deepEqual(passthrough, [{ type: 'text-delta', text: '默认' }])
  await features.disable('cliAdapters')
  assert.equal(listener, undefined)
})

test('CLI 功能模块从 DSH 会话头传递工作目录且不把已执行工具交给 DSH', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  let receivedCwd: string | undefined
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      receivedCwd = input.cwd
      yield { type: 'tool-running', toolName: 'read_directory', callId: 'call-1', input: '{"path":"."}', status: 'running' }
      yield { type: 'finish', reason: 'stop' }
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({
    rpc: table,
    events,
    nativeSessions: {
      available: true,
      store: undefined,
      controller: undefined,
      get() { return { header: { cwd: '/workspace/project' } } },
      list() { return [] },
      async ensure() { return null },
      async flush() {},
      subscribe() { return () => {} },
    },
  })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 's-cwd', adapterId: 'fake' })
  const chunks = []
  for await (const chunk of listener!({ sessionId: 's-cwd', messages: [{ role: 'user', content: '读取目录' }] }, async function* () {})) chunks.push(chunk)
  assert.equal(receivedCwd, '/workspace/project')
  assert.deepEqual(chunks, [
    { type: 'finish', reason: 'stop' },
  ])
  await features.disable('cliAdapters')
})

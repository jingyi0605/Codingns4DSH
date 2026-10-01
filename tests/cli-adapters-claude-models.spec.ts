import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'

function fakeClaudeProcess(output: string, code = 0): unknown {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    stdin: { end(value: string): void }
    kill(): boolean
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = { end() {
    queueMicrotask(() => {
      if (output) child.stdout.write(output)
      child.stdout.end()
      child.stderr.end()
      child.emit('close', code)
    })
  } }
  child.kill = () => true
  return child
}

test('Claude Code 通过 initialize、网关和 settings.json 合并真实模型', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-models-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
    ANTHROPIC_AUTH_TOKEN: 'secret-token',
    ANTHROPIC_MODEL: 'deepseek/deepseek-chat',
  } }), 'utf8')
  const initialize = JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: 'codingns-model-discovery', response: { models: [
      { value: 'default', displayName: 'Default' },
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8', supportedEffortLevels: ['high'] },
    ] },
  } }) + '\n'
  const calls: string[] = []
  try {
    const driver = new ClaudeCodeDriver({
      binaries: ['fake-claude'],
      claudeConfigDir: configDir,
      spawnSync: ((command: string, args: string[]) => args[0] === '--version'
        ? { status: 0, stdout: 'claude 1.0.0', stderr: '' }
        : { status: 1, stdout: '', stderr: '' }) as never,
      spawn: ((command: string, args: string[]) => { calls.push(`${command} ${args.join(' ')}`); return fakeClaudeProcess(initialize) }) as never,
      fetch: (async (url: string, init?: RequestInit) => {
        assert.equal(url, 'https://gateway.example/v1/models')
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret-token')
        assert.equal(new Headers(init?.headers).get('x-api-key'), 'secret-token')
        return new Response(JSON.stringify({ data: [{ id: 'gateway-sonnet', display_name: 'Gateway Sonnet' }] }), { status: 200 })
      }) as typeof fetch,
    })
    const catalog = await driver.listModels()
    const models = catalog.groups[0]?.models ?? []
    assert.deepEqual(models.map((model) => model.id), ['provider-default', 'sonnet', 'opus', 'haiku', 'claude-opus-4-8', 'gateway-sonnet', 'deepseek/deepseek-chat'])
    assert.equal(models.find((model) => model.id === 'claude-opus-4-8')?.efforts.join(','), 'high')
    assert.doesNotMatch(JSON.stringify(catalog), /secret-token/u)
    assert.equal(calls.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude Code 动态发现失败时回退静态别名并保留配置模型', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-models-fallback-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'deepseek/deepseek-reasoner', ANTHROPIC_BASE_URL: 'https://gateway.example' } }), 'utf8')
  try {
    const driver = new ClaudeCodeDriver({
      binaries: ['fake-claude'],
      claudeConfigDir: configDir,
      spawnSync: ((command: string, args: string[]) => args[0] === '--version'
        ? { status: 0, stdout: 'claude 1.0.0', stderr: '' }
        : { status: 1, stdout: '', stderr: '' }) as never,
      spawn: (() => fakeClaudeProcess('', 1)) as never,
      fetch: (async () => { throw new Error('gateway unavailable') }) as typeof fetch,
    })
    const ids = (await driver.listModels()).groups[0]?.models.map((model) => model.id) ?? []
    assert.deepEqual(ids, ['provider-default', 'sonnet', 'opus', 'haiku', 'deepseek/deepseek-reasoner'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude Code 未安装时不伪造模型目录', async () => {
  const driver = new ClaudeCodeDriver({
    binaries: ['missing-claude'],
    spawnSync: (() => { throw new Error('missing') }) as never,
  })
  assert.deepEqual(await driver.listModels(), { groups: [], currentModel: null, currentEffort: null })
})

test('Claude Code 把中转站自定义命名的模型也补上 CLI 确认过的思考档位', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-relay-efforts-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
    ANTHROPIC_MODEL: 'deepseek/deepseek-chat',
  } }), 'utf8')
  // initialize 只回报了部分模型的档位；网关 /v1/models 完全不返回档位元数据。
  const initialize = JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: 'codingns-model-discovery', response: { models: [
      { value: 'default', displayName: 'Default', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ] },
  } }) + '\n'
  try {
    const driver = new ClaudeCodeDriver({
      binaries: ['fake-claude'],
      claudeConfigDir: configDir,
      spawnSync: ((command: string, args: string[]) => args[0] === '--version'
        ? { status: 0, stdout: 'claude 1.0.0', stderr: '' }
        : { status: 1, stdout: '', stderr: '' }) as never,
      spawn: (() => fakeClaudeProcess(initialize)) as never,
      fetch: (async () => new Response(JSON.stringify({ data: [{ id: 'relay-custom-model', display_name: '中转自定义模型' }] }), { status: 200 })) as typeof fetch,
    })
    const models = (await driver.listModels()).groups[0]?.models ?? []
    // 中转站来源的模型 ID 与官方目录匹配不上，但档位不能是空的。
    for (const id of ['relay-custom-model', 'deepseek/deepseek-chat']) {
      assert.deepEqual(models.find((model) => model.id === id)?.efforts, ['low', 'medium', 'high', 'xhigh', 'max'], `${id} 应补齐档位`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude Code 的 initialize 未回报档位时退回该 CLI 已验证的档位表', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-no-effort-metadata-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  const initialize = JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: 'codingns-model-discovery', response: { models: [
      { value: 'default', displayName: 'Default' },
    ] },
  } }) + '\n'
  try {
    const driver = new ClaudeCodeDriver({
      binaries: ['fake-claude'],
      claudeConfigDir: configDir,
      spawnSync: ((command: string, args: string[]) => args[0] === '--version'
        ? { status: 0, stdout: 'claude 1.0.0', stderr: '' }
        : { status: 1, stdout: '', stderr: '' }) as never,
      spawn: (() => fakeClaudeProcess(initialize)) as never,
      fetch: (async () => { throw new Error('gateway unavailable') }) as typeof fetch,
    })
    const models = (await driver.listModels()).groups[0]?.models ?? []
    assert.deepEqual(models.find((model) => model.id === 'provider-default')?.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude Code 明确回报不支持档位的模型保持空档位，不被 Provider 级兜底覆盖', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-no-effort-model-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  const initialize = JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: 'codingns-model-discovery', response: { models: [
      { value: 'default', displayName: 'Default', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'plain-model', displayName: 'Plain', supportsEffort: false },
    ] },
  } }) + '\n'
  try {
    const driver = new ClaudeCodeDriver({
      binaries: ['fake-claude'],
      claudeConfigDir: configDir,
      spawnSync: ((command: string, args: string[]) => args[0] === '--version'
        ? { status: 0, stdout: 'claude 1.0.0', stderr: '' }
        : { status: 1, stdout: '', stderr: '' }) as never,
      spawn: (() => fakeClaudeProcess(initialize)) as never,
      fetch: (async () => { throw new Error('gateway unavailable') }) as typeof fetch,
    })
    const models = (await driver.listModels()).groups[0]?.models ?? []
    assert.deepEqual(models.find((model) => model.id === 'plain-model')?.efforts, [], '不支持档位的模型不能补档位')
    assert.deepEqual(models.find((model) => model.id === 'provider-default')?.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('中转模型的大小写与官方目录不一致时，仍按同一逻辑模型处理', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-effort-case-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  // 网关必须显式配置，否则不会走 /v1/models 发现路径。
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example/v1' } }), 'utf8')
  // CLI 明确回报 Sonnet 不支持档位；网关又用不同大小写提供了同名模型。
  const initialize = JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: 'codingns-model-discovery', response: { models: [
      { value: 'default', displayName: 'Default', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'sonnet', displayName: 'Sonnet', supportsEffort: false },
    ] },
  } }) + '\n'
  try {
    const driver = new ClaudeCodeDriver({
      binaries: ['fake-claude'],
      claudeConfigDir: configDir,
      spawnSync: ((command: string, args: string[]) => args[0] === '--version'
        ? { status: 0, stdout: 'claude 1.0.0', stderr: '' }
        : { status: 1, stdout: '', stderr: '' }) as never,
      spawn: (() => fakeClaudeProcess(initialize)) as never,
      fetch: (async () => new Response(JSON.stringify({ data: [{ id: 'Sonnet', display_name: 'Sonnet Relay' }] }), { status: 200 })) as typeof fetch,
    })
    const models = (await driver.listModels()).groups[0]?.models ?? []
    assert.deepEqual(models.find((model) => model.id === 'sonnet')?.efforts, [], 'CLI 明确不支持的模型不能补档位')
    assert.deepEqual(models.find((model) => model.id === 'Sonnet')?.efforts, [], '大小写不同不能绕过「不支持」的结论')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI 不支持 --effort 时不展示任何档位，避免出现切换后无效的选项', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-old-cli-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  const initialize = JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: 'codingns-model-discovery', response: { models: [
      { value: 'default', displayName: 'Default', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ] },
  } }) + '\n'
  const oldHelp = 'Usage: claude [options] [command] [prompt]\n\nOptions:\n  --model <model>  Model for the current session\n'
  try {
    const driver = new ClaudeCodeDriver({
      binaries: ['fake-claude'],
      claudeConfigDir: configDir,
      spawnSync: ((command: string, args: string[]) => {
        if (args[0] === '--version') return { status: 0, stdout: 'claude 1.0.0', stderr: '' }
        if (args[0] === '--help') return { status: 0, stdout: oldHelp, stderr: '' }
        return { status: 1, stdout: '', stderr: '' }
      }) as never,
      spawn: (() => fakeClaudeProcess(initialize)) as never,
      fetch: (async () => new Response(JSON.stringify({ data: [{ id: 'relay-model', display_name: 'Relay' }] }), { status: 200 })) as typeof fetch,
    })
    const models = (await driver.listModels()).groups[0]?.models ?? []
    // 旧 CLI 不接受 --effort，驱动不会下发；目录也必须一致地不展示档位。
    for (const model of models) assert.deepEqual(model.efforts, [], `${model.id} 在旧 CLI 上不应展示档位`)
    const args = (driver as unknown as { buildArgs(value: Record<string, unknown>): readonly string[] }).buildArgs({ sessionId: 's1', messages: [], prompt: '你好', effortId: 'high' })
    assert.equal(args.includes('--effort'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--help 探测异常时不清空目录，也不下发 --effort', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-help-failed-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  const initialize = JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: 'codingns-model-discovery', response: { models: [
      { value: 'default', displayName: 'Default', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ] },
  } }) + '\n'
  try {
    const driver = new ClaudeCodeDriver({
      binaries: ['fake-claude'],
      claudeConfigDir: configDir,
      spawnSync: ((command: string, args: string[]) => {
        if (args[0] === '--version') return { status: 0, stdout: 'claude 2.1.177', stderr: '' }
        // --help 异常退出：既不能判定为「不支持」，也不能据此清空档位。
        if (args[0] === '--help') return { status: 1, stdout: '', stderr: '' }
        return { status: 1, stdout: '', stderr: '' }
      }) as never,
      spawn: (() => fakeClaudeProcess(initialize)) as never,
      fetch: (async () => { throw new Error('gateway unavailable') }) as typeof fetch,
    })
    const models = (await driver.listModels()).groups[0]?.models ?? []
    assert.deepEqual(models.find((model) => model.id === 'provider-default')?.efforts, ['low', 'medium', 'high', 'xhigh', 'max'], '探测不确定时不能清空档位')
    const args = (driver as unknown as { buildArgs(value: Record<string, unknown>): readonly string[] }).buildArgs({ sessionId: 's1', messages: [], prompt: '你好', effortId: 'high' })
    assert.equal(args.includes('--effort'), false, '探测不确定时不下发')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

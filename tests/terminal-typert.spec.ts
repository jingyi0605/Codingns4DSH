import assert from 'node:assert/strict'
import test from 'node:test'
import { TYPERT } from '../data/build/dist/typert.host.js'

const expectedMethods = [
  'close', 'create', 'environment', 'follow', 'list',
  'rename', 'resize', 'retain', 'shells', 'write',
]

test('终端 Typert manifest 使用 dsh-codingns 自有 package 和 invocation identity', () => {
  assert.equal(TYPERT.package, 'dsh-codingns')
  assert.equal(TYPERT.face, 'host')
  assert.deepEqual(TYPERT.invocations.map((item) => item.method), expectedMethods)
  assert.deepEqual(
    TYPERT.invocations.map((item) => item.id),
    expectedMethods.map((method) => `dsh-codingns#terminal/${method}`),
  )
  assert.ok(TYPERT.invocations.every((item) => item.service === 'terminalController'))
  assert.ok(TYPERT.invocations.every((item) => item.namespace === 'terminal'))
})

test('终端 Typert manifest 保持官方 lookup、scope、stream 和 cancellation 形状', () => {
  const byMethod = new Map(TYPERT.invocations.map((item) => [item.method, item]))
  for (const method of ['close', 'create', 'environment', 'follow', 'rename', 'resize', 'shells', 'write']) {
    const item = byMethod.get(method)
    assert.deepEqual(item?.scope, { context: 'agent', wire: 'agentId' })
    const first = item?.parameters[0]
    assert.equal(first?.source, 'lookup')
    assert.equal(first?.lookup, 'agent')
    assert.equal(first?.wire, 'agentId')
  }
  assert.equal(byMethod.get('list')?.scope, undefined)
  assert.equal(byMethod.get('retain')?.scope, undefined)
  assert.equal(byMethod.get('follow')?.mode, 'stream')
  assert.equal(byMethod.get('retain')?.mode, 'stream')
  for (const method of ['create', 'environment', 'follow', 'retain', 'shells']) {
    assert.deepEqual(byMethod.get(method)?.cancellation, { parameter: 'signal' })
  }
})

test('终端 Typert result codec 会裁掉插件内部 shell profileId', () => {
  const create = TYPERT.invocations.find((item) => item.method === 'create')
  assert.ok(create)
  const parsed = create.result.create().parse({
    id: 'tab-1',
    title: 'zsh',
    shell: { profileId: 'zsh', path: '/bin/zsh', args: ['-i'], name: 'zsh' },
    cwd: '/workspace',
    cols: 80,
    rows: 24,
    state: 'running',
    exitCode: null,
  })
  assert.deepEqual(parsed.shell, { path: '/bin/zsh', args: ['-i'], name: 'zsh' })
})

test('终端环境 codec 保留跨会话的 DSH Workspace ID', () => {
  const environment = TYPERT.invocations.find((item) => item.method === 'environment')
  assert.ok(environment)
  assert.equal(environment.result.create().parse({
    cwd: '/workspace',
    workspaceId: 'workspace-stable',
    maxInputBytes: 65536,
    maxCols: 500,
    maxRows: 200,
    scrollback: 1000,
  }).workspaceId, 'workspace-stable')
})

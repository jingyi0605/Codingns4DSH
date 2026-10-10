import assert from 'node:assert/strict'
import test from 'node:test'
import { TYPERT } from '../data/build/dist/typert.host.js'

const expectedMethods = [
  'close', 'create', 'environment', 'follow', 'list',
  'rename', 'resize', 'retain', 'shells', 'write',
]
const terminalInvocations = TYPERT.invocations.filter((item) => item.namespace === 'codingnsTerminal')

test('终端 Typert manifest 使用 codingns4dsh 自有 package 和 invocation identity', () => {
  assert.equal(TYPERT.package, '@jingyi0605/codingns4dsh')
  assert.equal(TYPERT.face, 'host')
  assert.deepEqual(terminalInvocations.map((item) => item.method), expectedMethods)
  assert.deepEqual(
    terminalInvocations.map((item) => item.id),
    expectedMethods.map((method) => `codingns4dsh#terminal/${method}`),
  )
  assert.ok(terminalInvocations.every((item) => item.service === 'terminalController'))
  assert.ok(terminalInvocations.every((item) => item.namespace === 'codingnsTerminal'))
})

test('终端 Typert manifest 保持官方 lookup、scope、stream 和 cancellation 形状', () => {
  const byMethod = new Map(terminalInvocations.map((item) => [item.method, item]))
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
  const create = terminalInvocations.find((item) => item.method === 'create')
  assert.ok(create)
  const value = {
    id: 'tab-1',
    title: 'zsh',
    shell: { profileId: 'zsh', path: '/bin/zsh', args: ['-i'], name: 'zsh' },
    cwd: '/workspace',
    cols: 80,
    rows: 24,
    state: 'running',
    exitCode: null,
  }
  assert.deepEqual(create.result.schema.parse(value).shell, { path: '/bin/zsh', args: ['-i'], name: 'zsh' })
  const parsed = create.result.create().parse(value)
  assert.deepEqual(parsed.shell, { path: '/bin/zsh', args: ['-i'], name: 'zsh' })
})

test('终端环境 codec 保留跨会话的 DSH Workspace ID', () => {
  const environment = terminalInvocations.find((item) => item.method === 'environment')
  assert.ok(environment)
  const value = {
    cwd: '/workspace',
    workspaceId: 'workspace-stable',
    maxInputBytes: 65536,
    maxCols: 500,
    maxRows: 200,
    scrollback: 1000,
  }
  assert.equal(environment.result.schema.parse(value).workspaceId, 'workspace-stable')
  assert.equal(environment.result.create().parse(value).workspaceId, 'workspace-stable')
})

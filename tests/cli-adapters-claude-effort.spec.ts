import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'

const HELP_WITH_EFFORT = `Usage: claude [options] [command] [prompt]

Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session
`

/** 记录 buildArgs 结果；detect 与 --help 探测都由 spawnSync 桩提供。 */
function driverWithHelp(help: string): { driver: ClaudeCodeDriver; args: (input: Record<string, unknown>) => readonly string[] } {
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude'],
    spawnSync: ((command: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'claude 2.1.177', stderr: '' }
      if (args[0] === '--help') return { status: 0, stdout: help, stderr: '' }
      return { status: 1, stdout: '', stderr: '' }
    }) as never,
  })
  return {
    driver,
    args: (input) => (driver as unknown as { buildArgs(value: Record<string, unknown>): readonly string[] }).buildArgs(input),
  }
}

function fakeClaudeProcess(output: string): unknown {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    kill(): boolean
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  queueMicrotask(() => {
    if (output) child.stdout.write(output)
    child.stdout.end()
    child.stderr.end()
    child.emit('close', 0)
  })
  child.kill = () => true
  return child
}

test('Claude Code 把选中的思考强度传给 --effort', async () => {
  const { driver, args } = driverWithHelp(HELP_WITH_EFFORT)
  await driver.detect()
  const result = args({ sessionId: 's1', messages: [], prompt: '你好', modelId: 'sonnet', effortId: 'xhigh' })
  const index = result.indexOf('--effort')
  assert.notEqual(index, -1, '必须下发 --effort')
  assert.equal(result[index + 1], 'xhigh')
  assert.equal(result[result.indexOf('--model') + 1], 'sonnet')
})

test('Claude Code 在 resume 续接回合同样下发 --effort', async () => {
  const { driver, args } = driverWithHelp(HELP_WITH_EFFORT)
  await driver.detect()
  const result = args({ sessionId: 's1', messages: [], prompt: '继续', providerSessionId: 'provider-session-1', effortId: 'max' })
  assert.equal(result[result.indexOf('--resume') + 1], 'provider-session-1')
  assert.equal(result[result.indexOf('--effort') + 1], 'max')
})

test('Claude Code 未选强度、选中 default 或使用默认模型时不添加 --effort', async () => {
  const { driver, args } = driverWithHelp(HELP_WITH_EFFORT)
  await driver.detect()
  for (const effortId of [undefined, '', 'default', '   ']) {
    const result = args({ sessionId: 's1', messages: [], prompt: '你好', ...(effortId === undefined ? {} : { effortId }) })
    assert.equal(result.includes('--effort'), false, `effortId=${JSON.stringify(effortId)} 不应下发 --effort`)
  }
})

test('CLI 不支持 --effort 时不下发该参数，避免旧版本因未知选项整轮失败', async () => {
  const { driver, args } = driverWithHelp('Usage: claude [options] [command] [prompt]\n\nOptions:\n  --model <model>  Model for the current session\n')
  await driver.detect()
  const result = args({ sessionId: 's1', messages: [], prompt: '你好', effortId: 'high' })
  assert.equal(result.includes('--effort'), false)
  assert.equal(result.includes('--model'), false, '未指定模型时不应出现 --model')
})

test('CLI 探测尚未完成时保守跳过 --effort', () => {
  const driver = new ClaudeCodeDriver({ binaries: ['fake-claude'], spawnSync: (() => { throw new Error('missing') }) as never })
  const result = (driver as unknown as { buildArgs(value: Record<string, unknown>): readonly string[] }).buildArgs({ sessionId: 's1', messages: [], prompt: '你好', effortId: 'high' })
  assert.equal(result.includes('--effort'), false)
})

test('探测失败不会被缓存成「不支持」，下一轮重试即可恢复', async () => {
  let failHelp = true
  let helpCalls = 0
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude'],
    spawnSync: ((command: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'claude 2.1.177', stderr: '' }
      if (args[0] === '--help') {
        helpCalls += 1
        if (failHelp) throw new Error('spawn EAGAIN')
        return { status: 0, stdout: HELP_WITH_EFFORT, stderr: '' }
      }
      return { status: 1, stdout: '', stderr: '' }
    }) as never,
  })
  await driver.detect()
  const args = (input: Record<string, unknown>) => (driver as unknown as { buildArgs(value: Record<string, unknown>): readonly string[] }).buildArgs(input)
  // 首次探测失败：本轮不下发，但不能把失败固化成永久结论。
  assert.equal(args({ sessionId: 's1', messages: [], prompt: '你好', effortId: 'high' }).includes('--effort'), false)
  failHelp = false
  await driver.detect()
  assert.equal(args({ sessionId: 's1', messages: [], prompt: '你好', effortId: 'high' }).includes('--effort'), true, '探测失败必须重试而不是永久关闭')
  assert.equal(helpCalls, 2)
})

test('CLI 原地升级后重新探测，不会沿用旧版本的结论', async () => {
  let version = '1.0.0'
  let help = 'Usage: claude [options]\n\nOptions:\n  --model <model>  Model\n'
  let helpCalls = 0
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude'],
    spawnSync: ((command: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: `claude ${version}`, stderr: '' }
      if (args[0] === '--help') { helpCalls += 1; return { status: 0, stdout: help, stderr: '' } }
      return { status: 1, stdout: '', stderr: '' }
    }) as never,
  })
  const args = (input: Record<string, unknown>) => (driver as unknown as { buildArgs(value: Record<string, unknown>): readonly string[] }).buildArgs(input)
  await driver.detect()
  assert.equal(args({ sessionId: 's1', messages: [], prompt: '你好', effortId: 'high' }).includes('--effort'), false)
  // 同一路径升级到支持 --effort 的版本后，缓存必须失效。
  version = '2.1.177'
  help = HELP_WITH_EFFORT
  await driver.detect()
  assert.equal(args({ sessionId: 's1', messages: [], prompt: '你好', effortId: 'high' }).includes('--effort'), true, '版本变化后必须重新探测')
  assert.equal(helpCalls, 2)
})

test('Claude Code 执行回合时真实下发 --effort 参数', async () => {
  const calls: string[][] = []
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude'],
    spawnSync: ((command: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'claude 2.1.177', stderr: '' }
      if (args[0] === '--help') return { status: 0, stdout: HELP_WITH_EFFORT, stderr: '' }
      return { status: 1, stdout: '', stderr: '' }
    }) as never,
    spawn: ((command: string, args: string[]) => {
      calls.push([command, ...args])
      return fakeClaudeProcess(`${JSON.stringify({ type: 'result' })}\n`)
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'claude-effort', messages: [], prompt: '你好', modelId: 'opus', effortId: 'high' })) chunks.push(chunk)
  const args = calls[0] ?? []
  assert.equal(args[args.indexOf('--effort') + 1], 'high')
  assert.equal(args[args.indexOf('--model') + 1], 'opus')
  assert.deepEqual(chunks, [{ type: 'finish', reason: 'stop' }])
  driver.dispose()
})

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { AntigravityDriver } from '../data/build/dist/host/cli-adapters/antigravity-driver.js'

test('Antigravity 通过 stdin stream-json 输入一轮并转换标准事件', async () => {
  const calls: string[][] = []
  const inputs: string[] = []
  let killed = false
  const driver = new AntigravityDriver({
    binaries: ['fake-agy'],
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.2.11', stderr: '' })) as never,
    spawn: ((command: string, args: string[]) => {
      calls.push([command, ...args])
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let emitted = false
      const stdin = {
        end(value?: string): void {
          if (value !== undefined) inputs.push(value)
          if (emitted) return
          emitted = true
          queueMicrotask(() => {
            stdout.write(`${JSON.stringify({ event: 'init', conversation_id: 'agy-provider-session' })}\n`)
            stdout.write(`${JSON.stringify({ event: 'step_update', step_update: { text_delta: '完成', usage: { input_tokens: 2, output_tokens: 1 } } })}\n`)
            stdout.write(`${JSON.stringify({ event: 'result', result: { usage: { input_tokens: 2, output_tokens: 1 } } })}\n`)
            stdout.end()
            stderr.end()
          })
        },
      }
      return { stdout, stderr, stdin, kill() { killed = true; return true } }
    }) as never,
  })
  assert.equal(driver.supportsToolStepSplitting, true)

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'agy-session', messages: [], prompt: '你好' })) chunks.push(chunk)

  assert.equal((await driver.detect()).installed, true)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'agy-provider-session' },
    { type: 'text-delta', text: '完成', messageId: 'assistant-antigravity-agy-session-0' },
    { type: 'usage', inputTokens: 2, outputTokens: 1 },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(calls[0], [
    'fake-agy', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--dangerously-skip-permissions', '--add-dir', process.cwd(),
  ])
  assert.deepEqual(JSON.parse(inputs[0] ?? '{}'), { event: 'user', message: { content: '你好' } })
  assert.equal(driver.descriptor.capabilities?.includes('permission'), false)
  assert.equal(killed, true)
  driver.dispose()
})

test('Antigravity 从 agy models 动态加载模型并合并思考档位', async () => {
  const modelProbeCalls: string[][] = []
  const modelProbeOptions: Array<{ shell?: unknown; stdio?: unknown; env?: { PATH?: unknown } }> = []
  const driver = new AntigravityDriver({
    binaries: ['fake-agy'],
    spawnSync: ((command: string, args: string[]) => ({ status: 0, stdout: 'agy 1.2.14', stderr: '' })) as never,
    spawn: ((command: string, args: string[], options: { shell?: unknown; stdio?: unknown; env?: { PATH?: unknown } }) => {
      modelProbeCalls.push([command, ...args])
      modelProbeOptions.push(options)
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill(): boolean
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => true
      queueMicrotask(() => {
        child.stdout.end([
          'Fetching available models...',
          'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
          'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
          'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
          'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
          'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
          'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
        ].join('\n'))
        child.stderr.end()
        child.emit('close', 0)
      })
      return child
    }) as never,
  })

  const catalog = await driver.listModels()
  assert.deepEqual(catalog.groups[0]?.models, [
    { id: 'provider-default', name: '跟随 Antigravity 默认模型', efforts: [] },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', efforts: ['low', 'high'] },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', efforts: [] },
  ])
  assert.deepEqual(modelProbeCalls[0], ['fake-agy', 'models'])
  assert.deepEqual(modelProbeOptions[0]?.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(modelProbeOptions[0]?.shell, false)
  assert.equal(typeof modelProbeOptions[0]?.env?.PATH, 'string')
  driver.dispose()
})

test('Antigravity 释放驱动时取消后台模型探测并返回可重试回退目录', async () => {
  let killed = false
  const driver = new AntigravityDriver({
    binaries: ['fake-agy'],
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.2.14', stderr: '' })) as never,
    spawn: (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => { killed = true; return true }
      return child
    }) as never,
  })

  const pending = driver.listModels()
  await new Promise<void>((resolve) => setImmediate(resolve))
  driver.dispose()
  const catalog = await pending
  assert.equal(catalog.fallback, true)
  assert.equal(killed, true)
})

test('Antigravity 续接会话时传递 conversation，result.response 作为正文兜底', async () => {
  const calls: string[][] = []
  const driver = new AntigravityDriver({
    binaries: ['fake-agy'],
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.2.14', stderr: '' })) as never,
    spawn: ((command: string, args: string[]) => {
      calls.push([command, ...args])
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = {
        end(): void {
          queueMicrotask(() => {
            stdout.write(`${JSON.stringify({ event: 'result', result: { conversation_id: 'agy-existing', response: '续接完成', status: 'SUCCESS', num_turns: 2 } })}\n`)
            stdout.end()
            stderr.end()
          })
        },
      }
      return { stdout, stderr, stdin, kill() { return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'agy-session', providerSessionId: 'agy-existing', messages: [], prompt: '继续' })) chunks.push(chunk)

  assert.deepEqual(chunks, [
    { type: 'text-delta', text: '续接完成', messageId: 'assistant-antigravity-agy-session-0' },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(calls[0], [
    'fake-agy', '--conversation', 'agy-existing', '--input-format', 'stream-json',
    '--output-format', 'stream-json', '--dangerously-skip-permissions', '--add-dir', process.cwd(),
  ])
  driver.dispose()
})

test('Antigravity 不重复追加 result.response，并保留 tool step 生命周期', async () => {
  const driver = new AntigravityDriver({
    binaries: ['fake-agy'],
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.2.14', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = {
        end(): void {
          queueMicrotask(() => {
            stdout.write(`${JSON.stringify({ event: 'init', conversation_id: 'agy-tools' })}\n`)
            stdout.write(`${JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: '完成' } })}\n`)
            stdout.write(`${JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'bash', tool_info: { parameters: { command: 'pwd' } } } })}\n`)
            stdout.write(`${JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'bash', tool_info: { output: '/tmp' } } })}\n`)
            stdout.write(`${JSON.stringify({ event: 'result', result: { response: '完成', status: 'SUCCESS', num_turns: 1 } })}\n`)
            stdout.end()
            stderr.end()
          })
        },
      }
      return { stdout, stderr, stdin, kill() { return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'agy-tools', messages: [], prompt: '执行' })) chunks.push(chunk)

  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'agy-tools' },
    { type: 'text-delta', text: '完成', messageId: 'assistant-antigravity-agy-tools-0' },
    { type: 'tool-event', toolName: 'bash', status: 'running', input: '{"command":"pwd"}' },
    { type: 'tool-event', toolName: 'bash', status: 'completed', output: '/tmp', outputMode: 'snapshot' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Antigravity 续接返回不同 conversation 时明确失败', async () => {
  const driver = new AntigravityDriver({
    binaries: ['fake-agy'],
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.2.14', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = {
        end(): void {
          queueMicrotask(() => {
            stdout.write(`${JSON.stringify({ event: 'result', result: { conversation_id: 'other-conversation', response: '错误会话', status: 'SUCCESS', num_turns: 1 } })}\n`)
            stdout.end()
            stderr.end()
          })
        },
      }
      return { stdout, stderr, stdin, kill() { return true } }
    }) as never,
  })

  await assert.rejects(async () => {
    for await (const _chunk of driver.executeTurn({ sessionId: 'agy-mismatch', providerSessionId: 'expected-conversation', messages: [], prompt: '继续' })) {}
  }, /Antigravity 恢复会话不一致/)
  driver.dispose()
})

test('Antigravity result 非成功状态转换为 error 终态', async () => {
  const driver = new AntigravityDriver({
    binaries: ['fake-agy'],
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.2.14', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = {
        end(): void {
          queueMicrotask(() => {
            stdout.write(`${JSON.stringify({ event: 'result', result: { conversation_id: 'agy-error', status: 'FAILURE', error: '模型失败', num_turns: 1 } })}\n`)
            stdout.end()
            stderr.end()
          })
        },
      }
      return { stdout, stderr, stdin, kill() { return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'agy-error', messages: [], prompt: '失败' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'agy-error' },
    { type: 'finish', reason: 'error', failure: { message: '模型失败' } },
  ])
  driver.dispose()
})

test('Antigravity 子进程提前退出或 stdin 断开时不会触发宿主未捕获异常', async () => {
  const driver = new AntigravityDriver({
    binaries: ['fake-agy'],
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.2.14', stderr: '' })) as never,
    spawn: (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        stdin: EventEmitter & { end(value?: string): void }
        kill(): boolean
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = Object.assign(new EventEmitter(), {
        end(): void {
          queueMicrotask(() => child.stdin.emit('error', new Error('write EPIPE')))
        },
      })
      child.kill = () => true
      queueMicrotask(() => {
        child.stderr.end('agy failed')
        child.stdout.end()
        child.emit('close', 2)
      })
      return child
    }) as never,
  })

  await assert.rejects(async () => {
    for await (const _chunk of driver.executeTurn({ sessionId: 'agy-failed', messages: [], prompt: '你好' })) {}
  }, /Antigravity 执行失败：agy failed/)
  driver.dispose()
})

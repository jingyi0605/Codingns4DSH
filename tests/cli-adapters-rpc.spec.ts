import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { CodexAppServerDriver } from '../data/build/dist/host/cli-adapters/codex-driver.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'
import { GrokBuildDriver } from '../data/build/dist/host/cli-adapters/grok-driver.js'
import { PiAgentDriver } from '../data/build/dist/host/cli-adapters/pi-driver.js'

test('三个 RPC 驱动按各自协议完成握手并转换文本事件', async () => {
  for (const [Driver, expectedArgs] of [
    [PiAgentDriver, ['--mode', 'rpc']],
    [CodexAppServerDriver, ['-c', 'features.request_permissions_tool=true', 'app-server', '--disable', 'computer_use', '--enable', 'default_mode_request_user_input']],
    [GrokBuildDriver, ['agent', '--no-leader', 'stdio']],
  ] as const) {
    const calls: string[][] = []
    let killed = false
    const driver = new Driver({
      binaries: ['fake-agent'],
      spawnSync: (() => ({ status: 0, stdout: 'fake-agent 1.2.3', stderr: '' })) as never,
      spawn: ((command: string, args: string[]) => {
        calls.push([command, ...args])
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const stdin = {
          write(data: string): void {
            const request = JSON.parse(data) as { id: number; method?: string; type?: string; params?: unknown }
            const command = request.method ?? request.type
            let result: Record<string, unknown> = {}
            if (command === 'thread/start') result = { threadId: 'thread-1' }
            if (command === 'session/new') {
              assert.deepEqual(request.params, { cwd: process.cwd(), mcpServers: [] })
              result = { sessionId: 'session-1' }
            }
            if (command === 'prompt') {
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'message_update', params: { type: 'text_delta', delta: '完成' } })}\n`)
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
              setImmediate(() => stdout.write(`${JSON.stringify({ type: 'agent_settled' })}\n`))
              return
            }
            if (command === 'session/prompt') {
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'message_update', params: { type: 'text_delta', delta: '完成' } })}\n`)
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
              return
            }
            if (command === 'turn/start') {
              result = { turn: { id: 'turn-1', status: 'inProgress' } }
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
              setImmediate(() => {
                stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: '完成' } })}\n`)
                stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })}\n`)
              })
            } else {
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
            }
          },
        }
        return { stdout, stderr, stdin, kill() { killed = true; stdout.end(); stderr.end(); return true } }
      }) as never,
    })
    const chunks = []
    for await (const chunk of driver.executeTurn({ sessionId: 's1', messages: [], prompt: '你好' })) chunks.push(chunk)
    assert.deepEqual(calls[0], ['fake-agent', ...expectedArgs])
    driver.dispose()
    assert.deepEqual(chunks.filter((chunk) => chunk.type !== 'session-binding'), Driver === CodexAppServerDriver
      ? [{ type: 'text-delta', text: '完成', messageId: 'message-1' }, { type: 'finish', reason: 'stop' }]
      : [{ type: 'text-delta', text: '完成' }, { type: 'finish', reason: 'stop' }])
    assert.equal(killed, true)
  }
})

test('Codex turn/start 将图片附件作为 localImage 传递，并为文件保留可读取路径', async () => {
  let turnStartParams: Record<string, unknown> | undefined
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'attachment-thread' } } })}\n`)
          return
        }
        if (request.method === 'turn/start') {
          turnStartParams = request.params
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'attachment-turn', status: 'inProgress' } } })}\n`)
          setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'attachment-thread', turn: { id: 'attachment-turn', status: 'completed' } } })}\n`))
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  for await (const _chunk of driver.executeTurn({
    sessionId: 'codex-attachments',
    messages: [],
    prompt: '请检查附件文件。\n\n附件文件「说明.txt」位于：/tmp/说明.txt\n请使用工具读取该文件的内容。',
    attachments: [
      { kind: 'image', path: '/tmp/photo.png', name: 'photo.png', mimeType: 'image/png' },
      { kind: 'file', path: '/tmp/说明.txt', name: '说明.txt', mimeType: 'text/plain' },
    ],
  })) { /* 只验证发出的 RPC 参数 */ }

  assert.deepEqual(turnStartParams?.input, [
    { type: 'text', text: '请检查附件文件。\n\n附件文件「说明.txt」位于：/tmp/说明.txt\n请使用工具读取该文件的内容。' },
    { type: 'localImage', path: '/tmp/photo.png' },
  ])
  driver.dispose()
})

test('Codex Skill 目录可被列出，并在显式 mention 时补充原生 skill 输入项', async () => {
  let turnStartParams: Record<string, unknown> | undefined
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> }
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        if (request.method === 'skills/list') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { data: [{ cwd: '/workspace/', skills: [{ name: 'pdf', description: '处理 PDF 文档', enabled: true, path: '/workspace/.agents/skills/pdf/SKILL.md', interface: { displayName: 'PDF 工具' } }, { name: 'disabled', description: '不可用', enabled: false, path: '/workspace/.agents/skills/disabled/SKILL.md' }] }] } })}\n`)
          return
        }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'skill-thread' } } })}\n`)
          return
        }
        if (request.method === 'turn/start') {
          turnStartParams = request.params
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'skill-turn', status: 'inProgress' } } })}\n`)
          setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'skill-thread', turn: { id: 'skill-turn', status: 'completed' } } })}\n`))
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const catalog = await driver.listSkills({ sessionId: 'codex-skills', cwd: '/workspace', forceReload: true })
  assert.deepEqual(catalog, [
    { id: 'pdf', name: 'pdf', description: '处理 PDF 文档', enabled: true, displayName: 'PDF 工具' },
    { id: 'disabled', name: 'disabled', description: '不可用', enabled: false },
  ])

  for await (const _chunk of driver.executeTurn({
    sessionId: 'codex-skills',
    messages: [],
    prompt: '/pdf 请检查这个文档',
    cwd: '/workspace',
  })) { /* 只验证发出的 RPC 参数 */ }

  assert.deepEqual(turnStartParams?.input, [
    { type: 'text', text: '/pdf 请检查这个文档' },
    { type: 'skill', name: 'pdf', path: '/workspace/.agents/skills/pdf/SKILL.md' },
  ])
  driver.dispose()
})

test('RPC 驱动在命令不存在时返回未安装和空模型目录', async () => {
  const driver = new PiAgentDriver({ binaries: ['missing-agent'], spawnSync: (() => ({ status: 127, stdout: '', stderr: '' })) as never })
  assert.deepEqual(await driver.detect(), { installed: false, version: null, command: null })
  assert.deepEqual(await driver.listModels(), { groups: [], currentModel: null, currentEffort: null })
})

test('Pi RPC 保留工具执行的参数、增量结果和完成状态', async () => {
  const driver = new PiAgentDriver({
    binaries: ['fake-pi'],
    spawnSync: (() => ({ status: 0, stdout: 'pi 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method?: string; type?: string }
        const command = request.method ?? request.type
        if (command !== 'prompt') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'tool_execution_start', toolCallId: 'pi-call-1', toolName: 'bash', args: { command: 'pwd' } } })}\n`)
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'tool_execution_update', toolCallId: 'pi-call-1', toolName: 'bash', partialResult: '/work' } })}\n`)
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'tool_execution_end', toolCallId: 'pi-call-1', toolName: 'bash', result: '/workspace', isError: false } })}\n`)
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { accepted: true } })}\n`)
        setImmediate(() => stdout.write(`${JSON.stringify({ type: 'agent_settled' })}\n`))
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'pi-tools', messages: [], prompt: '执行' })) chunks.push(chunk)
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'tool-event'), [
    { type: 'tool-event', toolName: 'bash', callId: 'pi-call-1', input: '{"command":"pwd"}', status: 'running' },
    { type: 'tool-event', toolName: 'bash', callId: 'pi-call-1', output: '/work', outputMode: 'snapshot', status: 'running' },
    { type: 'tool-event', toolName: 'bash', callId: 'pi-call-1', output: '/workspace', outputMode: 'snapshot', status: 'completed' },
  ])
  driver.dispose()
})

test('Codex 恢复线程后按 DSH 选择纠正线程模型，避免沿用被污染的旧模型', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string; params: Record<string, unknown> }
        calls.push({ method: request.method, params: request.params ?? {} })
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        if (request.method === 'thread/resume') {
          // 线程持久化的模型是历史路由错误写入的 DSH 主模型。
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'resumed-thread' }, model: 'deepseek-v4.1-flash' } })}\n`)
          return
        }
        if (request.method === 'thread/settings/update') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { model: request.params.model } })}\n`)
          return
        }
        if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'resumed-turn', status: 'inProgress' } } })}\n`)
          setImmediate(() => {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'resumed-thread', turnId: 'resumed-turn', itemId: 'message-1', delta: '完成' } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'resumed-thread', turn: { id: 'resumed-turn', status: 'completed' } } })}\n`)
          })
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({
    sessionId: 'codex-model-align',
    messages: [],
    prompt: '继续',
    providerSessionId: 'resumed-thread',
    modelId: 'gpt-6.1-sol',
  })) chunks.push(chunk)

  const correction = calls.find((call) => call.method === 'thread/settings/update')
  assert.notEqual(correction, undefined)
  assert.deepEqual(correction?.params, { threadId: 'resumed-thread', model: 'gpt-6.1-sol' })
  // 纠正必须发生在 turn/start 之前，否则本轮仍会用旧模型发出请求。
  assert.equal(calls.findIndex((call) => call.method === 'thread/settings/update')
    < calls.findIndex((call) => call.method === 'turn/start'), true)
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === '完成'), true)
  driver.dispose()
})

test('Codex app-server 保留 item 工具生命周期和失败结果', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'codex-thread' } } })}\n`)
          return
        }
        if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'codex-turn', status: 'inProgress' } } })}\n`)
          setImmediate(() => {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'codex-thread', turnId: 'codex-turn', item: { type: 'commandExecution', id: 'codex-call-1', command: 'exit 2', status: 'inProgress' } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'codex-thread', turnId: 'codex-turn', item: { type: 'commandExecution', id: 'codex-call-1', command: 'exit 2', aggregated_output: '失败输出', exitCode: 2, status: 'failed' } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'codex-thread', turn: { id: 'codex-turn', status: 'completed' } } })}\n`)
          })
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-tools', messages: [], prompt: '执行' })) chunks.push(chunk)
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'tool-event'), [
    { type: 'tool-event', toolName: 'command_execution', callId: 'codex-call-1', input: 'exit 2', status: 'running' },
    { type: 'tool-event', toolName: 'command_execution', callId: 'codex-call-1', input: 'exit 2', error: '失败输出', status: 'failed' },
  ])
  driver.dispose()
})

test('Codex 在同一个 provider turn 内保留多个工具调用，不人为拆分 step', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'segmented-thread' } } })}\n`)
          return
        }
        if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'segmented-turn', status: 'inProgress' } } })}\n`)
          setImmediate(() => {
            const event = (method: string, item: Record<string, unknown>): void => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: { threadId: 'segmented-thread', turnId: 'segmented-turn', item } })}\n`)
            event('item/started', { type: 'commandExecution', id: 'call-1', command: 'pwd', status: 'inProgress' })
            event('item/completed', { type: 'commandExecution', id: 'call-1', command: 'pwd', aggregated_output: '/one', status: 'completed' })
            event('item/started', { type: 'commandExecution', id: 'call-2', command: 'ls', status: 'inProgress' })
            event('item/completed', { type: 'commandExecution', id: 'call-2', command: 'ls', aggregated_output: 'two', status: 'completed' })
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'segmented-thread', turnId: 'segmented-turn', itemId: 'message-1', delta: '完成' } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'segmented-thread', turn: { id: 'segmented-turn', status: 'completed' } } })}\n`)
          })
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'segmented', messages: [], prompt: '执行', splitToolSteps: true })) chunks.push(chunk)

  assert.equal(driver.supportsSegmentedTurns, true)
  assert.deepEqual(chunks.filter((chunk) => chunk.type), [
    { type: 'session-binding', providerSessionId: 'segmented-thread' },
    { type: 'tool-event', toolName: 'command_execution', callId: 'call-1', input: 'pwd', status: 'running' },
    { type: 'tool-event', toolName: 'command_execution', callId: 'call-1', input: 'pwd', output: '/one', outputMode: 'snapshot', status: 'completed' },
    { type: 'tool-event', toolName: 'command_execution', callId: 'call-2', input: 'ls', status: 'running' },
    { type: 'tool-event', toolName: 'command_execution', callId: 'call-2', input: 'ls', output: 'two', outputMode: 'snapshot', status: 'completed' },
    { type: 'text-delta', text: '完成', messageId: 'message-1' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Codex 只在 assistant item 切换后分段，同一 assistant 的多个工具保持同一 step', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'message-boundary-thread' } } })}\n`)
          return
        }
        if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'message-boundary-turn', status: 'inProgress' } } })}\n`)
          setImmediate(() => {
            const event = (method: string, item: Record<string, unknown>): void => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: { threadId: 'message-boundary-thread', turnId: 'message-boundary-turn', item } })}\n`)
            const text = (itemId: string, delta: string): void => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'message-boundary-thread', turnId: 'message-boundary-turn', itemId, delta } })}\n`)
            text('assistant-1', '先检查')
            event('item/started', { type: 'commandExecution', id: 'call-1', command: 'pwd', status: 'inProgress' })
            event('item/completed', { type: 'commandExecution', id: 'call-1', command: 'pwd', aggregated_output: '/one', status: 'completed' })
            event('item/started', { type: 'commandExecution', id: 'call-2', command: 'ls', status: 'inProgress' })
            event('item/completed', { type: 'commandExecution', id: 'call-2', command: 'ls', aggregated_output: 'two', status: 'completed' })
            text('assistant-2', '再总结')
            event('item/started', { type: 'commandExecution', id: 'call-3', command: 'cat README.md', status: 'inProgress' })
            event('item/completed', { type: 'commandExecution', id: 'call-3', command: 'cat README.md', aggregated_output: 'done', status: 'completed' })
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'message-boundary-thread', turn: { id: 'message-boundary-turn', status: 'completed' } } })}\n`)
          })
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const first = []
  for await (const chunk of driver.executeTurn({ sessionId: 'message-boundary', messages: [], prompt: '执行', splitToolSteps: true })) first.push(chunk)
  assert.deepEqual(first.map(({ type }) => type), [
    'session-binding', 'text-delta', 'tool-event', 'tool-event', 'tool-event', 'tool-event', 'step-boundary',
  ])

  const second = []
  for await (const chunk of driver.executeTurn({ sessionId: 'message-boundary', messages: [], prompt: '继续', splitToolSteps: true, resumeSegmentedTurn: true })) second.push(chunk)
  assert.deepEqual(second.map(({ type }) => type), ['text-delta', 'tool-event', 'tool-event', 'finish'])
  driver.dispose()
})

test('Codex 一轮结束后再次对话必须重新发起 turn/start，不会被已结束的分段吞掉', async () => {
  const turnStarts: string[] = []
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'restart-thread' } } })}\n`)
          return
        }
        if (request.method === 'turn/start') {
          const turnId = `restart-turn-${turnStarts.length + 1}`
          turnStarts.push(turnId)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } })}\n`)
          setImmediate(() => {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'restart-thread', turnId, itemId: `message-${turnStarts.length}`, delta: `第${turnStarts.length}轮回复` } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'restart-thread', turn: { id: turnId, status: 'completed' } } })}\n`)
          })
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const first = []
  for await (const chunk of driver.executeTurn({ sessionId: 'restart-session', messages: [], prompt: '第一轮', splitToolSteps: true })) first.push(chunk)
  // 上一轮已经结束：新用户回合没有续段声明，必须丢弃残留分段并重新 turn/start。
  const second = []
  for await (const chunk of driver.executeTurn({ sessionId: 'restart-session', messages: [], prompt: '第二轮', splitToolSteps: true })) second.push(chunk)

  assert.deepEqual(first.map(({ type }) => type), ['session-binding', 'text-delta', 'finish'])
  assert.deepEqual(second.map(({ type }) => type), ['session-binding', 'text-delta', 'finish'])
  assert.deepEqual(second.filter((chunk) => chunk.type === 'text-delta'), [{ type: 'text-delta', text: '第2轮回复', messageId: 'message-2' }])
  assert.deepEqual(turnStarts, ['restart-turn-1', 'restart-turn-2'])
  driver.dispose()
})

test('Codex 取消后丢弃分段运行，下一轮重新 turn/start 而不是续接旧段', async () => {
  const turnStarts: number[] = []
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'discard-thread' } } })}\n`)
          return
        }
        if (request.method === 'turn/start') {
          turnStarts.push(turnStarts.length + 1)
          const turnId = `discard-turn-${turnStarts.length}`
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } })}\n`)
          setImmediate(() => {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'discard-thread', turnId, itemId: `assistant-${turnStarts.length}`, delta: '先检查' } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'discard-thread', turnId, item: { type: 'commandExecution', id: 'call-1', command: 'pwd', aggregated_output: '/tmp', status: 'completed' } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'discard-thread', turnId, itemId: `assistant-${turnStarts.length}-next`, delta: '继续处理' } })}\n`)
          })
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const first = []
  for await (const chunk of driver.executeTurn({ sessionId: 'discard-session', messages: [], prompt: '执行', splitToolSteps: true })) first.push(chunk)
  assert.equal(first.at(-1)?.type, 'step-boundary')

  driver.discardSegmentedTurn?.('discard-session')
  const second = []
  for await (const chunk of driver.executeTurn({ sessionId: 'discard-session', messages: [], prompt: '新问题', splitToolSteps: true })) second.push(chunk)

  assert.deepEqual(second.map(({ type }) => type), ['session-binding', 'text-delta', 'tool-event', 'step-boundary'])
  assert.deepEqual(turnStarts, [1, 2])
  driver.dispose()
})

test('Codex app-server 解析 tokenUsage.last 并传递上下文窗口占用', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'codex-usage-thread' } } })}\n`)
          return
        }
        if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'codex-usage-turn', status: 'inProgress' } } })}\n`)
          setImmediate(() => {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'codex-usage-thread', tokenUsage: { last: { input_tokens: 32000, cached_input_tokens: 8000, output_tokens: 120, total_tokens: 32120 }, contextWindow: 258400 } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'codex-usage-thread', turn: { id: 'codex-usage-turn', status: 'completed' } } })}\n`)
          })
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-usage', messages: [], prompt: '统计用量' })) chunks.push(chunk)
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'usage'), [{
    type: 'usage', inputTokens: 32000, outputTokens: 120, cacheReadTokens: 8000,
    uncachedInputTokens: 24000, totalTokens: 32120, cacheHitRate: 25,
    contextWindow: 258400, contextTokens: 32000, contextUsageRatio: 0.123839,
  }])
  driver.dispose()
})

test('Codex 同一会话第二轮的冲突 usage 窗口不会覆盖首轮 256K', async () => {
  let turnCount = 0
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'codex-stable-window' } } })}\n`)
          return
        }
        if (request.method === 'turn/start') {
          turnCount += 1
          const turnId = `codex-stable-turn-${turnCount}`
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } })}\n`)
          setImmediate(() => {
            const contextWindow = turnCount === 1 ? 258400 : 1000000
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'codex-stable-window', tokenUsage: { last: { input_tokens: 258000, output_tokens: 4, total_tokens: 258004 }, contextWindow } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'codex-stable-window', turn: { id: turnId, status: 'completed' } } })}\n`)
          })
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const first = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-stable-window', messages: [], prompt: '第一轮' })) first.push(chunk)
  const second = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-stable-window', messages: [], prompt: '第二轮' })) second.push(chunk)

  assert.equal(first.find((chunk) => chunk.type === 'usage')?.contextWindow, 258400)
  assert.equal(second.find((chunk) => chunk.type === 'usage')?.contextWindow, 258400)
  assert.equal(second.at(-1)?.type, 'finish')
  assert.equal(second.at(-1)?.reason, 'stop')
  driver.dispose()
})

test('Codex 上下文超限时自动压缩并重试第二轮', async () => {
  const methods: string[] = []
  let turnStarts = 0
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        methods.push(request.method)
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'compact-thread' } } })}\n`)
          return
        }
        if (request.method === 'thread/compact/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          setImmediate(() => {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'compact-thread', turn: { id: 'compact-turn', status: 'inProgress' } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'compact-thread', turnId: 'compact-turn', item: { type: 'contextCompaction', id: 'compact-item' } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'compact-thread', turn: { id: 'compact-turn', status: 'completed' } } })}\n`)
          })
          return
        }
        if (request.method !== 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        turnStarts += 1
        if (turnStarts === 2) {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, data: { codexErrorInfo: 'contextWindowExceeded' } } })}\n`)
          return
        }
        const turnId = `compact-turn-${turnStarts}`
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } })}\n`)
        setImmediate(() => {
          const usage = turnStarts === 1
            ? { input_tokens: 99, output_tokens: 1, total_tokens: 100 }
            : { input_tokens: 12, output_tokens: 1, total_tokens: 13 }
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'compact-thread', tokenUsage: { last: usage, contextWindow: 100 } } })}\n`)
          if (turnStarts > 1) stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'compact-thread', turnId, itemId: 'compact-message', delta: '压缩后继续' } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'compact-thread', turn: { id: turnId, status: 'completed' } } })}\n`)
        })
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const first = []
  for await (const chunk of driver.executeTurn({ sessionId: 'compact-session', messages: [], prompt: '第一轮' })) first.push(chunk)
  const second = []
  for await (const chunk of driver.executeTurn({ sessionId: 'compact-session', messages: [], prompt: '第二轮' })) second.push(chunk)

  assert.equal(methods.filter((method) => method === 'thread/compact/start').length, 1)
  assert.equal(methods.filter((method) => method === 'turn/start').length, 3)
  assert.deepEqual(second.filter((chunk) => chunk.type === 'context-compaction').map((chunk) => chunk.phase), ['start', 'end'])
  assert.equal(second.find((chunk) => chunk.type === 'text-delta')?.text, '压缩后继续')
  assert.equal(second.at(-1)?.reason, 'stop')
  driver.dispose()
})

test('Codex 上下文恰好达到窗口上限时在下一轮前主动压缩', async () => {
  const methods: string[] = []
  let turnStarts = 0
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        methods.push(request.method)
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'exact-window-thread' } } })}\n`)
          return
        }
        if (request.method === 'thread/compact/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/compacted', params: { threadId: 'exact-window-thread' } })}\n`))
          return
        }
        if (request.method !== 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        turnStarts += 1
        const turnId = `exact-window-turn-${turnStarts}`
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } })}\n`)
        setImmediate(() => {
          const usage = turnStarts === 1
            ? { input_tokens: 100, output_tokens: 1, total_tokens: 101 }
            : { input_tokens: 12, output_tokens: 1, total_tokens: 13 }
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'exact-window-thread', tokenUsage: { last: usage, contextWindow: 100 } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'exact-window-thread', turn: { id: turnId, status: 'completed' } } })}\n`)
        })
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  for await (const _chunk of driver.executeTurn({ sessionId: 'exact-window-session', messages: [], prompt: '第一轮' })) { /* 消费首轮 */ }
  const second: Array<{ type: string; phase?: string }> = []
  for await (const chunk of driver.executeTurn({ sessionId: 'exact-window-session', messages: [], prompt: '第二轮' })) {
    if (chunk.type === 'context-compaction' || chunk.type === 'finish') second.push(chunk)
  }

  assert.equal(methods.filter((method) => method === 'thread/compact/start').length, 1)
  assert.deepEqual(second.filter((chunk) => chunk.type === 'context-compaction').map((chunk) => chunk.phase), ['start', 'end'])
  assert.equal(second.at(-1)?.type, 'finish')
  driver.dispose()
})

test('Codex 第二轮不会被响应前迟到的旧 turn/completed 直接结束', async () => {
  let turnCount = 0
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'stale-thread' } } })}\n`)
          return
        }
        if (request.method !== 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        turnCount += 1
        const turnId = `stale-turn-${turnCount}`
        if (turnCount === 2) stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'stale-thread', turn: { status: 'completed' } } })}\n`)
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } })}\n`)
        setImmediate(() => {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'stale-thread', turnId, itemId: turnId, delta: '第二轮有效回复' } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'stale-thread', turn: { id: turnId, status: 'completed' } } })}\n`)
        })
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  for await (const _chunk of driver.executeTurn({ sessionId: 'stale-session', messages: [], prompt: '第一轮' })) { /* 消费第一轮 */ }
  const second = []
  for await (const chunk of driver.executeTurn({ sessionId: 'stale-session', messages: [], prompt: '第二轮' })) second.push(chunk)
  assert.equal(second.find((chunk) => chunk.type === 'text-delta')?.text, '第二轮有效回复')
  assert.equal(second.at(-1)?.reason, 'stop')
  driver.dispose()
})

test('Codex 独立压缩 turn 的 item 通知不会被当前 turn 过滤器丢弃', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'auto-compact-thread' } } })}\n`)
          return
        }
        if (request.method !== 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'user-turn', status: 'inProgress' } } })}\n`)
        setImmediate(() => {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'auto-compact-thread', tokenUsage: { last: { input_tokens: 99, output_tokens: 1, total_tokens: 100 }, contextWindow: 100 } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'auto-compact-thread', turnId: 'compact-turn', item: { type: 'contextCompaction', id: 'compact-item' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'auto-compact-thread', turnId: 'compact-turn', item: { type: 'contextCompaction', id: 'compact-item', summary: '已压缩旧上下文' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/compacted', params: { threadId: 'auto-compact-thread', summary: '已压缩旧上下文' } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'auto-compact-thread', turnId: 'user-turn', itemId: 'user-message', delta: '继续回答' } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'auto-compact-thread', turn: { id: 'user-turn', status: 'completed' } } })}\n`)
        })
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'auto-compact-session', messages: [], prompt: '继续' })) chunks.push(chunk)
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'context-compaction').map((chunk) => chunk.phase), ['start', 'summary', 'end'])
  assert.equal(chunks.find((chunk) => chunk.type === 'context-compaction' && chunk.phase === 'summary')?.shadowedTokenCount, 99)
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === '继续回答'), true)
  assert.equal(chunks.at(-1)?.type, 'finish')
  driver.dispose()
})

test('Codex 只发送 contextCompaction item 时自动闭合压缩事务', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'item-only-thread' } } })}\n`)
          return
        }
        if (request.method !== 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'user-turn', status: 'inProgress' } } })}\n`)
        setImmediate(() => {
          // Codex 0.158 起 thread/compacted 已废弃：自动压缩只发布 item 生命周期，
          // 适配器必须在 item/completed 之后自行闭合压缩事务。
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'item-only-thread', turnId: 'compact-turn', item: { type: 'contextCompaction', id: 'compact-item' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'item-only-thread', turnId: 'compact-turn', item: { type: 'contextCompaction', id: 'compact-item' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'item-only-thread', turnId: 'user-turn', itemId: 'user-message', delta: '继续回答' } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'item-only-thread', turn: { id: 'user-turn', status: 'completed' } } })}\n`)
        })
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'item-only-session', messages: [], prompt: '继续' })) chunks.push(chunk)
  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === 'context-compaction').map((chunk) => `${chunk.phase}:${String(chunk.compactionId)}`),
    ['start:compact-item', 'summary:compact-item', 'end:compact-item'],
  )
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === '继续回答'), true)
  assert.equal(chunks.at(-1)?.type, 'finish')
  driver.dispose()
})

test('Codex 压缩中途结束回合时补写压缩结束事件', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'dangling-thread' } } })}\n`)
          return
        }
        if (request.method !== 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'user-turn', status: 'inProgress' } } })}\n`)
        setImmediate(() => {
          // 压缩尚未完成，回合已经终结：必须补一个 end，避免会话日志残留
          // 未闭合 compaction 让历史加载失败。
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'dangling-thread', turnId: 'compact-turn', item: { type: 'contextCompaction', id: 'dangling-item' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'dangling-thread', turn: { id: 'user-turn', status: 'completed' } } })}\n`)
        })
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dangling-session', messages: [], prompt: '继续' })) chunks.push(chunk)
  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === 'context-compaction').map((chunk) => `${chunk.phase}:${String(chunk.compactionId)}`),
    ['start:dangling-item', 'end:dangling-item'],
  )
  assert.equal(chunks.at(-1)?.type, 'finish')
  driver.dispose()
})

test('Codex 自动压缩后第二轮使用压缩后的上下文状态', async () => {
  const methods: string[] = []
  let turnCount = 0
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        methods.push(request.method)
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'auto-reset-thread' } } })}\n`)
          return
        }
        if (request.method !== 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        turnCount += 1
        const turnId = `auto-reset-turn-${turnCount}`
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } })}\n`)
        setImmediate(() => {
          const usage = turnCount === 1
            ? { input_tokens: 99, output_tokens: 1, total_tokens: 100 }
            : { input_tokens: 12, output_tokens: 1, total_tokens: 13 }
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'auto-reset-thread', tokenUsage: { last: usage, contextWindow: 100 } } })}\n`)
          if (turnCount === 1) {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'auto-reset-thread', turnId: 'auto-reset-compact', item: { type: 'contextCompaction', id: 'auto-reset-item' } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'auto-reset-thread', turnId: 'auto-reset-compact', item: { type: 'contextCompaction', id: 'auto-reset-item', summary: '已自动压缩' } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/compacted', params: { threadId: 'auto-reset-thread', summary: '已自动压缩' } })}\n`)
          }
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'auto-reset-thread', turnId, itemId: turnId, delta: `第${turnCount}轮` } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'auto-reset-thread', turn: { id: turnId, status: 'completed' } } })}\n`)
        })
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const first = []
  for await (const chunk of driver.executeTurn({ sessionId: 'auto-reset-session', messages: [], prompt: '第一轮' })) first.push(chunk)
  const second = []
  for await (const chunk of driver.executeTurn({ sessionId: 'auto-reset-session', messages: [], prompt: '第二轮' })) second.push(chunk)

  assert.equal(first.some((chunk) => chunk.type === 'context-compaction'), true)
  assert.equal(second.find((chunk) => chunk.type === 'usage')?.contextTokens, 12)
  assert.equal(methods.filter((method) => method === 'thread/compact/start').length, 0)
  assert.equal(second.at(-1)?.reason, 'stop')
  driver.dispose()
})

test('Codex 空回合不得伪装成正常 stop', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'codex-empty' } } })}\n`)
          return
        }
        if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'codex-empty-turn', status: 'inProgress' } } })}\n`)
          setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'codex-empty', turn: { id: 'codex-empty-turn', status: 'completed' } } })}\n`))
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-empty', messages: [], prompt: '第二句话' })) chunks.push(chunk)
  assert.deepEqual(chunks.filter((chunk) => chunk.type !== 'session-binding'), [
    { type: 'text-delta', text: 'CODINGNS_PROVIDER_EMPTY_RESPONSE: Codex Provider 未返回任何有效事件。' },
    { type: 'finish', reason: 'error' },
  ])
  driver.dispose()
})

test('Grok ACP 保留 tool_call 与 tool_call_update 的结构化字段', async () => {
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'],
    spawnSync: (() => ({ status: 0, stdout: 'grok 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'session/new') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'grok-session' } })}\n`)
          return
        }
        if (request.method === 'session/prompt') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'grok-call-1', title: 'search', status: 'running', rawInput: { query: 'DSH' }, agentId: 'agent-1', detail: '搜索工作区' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'grok-call-1', title: 'search', status: 'completed', rawOutput: { count: 2 } } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'turn_completed' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'grok-tools', messages: [], prompt: '搜索' })) chunks.push(chunk)
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'tool-event'), [
    { type: 'tool-event', toolName: 'search', callId: 'grok-call-1', input: '{"query":"DSH"}', agentId: 'agent-1', detail: '搜索工作区', status: 'running' },
    { type: 'tool-event', toolName: 'search', callId: 'grok-call-1', output: '{"count":2}', outputMode: 'snapshot', status: 'completed' },
  ])
  driver.dispose()
})

test('Grok ask_user_question 真实事件经过原生问题入口闭环保留 toolCallId 并使用私有 outcome', { timeout: 5_000 }, async () => {
  const replay = createGrokQuestionReplay()
  const chunks = []
  const cards = []
  const calls = []
  const results = []
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'grok', sessionId: 'grok-question',
    nativeSessions: {
      async askQuestions(sessionId, request) {
        cards.push({ sessionId, request })
        return { requestId: request.requestId, answers: [{ id: request.questions[0].id, selected: ['是 (Recommended)'] }] }
      },
      appendToolCall(sessionId, call) {
        calls.push(call)
        return { sessionId, turn: 1, step: 1, callId: call.callId, callSeq: 1 }
      },
      appendToolResult(handle, result) { results.push({ handle, result }); return true },
    },
    respondQuestion: (response) => replay.driver.respondQuestion('grok-question', response),
  })
  for await (const chunk of replay.driver.executeTurn({ sessionId: 'grok-question', messages: [], prompt: '请使用提问组件向我提问' })) {
    chunks.push(chunk)
    if (chunk.type === 'question-request') {
      assert.equal(chunk.requestId, replay.callId)
      assert.equal(chunk.callId, replay.callId)
      assert.deepEqual(chunk.questions, [{
        id: 'question-1',
        question: '你好！正在测试提问功能。请回答：',
        options: [{ label: '是 (Recommended)', description: '是的，这是测试正常。' }, { label: '否', description: '不是，我需要更多信息。' }],
      }])
    }
    await projector.push(chunk)
  }
  assert.deepEqual(replay.replies, [{ id: 77, result: {
    outcome: 'accepted', answers: { '你好！正在测试提问功能。请回答：': ['是 (Recommended)'] },
  } }])
  assert.equal(chunks.filter((chunk) => chunk.type === 'question-request').length, 1)
  assert.equal(cards.length, 1)
  assert.deepEqual(cards[0], { sessionId: 'grok-question', request: {
    requestId: replay.callId, questions: chunks.find((chunk) => chunk.type === 'question-request').questions,
  } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].callId, replay.callId)
  assert.deepEqual(JSON.parse(calls[0].arguments), cards[0].request)
  assert.equal(results.length, 1)
  assert.equal(results[0].handle.callId, replay.callId)
  assert.deepEqual(JSON.parse(results[0].result.output).answers, [{ id: 'question-1', selected: ['是 (Recommended)'] }])
  assert.equal(chunks.some((chunk) => chunk.type === 'tool-event'), false)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'stop' })
  assert.match(String(replay.prompt[0]?.text), /ask_user_question 属于 grok_build 内建工具，不依赖 MCP 服务器/u)
  assert.deepEqual(replay.prompt.at(-1), { type: 'text', text: '请使用提问组件向我提问' })
  replay.driver.dispose()
})

test('Grok 问题卡回答先于私有请求时暂存答案，连续回合仍可提问', { timeout: 5_000 }, async () => {
  const replay = createGrokQuestionReplay({ deferRequest: true, method: 'x.ai/ask_user_question' })
  for (let turn = 0; turn < 2; turn++) {
    let questionCount = 0
    for await (const chunk of replay.driver.executeTurn({ sessionId: 'grok-early-answer', messages: [], prompt: '提问' })) {
      if (chunk.type !== 'question-request') continue
      questionCount++
      replay.driver.respondQuestion('grok-early-answer', {
        requestId: chunk.requestId, answers: [{ id: 'question-1', selected: [], custom: '用户自由文本' }],
      })
      assert.equal(replay.replies.length, turn)
      replay.sendRequest()
    }
    assert.equal(questionCount, 1)
  }
  assert.deepEqual(replay.replies, [77, 78].map((id) => ({ id, result: {
    outcome: 'accepted',
    answers: { '你好！正在测试提问功能。请回答：': ['Other'] },
    annotations: { '你好！正在测试提问功能。请回答：': { notes: '用户自由文本' } },
  } })))
  replay.driver.dispose()
})

test('Grok 问题卡关闭时回传私有 cancelled 并清理旧回合', { timeout: 5_000 }, async () => {
  const replay = createGrokQuestionReplay()
  for await (const chunk of replay.driver.executeTurn({ sessionId: 'grok-dismiss-question', messages: [], prompt: '提问' })) {
    if (chunk.type === 'question-request') {
      // 让反向请求处理器登记 RPC id，再模拟原生问题卡关闭导致消费者提前结束。
      await new Promise<void>((resolve) => setImmediate(resolve))
      break
    }
  }
  assert.deepEqual(replay.replies, [{ id: 77, result: { outcome: 'cancelled' } }])
  replay.driver.dispose()
})

test('Grok 多选和补充文字按问题原文回传，不使用 ACP elicitation 格式', { timeout: 5_000 }, async () => {
  const replay = createGrokQuestionReplay({ questions: [
    { question: '选择语言', options: [{ label: 'TypeScript', description: '前端' }, { label: 'Rust', description: '后端' }], multiSelect: true },
    { question: '补充要求', options: [{ label: '默认', description: '使用默认配置' }] },
  ] })
  for await (const chunk of replay.driver.executeTurn({ sessionId: 'grok-multiple', messages: [], prompt: '提问' })) {
    if (chunk.type !== 'question-request') continue
    assert.equal(chunk.questions[0].multiSelect, true)
    replay.driver.respondQuestion('grok-multiple', { requestId: chunk.requestId, answers: [
      { id: 'question-1', selected: ['TypeScript', 'Rust'], custom: '保持兼容' },
      { id: 'question-2', selected: [], custom: '使用中文' },
    ] })
  }
  assert.deepEqual(replay.replies, [{ id: 77, result: {
    outcome: 'accepted',
    answers: { '选择语言': ['TypeScript', 'Rust'], '补充要求': ['Other'] },
    annotations: { '选择语言': { notes: '保持兼容' }, '补充要求': { notes: '使用中文' } },
  } }])
  replay.driver.dispose()
})

/** 保存用户真实 updates.jsonl 的参数；反向请求信封按上游公开类型补齐。 */
function createGrokQuestionReplay(options: { deferRequest?: boolean; method?: string; questions?: readonly Record<string, unknown>[] } = {}) {
  const updates = readFileSync(new URL('./fixtures/grok-1.0.46-question-updates.jsonl', import.meta.url), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line))
  if (options.questions !== undefined) {
    updates[0].params.update.rawInput.questions = options.questions
    updates[1].params.update.rawInput.questions = options.questions
  }
  const { sessionId, update } = updates[0].params
  const callId = update.toolCallId as string
  const replies: { id: number | string; result: Record<string, unknown> }[] = []
  let prompt: Record<string, unknown>[] = []
  let sendRequest = (): void => { throw new Error('回放尚未启动') }
  let questionRpcId = 76
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'],
    spawnSync: (() => ({ status: 0, stdout: 'grok 1.0.46', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const emit = (message: unknown): void => { stdout.write(`${JSON.stringify(message)}\n`) }
      let promptId: number | string
      const stdin = { write(data: string): void {
        const request = JSON.parse(data)
        if (request.method === 'session/prompt') {
          promptId = request.id
          prompt = request.params.prompt
          questionRpcId++
          for (const notification of updates) emit(notification)
          sendRequest = () => emit({ jsonrpc: '2.0', id: questionRpcId, method: options.method ?? '_x.ai/ask_user_question', params: {
            sessionId, toolCallId: callId, questions: updates[1].params.update.rawInput.questions, mode: 'default',
          } })
          if (!options.deferRequest) sendRequest()
          return
        }
        if (request.result?.outcome !== undefined) {
          replies.push({ id: request.id, result: request.result })
          emit({ method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'completed', rawOutput: request.result,
          } } })
          emit({ method: '_x.ai/session/update', params: { sessionId, update: { sessionUpdate: 'turn_completed' } } })
          emit({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } })
          return
        }
        if (request.method === 'session/new') emit({ jsonrpc: '2.0', id: request.id, result: { sessionId } })
        else if (request.id !== undefined) emit({ jsonrpc: '2.0', id: request.id, result: {} })
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  return { driver, callId, replies, get prompt() { return prompt }, sendRequest() { sendRequest() } }
}

test('Grok ACP 传递缓存 token 并计算缓存命中率', async () => {
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'],
    spawnSync: (() => ({ status: 0, stdout: 'grok 1.0.41', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id?: number; method?: string }
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        if (request.method === 'session/new') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'grok-usage-session' } })}\n`)
          return
        }
        if (request.method !== 'session/prompt') return
        const usage = { inputTokens: 14646, outputTokens: 4, totalTokens: 14650, cachedReadTokens: 1920, cacheCreationTokens: 0 }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: '_x.ai/session_notification', params: { update: { sessionUpdate: 'turn_completed', usage } } })}\n`)
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'grok-usage', messages: [], prompt: '统计' })) chunks.push(chunk)
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'usage'), [{
    type: 'usage', inputTokens: 14646, outputTokens: 4, cacheReadTokens: 1920, cacheWriteTokens: 0,
    uncachedInputTokens: 12726, totalTokens: 14650, cacheHitRate: 13.1094,
  }])
  driver.dispose()
})

test('Pi 读取真实 --list-models 表格并生成思维强度列表', async () => {
  const driver = new PiAgentDriver({
    binaries: ['fake-pi'],
    spawnSync: ((command: string, args: string[]) => {
      assert.equal(command, 'fake-pi')
      if (args[0] === '--version') return { status: 0, stdout: 'pi 0.85.1', stderr: '' }
      return { status: 0, stdout: 'provider  model  context  max-out  thinking  images\nopenai  gpt-5.5  1M  128K  yes  no\n', stderr: '' }
    }) as never,
    spawn: (() => { throw new Error('不应回退到 RPC') }) as never,
  })
  const catalog = await driver.listModels()
  assert.deepEqual(catalog.groups[0]?.models[0], {
    id: 'openai/gpt-5.5', name: 'gpt-5.5', efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  })
})

test('Pi 优先使用 RPC thinkingLevelMap 返回模型真实思维强度', async () => {
  const driver = new PiAgentDriver({
    binaries: ['fake-pi'],
    spawnSync: (() => ({ status: 0, stdout: 'pi 0.85.1', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; type: string }
        assert.equal(request.type, 'get_available_models')
        stdout.write(`${JSON.stringify({
          id: request.id,
          type: 'response',
          success: true,
          data: {
            models: [{
              provider: 'deepseek',
              id: 'deepseek-flash',
              name: 'DeepSeek V4.1 Flash',
              reasoning: true,
              thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
            }],
          },
        })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  assert.deepEqual((await driver.listModels()).groups[0]?.models[0], {
    id: 'deepseek/deepseek-flash',
    name: 'DeepSeek V4.1 Flash',
    efforts: ['low', 'high', 'max'],
  })
})

test('Codex app-server 读取 model/list 的模型和思维强度元数据', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 0.154.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      return {
        stdout,
        stderr,
        stdin: { write(data: string): void {
          const request = JSON.parse(data) as { id: number; method: string }
          const result = request.method === 'model/list'
            ? { models: [{ model: 'gpt-5.5', displayName: 'GPT-5.5', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }, { reasoningEffort: 'high', description: 'High' }], isDefault: true }] }
            : {}
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
        } },
        kill() { stdout.end(); stderr.end(); return true },
      }
    }) as never,
  })
  assert.deepEqual(await driver.listModels(), {
    groups: [{ id: 'codex', name: 'Codex', models: [{ id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low', 'high'] }] }],
    currentModel: null,
    currentEffort: null,
  })
})

test('RPC 执行收到取消信号时结束为 cancel 并清理进程', async () => {
  let killed = false
  const driver = new PiAgentDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'fake-agent 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method?: string; type?: string }
        const command = request.method ?? request.type
        if (command !== 'prompt') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { killed = true; stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const controller = new AbortController()
  const chunks: unknown[] = []
  const running = (async () => {
    for await (const chunk of driver.executeTurn({ sessionId: 's1', messages: [], prompt: '等待', signal: controller.signal })) chunks.push(chunk)
  })()
  setTimeout(() => controller.abort(), 10)
  await running
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'cancel' })
  driver.dispose()
  assert.equal(killed, true)
})

test('Grok ACP 权限请求保留原始 request id 并接受标准回复', async () => {
  let promptRequestId = 0
  let permissionReply: Record<string, unknown> | null = null
  const driver = new GrokBuildDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'fake-agent 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id?: number; method: string; result?: unknown }
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'grok-session' } })}\n`)
        else if (request.method === 'session/prompt') {
          promptRequestId = request.id ?? 0
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { kind: 'terminal', detail: '运行命令' } })}\n`)
        } else if (request.id === 99) {
          permissionReply = request as unknown as Record<string, unknown>
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'message_update', params: { type: 'text_delta', delta: '完成' } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptRequestId, result: {} })}\n`)
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks: unknown[] = []
  for await (const chunk of driver.executeTurn({ sessionId: 'coding-session', messages: [], prompt: '执行' })) {
    chunks.push(chunk)
    if (chunk.type === 'permission-request') driver.respondPermission('coding-session', { requestId: chunk.requestId, approved: true })
  }
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'grok-session' },
    { type: 'permission-request', requestId: '99', kind: 'terminal', detail: '运行命令' },
    { type: 'text-delta', text: '完成' },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(permissionReply, { jsonrpc: '2.0', id: 99, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
  driver.dispose()
})

test('Pi 同一 sessionId 跨轮复用 RPC 进程，并在 dispose 时统一回收', async () => {
  let spawnCount = 0
  let killed = 0
  const driver = new PiAgentDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'fake-agent 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      spawnCount += 1
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method?: string; type?: string }
        const command = request.method ?? request.type
        if (command === 'prompt') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'message_update', params: { type: 'text_delta', delta: 'ok' } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          setImmediate(() => stdout.write(`${JSON.stringify({ type: 'agent_settled' })}\n`))
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { killed += 1; stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  for (let index = 0; index < 2; index += 1) {
    const chunks = []
    for await (const chunk of driver.executeTurn({ sessionId: 'same', messages: [], prompt: `第${index}轮` })) chunks.push(chunk)
    assert.equal(chunks.some((chunk) => chunk.type === 'text-delta'), true)
  }
  assert.equal(spawnCount, 1)
  driver.dispose()
  assert.equal(killed, 1)
})

test('Codex 原生权限请求转换为标准事件并可回传审批结果', async () => {
  let approved: unknown = null
  const driver = new CodexAppServerDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string; result?: unknown }
        if (request.method === 'thread/start') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'thread-1' } } })}\n`)
        else if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'turn-1' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'item/commandExecution/requestApproval', params: { kind: 'command', command: 'echo hidden' } })}\n`)
        } else if (request.id === 77) {
          approved = request.result
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })}\n`)
        } else stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks: unknown[] = []
  const running = (async () => {
    for await (const chunk of driver.executeTurn({ sessionId: 'codex-session', messages: [], prompt: '执行命令' })) {
      chunks.push(chunk)
      if (chunk.type === 'permission-request') driver.respondPermission('codex-session', { requestId: chunk.requestId, approved: true })
    }
  })()
  await running
  assert.deepEqual(chunks.find((chunk) => (chunk as { type?: string }).type === 'permission-request'), { type: 'permission-request', requestId: '77', kind: 'command', detail: 'echo hidden' })
  assert.deepEqual(approved, { approved: true })
  driver.dispose()
})

test('Codex 动态工具请求必须立即回绝，不能让回合永久等待宿主执行', async () => {
  let dynamicToolReply: unknown = null
  const driver = new CodexAppServerDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id?: number; method?: string; result?: unknown }
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        } else if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'dynamic-thread' } } })}\n`)
        } else if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'dynamic-turn', status: 'inProgress' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'item/tool/call', params: { threadId: 'dynamic-thread', turnId: 'dynamic-turn', callId: 'call-1', tool: 'exec', arguments: '{}' } })}\n`)
        } else if (request.id === 77) {
          dynamicToolReply = request.result
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'dynamic-thread', turnId: 'dynamic-turn', item: { type: 'customToolCall', id: 'call-1', tool: 'exec', status: 'failed', error: '动态工具未执行' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'dynamic-thread', turn: { id: 'dynamic-turn', status: 'completed' } } })}\n`)
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-dynamic-tool', messages: [], prompt: '执行动态工具' })) chunks.push(chunk)

  assert.deepEqual(dynamicToolReply, {
    success: false,
    contentItems: [{ type: 'inputText', text: 'CodingNS 不支持由 Codex 反向调用动态工具' }],
  })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'stop' })
  driver.dispose()
})

test('Codex fileChange 使用工作区可写沙箱、编辑工具名和原生审批格式', async () => {
  let turnParams: Record<string, unknown> | null = null
  let approval: unknown = null
  const driver = new CodexAppServerDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        } else if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'file-thread' } } })}\n`)
        } else if (request.method === 'turn/start') {
          turnParams = request.params ?? null
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'file-turn', status: 'inProgress' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 88, method: 'item/fileChange/requestApproval', params: { threadId: 'file-thread', turnId: 'file-turn', itemId: 'file-change-item', reason: '需要写入工作区' } })}\n`)
        } else if (request.id === 88) {
          approval = request.result
          const item = { type: 'fileChange', id: 'file-change-item', changes: [{ path: '/workspace/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }], status: 'completed' }
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'file-thread', turnId: 'file-turn', item: { ...item, status: 'inProgress' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'file-thread', turnId: 'file-turn', item } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'file-thread', turnId: 'file-turn', turn: { id: 'file-turn', status: 'completed' } } })}\n`)
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks: unknown[] = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-file-change', messages: [], prompt: '修改文件' })) {
    chunks.push(chunk)
    if (chunk.type === 'permission-request') driver.respondPermission('codex-file-change', { requestId: chunk.requestId, approved: true })
  }

  assert.deepEqual(turnParams?.sandboxPolicy, {
    type: 'workspaceWrite',
    writableRoots: [process.cwd()],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  })
  assert.equal(turnParams?.approvalPolicy, 'on-request')
  assert.deepEqual(chunks.find((chunk) => (chunk as { type?: string }).type === 'permission-request'), {
    type: 'permission-request',
    requestId: '88',
    kind: 'file_change',
    toolName: 'edit',
    callId: 'file-change-item',
    detail: '需要写入工作区',
  })
  assert.deepEqual(chunks.filter((chunk) => (chunk as { type?: string }).type === 'tool-event'), [
    { type: 'tool-event', toolName: 'edit_file', callId: 'file-change-item', input: '{"changes":[{"file_path":"/workspace/a.ts","kind":"update","diff":"@@ -1 +1 @@\\n-old\\n+new"}]}', status: 'running' },
    { type: 'tool-event', toolName: 'edit_file', callId: 'file-change-item', input: '{"changes":[{"file_path":"/workspace/a.ts","kind":"update","diff":"@@ -1 +1 @@\\n-old\\n+new"}]}', status: 'completed' },
  ])
  assert.deepEqual(approval, { decision: 'accept' })
  driver.dispose()
})

test('Codex requestUserInput 经原生问题组件回传回答并保留工具历史', async () => {
  let answer: unknown = null
  let threadStartParams: Record<string, unknown> | undefined
  const calls = []
  const results = []
  const driver = new CodexAppServerDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        } else if (request.method === 'thread/start') {
          threadStartParams = request.params
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'thread-question' } } })}\n`)
        } else if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'turn-question' } } })}\n`)
          stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 88,
            method: 'item/tool/requestUserInput',
            params: {
              threadId: 'thread-question',
              turnId: 'turn-question',
              itemId: 'question-item',
              questions: [{ id: 'framework', question: '选择框架', header: '框架', options: [{ label: 'React' }, { label: 'Vue' }] }],
            },
          })}\n`)
        } else if (request.id === 88) {
          answer = request.result
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-question', status: 'completed' } } })}\n`)
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const projector = new CodingNsDshMessageProjector({
    adapterId: 'codex',
    sessionId: 'codex-question',
    nativeSessions: {
      appendToolCall(sessionId, call) {
        calls.push(call)
        return { sessionId, turn: 1, step: 1, callId: call.callId, callSeq: 1 }
      },
      appendToolResult(handle, result) {
        results.push({ handle, result })
        return true
      },
      async askQuestions(sessionId, request) {
        assert.equal(sessionId, 'codex-question')
        assert.equal(request.requestId, '88')
        // 用户尚未回答时，工具历史就应包含问题；完成结果必须等回传成功后再写入。
        assert.equal(calls.length, 1)
        assert.deepEqual(JSON.parse(calls[0].arguments).questions, request.questions)
        assert.equal(results.length, 0)
        assert.equal(answer, null)
        return { requestId: request.requestId, answers: [{ id: 'framework', selected: ['React'] }] }
      },
    },
    respondQuestion(response) { driver.respondQuestion('codex-question', response) },
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-question', messages: [], prompt: '创建页面' })) {
    chunks.push(chunk)
    await projector.push(chunk)
  }

  assert.deepEqual(chunks.find((chunk) => chunk.type === 'question-request'), {
    type: 'question-request',
    requestId: '88',
    callId: 'question-item',
    questions: [{ id: 'framework', question: '选择框架', header: '框架', options: [{ label: 'React' }, { label: 'Vue' }] }],
  })
  assert.deepEqual(answer, { answers: { framework: { answers: ['React'] } } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].callId, 'question-item')
  assert.equal(calls[0].name, 'question')
  assert.equal(calls[0].adapterId, 'codex')
  assert.equal(results.length, 1)
  assert.equal(results[0].handle.callId, 'question-item')
  assert.equal(results[0].result.isError, false)
  assert.deepEqual(JSON.parse(results[0].result.output), {
    requestId: '88',
    answers: [{ id: 'framework', selected: ['React'] }],
    providerAnswers: [['React']],
  })
  assert.match(String(threadStartParams?.developerInstructions), /request_user_input/u)
  assert.match(String(threadStartParams?.developerInstructions), /request_user_input_async/u)
  driver.dispose()
})

test('Pi 在 prompt 响应先到时继续等待文本和 agent_settled', async () => {
  const driver = new PiAgentDriver({
    binaries: ['fake-pi'],
    spawnSync: (() => ({ status: 0, stdout: 'pi 0.85.1', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method?: string; type?: string }
        const command = request.method ?? request.type
        if (command !== 'prompt') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { accepted: true } })}\n`)
        setImmediate(() => {
          stdout.write(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '延迟回复' } })}\n`)
          stdout.write(`${JSON.stringify({ type: 'agent_settled' })}\n`)
        })
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'pi-late', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'pi-late' },
    { type: 'text-delta', text: '延迟回复' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Pi prompt 被拒绝时结束为 error', async () => {
  const driver = new PiAgentDriver({
    binaries: ['fake-pi'],
    spawnSync: (() => ({ status: 0, stdout: 'pi 0.85.1', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method?: string; type?: string }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: '拒绝' } })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'pi-error', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'error', failure: { message: '拒绝' } })
  driver.dispose()
})

test('Pi turn_end 的 Provider 错误不会被 agent_settled 覆盖为成功', async () => {
  const driver = new PiAgentDriver({
    binaries: ['fake-pi'],
    spawnSync: (() => ({ status: 0, stdout: 'pi 0.85.1', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method?: string; type?: string }
        const command = request.method ?? request.type
        if (command !== 'prompt') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        stdout.write(`${JSON.stringify({ id: request.id, type: 'response', command: 'prompt', success: true })}\n`)
        setImmediate(() => {
          stdout.write(`${JSON.stringify({ type: 'turn_end', message: { stopReason: 'error', errorMessage: '认证失败' } })}\n`)
          stdout.write(`${JSON.stringify({ type: 'agent_settled' })}\n`)
        })
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'pi-provider-error', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'tool-event'), [])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'error', failure: { message: '认证失败' } })
  driver.dispose()
})

test('Grok 在 prompt 响应后排空延迟到达的文本和完成通知', async () => {
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'],
    spawnSync: (() => ({ status: 0, stdout: 'grok 1.0.40', stderr: '' })) as never,
    spawn: createGrokTimingSpawn('response-first'),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'grok-late', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'grok-session' },
    { type: 'text-delta', text: '延迟回复' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Grok 只有终态通知而没有 prompt 响应时仍能完成', async () => {
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'],
    spawnSync: (() => ({ status: 0, stdout: 'grok 1.0.40', stderr: '' })) as never,
    spawn: createGrokTimingSpawn('terminal-only'),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'grok-terminal', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'stop' })
  driver.dispose()
})

test('Grok 延迟错误通知覆盖先到的 prompt 响应', async () => {
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'],
    spawnSync: (() => ({ status: 0, stdout: 'grok 1.0.40', stderr: '' })) as never,
    spawn: createGrokTimingSpawn('terminal-error'),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'grok-error', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'error' })
  driver.dispose()
})

function createGrokTimingSpawn(mode: 'response-first' | 'terminal-only' | 'terminal-error') {
  return (() => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = { write(data: string): void {
      const request = JSON.parse(data) as { id?: number; method?: string }
      if (request.method === 'initialize') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        return
      }
      if (request.method === 'session/new') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'grok-session' } })}\n`)
        return
      }
      if (request.method !== 'session/prompt') return
      if (mode !== 'terminal-only') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: mode === 'response-first' ? { stopReason: 'end_turn' } : {} })}\n`)
      }
      setTimeout(() => {
        if (mode === 'response-first') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', text: '延迟回复' } } })}\n`)
        }
        const sessionUpdate = mode === 'terminal-error' ? 'turn_failed' : 'turn_completed'
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate } } })}\n`)
      }, 10)
    } }
    return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
  }) as never
}

test('Codex 在 turn/start 响应先到时继续等待文本和完成通知', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'thread/start') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'thread-late' } } })}\n`)
        else if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'turn-late', status: 'inProgress' } } })}\n`)
          setImmediate(() => {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-late', turnId: 'turn-late', itemId: 'message-late', delta: '延迟回复' } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-late', turn: { id: 'turn-late', status: 'completed' } } })}\n`)
          })
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-late', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'thread-late' },
    { type: 'text-delta', text: '延迟回复', messageId: 'message-late' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Codex 不会把 turn/start 响应前迟到的旧回合工具事件带入当前流', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        } else if (request.method === 'thread/resume') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'thread-order' } } })}\n`)
        } else if (request.method === 'turn/start') {
          // 模拟 thread/resume 后旧回合事件迟到，并在本次响应前插入队列。
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/commandExecution', params: { threadId: 'thread-order', item: { type: 'commandExecution', id: 'old-call', command: '旧命令' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/commandExecution', params: { threadId: 'thread-order', turnId: 'turn-current', item: { type: 'commandExecution', id: 'current-call', command: '当前命令' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'turn-current', status: 'inProgress' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-order', turn: { id: 'turn-current', status: 'completed' } } })}\n`)
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-order', providerSessionId: 'thread-order', messages: [], prompt: '执行' })) chunks.push(chunk)

  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'thread-order' },
    { type: 'tool-event', toolName: 'command_execution', callId: 'current-call', input: '当前命令', status: 'running' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Codex 会把 turn/start 响应后的无 turnId 工具事件交给当前流', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        } else if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'thread-after' } } })}\n`)
        } else if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'turn-after', status: 'inProgress' } } })}\n`)
          setImmediate(() => {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/commandExecution', params: { threadId: 'thread-after', item: { type: 'commandExecution', id: 'late-old-call', command: '历史命令' } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/commandExecution', params: { threadId: 'thread-after', turnId: 'turn-after', item: { type: 'commandExecution', id: 'current-call', command: '当前命令' } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-after', turn: { id: 'turn-after', status: 'completed' } } })}\n`)
          })
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-after', messages: [], prompt: '执行' })) chunks.push(chunk)

  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'thread-after' },
    { type: 'tool-event', toolName: 'command_execution', callId: 'late-old-call', input: '历史命令', status: 'running' },
    { type: 'tool-event', toolName: 'command_execution', callId: 'current-call', input: '当前命令', status: 'running' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Codex 取消时使用 turn/start 响应中的 turnId 中断当前轮次', async () => {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = []
  const controller = new AbortController()
  const driver = new CodexAppServerDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> }
        requests.push(request)
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'thread/start') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'thread-cancel' } } })}\n`)
        else if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'turn-cancel', status: 'inProgress' } } })}\n`)
          setImmediate(() => controller.abort())
        } else if (request.method === 'turn/interrupt') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-cancel', messages: [], prompt: '等待', signal: controller.signal })) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'cancel' })
  assert.deepEqual(requests.find((request) => request.method === 'turn/interrupt')?.params, { threadId: 'thread-cancel', turnId: 'turn-cancel' })
  driver.dispose()
})

test('Codex 仅在失败终止通知到达后结束为 error', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'thread/start') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'thread-failed' } } })}\n`)
        else if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'turn-failed', status: 'inProgress' } } })}\n`)
          setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-failed', turn: { id: 'turn-failed', status: 'failed', error: { code: 429, type: 'rate_limit_exceeded', message: '上游请求过于频繁，请稍后重试' } } } })}\n`))
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-failed', messages: [], prompt: '执行' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'thread-failed' },
    { type: 'text-delta', text: 'CODINGNS_PROVIDER_EMPTY_RESPONSE: Codex Provider 未返回任何有效事件。' },
    { type: 'finish', reason: 'error', failure: { message: '上游请求过于频繁，请稍后重试', code: '429' } },
  ])
  driver.dispose()
})

test('Codex 工具完成后收到 turn/aborted 也必须收敛会话终态', async () => {
  const driver = new CodexAppServerDriver({
    binaries: ['fake-agent'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'thread/start') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'thread-aborted' } } })}\n`)
        else if (request.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'turn-aborted', status: 'inProgress' } } })}\n`)
          setImmediate(() => {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-aborted', turnId: 'turn-aborted', item: { type: 'fileChange', id: 'file-change-aborted', changes: [], status: 'completed' } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/aborted', params: { threadId: 'thread-aborted', turnId: 'turn-aborted' } })}\n`)
          })
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-aborted', messages: [], prompt: '执行编辑' })) chunks.push(chunk)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'cancel' })
  driver.dispose()
})

/** 记录 Codex 线程级与回合级权限参数，用于验证两侧同源。 */
function createCodexPermissionRecorder(options: {
  readonly requestPermission?: boolean
  readonly permissionRequest?: Record<string, unknown>
} = {}) {
  const state: {
    threadStart: Record<string, unknown> | null
    threadResume: Record<string, unknown> | null
    turnStart: Record<string, unknown> | null
    permissionResult: unknown
  } = { threadStart: null, threadResume: null, turnStart: null, permissionResult: null }
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        } else if (request.method === 'thread/start') {
          state.threadStart = request.params ?? null
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'perm-thread' } } })}\n`)
        } else if (request.method === 'thread/resume') {
          state.threadResume = request.params ?? null
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'perm-thread' } } })}\n`)
        } else if (request.method === 'turn/start') {
          state.turnStart = request.params ?? null
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'perm-turn', status: 'inProgress' } } })}\n`)
          if (options.requestPermission === true) {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'item/permissions/requestApproval', params: options.permissionRequest ?? {} })}\n`)
          } else {
            setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'perm-thread', turn: { id: 'perm-turn', status: 'completed' } } })}\n`))
          }
        } else if (request.id === 77) {
          state.permissionResult = request.result
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'perm-thread', turn: { id: 'perm-turn', status: 'completed' } } })}\n`)
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  return { driver, state }
}

test('Codex 按 DSH 权限状态派生沙箱与审批，danger-full-access 不再降级为工作区可写', async () => {
  const cases = [
    {
      permission: { sandboxMode: 'danger-full-access', approvalPolicy: 'never', preset: 'danger-full-access' },
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
      approvalPolicy: 'never',
    },
    {
      permission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask', preset: 'workspace-write' },
      sandbox: 'workspace-write',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [process.cwd()],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      approvalPolicy: 'on-request',
    },
    {
      permission: { sandboxMode: 'read-only', approvalPolicy: 'ask' },
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      approvalPolicy: 'on-request',
    },
  ] as const

  for (const item of cases) {
    const { driver, state } = createCodexPermissionRecorder()
    for await (const _chunk of driver.executeTurn({ sessionId: 'codex-perm', messages: [], prompt: '检查权限', permission: item.permission })) { /* 只验证发出的 RPC 参数 */ }
    // thread/start、thread/resume 与 turn/start 必须由同一份权限状态派生。
    assert.equal(state.threadStart?.sandbox, item.sandbox)
    assert.equal(state.threadStart?.approvalPolicy, item.approvalPolicy)
    assert.deepEqual(state.turnStart?.sandboxPolicy, item.sandboxPolicy)
    assert.equal(state.turnStart?.approvalPolicy, item.approvalPolicy)
    driver.dispose()
  }
})

test('Codex 未读到 DSH 权限状态时保留保守默认，不推断为完全权限', async () => {
  const { driver, state } = createCodexPermissionRecorder()
  for await (const _chunk of driver.executeTurn({ sessionId: 'codex-perm-default', messages: [], prompt: '检查默认权限' })) { /* 只验证发出的 RPC 参数 */ }
  assert.equal(state.threadStart?.sandbox, 'workspace-write')
  assert.equal(state.threadStart?.approvalPolicy, 'on-request')
  assert.deepEqual(state.turnStart?.sandboxPolicy, {
    type: 'workspaceWrite',
    writableRoots: [process.cwd()],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  })
  assert.equal(state.turnStart?.approvalPolicy, 'on-request')
  driver.dispose()
})

test('Codex thread/resume 与 turn/start 使用同一份权限状态', async () => {
  const { driver, state } = createCodexPermissionRecorder()
  for await (const _chunk of driver.executeTurn({
    sessionId: 'codex-perm-resume',
    messages: [],
    prompt: '恢复线程',
    providerSessionId: 'existing-thread',
    permission: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
  })) { /* 只验证发出的 RPC 参数 */ }
  assert.equal(state.threadStart, null)
  assert.equal(state.threadResume?.threadId, 'existing-thread')
  assert.equal(state.threadResume?.sandbox, 'danger-full-access')
  assert.equal(state.threadResume?.approvalPolicy, 'never')
  // 恢复已有会话也必须提供宿主交互契约，同时保留 never 策略。
  assert.match(String(state.threadResume?.developerInstructions), /request_permissions/u)
  assert.match(String(state.threadResume?.developerInstructions), /审批策略为 never/u)
  assert.match(String(state.threadResume?.developerInstructions), /request_user_input/u)
  assert.deepEqual(state.turnStart?.sandboxPolicy, { type: 'dangerFullAccess' })
  assert.equal(state.turnStart?.approvalPolicy, 'never')
  driver.dispose()
})

test('Codex permissions/requestApproval 按 {permissions, scope} 应答并回显请求画像', async () => {
  const requestedProfile = {
    fileSystem: { write: ['/workspace/out'], read: ['/workspace/in'] },
    network: { enabled: true },
  }
  const { driver, state } = createCodexPermissionRecorder({
    requestPermission: true,
    permissionRequest: {
      threadId: 'perm-thread',
      turnId: 'perm-turn',
      itemId: 'perm-item',
      reason: '需要额外写权限',
      permissions: requestedProfile,
    },
  })
  const chunks: unknown[] = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-permissions', messages: [], prompt: '申请提权' })) {
    chunks.push(chunk)
    if (chunk.type === 'permission-request') driver.respondPermission('codex-permissions', { requestId: chunk.requestId, approved: true })
  }
  const request = chunks.find((chunk) => (chunk as { type?: string }).type === 'permission-request') as Record<string, unknown> | undefined
  assert.equal(request?.kind, 'permissions')
  assert.equal(request?.callId, 'perm-item')
  assert.match(String(request?.detail), /需要额外写权限/u)
  assert.match(String(request?.detail), /请求写入: \/workspace\/out/u)
  assert.match(String(request?.detail), /请求网络访问/u)
  // 应答必须是 {permissions, scope}，不能退化成 {approved}。
  assert.deepEqual(state.permissionResult, { permissions: requestedProfile, scope: 'turn' })
  driver.dispose()
})

test('Codex permissions/requestApproval 被拒绝时回传空权限画像', async () => {
  const { driver, state } = createCodexPermissionRecorder({
    requestPermission: true,
    permissionRequest: {
      threadId: 'perm-thread',
      turnId: 'perm-turn',
      itemId: 'perm-item',
      permissions: { fileSystem: { write: ['/workspace/out'] } },
    },
  })
  for await (const chunk of driver.executeTurn({ sessionId: 'codex-permissions-deny', messages: [], prompt: '申请提权' })) {
    if (chunk.type === 'permission-request') driver.respondPermission('codex-permissions-deny', { requestId: chunk.requestId, approved: false })
  }
  assert.deepEqual(state.permissionResult, { permissions: {}, scope: 'turn' })
  driver.dispose()
})

/** Codex 服务档位夹具：目录声明档位，账号类型可控。 */
function createCodexServiceTierRecorder(options: {
  readonly account?: unknown
  readonly accountReadFails?: boolean
  readonly modelList?: unknown
  readonly configuredServiceTier?: string | null
} = {}) {
  const state: {
    calls: Array<{ method: string; params: Record<string, unknown> }>
    turnStarts: number
  } = { calls: [], turnStarts: 0 }
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id?: number; method?: string; params?: Record<string, unknown> }
        state.calls.push({ method: request.method ?? '', params: request.params ?? {} })
        if (request.method === 'account/read') {
          if (options.accountReadFails === true) {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } })}\n`)
            return
          }
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { account: options.account ?? null, requiresOpenaiAuth: true } })}\n`)
          return
        }
        if (request.method === 'config/read') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { config: { service_tier: options.configuredServiceTier ?? null } } })}\n`)
          return
        }
        if (request.method === 'model/list') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: options.modelList ?? { data: [] } })}\n`)
          return
        }
        if (request.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'tier-thread' }, serviceTier: request.params?.serviceTier ?? null } })}\n`)
          return
        }
        if (request.method === 'thread/resume') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'tier-thread' } } })}\n`)
          return
        }
        if (request.method === 'thread/settings/update') {
          // 真实 app-server 只返回 {}，不回显档位。
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return
        }
        if (request.method === 'turn/start') {
          state.turnStarts += 1
          const turnId = `tier-turn-${state.turnStarts}`
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } })}\n`)
          setImmediate(() => {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'tier-thread', turn: { id: turnId, status: 'completed' } } })}\n`)
          })
          return
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  return { driver, state }
}

test('Codex model/list 的 serviceTiers 进入目录，并据 account/read 判定官方订阅', async () => {
  const modelList = {
    data: [{
      id: 'gpt-6.1-sol',
      displayName: 'GPT-6.1-Sol',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }],
      defaultServiceTier: null,
    }],
  }
  const subscribed = createCodexServiceTierRecorder({ account: { type: 'chatgpt', email: null, planType: 'pro' }, modelList })
  assert.deepEqual(await subscribed.driver.listModels(), {
    groups: [{
      id: 'codex',
      name: 'Codex',
      models: [{
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1-Sol',
        efforts: ['low'],
        serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }],
      }],
    }],
    currentModel: null,
    currentEffort: null,
    officialSubscription: true,
    // 配置未设置 service_tier：默认档位显式为 null，表示线程以标准档运行。
    defaultServiceTier: null,
  })
  subscribed.driver.dispose()

  // Provider 配置了 service_tier：它才是线程未显式选择时真正生效的档位。
  // 注意来源是 config/read 而不是 model/list 的 defaultServiceTier。
  const configured = createCodexServiceTierRecorder({
    account: { type: 'chatgpt', email: null, planType: 'pro' },
    modelList: { data: [{ ...(modelList.data as Array<Record<string, unknown>>)[0], defaultServiceTier: 'priority' }] },
    configuredServiceTier: 'priority',
  })
  const configuredCatalog = await configured.driver.listModels()
  assert.equal(configuredCatalog.defaultServiceTier, 'priority')
  // 模型的 defaultServiceTier 只是目录元数据，不得进入目录结果。
  assert.equal('defaultServiceTier' in (configuredCatalog.groups[0]?.models[0] ?? {}), false)
  configured.driver.dispose()

  // 纯 API key 账号：目录仍带档位，但必须明确判为不可用。
  const apiKey = createCodexServiceTierRecorder({ account: { type: 'apiKey' }, modelList })
  assert.equal((await apiKey.driver.listModels()).officialSubscription, false)
  apiKey.driver.dispose()

  // 未登录（account 为 null）。
  const anonymous = createCodexServiceTierRecorder({ account: null, modelList })
  assert.equal((await anonymous.driver.listModels()).officialSubscription, false)
  anonymous.driver.dispose()

  // 旧版 Codex 没有 account/read：保留“未确认”，不能当成已确认官方订阅。
  const legacy = createCodexServiceTierRecorder({ accountReadFails: true, modelList })
  const legacyCatalog = await legacy.driver.listModels()
  assert.equal(legacyCatalog.officialSubscription, undefined)
  assert.equal(legacyCatalog.groups[0]?.models[0]?.serviceTiers?.[0]?.id, 'priority')
  legacy.driver.dispose()
})

test('Codex 线程按 DSH 选择下发服务档位，并在关闭 Fast 时显式回落标准速度', async () => {
  const { driver, state } = createCodexServiceTierRecorder()

  // 首轮选择 Fast：thread/start 直接带上档位。
  for await (const _chunk of driver.executeTurn({
    sessionId: 'codex-tier',
    messages: [],
    prompt: '开始',
    modelId: 'gpt-6.1-sol',
    serviceTierId: 'priority',
  })) { /* 只验证发出的 RPC 参数 */ }

  const start = state.calls.find((call) => call.method === 'thread/start')
  assert.equal(start?.params.serviceTier, 'priority')

  // 用户关掉 Fast：必须下发 default，不能只是停止下发而让线程保留加速档。
  for await (const _chunk of driver.executeTurn({
    sessionId: 'codex-tier',
    messages: [],
    prompt: '继续',
    modelId: 'gpt-6.1-sol',
    serviceTierId: 'default',
  })) { /* 只验证发出的 RPC 参数 */ }

  // 模型纠正与档位纠正共用 thread/settings/update，这里只看带 serviceTier 的那些。
  const tierUpdates = (): Array<Record<string, unknown>> => state.calls
    .filter((call) => call.method === 'thread/settings/update' && 'serviceTier' in call.params)
    .map((call) => call.params)

  const updates = tierUpdates()
  assert.equal(updates.length, 1)
  assert.deepEqual(updates[0], { threadId: 'tier-thread', serviceTier: 'default' })

  // 档位没有再次变化：不能每个 step 都重复下发。
  for await (const _chunk of driver.executeTurn({
    sessionId: 'codex-tier',
    messages: [],
    prompt: '再继续',
    modelId: 'gpt-6.1-sol',
    serviceTierId: 'default',
  })) { /* 只验证发出的 RPC 参数 */ }
  assert.equal(tierUpdates().length, 1)

  // 重新打开 Fast 时再次下发。
  for await (const _chunk of driver.executeTurn({
    sessionId: 'codex-tier',
    messages: [],
    prompt: '加速',
    modelId: 'gpt-6.1-sol',
    serviceTierId: 'priority',
  })) { /* 只验证发出的 RPC 参数 */ }
  const reopened = tierUpdates()
  assert.equal(reopened.length, 2)
  assert.deepEqual(reopened[1], { threadId: 'tier-thread', serviceTier: 'priority' })

  driver.dispose()
})

test('Codex 未声明服务档位时不下发 serviceTier，旧版无该方法也不阻断回合', async () => {
  const { driver, state } = createCodexServiceTierRecorder()
  for await (const _chunk of driver.executeTurn({
    sessionId: 'codex-tier-absent',
    messages: [],
    prompt: '普通回合',
    modelId: 'gpt-6.1-sol',
  })) { /* 只验证发出的 RPC 参数 */ }

  // Host 没有该选择时不能擅自改写线程档位：档位纠正只在显式声明时发生。
  assert.equal(state.calls.some((call) => call.method === 'thread/settings/update' && 'serviceTier' in call.params), false)
  assert.equal(state.calls.find((call) => call.method === 'thread/start')?.params.serviceTier, undefined)
  assert.equal(state.turnStarts, 1)
  driver.dispose()
})

test('Codex Provider 配置指纹只覆盖影响目录语义的字段且不含凭据', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'codingns-codex-home-'))
  // 驱动按 CODEX_HOME 解析配置目录；用环境变量把它指向临时目录。
  const previousHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = home
  try {
    const official = new CodexAppServerDriver({ binaries: ['fake-codex'] })
    // 两个文件都不存在：返回 undefined 表示“无法判断”，不能据此失效缓存。
    assert.equal(official.catalogFingerprint(), undefined)

    writeFileSync(join(home, 'config.toml'), 'model = "gpt-6.1-sol"\nservice_tier = "default"\n')
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { refresh_token: 'rt-1', account_id: 'acct-1' } }))
    const subscribed = official.catalogFingerprint()
    assert.equal(typeof subscribed, 'string')
    // 凭据原文绝不能进入指纹。
    assert.equal(subscribed!.includes('rt-1'), false)

    // 仅轮换 access_token（官方订阅每次刷新都会变）：指纹必须保持不变，
    // 否则目录会在每次 token 刷新后无谓失效。
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { refresh_token: 'rt-1', access_token: 'at-rotated', account_id: 'acct-1' } }))
    assert.equal(official.catalogFingerprint(), subscribed)

    // 切换到第三方 Provider：这是真正改变目录语义的变化，指纹必须变化。
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_provider = "relay"\nservice_tier = "default"\n\n[model_providers.relay]\nbase_url = "https://api.glor-ai.top:1443"\n')
    assert.notEqual(official.catalogFingerprint(), subscribed)

    // 登录方式从订阅切成纯 API key：同样必须触发失效。
    const thirdParty = official.catalogFingerprint()
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-secret-value', tokens: null }))
    const apiKey = official.catalogFingerprint()
    assert.notEqual(apiKey, thirdParty)
    assert.equal(apiKey!.includes('sk-secret-value'), false)
    official.dispose()
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('Codex 供应商切换后 Host 立即作废目录缓存，不必等待 TTL', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { CodingNsCliAdapterRegistry } = await import('../data/build/dist/host/cli-adapters/registry.js')

  const home = mkdtempSync(join(tmpdir(), 'codingns-codex-switch-'))
  const previousHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = home
  writeFileSync(join(home, 'config.toml'), 'model_provider = "relay"\nservice_tier = "default"\n')
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x', tokens: null }))

  let accountType: string | null = null
  let modelListCalls = 0
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string }
        const reply = (result: unknown): void => { stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`) }
        if (request.method === 'initialize') return reply({})
        if (request.method === 'config/read') return reply({ config: { service_tier: 'default' } })
        if (request.method === 'model/list') {
          modelListCalls += 1
          return reply({ data: [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], serviceTiers: [{ id: 'priority', name: 'Fast' }] }] })
        }
        if (request.method === 'account/read') return reply({ account: accountType === null ? null : { type: accountType }, requiresOpenaiAuth: accountType !== null })
        return reply({})
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  // TTL 设成 10 分钟，模拟真实默认值：只有指纹比对能让它提前失效。
  const registry = new CodingNsCliAdapterRegistry([driver], {}, { modelCacheTtlMs: 10 * 60_000, modelRetryTtlMs: 10 * 60_000 })
  try {
    const thirdParty = await registry.models('codex')
    assert.equal(thirdParty.officialSubscription, false)
    assert.equal(modelListCalls, 1)

    // 同配置再读一次：命中缓存，不重复探测。
    const cached = await registry.models('codex')
    assert.equal(cached, thirdParty)
    assert.equal(modelListCalls, 1)

    // 用户切回官方订阅：config.toml 与 auth.json 被外部工具改写，CLI 版本不变。
    accountType = 'chatgpt'
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-6.1-sol"\nservice_tier = "default"\n')
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { refresh_token: 'rt-2', account_id: 'acct-2' } }))

    // 关键断言：不必等 TTL，也不必重启 Host，下一次读取就必须拿到官方订阅判定。
    const official = await registry.models('codex')
    assert.equal(official.officialSubscription, true)
    assert.notEqual(official, thirdParty)
    assert.equal(modelListCalls, 2)

    // 官方订阅下 Fast 档位开关的展示条件随之成立。
    const { canSelectServiceTier } = await import('../data/build/dist/client/service-tier.js')
    assert.equal(canSelectServiceTier(official, official.groups[0]!.models[0]), true)
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
    await registry.dispose()
  }
})

test('Provider 未声明配置指纹的适配器保持原缓存行为', async () => {
  const { CodingNsCliAdapterRegistry } = await import('../data/build/dist/host/cli-adapters/registry.js')
  let listCalls = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'no-fingerprint', name: 'NoFingerprint' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() {
      listCalls += 1
      return { groups: [{ id: 'g', name: 'G', models: [{ id: 'm', name: 'M', efforts: [] }] }], currentModel: null, currentEffort: null }
    },
    async *executeTurn() { yield { type: 'finish', reason: 'stop' } },
  }], {}, { modelCacheTtlMs: 10 * 60_000 })
  try {
    await registry.models('no-fingerprint')
    await registry.models('no-fingerprint')
    // 没有指纹可比对时沿用长 TTL 缓存，不能退化成每次重新探测。
    assert.equal(listCalls, 1)
  } finally {
    await registry.dispose()
  }
})

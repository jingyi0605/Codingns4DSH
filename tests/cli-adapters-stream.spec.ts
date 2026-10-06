import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'
import { GeminiCliDriver } from '../data/build/dist/host/cli-adapters/gemini-driver.js'
import { KimiCliDriver } from '../data/build/dist/host/cli-adapters/kimi-driver.js'
import { CodingNsAgentEventNormalizer } from '../data/build/dist/host/cli-adapters/stream-normalizer.js'

test('Claude、Gemini、Kimi 的标准流驱动统一转换文本和完成事件', async () => {
  for (const [Driver, event] of [
    [ClaudeCodeDriver, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '完成' } } }],
    [GeminiCliDriver, { type: 'text_delta', delta: '完成' }],
    [KimiCliDriver, { type: 'text_delta', delta: '完成' }],
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
        queueMicrotask(() => {
          stdout.write(`${JSON.stringify(event)}\n`)
          stdout.write(`${JSON.stringify({ type: 'result' })}\n`)
          stdout.end()
          stderr.end()
        })
        return { stdout, stderr, kill() { killed = true; return true } }
      }) as never,
    })
    const chunks = []
    for await (const chunk of driver.executeTurn({ sessionId: 's1', messages: [], prompt: '你好' })) chunks.push(chunk)
    assert.equal(calls[0]?.[0], 'fake-agent')
    if (Driver === ClaudeCodeDriver) assert.equal(calls[0]?.includes('--include-partial-messages'), true)
    const expectedText = Driver === ClaudeCodeDriver
      ? { type: 'text-delta', text: '完成', messageId: 'assistant-claude-code-s1-0' }
      : { type: 'text-delta', text: '完成' }
    assert.deepEqual(chunks.filter((chunk) => chunk.type !== 'session-binding'), [
      expectedText,
      { type: 'finish', reason: 'stop' },
    ])
    assert.equal(killed, true)
    driver.dispose()
  }
})

test('Claude Code 通过公开 control_request/control_response 接入权限与结构化问题', async () => {
  const responses: Array<Record<string, any>> = []
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude'],
    spawnSync: (() => ({ status: 0, stdout: 'claude 1.2.3', stderr: '' })) as never,
    spawn: ((_command: string, args: string[]) => {
      assert.equal(args.includes('--permission-prompts'), true)
      assert.equal(args.includes('host'), true)
      assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), ['--permission-mode', 'manual'])
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = new PassThrough()
      stdin.on('data', (chunk) => {
        const message = JSON.parse(String(chunk)) as Record<string, any>
        if (message.type !== 'control_response') return
        responses.push(message)
        const requestId = message.response?.request_id
        if (requestId === 'approval-1') {
          stdout.write(`${JSON.stringify({
            type: 'control_request',
            request_id: 'question-1',
            request: {
              subtype: 'can_use_tool',
              tool_name: 'AskUserQuestion',
              tool_use_id: 'question-tool-1',
              input: {
                questions: [{
                  question: '使用哪种语言？',
                  header: '语言',
                  options: [{ label: 'TypeScript' }, { label: 'Rust' }],
                }],
              },
            },
          })}\n`)
        } else if (requestId === 'question-1') {
          stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success' })}\n`)
          stdout.end()
          stderr.end()
        }
      })
      queueMicrotask(() => stdout.write(`${JSON.stringify({
        type: 'control_request',
        request_id: 'approval-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 'bash-tool-1',
          input: { command: 'pwd' },
          decision_reason: '需要执行命令',
        },
      })}\n`))
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); stdin.end(); return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({
    sessionId: 'claude-interaction',
    messages: [],
    prompt: '执行',
    permission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
  })) {
    chunks.push(chunk)
    if (chunk.type === 'permission-request') driver.respondPermission('claude-interaction', { requestId: chunk.requestId, approved: true })
    if (chunk.type === 'question-request') driver.respondQuestion('claude-interaction', {
      requestId: chunk.requestId,
      answers: [{ id: 'question-1', selected: ['TypeScript'] }],
    })
  }

  assert.deepEqual(chunks, [
    { type: 'permission-request', requestId: 'approval-1', kind: 'Bash', toolName: 'Bash', callId: 'bash-tool-1', detail: '需要执行命令' },
    { type: 'question-request', requestId: 'question-1', questions: [{ id: 'question-1', question: '使用哪种语言？', header: '语言', options: [{ label: 'TypeScript' }, { label: 'Rust' }] }] },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(responses, [
    {
      type: 'control_response',
      response: {
        subtype: 'success', request_id: 'approval-1',
        response: { behavior: 'allow', updatedInput: { command: 'pwd' }, toolUseID: 'bash-tool-1' },
      },
    },
    {
      type: 'control_response',
      response: {
        subtype: 'success', request_id: 'question-1',
        response: {
          behavior: 'allow',
          updatedInput: {
            questions: [{ question: '使用哪种语言？', header: '语言', options: [{ label: 'TypeScript' }, { label: 'Rust' }] }],
            answers: { '使用哪种语言？': 'TypeScript' },
          },
          toolUseID: 'question-tool-1',
        },
      },
    },
  ])
  assert.equal(driver.descriptor.capabilities?.includes('permission'), true)
  assert.equal(driver.descriptor.capabilities?.includes('questions'), true)
  driver.dispose()
})

test('Claude stream-json 保留 tool_use 与 tool_result 的完整生命周期', async () => {
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude'],
    spawnSync: (() => ({ status: 0, stdout: 'claude 1.2.3', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      queueMicrotask(() => {
        stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'claude-call-1', name: 'Read', input: { file_path: 'a.ts' } }] } })}\n`)
        stdout.write(`${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'claude-call-1', content: '文件内容' }] } })}\n`)
        stdout.write(`${JSON.stringify({ type: 'result', usage: { input_tokens: 100, output_tokens: 3, cache_read_input_tokens: 40, cache_creation_input_tokens: 5, total_tokens: 148 } })}\n`)
        stdout.end()
        stderr.end()
      })
      return { stdout, stderr, kill() { return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'claude-tools', messages: [], prompt: '读取' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'tool-event', toolName: 'Read', callId: 'claude-call-1', input: '{"file_path":"a.ts"}', status: 'running' },
    { type: 'tool-event', toolName: 'Read', callId: 'claude-call-1', output: '文件内容', outputMode: 'snapshot', status: 'completed' },
    { type: 'usage', inputTokens: 100, outputTokens: 3, cacheReadTokens: 40, cacheWriteTokens: 5, uncachedInputTokens: 100, totalTokens: 148, cacheHitRate: 27.5862 },
    { type: 'finish', reason: 'stop' },
  ])
})

test('Claude stream-json 不重复投影 assistant 结算快照，并按工具切换消息段', async () => {
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude'],
    spawnSync: (() => ({ status: 0, stdout: 'claude 1.2.3', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      queueMicrotask(() => {
        const streamEvent = (event: Record<string, unknown>): void => {
          stdout.write(`${JSON.stringify({ type: 'stream_event', event })}\n`)
        }
        streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: '工具前' } })
        stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '工具前' }] } })}\n`)
        // Claude Code 可能在同一块内容结算时重复发送完整 assistant 快照。
        // 快照不是正文增量，不能再次追加到 DSH 消息。
        stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '工具前' }] } })}\n`)
        streamEvent({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'pwd' } } })
        stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'pwd' } }] } })}\n`)
        stdout.write(`${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '/workspace' }] } })}\n`)
        streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: '工具后' } })
        stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '工具后' }] } })}\n`)
        stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '工具后' }] } })}\n`)
        stdout.write(`${JSON.stringify({ type: 'result' })}\n`)
        stdout.end()
        stderr.end()
      })
      return { stdout, stderr, kill() { return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'claude-segments', messages: [], prompt: '执行' })) chunks.push(chunk)
  assert.equal(driver.supportsToolStepSplitting, true)
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'text-delta'), [
    { type: 'text-delta', text: '工具前', messageId: 'assistant-claude-code-claude-segments-0' },
    { type: 'text-delta', text: '工具后', messageId: 'assistant-claude-code-claude-segments-1' },
  ])
  assert.equal(chunks.some((chunk) => chunk.type === 'text-snapshot' || chunk.type === 'reasoning-snapshot'), false)
  const normalizer = new CodingNsAgentEventNormalizer()
  const normalized = chunks.flatMap((chunk) => normalizer.push(chunk))
  assert.deepEqual(normalized.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text), ['工具前', '工具后'])
  assert.equal(chunks.filter((chunk) => chunk.type === 'tool-event' && chunk.status === 'completed').length, 1)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'stop' })
  driver.dispose()
})

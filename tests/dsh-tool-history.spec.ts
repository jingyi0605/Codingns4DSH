import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CodingNsDshToolHistoryProjector } from '../dist/host/cli-adapters/dsh-tool-history.js'
import { CommandCodeDriver } from '../dist/host/cli-adapters/command-code-driver.js'
import { ClaudeCodeDriver } from '../dist/host/cli-adapters/claude-driver.js'
import { KimiCliDriver } from '../dist/host/cli-adapters/kimi-driver.js'
import { GeminiCliDriver } from '../dist/host/cli-adapters/gemini-driver.js'
import { PiAgentDriver } from '../dist/host/cli-adapters/pi-driver.js'
import { CodexAppServerDriver } from '../dist/host/cli-adapters/codex-driver.js'
import { OpenCodeDriver } from '../dist/host/cli-adapters/opencode-driver.js'
import { GrokBuildDriver } from '../dist/host/cli-adapters/grok-driver.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function createSink() {
  const calls: Array<{ sessionId: string; call: Record<string, unknown> }> = []
  const results: Array<{ handle: Record<string, unknown>; result: Record<string, unknown> }> = []
  const bridge = {
    appendToolCall(sessionId: string, call: Record<string, unknown>) {
      calls.push({ sessionId, call })
      return { sessionId, turn: 1, step: 1, callId: String(call.callId), callSeq: calls.length }
    },
    appendToolResult(handle: Record<string, unknown>, result: Record<string, unknown>) {
      results.push({ handle, result })
      return true
    },
  }
  return { bridge, calls, results }
}

test('公共工具投影层聚合生命周期并提取 Provider 文本块', () => {
  const sink = createSink()
  const projector = new CodingNsDshToolHistoryProjector(sink.bridge as never, 'session-1')
  projector.observe({ type: 'tool-event', toolName: 'read_directory', callId: 'call-1', input: '{"path":"."}', status: 'running' })
  projector.observe({
    type: 'tool-event',
    toolName: 'tool',
    callId: 'call-1',
    output: '[{"type":"text","text":"Found 2 items"}]',
    outputMode: 'snapshot',
    status: 'completed',
  })
  projector.finalize('stop')

  assert.deepEqual(sink.calls, [{
    sessionId: 'session-1',
    call: { callId: 'call-1', name: 'read_directory', arguments: '{"path":"."}' },
  }])
  assert.deepEqual(sink.results[0]?.result, { output: 'Found 2 items', isError: false })
})

test('公共工具投影层在当前 step 立即追加原生工具事件', async () => {
  const calls: string[] = []
  const session = {}
  let onEvent: ((subject: unknown, event: unknown) => void) | undefined
  let publishing = false
  const bridge = {
    supportsEvents: true,
    get() { return session },
    subscribe(handlers: { onEvent?: (subject: unknown, event: unknown) => void }) {
      onEvent = handlers.onEvent
      return () => { onEvent = undefined }
    },
    appendToolCall() {
      if (publishing) throw new Error('Session 正在发布事件时禁止重入 append')
      calls.push('tool/call')
      return { sessionId: 'session-deferred', turn: 1, step: 1, callId: 'call-1', callSeq: 1 }
    },
    appendToolResult() {
      calls.push('tool/result')
      return true
    },
  }
  const projector = new CodingNsDshToolHistoryProjector(bridge as never, 'session-deferred')
  projector.observe({ type: 'tool-event', toolName: 'bash', callId: 'call-1', input: 'pwd', status: 'running' })
  projector.observe({ type: 'tool-event', toolName: 'bash', callId: 'call-1', output: '/workspace', outputMode: 'snapshot', status: 'completed' })
  projector.finalize('stop')

  assert.deepEqual(calls, ['tool/call', 'tool/result'])
  publishing = true
  onEvent?.(session, { type: 'step/start' })
  publishing = false
  await Promise.resolve()
  assert.deepEqual(calls, ['tool/call', 'tool/result'])
})

test('公共工具投影层优先按通知顺序保存外部工具标记，不追加原生 call/result', () => {
  const markers: Array<Record<string, unknown>> = []
  const bridge = {
    appendExternalToolEvent(_sessionId: string, marker: Record<string, unknown>) {
      markers.push(marker)
      return true
    },
  }
  const projector = new CodingNsDshToolHistoryProjector(bridge as never, 'session-timeline')
  assert.equal(projector.observe({ type: 'tool-event', toolName: 'bash', callId: 'bash-1', input: 'pwd', status: 'running' })?.phase, 'start')
  assert.equal(projector.observe({ type: 'tool-event', toolName: 'bash', callId: 'bash-1', output: '/workspace', outputMode: 'snapshot', status: 'completed' })?.phase, 'update')
  projector.finalize('stop')

  assert.deepEqual(markers.map((marker) => ({ phase: marker.phase, status: marker.status, output: marker.output })), [
    { phase: 'start', status: 'running', output: undefined },
    { phase: 'update', status: 'completed', output: '/workspace' },
  ])
})

test('公共工具投影层在 step 尚未打开时等待并补写持久起点', async () => {
  const session = {}
  const markers: Array<Record<string, unknown>> = []
  let stepOpen = false
  let onEvent: ((subject: unknown, event: unknown) => void) | undefined
  const bridge = {
    supportsEvents: true,
    get() { return session },
    subscribe(handlers: { onEvent?: (subject: unknown, event: unknown) => void }) {
      onEvent = handlers.onEvent
      return () => { onEvent = undefined }
    },
    appendExternalToolEvent(_sessionId: string, marker: Record<string, unknown>) {
      if (!stepOpen) return false
      markers.push(marker)
      return true
    },
  }
  const projector = new CodingNsDshToolHistoryProjector(bridge as never, 'session-race')
  assert.deepEqual(projector.observe({ type: 'tool-event', toolName: 'bash', callId: 'bash-race', input: 'pwd', status: 'running' }), {
    source: 'codingns-external-tool',
    phase: 'start',
    callId: 'bash-race',
    name: 'bash',
    arguments: '{"command":"pwd"}',
    status: 'running',
  })
  stepOpen = true
  onEvent?.(session, { type: 'step/start' })
  await Promise.resolve()
  assert.deepEqual(markers.map((marker) => marker.phase), ['start'])
  assert.deepEqual(projector.observe({ type: 'tool-event', toolName: 'bash', callId: 'bash-race', output: '/workspace', outputMode: 'snapshot', status: 'completed' }), {
    source: 'codingns-external-tool',
    phase: 'update',
    callId: 'bash-race',
    name: 'bash',
    arguments: '{"command":"pwd"}',
    status: 'completed',
    output: '/workspace',
  })
  assert.deepEqual(markers.map((marker) => marker.phase), ['start', 'update'])
  projector.finalize('stop')
})

test('公共工具投影层统一映射 edit_file 并生成 DSH diff 元数据', () => {
  const sink = createSink()
  const projector = new CodingNsDshToolHistoryProjector(sink.bridge as never, 'session-edit')
  projector.observe({
    type: 'tool-event',
    toolName: 'edit_file',
    callId: 'edit-1',
    input: JSON.stringify({ filePath: '/workspace/a.ts', oldString: 'old', newString: 'new', replaceAll: true }),
    status: 'running',
  })
  projector.observe({
    type: 'tool-event',
    toolName: 'tool',
    callId: 'edit-1',
    output: 'Updated /workspace/a.ts',
    outputMode: 'snapshot',
    status: 'completed',
  })
  projector.finalize('stop')

  assert.deepEqual(sink.calls[0]?.call, {
    callId: 'edit-1',
    name: 'edit',
    arguments: JSON.stringify({ file_path: '/workspace/a.ts', old_string: 'old', new_string: 'new', replace_all: true }),
  })
  assert.deepEqual(sink.results[0]?.result, {
    output: 'Updated /workspace/a.ts',
    isError: false,
    meta: { diffs: [{ path: '/workspace/a.ts', oldText: 'old', newText: 'new' }] },
  })
})

test('公共工具投影层把 shell 别名归一为 bash 且失败终态只记录一次', () => {
  const sink = createSink()
  const projector = new CodingNsDshToolHistoryProjector(sink.bridge as never, 'session-shell')
  projector.observe({ type: 'tool-event', toolName: 'shell_command', callId: 'shell-1', input: '{"command":"exit 2"}', status: 'running' })
  projector.observe({ type: 'tool-event', toolName: 'tool', callId: 'shell-1', error: 'exit 2', status: 'failed' })
  projector.finalize('error', '不应重复')

  assert.equal(sink.calls[0]?.call.name, 'bash')
  assert.deepEqual(sink.results.map(({ result }) => result), [{ output: 'exit 2', isError: true, error: 'exit 2' }])
})

test('所有外部 Agent 驱动只产出统一事件，不直接依赖 DSH 原生消息', async () => {
  const directory = join(projectRoot, 'src/host/cli-adapters')
  const files = (await readdir(directory)).filter((file) => file === 'driver.ts' || file.endsWith('-driver.ts'))
  const forbidden = /native-session-bridge|dsh-message-projector|dsh-tool-history|appendToolCall|appendToolResult|tool\/call|tool\/result|toDshChunks/u

  for (const file of files) {
    const source = await readFile(join(directory, file), 'utf8')
    assert.doesNotMatch(source, forbidden, `${file} 不得绕过统一事件契约直接对接 DSH`)
  }
})

test('公共消息链路不保留旧契约、旧工具事件或浏览器权限 RPC', async () => {
  const adapterDirectory = join(projectRoot, 'src/host/cli-adapters')
  const adapterFiles = (await readdir(adapterDirectory)).filter((file) => file.endsWith('.ts'))
  const files = [
    ...adapterFiles.map((file) => join(adapterDirectory, file)),
    join(projectRoot, 'src/shared/contracts/cli-adapter.ts'),
    join(projectRoot, 'src/shared/index.ts'),
    join(projectRoot, 'src/client/cli-catalog.ts'),
    join(projectRoot, 'src/host/rpc.ts'),
  ]
  const forbidden = /CodingNsCliStreamChunk|CodingNsCliToolObservation|CodingNsCliStreamNormalizer|CodingNsNormalizedCliStreamChunk|CodingNsCliPermissionResponse|tool-running|permission\/respond|respondToPermission/u

  for (const file of files) {
    assert.doesNotMatch(await readFile(file, 'utf8'), forbidden, `${file} 仍包含旧消息实现`)
  }
})

test('八个适配器声明的交互能力与实际回传接口一致', async () => {
  const drivers = [
    new CommandCodeDriver(),
    new ClaudeCodeDriver(),
    new KimiCliDriver(),
    new GeminiCliDriver(),
    new PiAgentDriver(),
    new CodexAppServerDriver(),
    new OpenCodeDriver(),
    new GrokBuildDriver(),
  ]

  try {
    for (const driver of drivers) {
      const capabilities = driver.descriptor.capabilities ?? []
      assert.equal(
        capabilities.includes('permission'),
        typeof driver.respondPermission === 'function',
        `${driver.descriptor.id} 的权限能力声明与接口不一致`,
      )
      assert.equal(
        capabilities.includes('questions'),
        typeof driver.respondQuestion === 'function',
        `${driver.descriptor.id} 的问题能力声明与接口不一致`,
      )
    }
  } finally {
    for (const driver of drivers) await driver.dispose?.()
  }
})

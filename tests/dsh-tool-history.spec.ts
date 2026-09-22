import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CodingNsDshToolHistoryProjector } from '../dist/host/cli-adapters/dsh-tool-history.js'

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
  projector.observe({ type: 'tool-running', toolName: 'read_directory', callId: 'call-1', input: '{"path":"."}', status: 'running' })
  projector.observe({
    type: 'tool-running',
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

test('公共工具投影层统一映射 edit_file 并生成 DSH diff 元数据', () => {
  const sink = createSink()
  const projector = new CodingNsDshToolHistoryProjector(sink.bridge as never, 'session-edit')
  projector.observe({
    type: 'tool-running',
    toolName: 'edit_file',
    callId: 'edit-1',
    input: JSON.stringify({ filePath: '/workspace/a.ts', oldString: 'old', newString: 'new', replaceAll: true }),
    status: 'running',
  })
  projector.observe({
    type: 'tool-running',
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
  projector.observe({ type: 'tool-running', toolName: 'shell_command', callId: 'shell-1', input: '{"command":"exit 2"}', status: 'running' })
  projector.observe({ type: 'tool-running', toolName: 'tool', callId: 'shell-1', error: 'exit 2', status: 'failed' })
  projector.finalize('error', '不应重复')

  assert.equal(sink.calls[0]?.call.name, 'bash')
  assert.deepEqual(sink.results.map(({ result }) => result), [{ output: 'exit 2', isError: true, error: 'exit 2' }])
})

test('所有外部 Agent 驱动只产出统一事件，不直接依赖 DSH 原生消息', async () => {
  const directory = join(projectRoot, 'src/host/cli-adapters')
  const files = (await readdir(directory)).filter((file) => file === 'driver.ts' || file.endsWith('-driver.ts'))
  const forbidden = /native-session-bridge|dsh-tool-history|appendToolCall|appendToolResult|tool\/call|tool\/result|toDshChunks/u

  for (const file of files) {
    const source = await readFile(join(directory, file), 'utf8')
    assert.doesNotMatch(source, forbidden, `${file} 不得绕过统一事件契约直接对接 DSH`)
  }
})

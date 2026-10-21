import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { CodexAppServerDriver } from '../src/host/cli-adapters/codex-driver.js'

async function runTurn(modelId: string): Promise<{
  readonly threadStart: Record<string, unknown>
  readonly turnStarts: readonly Record<string, unknown>[]
}> {
  const requests: Array<{ readonly method?: string; readonly params?: Record<string, unknown> }> = []
  let turnCount = 0
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 0.162.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const threadId = 'magpie-thread'
      const stdin = {
        write(data: string): void {
          const request = JSON.parse(data) as { readonly id: number; readonly method: string; readonly params?: Record<string, unknown> }
          if (request.method === 'initialized') return
          requests.push(request)
          if (request.method === 'initialize') {
            const clientInfo = request.params?.clientInfo as { readonly version?: unknown } | undefined
            const response = typeof clientInfo?.version === 'string' && clientInfo.version !== ''
              ? { result: {} }
              : { error: { code: -32600, message: 'Invalid request: missing field `version`' } }
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response })}\n`)
          } else if (request.method === 'thread/start') {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { thread: { id: threadId } } })}\n`)
          } else if (request.method === 'turn/start') {
            const turnId = `magpie-turn-${++turnCount}`
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } })}\n`)
            setImmediate(() => {
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'magpie-message', delta: 'OK' } })}\n`)
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })}\n`)
            })
          } else {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          }
        },
      }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  try {
    const events = []
    for (const prompt of ['First turn', 'Follow-up turn']) {
      for await (const event of driver.executeTurn({
        sessionId: 'magpie-model-session', messages: [], prompt, modelId,
      })) events.push(event)
    }
    assert.equal(events.at(-1)?.type, 'finish')
    return {
      threadStart: requests.find((request) => request.method === 'thread/start')?.params ?? {},
      turnStarts: requests.filter((request) => request.method === 'turn/start').map((request) => request.params ?? {}),
    }
  } finally {
    driver.dispose()
  }
}

test('Codex sends a selected Magpie model on thread/start and every turn/start', async () => {
  const modelId = 'auto/gpt-6.1-sol'
  const requests = await runTurn(modelId)
  assert.equal(requests.threadStart.model, modelId)
  assert.equal(requests.turnStarts.length, 2)
  assert.deepEqual(requests.turnStarts.map((params) => params.model), [modelId, modelId])
  assert.deepEqual(requests.turnStarts.map((params) => params.responsesapiClientMetadata), [
    { workspace_kind: 'project' },
    { workspace_kind: 'project' },
  ])
})

test('Codex leaves provider-default selection to the configured thread model', async () => {
  const requests = await runTurn('provider-default')
  assert.equal(requests.turnStarts.length, 2)
  assert.ok(requests.turnStarts.every((params) => !('model' in params)))
  assert.deepEqual(requests.turnStarts.map((params) => params.responsesapiClientMetadata), [
    { workspace_kind: 'project' },
    { workspace_kind: 'project' },
  ])
})

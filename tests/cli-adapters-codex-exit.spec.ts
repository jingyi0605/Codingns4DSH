import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { CodexAppServerDriver } from '../src/host/cli-adapters/codex-driver.js'
import { CodingNsDshMessageProjector } from '../src/host/cli-adapters/dsh-message-projector.js'
import type { CodingNsAgentEvent } from '../src/shared/contracts/cli-adapter.js'

const scenarios = [
  ...(['empty', 'partial', 'starting', 'completed', 'cancel'] as const).map(scenario => ({ scenario, segmented: false, pause: false })),
  { scenario: 'partial', segmented: true, pause: false },
  { scenario: 'completed', segmented: true, pause: false },
  { scenario: 'completed', segmented: true, pause: true },
]
for (const { scenario, segmented, pause } of scenarios) {
  const mode = pause ? 'suspended segmented' : segmented ? 'segmented' : 'normal'
  test(`Codex process exit settles a ${mode} turn promptly: ${scenario}`, { timeout: segmented ? 3000 : 8000 }, async () => {
    const controller = new AbortController()
    let child: ReturnType<typeof spawn> | undefined
    let childClosed: Promise<unknown> | undefined
    const driver = new CodexAppServerDriver({
      binaries: ['fixture-codex'],
      spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
      spawn: ((_command, _args, options) => {
        child = spawn(process.execPath, ['-e', `
          const readline = require('node:readline');
          const send = value => console.log(JSON.stringify(value));
          readline.createInterface({ input: process.stdin }).on('line', line => {
            const request = JSON.parse(line);
            if (request.id === undefined) return;
            if (request.method === 'turn/start') {
              if (${JSON.stringify(scenario)} === 'starting') process.exit(17);
              send({ id: request.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
              if (${segmented} && ${JSON.stringify(scenario)} === 'partial') {
                send({ id: 401, method: 'item/commandExecution/requestApproval', params: {
                  threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', command: 'pwd',
                } });
              }
              if (${JSON.stringify(scenario)} !== 'empty') {
                send({ method: 'item/agentMessage/delta', params: {
                  threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Partial output',
                } });
              }
              if (${pause}) {
                send({ method: 'item/completed', params: {
                  threadId: 'thread-1', turnId: 'turn-1',
                  item: { id: 'command-1', type: 'commandExecution', status: 'completed', command: 'pwd' },
                } });
                send({ method: 'item/agentMessage/delta', params: {
                  threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-2', delta: ' after the tool',
                } });
              }
              if (${JSON.stringify(scenario)} === 'completed') send({ method: 'turn/completed', params: {
                threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
              } });
              if (${JSON.stringify(scenario)} !== 'cancel') setTimeout(() => process.exit(17), 50);
              return;
            }
            send({ id: request.id, result: request.method === 'thread/start' ? { threadId: 'thread-1' } : {} });
            if (request.method === 'turn/interrupt') process.stdout.write('', () => process.exit(17));
          });
        `], { ...options, windowsVerbatimArguments: false })
        childClosed = once(child, 'close')
        return child
      }) as typeof spawn,
    })
    const deadline = segmented ? undefined : setTimeout(() => controller.abort(), 3000)
    const sessionId = `exit-${scenario}`
    const events: CodingNsAgentEvent[] = []
    const startedAt = Date.now()
    try {
      const input = {
        sessionId, prompt: 'Test process termination', messages: [],
        ...(segmented ? { splitToolSteps: true } : { signal: controller.signal }),
      }
      for await (const event of driver.executeTurn(input)) {
        events.push(event)
        if (scenario === 'cancel' && event.type === 'text-delta') controller.abort()
        if (scenario === 'cancel' && event.type === 'finish') await childClosed
        if (segmented && !pause && scenario === 'completed' && event.type === 'text-delta') await childClosed
      }
      if (pause) {
        assert.equal(events.at(-1)?.type, 'step-boundary')
        await childClosed
        for await (const event of driver.executeTurn({ ...input, resumeSegmentedTurn: true })) events.push(event)
      }
      assert.ok(Date.now() - startedAt < 2000, 'Process failure must wake the turn without waiting for cancellation')
      const finish = events.findLast(event => event.type === 'finish')
      assert.equal(finish?.reason, scenario === 'completed' ? 'stop' : scenario === 'cancel' ? 'cancel' : 'error')
      assert.equal(events.filter(event => event.type === 'finish').length, 1)
      if (scenario === 'partial' || scenario === 'completed') {
        assert.equal(events.filter(event => event.type === 'text-delta').map(event => event.text).join(''), pause ? 'Partial output after the tool' : 'Partial output')
      }
      if (segmented && scenario === 'partial') {
        assert.ok(events.some(event => event.type === 'permission-request' && event.requestId === '401'))
        assert.throws(() => driver.respondPermission(sessionId, { requestId: '401', approved: false }), /Codex 权限请求不存在/u)
      }
      if (scenario !== 'completed' && scenario !== 'cancel') {
        assert.equal(finish?.failure?.code, 'PROVIDER_ERROR')
        const projector = new CodingNsDshMessageProjector({ adapterId: 'codex', sessionId: `exit-${scenario}` })
        const projected = []
        for (const event of events) {
          if (event.type !== 'permission-request') projected.push(...await projector.push(event))
        }
        assert.ok(JSON.stringify(projected).includes('PROVIDER_ERROR'))
      }
    } finally {
      clearTimeout(deadline)
      driver.dispose()
      child?.kill('SIGKILL')
    }
  })
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { CodexAppServerDriver } from '../src/host/cli-adapters/codex-driver.js'
import { CodingNsDshMessageProjector } from '../src/host/cli-adapters/dsh-message-projector.js'
import type { CodingNsAgentEvent } from '../src/shared/contracts/cli-adapter.js'

for (const scenario of ['empty', 'partial', 'starting', 'completed', 'cancel'] as const) {
  test(`Codex process exit settles a normal turn promptly: ${scenario}`, { timeout: 8000 }, async () => {
    const controller = new AbortController()
    let child: ReturnType<typeof spawn> | undefined
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
              if (${JSON.stringify(scenario)} === 'partial' || ${JSON.stringify(scenario)} === 'completed') {
                send({ method: 'item/agentMessage/delta', params: {
                  threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Partial output',
                } });
              }
              if (${JSON.stringify(scenario)} === 'completed') send({ method: 'turn/completed', params: {
                threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
              } });
              setTimeout(() => process.exit(17), 50);
              return;
            }
            send({ id: request.id, result: request.method === 'thread/start' ? { threadId: 'thread-1' } : {} });
          });
        `], options)
        return child
      }) as typeof spawn,
    })
    const deadline = setTimeout(() => controller.abort(), 3000)
    const events: CodingNsAgentEvent[] = []
    const startedAt = Date.now()
    try {
      for await (const event of driver.executeTurn({
        sessionId: `exit-${scenario}`, prompt: 'Test process termination', messages: [], signal: controller.signal,
      })) {
        events.push(event)
        if (scenario === 'cancel' && event.type === 'session-binding') controller.abort()
      }
      assert.ok(Date.now() - startedAt < 2000, 'Process failure must wake the turn without waiting for cancellation')
      const finish = events.findLast(event => event.type === 'finish')
      assert.equal(finish?.reason, scenario === 'completed' ? 'stop' : scenario === 'cancel' ? 'cancel' : 'error')
      assert.equal(events.filter(event => event.type === 'finish').length, 1)
      if (scenario !== 'completed' && scenario !== 'cancel') {
        assert.equal(finish?.failure?.code, 'PROVIDER_ERROR')
        const projector = new CodingNsDshMessageProjector({ adapterId: 'codex', sessionId: `exit-${scenario}` })
        const projected = []
        for (const event of events) projected.push(...await projector.push(event))
        assert.ok(JSON.stringify(projected).includes('PROVIDER_ERROR'))
      }
    } finally {
      clearTimeout(deadline)
      driver.dispose()
      child?.kill('SIGKILL')
    }
  })
}

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { CodexAppServerDriver } from '../data/build/dist/host/cli-adapters/codex-driver.js'

test('Codex app-server receives the Host credential broker environment at process startup', async () => {
  let spawnEnvironment: Record<string, string | undefined> | undefined
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: ((_command: string, _args: readonly string[], options: { readonly env?: Record<string, string | undefined> }) => {
      spawnEnvironment = options.env
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = {
        write(data: string): void {
          const request = JSON.parse(data) as { readonly id?: number; readonly method?: string }
          if (request.id === undefined || request.method === undefined) return
          const result = request.method === 'thread/start'
            ? { thread: { id: 'credential-thread' } }
            : request.method === 'turn/start'
              ? { turn: { id: 'credential-turn', status: 'inProgress' } }
              : {}
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
          if (request.method === 'turn/start') {
            stdout.write(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'turn/completed',
              params: { turn: { id: 'credential-turn', status: 'completed' } },
            })}\n`)
          }
        },
      }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  for await (const _event of driver.executeTurn({
    sessionId: 'codex-credential-env',
    messages: [],
    prompt: 'Use the credential broker',
    runtimeEnv: {
      CODINGNS_CREDENTIAL_BROKER_ENDPOINT: 'unix:/tmp/codingns-credential.sock',
      CODINGNS_CREDENTIAL_BROKER_TOKEN: 'env-marker-123',
      PATH: '/tmp/codingns-credential-bin:/usr/bin',
    },
  })) {}

  assert.equal(spawnEnvironment?.CODINGNS_CREDENTIAL_BROKER_ENDPOINT, 'unix:/tmp/codingns-credential.sock')
  assert.equal(spawnEnvironment?.CODINGNS_CREDENTIAL_BROKER_TOKEN, 'env-marker-123')
  assert.equal(spawnEnvironment?.PATH, '/tmp/codingns-credential-bin:/usr/bin')
})

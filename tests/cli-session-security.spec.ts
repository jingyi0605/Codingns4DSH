import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodingNsSettingsRpcHandler } from '../dist/host/rpc.js'

test('设置 RPC 不向浏览器暴露 Host-only 外部会话绑定', async () => {
  const handler = createCodingNsSettingsRpcHandler({
    writable: true,
    describe: () => [{ ns: 'codingns', revision: 1 }],
    get: () => ({
      controlBaseUrl: 'https://control.example.com',
      controlBaseUrls: ['https://control.example.com'],
      modules: {},
      agentAdapters: {},
      cliSessions: [{
        dshSessionId: 'dsh-1', adapterId: 'codex', providerSessionId: 'thread-secret',
        status: 'idle', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
      }],
      lanAccessDsh: { autoStart: false, listenHost: '0.0.0.0', listenPort: 13080, dshPort: 0 },
    }),
    mutate: async () => undefined,
  })
  const response = await handler('get', {})
  assert.equal(response.value.cliSessions, undefined)
  assert.equal(JSON.stringify(response).includes('thread-secret'), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodingNsSettingsBridge } from '../data/build/dist/client/settings-bridge.js'
import { callCliRpc } from '../data/build/dist/client/cli-catalog.js'
import type { CodingNsSettings } from '../data/build/dist/shared/contracts/config.js'
import { CODINGNS_RPC_CHANNEL } from '../data/build/dist/shared/contracts/transport.js'

const settings: CodingNsSettings = {
  controlBaseUrl: 'https://control.example.com',
  controlBaseUrls: ['https://control.example.com'],
  modules: {},
  lanAccessDsh: { autoStart: false, listenHost: '0.0.0.0', listenPort: 13080, dshPort: 0 },
}

test('Host 模式但命名空间不可用时由远程设置 RPC 接管', async () => {
  let snapshot = {
    status: 'loading' as 'loading' | 'unavailable',
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: false,
    mode: 'host' as const,
  }
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  let notify: (() => void) | undefined
  const local = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      notify = listener
      return () => undefined
    },
    set: async () => undefined,
    unset: async () => undefined,
    mutate: async () => undefined,
  }
  const rpc = {
    call: async (_channel: string, endpoint: string, payload: unknown) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'settings/get') return { ok: true as const, value: { value: settings, revision: 2 } }
      return { ok: true as const, value: { value: { ...settings, modules: { reverseProxy: true } }, revision: 3 } }
    },
  }
  const bridge = createCodingNsSettingsBridge(local, rpc)

  snapshot = { ...snapshot, status: 'unavailable' }
  notify?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(bridge.getSnapshot().writable, true)
  assert.deepEqual(bridge.getSnapshot().value, settings)
  await bridge.set('modules', { reverseProxy: true })
  assert.deepEqual(calls.map((entry) => entry.endpoint), ['settings/get', 'settings/set'])
  snapshot = bridge.getSnapshot()
  assert.equal(snapshot.value?.modules.reverseProxy, true)
})

test('远程设置 RPC 在逻辑通道不存在时回退到 /api 路由', async () => {
  const local = {
    getSnapshot: () => ({
      status: 'unavailable' as const,
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: 'host' as const,
    }),
    subscribe: () => () => undefined,
    set: async () => undefined,
    unset: async () => undefined,
    mutate: async () => undefined,
  }
  const calls: Array<[string, string]> = []
  const rpc = {
    call: async (channel: string, endpoint: string) => {
      calls.push([channel, endpoint])
      if (channel === CODINGNS_RPC_CHANNEL) throw new Error('transport failure for /codingns/settings/get: HTTP 404')
      return { ok: true as const, value: { value: settings, revision: 7 } }
    },
  }
  const bridge = createCodingNsSettingsBridge(local, rpc)

  await bridge.load()

  assert.deepEqual(calls, [
    [CODINGNS_RPC_CHANNEL, 'settings/get'],
    ['/api', 'codingns/settings/get'],
  ])
  assert.equal(bridge.getSnapshot().writable, true)
  assert.deepEqual(bridge.getSnapshot().value, settings)
})

test('外部 Agent RPC 在逻辑通道返回 405 时回退到 /api 路由', async () => {
  const calls: Array<[string, string]> = []
  const rpc = {
    call: async (channel: string, endpoint: string) => {
      calls.push([channel, endpoint])
      if (channel === CODINGNS_RPC_CHANNEL) throw new Error('transport failure for /codingns/cli/catalog: HTTP 405')
      return { ok: true as const, value: [{ id: 'command-code', enabled: true }] }
    },
  }

  const value = await callCliRpc(rpc, 'catalog', {})

  assert.deepEqual(calls, [
    [CODINGNS_RPC_CHANNEL, 'cli/catalog'],
    ['/api', 'codingns/cli/catalog'],
  ])
  assert.deepEqual(value, [{ id: 'command-code', enabled: true }])
})

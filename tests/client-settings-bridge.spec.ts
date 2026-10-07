import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodingNsSettingsBridge } from '../data/build/dist/client/settings-bridge.js'
import { callCliRpc } from '../data/build/dist/client/cli-catalog.js'
import type { CodingNsSettings } from '../data/build/dist/shared/contracts/config.js'
import { CODINGNS_RPC_CHANNEL } from '../data/build/dist/shared/contracts/transport.js'

test('Host 音色业务 RPC 修改后，reload 绕过 load 缓存并立即更新播报设置', async () => {
  let backend = 'browser'; let reads = 0
  const bridge = createCodingNsSettingsBridge(undefined, { call: async () => {
    reads++
    return { ok: true as const, value: { value: { ...settings, assistant: { tts: { backend } } }, revision: reads } }
  } })
  await bridge.load?.()
  backend = 'moss-onnx'
  await bridge.load?.()
  assert.equal(reads, 1, '普通 load 保持缓存语义')
  await bridge.reload?.()
  assert.equal(reads, 2)
  assert.equal(bridge.getSnapshot().value?.assistant.tts?.backend, 'moss-onnx')
})

const settings: CodingNsSettings = {
  controlBaseUrl: 'https://control.example.com',
  controlBaseUrls: ['https://control.example.com'],
  modules: {},
  lanAccessDsh: { autoStart: false, listenHost: '0.0.0.0', listenPort: 13080, dshPort: 0 },
}

test('本地镜像内容未变化时不重复通知设置页', () => {
  const value = { controlBaseUrl: 'https://control.example.com', modules: {} }
  let notify: (() => void) | undefined
  const local = {
    // 只读/同步镜像会在每次读取时构造新对象；内容相同的通知必须被吞掉。
    getSnapshot: () => ({
      status: 'ready' as const,
      value: { ...value, modules: { ...value.modules } },
      base: undefined,
      user: undefined,
      revision: 5,
      writable: true,
      mode: 'host' as const,
    }),
    subscribe: (listener: () => void) => { notify = listener; return () => undefined },
    set: async () => undefined,
    unset: async () => undefined,
    mutate: async () => undefined,
  }
  const bridge = createCodingNsSettingsBridge(local, {
    call: async () => { throw new Error('本地镜像可用时不应请求 Host RPC') },
  })
  const first = bridge.getSnapshot()
  let calls = 0
  bridge.subscribe(() => { calls += 1 })

  notify?.()

  assert.equal(calls, 0)
  assert.equal(bridge.getSnapshot(), first)
})

test('没有本地设置镜像时完全使用 Host RPC', async () => {
  const calls: string[] = []
  const bridge = createCodingNsSettingsBridge(undefined, {
    call: async (_channel: string, endpoint: string) => {
      calls.push(endpoint)
      if (endpoint === 'settings/get') return { ok: true as const, value: { value: settings, revision: 6 } }
      return { ok: true as const, value: { value: { ...settings, modules: { reverseProxy: true } }, revision: 7 } }
    },
  })

  // 局域网与中继页面拿不到 DSH 的持久设置镜像，读取前只暴露稳定的占位快照。
  assert.equal(bridge.getSnapshot().status, 'unavailable')
  assert.equal(bridge.getSnapshot(), bridge.getSnapshot())

  await bridge.load()

  assert.deepEqual(calls, ['settings/get'])
  assert.equal(bridge.getSnapshot().writable, true)
  assert.deepEqual(bridge.getSnapshot().value, settings)
  assert.equal(await bridge.set('modules', { reverseProxy: true }), true)
  assert.deepEqual(calls, ['settings/get', 'settings/set'])
  assert.equal(bridge.getSnapshot().value?.modules.reverseProxy, true)
})

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

test('远程 DSH Web iframe 强制使用外层 CodingNS Host 设置', async () => {
  const previous = (globalThis as typeof globalThis & { __CODINGNS4DSH_REMOTE_WEB_CONTEXT__?: unknown }).__CODINGNS4DSH_REMOTE_WEB_CONTEXT__
  ;(globalThis as typeof globalThis & { __CODINGNS4DSH_REMOTE_WEB_CONTEXT__?: unknown }).__CODINGNS4DSH_REMOTE_WEB_CONTEXT__ = true
  try {
    const local = {
      getSnapshot: () => ({ status: 'ready' as const, value: settings, revision: 4, writable: true, mode: 'host' as const }),
      subscribe: () => () => undefined,
      set: async () => undefined,
      unset: async () => undefined,
      mutate: async () => undefined,
    }
    let loaded = false
    const rpc = {
      call: async (_channel: string, endpoint: string) => {
        assert.equal(endpoint, 'settings/get')
        loaded = true
        return { ok: true as const, value: { value: settings, revision: 9 } }
      },
    }
    const bridge = createCodingNsSettingsBridge(local, rpc)
    await bridge.load()
    assert.equal(loaded, true)
    assert.equal(bridge.getSnapshot().revision, 9)
  } finally {
    const target = globalThis as typeof globalThis & { __CODINGNS4DSH_REMOTE_WEB_CONTEXT__?: unknown }
    if (previous === undefined) delete target.__CODINGNS4DSH_REMOTE_WEB_CONTEXT__
    else target.__CODINGNS4DSH_REMOTE_WEB_CONTEXT__ = previous
  }
})

test('局域网 HTTP 页面也使用外层 CodingNS Host 设置', async () => {
  const globalValue = globalThis as typeof globalThis & {
    location?: { readonly protocol?: string }
    __CODINGNS4DSH_REMOTE_WEB_CONTEXT__?: unknown
  }
  const previousLocation = globalValue.location
  const previousMarker = globalValue.__CODINGNS4DSH_REMOTE_WEB_CONTEXT__
  globalValue.location = { protocol: 'http:', href: 'http://127.0.0.1:13080/' }
  delete globalValue.__CODINGNS4DSH_REMOTE_WEB_CONTEXT__
  try {
    const local = {
      getSnapshot: () => ({ status: 'ready' as const, value: settings, revision: 1, writable: true, mode: 'host' as const }),
      subscribe: () => () => undefined,
      set: async () => undefined,
      unset: async () => undefined,
      mutate: async () => undefined,
    }
    let calls = 0
    const bridge = createCodingNsSettingsBridge(local, {
      call: async () => {
        calls += 1
        return { ok: true as const, value: { value: settings, revision: 2 } }
      },
    })
    await bridge.load()
    assert.equal(calls, 1)
    assert.equal(bridge.getSnapshot().revision, 2)
  } finally {
    if (previousLocation === undefined) delete globalValue.location
    else globalValue.location = previousLocation
    if (previousMarker === undefined) delete globalValue.__CODINGNS4DSH_REMOTE_WEB_CONTEXT__
    else globalValue.__CODINGNS4DSH_REMOTE_WEB_CONTEXT__ = previousMarker
  }
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

test('只读 SettingsScope 镜像切换到 Host RPC 后可写', async () => {
  const local = {
    getSnapshot: () => ({
      status: 'ready' as const,
      value: settings,
      revision: 1,
      writable: false,
      mode: 'host' as const,
    }),
    subscribe: () => () => undefined,
    set: async () => undefined,
    unset: async () => undefined,
    mutate: async () => undefined,
  }
  const calls: string[] = []
  const bridge = createCodingNsSettingsBridge(local, {
    call: async (_channel, endpoint) => {
      calls.push(endpoint)
      return { ok: true as const, value: { value: { ...settings, modules: { peerHost: false } }, revision: 2 } }
    },
  })

  await bridge.load()
  assert.equal(bridge.getSnapshot().writable, true)
  assert.deepEqual(calls, ['settings/get'])
  assert.equal(await bridge.mutate([{ op: 'set', path: ['modules', 'peerHost'], value: false }]), true)
  assert.deepEqual(calls, ['settings/get', 'settings/set'])
  assert.equal(bridge.getSnapshot().value?.modules.peerHost, false)
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

import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL,
  CODINGNS_BOOTSTRAP_DSH_VERSION,
  createDshPeerHostPrebootShimScript,
  installDshPeerHostPrebootShim,
} from '../data/build/dist/bootstrap/index.js'

type ShimGlobal = typeof globalThis & {
  __DSH_TRANSPORT__?: unknown
  dshDesktopBoot?: unknown
  location?: unknown
  [DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]?: { getState: () => string; getMode: () => string; activate: (t?: unknown) => string; deactivate: () => string; dispose: () => void }
}

async function withCleanGlobals(run: (globals: ShimGlobal) => void | Promise<void>): Promise<void> {
  const globals = globalThis as ShimGlobal
  const previous = {
    transport: globals.__DSH_TRANSPORT__,
    desktop: globals.dshDesktopBoot,
    shim: globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL],
  }
  const hadTransport = Object.hasOwn(globals, '__DSH_TRANSPORT__')
  const hadDesktop = Object.hasOwn(globals, 'dshDesktopBoot')
  delete globals.__DSH_TRANSPORT__
  delete globals.dshDesktopBoot
  delete globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
  try {
    await run(globals)
  } finally {
    if (hadTransport) globals.__DSH_TRANSPORT__ = previous.transport
    else delete globals.__DSH_TRANSPORT__
    if (hadDesktop) globals.dshDesktopBoot = previous.desktop
    else delete globals.dshDesktopBoot
    if (previous.shim === undefined) delete globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
    else globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] = previous.shim
  }
}

test('0.2.0-rc.1/rc.2 Web shim 可幂等安装并在激活后切换 rpc.call', async () => {
  await withCleanGlobals(async (globals) => {
    const first = installDshPeerHostPrebootShim({ dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION })
    const second = installDshPeerHostPrebootShim({ dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION })
    assert.equal(first, second)
    assert.equal(first.getMode(), 'web')
    assert.equal(first.getState(), 'installed')
    assert.equal(first.activate(), 'requires-reload')
    assert.equal(first.getState(), 'requires-reload')
    first.deactivate()
    const transport = globals.__DSH_TRANSPORT__ as { rpc: { call: (...args: unknown[]) => Promise<unknown>; open?: unknown } }
    const activeCalls: unknown[] = []
    first.activate({
      rpc: async (request) => { activeCalls.push(request); return { ok: true, value: 'peer' } },
      openStream: () => [],
    })
    assert.equal(first.getState(), 'active')
    assert.deepEqual(await transport.rpc.call('/codingns', 'peerHost/native', { id: 1 }), { ok: true, value: 'peer' })
    assert.deepEqual(activeCalls, [{ method: 'peerHost/native', payload: { channel: '/codingns', payload: { id: 1 } } }])
    first.deactivate()
    assert.equal(first.getState(), 'installed')
    first.dispose()
    assert.equal(globals.__DSH_TRANSPORT__, undefined)
    // 兼容范围只声明下界后，同一个 shim 必须能在更新的 rc 版本上安装。
    const updated = installDshPeerHostPrebootShim({ dshVersion: '0.2.0-rc.2' })
    assert.equal(updated.getState(), 'installed')
    assert.equal(updated.version, '0.2.0-rc.2')
    updated.dispose()
  })
})

test('Desktop 已先下发 Transport 时 shim 用访问器接管并保留 streamBaseUrl', () => {
  withCleanGlobals((globals) => {
    // Desktop 前端 Bundle 的真实顺序：先赋值 Transport，再执行注入脚本行。
    const desktopTransport = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:13082' }
    globals.__DSH_TRANSPORT__ = desktopTransport
    globals.dshDesktopBoot = {}
    const shim = installDshPeerHostPrebootShim({ dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION })
    assert.equal(shim.getMode(), 'desktop')
    assert.equal(shim.getState(), 'installed')

    const facade = globals.__DSH_TRANSPORT__ as Record<string, unknown>
    assert.equal(facade.ownsHost, true)
    // streamBaseUrl 必须透传，否则 `/api/remote.mux` 会退回 document.baseURI。
    assert.equal(facade.streamBaseUrl, 'http://127.0.0.1:13082')
    // Desktop 分支不提供 rpc/openStream：DSH 必须继续创建原生 createWebConnectionRpc，
    // 网关才能按 `connection.rpc.open === void 0` 启动原生 Remote mux。
    assert.equal(facade.rpc, undefined)
    assert.equal(facade.openStream, undefined)
    // 原始 Transport 对象保持可读，且 shim 没有覆盖 Desktop 自己下发的字段。
    assert.equal(desktopTransport.ownsHost, true)

    shim.dispose()
    assert.equal(globals.__DSH_TRANSPORT__, desktopTransport)
  })
})

test('Desktop 在 shim 之后赋值时 setter 接管，基址随赋值更新', () => {
  withCleanGlobals((globals) => {
    globals.dshDesktopBoot = {}
    const shim = installDshPeerHostPrebootShim({ dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION })
    assert.equal(shim.getMode(), 'desktop')
    const facade = globals.__DSH_TRANSPORT__ as Record<string, unknown>
    assert.equal(facade.streamBaseUrl, undefined)
    // Desktop 之后才赋值：setter 只更新 baseline，facade 身份不变。
    globals.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:13082' }
    assert.equal(globals.__DSH_TRANSPORT__, facade)
    assert.equal(facade.streamBaseUrl, 'http://127.0.0.1:13082')
    shim.dispose()
  })
})

test('Desktop 协议是 dsh-app: 时也按 Desktop 拓扑接管', () => {
  withCleanGlobals((globals) => {
    globals.location = { protocol: 'dsh-app:' }
    try {
      const shim = installDshPeerHostPrebootShim({ dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION })
      assert.equal(shim.getMode(), 'desktop')
      shim.dispose()
    } finally {
      delete (globals as { location?: unknown }).location
    }
  })
})

test('未知 Transport 形状保持 external，不被 shim 覆盖，也不接受不支持的版本', () => {
  withCleanGlobals((globals) => {
    globals.__DSH_TRANSPORT__ = 'desktop-managed'
    globals.dshDesktopBoot = {}
    const shim = installDshPeerHostPrebootShim({ dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION })
    assert.equal(shim.getState(), 'external')
    assert.equal(shim.getMode(), 'external')
    assert.equal(globals.__DSH_TRANSPORT__, 'desktop-managed')
    assert.throws(() => installDshPeerHostPrebootShim({ dshVersion: '0.1.7-rc.2' }), /不支持/u)
  })
})

test('启动页脚本在 Connection 读取前创建 facade，且脚本可重复执行', () => {
  const sandbox: Record<string, unknown> = {}
  const script = createDshPeerHostPrebootShimScript()
  runInNewContext(script, sandbox)
  const firstTransport = sandbox.__DSH_TRANSPORT__ as { rpc?: { call?: unknown; open?: unknown } }
  assert.equal(typeof firstTransport.rpc, 'object')
  assert.equal(firstTransport.rpc?.open, undefined)
  assert.equal((sandbox[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] as { getState: () => string }).getState(), 'installed')
  assert.equal((sandbox[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] as { getMode: () => string }).getMode(), 'web')
  const shim = sandbox[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] as { activate: (transport?: unknown) => string; deactivate: () => string }
  assert.equal(shim.activate({ openStream: () => [] }), 'active')
  assert.equal(typeof firstTransport.rpc?.open, 'function')
  assert.equal(shim.deactivate(), 'installed')
  assert.equal(firstTransport.rpc?.open, undefined)
  runInNewContext(script, sandbox)
  assert.equal(sandbox.__DSH_TRANSPORT__, firstTransport)
  const skipped: Record<string, unknown> = {}
  runInNewContext(createDshPeerHostPrebootShimScript('0.1.7-rc.2'), skipped)
  assert.equal(skipped.__DSH_TRANSPORT__, undefined)
  assert.equal(skipped[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL], undefined)
})

test('启动页脚本在 Desktop 沙箱里接管 Transport 并保留 streamBaseUrl', () => {
  const sandbox: Record<string, unknown> = { dshDesktopBoot: {}, __DSH_TRANSPORT__: { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:13082' } }
  runInNewContext(createDshPeerHostPrebootShimScript(), sandbox)
  const facade = sandbox.__DSH_TRANSPORT__ as Record<string, unknown>
  assert.equal((sandbox[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] as { getMode: () => string }).getMode(), 'desktop')
  assert.equal(facade.streamBaseUrl, 'http://127.0.0.1:13082')
  assert.equal(facade.rpc, undefined)
  assert.equal(facade.openStream, undefined)
  // Desktop 之后赋值时 setter 接住，facade 身份不变。
  sandbox.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:9999' }
  assert.equal(sandbox.__DSH_TRANSPORT__, facade)
  assert.equal(facade.streamBaseUrl, 'http://127.0.0.1:9999')
  const shim = sandbox[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] as { getState: () => string; dispose: () => void }
  assert.equal(shim.getState(), 'installed')
  shim.dispose()
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL,
  CODINGNS_BOOTSTRAP_DSH_VERSION,
  createDshPeerHostPrebootShimScript,
  installDshPeerHostPrebootShim,
} from '../data/build/dist/bootstrap/index.js'

test('0.2.0-rc.1/rc.2 shim 可幂等安装并在激活后切换 rpc.call', async () => {
  const globals = globalThis as typeof globalThis & { __DSH_TRANSPORT__?: unknown; [DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]?: unknown }
  const previousTransport = globals.__DSH_TRANSPORT__
  const previousShim = globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
  delete globals.__DSH_TRANSPORT__
  delete globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
  try {
    const first = installDshPeerHostPrebootShim({ dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION })
    const second = installDshPeerHostPrebootShim({ dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION })
    assert.equal(first, second)
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
  } finally {
    if (previousTransport === undefined) delete globals.__DSH_TRANSPORT__
    else globals.__DSH_TRANSPORT__ = previousTransport
    if (previousShim === undefined) delete globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
    else globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] = previousShim
  }
})

test('已有 Desktop Transport 或未知版本不会被 shim 覆盖', () => {
  const globals = globalThis as typeof globalThis & { __DSH_TRANSPORT__?: unknown; dshDesktopBoot?: unknown; [DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]?: unknown }
  const previousTransport = globals.__DSH_TRANSPORT__
  const previousDesktop = globals.dshDesktopBoot
  const previousShim = globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
  const desktopTransport = { streamBaseUrl: 'dsh-app://app' }
  globals.__DSH_TRANSPORT__ = desktopTransport
  globals.dshDesktopBoot = {}
  delete globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
  try {
    const shim = installDshPeerHostPrebootShim({ dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION })
    assert.equal(shim.getState(), 'external')
    assert.equal(globals.__DSH_TRANSPORT__, desktopTransport)
    assert.throws(() => installDshPeerHostPrebootShim({ dshVersion: '0.1.7-rc.2' }), /不支持/u)
  } finally {
    if (previousTransport === undefined) delete globals.__DSH_TRANSPORT__
    else globals.__DSH_TRANSPORT__ = previousTransport
    if (previousDesktop === undefined) delete globals.dshDesktopBoot
    else globals.dshDesktopBoot = previousDesktop
    if (previousShim === undefined) delete globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
    else globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] = previousShim
  }
})

test('启动页脚本在 Connection 读取前创建 facade，且脚本可重复执行', () => {
  const sandbox: Record<string, unknown> = {}
  const script = createDshPeerHostPrebootShimScript()
  runInNewContext(script, sandbox)
  const firstTransport = sandbox.__DSH_TRANSPORT__ as { rpc?: { call?: unknown; open?: unknown } }
  assert.equal(typeof firstTransport.rpc, 'object')
  assert.equal(firstTransport.rpc?.open, undefined)
  assert.equal((sandbox[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] as { getState: () => string }).getState(), 'installed')
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

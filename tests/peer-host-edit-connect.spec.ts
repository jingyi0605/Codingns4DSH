import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPeerHostFeature } from '../data/build/dist/host/features/peer-host.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'

/** 目标 Host 的握手响应；pluginVersion 必须与当前插件版本一致才会 ready。 */
const PLUGIN_VERSION = (await import('../data/build/dist/shared/contracts/version.js')).CODINGNS_VERSION as string

function handshakeResponse(): Response {
  return Response.json({
    productId: 'CodingNS',
    pluginId: '@jingyi0605/codingns4dsh',
    pluginVersion: PLUGIN_VERSION,
    dshVersion: '0.2.0-rc.2',
    apiCompatibility: 'peer-host-v1',
    fingerprint: 'sha256:target',
    capabilities: [],
  })
}

interface Harness {
  readonly rpc: CodingNsRpcTable
  readonly calls: string[]
  call(endpoint: string, payload: unknown): Promise<unknown>
  dispose(): Promise<void>
}

/**
 * 装配一个只依赖假 fetch 的 Host PeerHost Feature。
 *
 * 状态目录用临时目录，避免测试互相污染或写到用户真实配置。
 */
async function harness(options: {
  readonly authStatus?: number
  readonly authBody?: unknown
  readonly onLogin?: (body: unknown) => void
  readonly handshake?: () => Response
} = {}): Promise<Harness> {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'codingns-peer-host-feature-'))
  const calls: string[] = []
  const rpc = new CodingNsRpcTable()
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    if (url.pathname === '/api/public/host-handshake') return options.handshake?.() ?? handshakeResponse()
    if (url.pathname === '/api/auth/login') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      options.onLogin?.(body)
      if (options.authStatus !== undefined && options.authStatus !== 200) {
        return Response.json(options.authBody ?? { error: { code: 'PEER_HOST_SESSION_REQUIRED', message: '目标 Host 用户名或密码错误' } }, { status: options.authStatus })
      }
      return Response.json({ accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 3600 })
    }
    if (url.pathname === '/api/auth/refresh') return Response.json({ accessToken: 'access-refreshed', refreshToken: 'refresh-refreshed', expiresIn: 3600 })
    if (url.pathname === '/api/auth/logout') return Response.json({ ok: true })
    return Response.json({})
  }) as typeof fetch

  const feature = createPeerHostFeature({
    stateDirectory,
    ownerUserId: 'user-1',
    encryptionKey: new Uint8Array(32).fill(9),
    fetchImpl,
  })
  const resources: Array<() => void | Promise<void>> = []
  const context = {
    services: { rpc },
    resources: { add: (dispose: () => void | Promise<void>) => { resources.push(dispose) } },
  }
  await feature.start(context as never)
  return {
    rpc,
    calls,
    async call(endpoint, payload) {
      const target = rpc.resolve(endpoint)
      if (target === null) throw new Error(`未登记的 RPC: ${endpoint}`)
      return await target.handler(target.action, payload)
    },
    async dispose() {
      for (const dispose of resources.reverse()) await dispose()
    },
  }
}

test('编辑保存一次性完成握手与登录，凭据落在 Host 且不回传客户端', async () => {
  const loginBodies: unknown[] = []
  const host = await harness({ onLogin: (body) => loginBodies.push(body) })
  try {
    const created = await host.call('peerHost/create', {
      displayName: '开发机',
      route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
    }) as { id: string; status: string }
    assert.equal(created.status, 'configured')

    const updated = await host.call('peerHost/update', {
      peerHostId: created.id,
      displayName: '开发机',
      color: '#1677ff',
      route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
      username: 'alice',
      password: 'password-secret',
    }) as { status: string; color: string; hostname: string | null }

    // 用户只填一次表单：握手和登录都由 Host 自动完成，状态直接到 ready。
    assert.equal(updated.status, 'ready')
    assert.equal(updated.color, '#1677ff')
    // 握手信息来自目标 Host，编辑后即可用（假目标未上报主机名时为 null）。
    assert.equal(updated.hostname, null)
    assert.deepEqual(loginBodies, [{ username: 'alice', password: 'password-secret' }])
    // 客户端 DTO 不含任何凭据字段。
    assert.equal(JSON.stringify(updated).includes('password-secret'), false)
    assert.equal(JSON.stringify(updated).includes('access-secret'), false)

    const status = await host.call('peerHost/credentialStatus', { peerHostId: created.id }) as { hasSavedCredential: boolean }
    assert.equal(status.hasSavedCredential, true)
  } finally {
    await host.dispose()
  }
})

test('编辑只改名称或配色时保持既有登录态，不重新握手', async () => {
  const host = await harness()
  try {
    const created = await host.call('peerHost/create', {
      displayName: '开发机',
      route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
    }) as { id: string }
    await host.call('peerHost/update', {
      peerHostId: created.id,
      displayName: '开发机',
      route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
      username: 'alice',
      password: 'password-secret',
    })
    const handshakesBefore = host.calls.filter((path) => path === '/api/public/host-handshake').length

    const renamed = await host.call('peerHost/update', {
      peerHostId: created.id,
      displayName: '构建机',
      color: '#f5222d',
    }) as { displayName: string; color: string; status: string }

    assert.equal(renamed.displayName, '构建机')
    assert.equal(renamed.color, '#f5222d')
    // 不填凭据就不应该触碰目标 Host：改个名字不该把已连接的机器踢下线。
    assert.equal(renamed.status, 'ready')
    assert.equal(host.calls.filter((path) => path === '/api/public/host-handshake').length, handshakesBefore)
  } finally {
    await host.dispose()
  }
})

test('握手未通过时不保存凭据，并给出可操作的错误', async () => {
  // 目标返回不兼容的插件版本：握手会停在 version_mismatch，而不是 ready。
  const host = await harness({
    handshake: () => Response.json({
      productId: 'CodingNS',
      pluginId: '@jingyi0605/codingns4dsh',
      pluginVersion: '0.0.1-incompatible',
      dshVersion: '0.2.0-rc.2',
      apiCompatibility: 'peer-host-v1',
      fingerprint: 'sha256:target',
      capabilities: [],
    }),
  })
  try {
    const created = await host.call('peerHost/create', {
      displayName: '开发机',
      route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
    }) as { id: string }

    await assert.rejects(
      host.call('peerHost/update', {
        peerHostId: created.id,
        displayName: '开发机',
        route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
        username: 'alice',
        password: 'password-secret',
      }),
      (error: unknown) => {
        // 握手失败必须明确报错，不能静默保存一份永远用不上的凭据。
        assert.match((error as Error).message, /握手未通过/u)
        return true
      },
    )
    const status = await host.call('peerHost/credentialStatus', { peerHostId: created.id }) as { hasSavedCredential: boolean }
    assert.equal(status.hasSavedCredential, false)
  } finally {
    await host.dispose()
  }
})

test('编辑被禁用的 Host 不会把它重新启用', async () => {
  const host = await harness()
  try {
    const created = await host.call('peerHost/create', {
      displayName: '开发机',
      route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
    }) as { id: string }
    await host.call('peerHost/disable', { peerHostId: created.id })

    const updated = await host.call('peerHost/update', {
      peerHostId: created.id,
      displayName: '开发机',
      route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
      username: 'alice',
      password: 'password-secret',
    }) as { status: string }

    // 用户显式禁用的意图必须保留，否则一次编辑会意外把目标重新上线。
    assert.equal(updated.status, 'disabled')
    const status = await host.call('peerHost/credentialStatus', { peerHostId: created.id }) as { hasSavedCredential: boolean }
    assert.equal(status.hasSavedCredential, true)
  } finally {
    await host.dispose()
  }
})

test('账号被目标拒绝时编辑报错，凭据不落盘', async () => {
  const host = await harness({ authStatus: 401 })
  try {
    const created = await host.call('peerHost/create', {
      displayName: '开发机',
      route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
    }) as { id: string }

    await assert.rejects(
      host.call('peerHost/update', {
        peerHostId: created.id,
        displayName: '开发机',
        route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
        username: 'alice',
        password: 'wrong-password',
      }),
      /用户名或密码错误/u,
    )
    const status = await host.call('peerHost/credentialStatus', { peerHostId: created.id }) as { hasSavedCredential: boolean }
    assert.equal(status.hasSavedCredential, false)
  } finally {
    await host.dispose()
  }
})

test('未就绪的 Host 读取工作区候选时给出明确错误，不静默返回空列表', async () => {
  const host = await harness()
  try {
    const created = await host.call('peerHost/create', {
      displayName: '开发机',
      route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
    }) as { id: string }

    // 尚未握手（configured）时不能假装"该 Host 没有工作区"。
    await assert.rejects(
      host.call('peerHost/workspaceCandidates', { peerHostId: created.id }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'PEER_HOST_NOT_READY')
        return true
      },
    )
  } finally {
    await host.dispose()
  }
})

test('可见工作区默认不显示，显式添加后才进入聚合摘要', async () => {
  const host = await harness()
  try {
    const created = await host.call('peerHost/create', {
      displayName: '开发机',
      route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
    }) as { id: string; visibleWorkspaceIds: readonly string[] }
    // 新建的 Host 不显示任何远端工作区。
    assert.deepEqual(created.visibleWorkspaceIds, [])

    const added = await host.call('peerHost/setWorkspaceVisibility', {
      peerHostId: created.id,
      workspaceId: 'workspace-1',
      visible: true,
    }) as { visibleWorkspaceIds: readonly string[] }
    assert.deepEqual(added.visibleWorkspaceIds, ['workspace-1'])

    const removed = await host.call('peerHost/setWorkspaceVisibility', {
      peerHostId: created.id,
      workspaceId: 'workspace-1',
      visible: false,
    }) as { visibleWorkspaceIds: readonly string[] }
    assert.deepEqual(removed.visibleWorkspaceIds, [])
  } finally {
    await host.dispose()
  }
})

test('聚合刷新会自动重试握手并复用已保存凭据，不依赖手工点击测试', async () => {
  const host = await harness()
  try {
    const created = await host.call('peerHost/create', {
      displayName: '开发机',
      route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
    }) as { id: string }
    await host.call('peerHost/update', {
      peerHostId: created.id,
      displayName: '开发机',
      route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
      username: 'alice',
      password: 'password-secret',
    })
    await host.call('peerHost/setWorkspaceVisibility', { peerHostId: created.id, workspaceId: 'workspace-1', visible: true })

    // 模拟进程重启后只剩配置状态；聚合刷新应自动做握手并继续使用加密保存的登录态。
    await host.call('peerHost/disable', { peerHostId: created.id })
    await host.call('peerHost/enable', { peerHostId: created.id })
    host.calls.length = 0
    await host.call('peerHost/aggregate', {})

    assert.equal(host.calls.includes('/api/public/host-handshake'), true)
    assert.equal(host.calls.includes('/api/auth/refresh'), false)
    const records = await host.call('peerHost/list', {}) as Array<{ status: string }>
    assert.equal(records[0]?.status, 'ready')
  } finally {
    await host.dispose()
  }
})

test('非法配色被拒绝，避免把任意 CSS 写进侧栏', async () => {
  const host = await harness()
  try {
    const created = await host.call('peerHost/create', {
      displayName: '开发机',
      route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
    }) as { id: string }
    await assert.rejects(
      host.call('peerHost/update', { peerHostId: created.id, color: 'red; background:url(x)' }),
      /#rrggbb/u,
    )
  } finally {
    await host.dispose()
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveGitWorkspaceId } from '../data/build/dist/client/git-management.js'
import { createPeerHostPageTransport, installPeerHostConnectionRouting } from '../data/build/dist/client/features/peer-host.js'
import { createPeerHostNativeProjection } from '../data/build/dist/client/peer-host-native-projection.js'
import { installPeerHostNativeStoreProjection } from '../data/build/dist/client/peer-host-native-store-projection.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../data/build/dist/shared/contracts/peer-host.js'
import { en, zh } from '../data/build/dist/client/locales/peerHost.js'

const workspaceId = 'workspace-1'
const sessionId = 'session-1'
const peerWorkspace = (host: string) => createVirtualWorkspaceId(host, workspaceId)
const peerSession = (host: string) => createVirtualSessionId(host, sessionId)

test('PeerHost Git 与调试作用域错误使用当前界面语言，切换语言无需重建连接', async () => {
  let language: 'en' | 'zh' = 'en'
  const locale = {
    bind: (namespace: string) => {
      assert.equal(namespace, 'codingns')
      return (key: string) => (language === 'en' ? en : zh)[key] ?? key
    },
  } as never
  const transport = createPeerHostPageTransport(undefined, undefined, locale)
  for (const nextLanguage of ['en', 'zh'] as const) {
    language = nextLanguage
    for (const method of ['git/status', 'debug/config/get']) {
      const result = await transport.hooks.rpc!<{ ok: false; error: { code: string; message: string } }>({
        method, payload: { channel: '/codingns', payload: { workspaceId: peerWorkspace('missing') } },
      })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'PEER_HOST_SCOPE_MISMATCH')
      assert.match(result.error.message, language === 'en' ? /Please wait for PeerHost workspaces to refresh\./u : /请等待 PeerHost 工作区刷新/u)
    }
  }
})

/** 两台远端与本机故意使用相同工作区 ID、会话 ID 和目录，检查归属是否串线。 */
function aggregate() {
  return ['peer-a', 'peer-b'].map((host) => ({
    hostId: 'local', targetHostId: host, hostLabel: host, availability: 'ready', errorCode: null,
    workspaces: [{
      workspaceId, displayName: host, path: '/work/repo',
      sessions: [{ scope: { hostId: 'local', targetHostId: host, workspaceId, sessionId, scopeGeneration: 0 }, title: host, status: 'idle', updatedAt: 1 }],
      archivedSessions: [{ scope: { hostId: 'local', targetHostId: host, workspaceId, sessionId: 'archived', scopeGeneration: 0 }, title: '已归档', status: 'idle', updatedAt: 1 }],
    }],
  }))
}

test('Git 与侧栏共用聚合工作区，区分同 ID 的 Host 并支持摘要晚到', async () => {
  const snapshot = { items: [{ workspaceId, path: '/work/repo', title: '本机', sessionIds: [sessionId] }], archivedSessionIds: [] }
  const list = { getSnapshot: () => snapshot, subscribe: () => () => undefined }
  const context = { get: (name: string) => name === 'workspaces' ? { list } : undefined } as never
  const projection = createPeerHostNativeProjection()
  const restore = installPeerHostNativeStoreProjection({ uiContext: context, projection })
  const remote = { workspace: { follow: () => { throw new Error('已有聚合 Store 时不应读取本机工作区流') } } }
  try {
    assert.equal(await resolveGitWorkspaceId(remote, peerSession('peer-a'), context), undefined)
    projection.setAggregate(aggregate() as never)
    assert.equal(await resolveGitWorkspaceId(remote, peerSession('peer-a'), context), peerWorkspace('peer-a'))
    assert.equal(await resolveGitWorkspaceId(remote, peerSession('peer-b'), context), peerWorkspace('peer-b'))
    assert.equal(await resolveGitWorkspaceId(remote, createVirtualSessionId('peer-a', 'archived'), context), peerWorkspace('peer-a'))
    assert.equal(await resolveGitWorkspaceId(remote, sessionId, context), workspaceId)
    assert.equal(await resolveGitWorkspaceId(remote, peerSession('missing'), context), undefined)
    projection.setAggregate([])
    assert.equal(await resolveGitWorkspaceId(remote, peerSession('peer-a'), context), undefined)
  } finally {
    restore()
  }
})

test('Git 缺少聚合归属时不把虚拟会话回退到唯一本机工作区', async () => {
  const remote = {
    workspace: { follow: async function* () { yield { value: { items: [{ workspaceId, path: '/work/repo', sessionIds: [] }] } } } },
    session: { list: async () => ({ items: [{ sessionId: peerSession('peer-a'), cwd: '/work/repo' }] }) },
  }
  assert.equal(await resolveGitWorkspaceId(remote, peerSession('peer-a')), undefined)
  assert.equal(await resolveGitWorkspaceId(remote, 'local-missing'), workspaceId)
})

for (const connection of ['web', 'native'] as const) {
  test(`Git ${connection} 连接按工作区转发全部操作，保留正文并隔离本机与失效作用域`, async () => {
    const previousFetch = globalThis.fetch
    const calls: Array<{ host: string | null; method: string; payload: Record<string, unknown> }> = []
    const response = (value: unknown) => Response.json({ result: { ok: true, value } })
    let remoteError = false
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body))
      if (request.method !== 'peerHost/request') {
        calls.push({ host: null, method: request.method, payload: request.payload })
        return response({ local: true })
      }
      const proxy = request.payload
      const git = JSON.parse(proxy.body)
      calls.push({ host: proxy.peerHostId, method: git.method, payload: git.payload })
      assert.equal(proxy.path, `/api/codingns/${git.method}`)
      assert.equal(proxy.scope.workspaceId, workspaceId)
      assert.equal(proxy.scope.targetHostId, proxy.peerHostId)
      assert.equal(git.payload.workspaceId, workspaceId)
      // 用嵌套状态同时检查提交返回值里的 ID；Diff 和提交文本仍保持原文。
      return response({ status: 200, body: JSON.stringify({ result: remoteError
        ? { ok: false, error: { code: 'GIT_FAILED', message: '远端 Git 失败' } }
        : { ok: true, value: { workspaceId, status: { snapshot: { workspaceId } }, host: proxy.peerHostId, content: workspaceId } },
      }) })
    }) as typeof fetch
    const transport = createPeerHostPageTransport()
    transport.setAggregate(aggregate() as never)
    const rpc = {
      call: async (_channel: string, method: string, payload: unknown) => {
        calls.push({ host: null, method, payload: payload as Record<string, unknown> })
        return { ok: true, value: { local: true } }
      },
    }
    const remote = { openRemoteStream: async function* () {} }
    const restore = connection === 'native' ? installPeerHostConnectionRouting({
      uiContext: { get: (name) => name === 'connection' ? { rpc } : undefined },
      remote, hooks: transport.hooks, matchesScope: transport.matchesScope,
    }) : undefined
    const call = async (channel: string, method: string, payload: unknown): Promise<any> => connection === 'native'
      ? rpc.call(channel, method, payload)
      : transport.hooks.rpc!({ method, payload: { channel, payload } })
    try {
      for (const channel of ['/codingns', '/api']) {
        const method = (action: string) => channel === '/api' ? `codingns/git/${action}` : `git/${action}`
        for (const host of ['peer-a', 'peer-b']) {
          for (const action of ['status', 'history', 'branches', 'diff', 'init', 'stage', 'unstage', 'discard', 'commit', 'commit-diff', 'switch', 'fetch', 'pull', 'push', 'undo']) {
            const payload = { workspaceId: peerWorkspace(host), targets: [peerWorkspace('peer-b')], subject: peerSession('peer-b') }
            const result = await call(channel, method(action), payload)
            assert.equal(result.ok, true)
            assert.equal(result.value.host, host)
            assert.equal(result.value.workspaceId, peerWorkspace(host))
            assert.equal(result.value.status.snapshot.workspaceId, peerWorkspace(host))
            assert.equal(result.value.content, workspaceId)
            assert.deepEqual(calls.at(-1), { host, method: `git/${action}`, payload: { ...payload, workspaceId } })
          }
        }
        // 本机请求即使正文恰好包含远端标识，也必须留在本机。
        const local = await call(channel, method('status'), { workspaceId, subject: peerWorkspace('peer-b') })
        assert.equal(local.value.local, true)
        assert.equal(calls.at(-1)?.host, null)
      }
      remoteError = true
      const failed = await call('/codingns', 'git/status', { workspaceId: peerWorkspace('peer-a') })
      assert.deepEqual(failed, { ok: false, error: { code: 'GIT_FAILED', message: '远端 Git 失败' } })
      assert.equal(calls.at(-1)?.host, 'peer-a')
      const count = calls.length
      transport.setAggregate([])
      const missing = await call('/api', 'codingns/git/status', { workspaceId: peerWorkspace('peer-a') })
      assert.equal(missing.ok, false)
      assert.equal(missing.error.code, 'PEER_HOST_SCOPE_MISMATCH')
      assert.equal(calls.length, count)
    } finally {
      restore?.()
      globalThis.fetch = previousFetch
    }
  })
}

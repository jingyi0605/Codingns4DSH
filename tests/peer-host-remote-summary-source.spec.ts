import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostRemoteSummarySource, readPeerHostRemoteWorkspaceCandidates } from '../data/build/dist/host/modules/peer-host/peer-host-remote-summary-source.js'

const scope = { hostId: 'local-host', targetHostId: 'peer-1', workspaceId: '__aggregate__', sessionId: null, scopeGeneration: 0 }

function asyncIterableOf(frames: readonly unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) yield frame
    },
  }
}

test('远端摘要用 workspace/follow 首帧和 session/list 组装工作区会话', async () => {
  const calls: string[] = []
  let closed = 0
  const source = createPeerHostRemoteSummarySource({
    scope,
    transport: {
      async rpc(request) {
        calls.push(`${request.method}:${String(request.scope.targetHostId)}:${JSON.stringify(request.payload)}`)
        return {
          items: [
            { sessionId: 'session-a', cwd: '/Users/dev/project-a', running: true, updatedAt: 42, blank: false, projections: { values: { title: '修复登录问题' } } },
            { sessionId: 'session-b', cwd: 'C:\\work\\project-b', updatedAt: 11, blank: true },
            { sessionId: 'session-done', cwd: '/Users/dev/project-a', updatedAt: 10, blank: false, completed: true },
            { sessionId: 'session-error', cwd: '/Users/dev/project-a', updatedAt: 9, blank: false, status: 'failed' },
            { sessionId: 'session-archived', cwd: '/Users/dev/project-a', updatedAt: 7, blank: false },
            { sessionId: 'session-subagent', cwd: '/Users/dev/project-a', updatedAt: 8, blank: true, origin: 'subagent' },
          ],
        }
      },
      stream(request) {
        calls.push(`${request.method}:${String(request.scope.targetHostId)}:${JSON.stringify(request.payload ?? null)}`)
        const frames = [
          { type: 'baseline', value: { items: [{ workspaceId: 'workspace-a', title: '项目 A', path: '/Users/dev/project-a', sessionIds: ['session-a', 'session-b', 'session-done', 'session-error', 'session-archived', 'session-subagent'] }], archivedSessionIds: ['session-archived'], pinnedSessionIds: [] } },
          { type: 'upsert', workspace: { workspaceId: 'workspace-b' } },
        ]
        let index = 0
        return {
          [Symbol.asyncIterator]() { return this },
          async next() {
            const value = frames[index]
            index += 1
            return index > frames.length ? { done: true, value: undefined } : { done: false, value }
          },
          async return() {
            closed += 1
            return { done: true, value: undefined }
          },
        }
      },
    },
  })
  assert.equal(source.available, true)
  assert.equal(source.capabilityId, 'peer-host.native-workspace-session-summary')
  assert.deepEqual(await source.load(), [{
    workspaceId: 'workspace-a',
    displayName: '项目 A',
    path: '/Users/dev/project-a',
    sessions: [
      { sessionId: 'session-a', title: '修复登录问题', status: 'running', activity: 'running', updatedAt: 42, blank: false },
      // 临时占位不伪造 cwd 目录名；原生 UI 会根据 blank 显示“新建会话”。
      { sessionId: 'session-b', title: '', status: 'idle', activity: 'unknown', updatedAt: 11, blank: true },
      { sessionId: 'session-done', title: 'project-a', status: 'completed', activity: 'idle', updatedAt: 10, blank: false },
      { sessionId: 'session-error', title: 'project-a', status: 'failed', activity: 'idle', updatedAt: 9, blank: false },
    ],
    // 归档会话单独归类：原生侧栏默认隐藏，但归档入口与取消归档路由需要它们。
    archivedSessions: [
      { sessionId: 'session-archived', title: 'project-a', status: 'idle', activity: 'unknown', updatedAt: 7, blank: false },
    ],
  }])
  assert.deepEqual(calls.sort(), [
    'session/list:peer-1:{"args":{"_request":{}}}',
    'workspace/follow:peer-1:null',
  ])
  assert.equal(closed, 1)
})

test('远端摘要合并目标 Host 的 CLI 会话适配器映射', async () => {
  const source = createPeerHostRemoteSummarySource({
    scope,
    transport: {
      async rpc() { return { items: [{ sessionId: 'session-a', cwd: '/repo', updatedAt: 1 }] } },
      stream() { return asyncIterableOf([{ type: 'baseline', value: { items: [{ workspaceId: 'workspace-a', path: '/repo', sessionIds: ['session-a'] }], archivedSessionIds: [] } }]) },
      async cli() { return { ok: true, value: [{ sessionId: 'session-a', adapterId: 'codex' }] } },
    },
  })
  assert.deepEqual(await source.load(), [{
    workspaceId: 'workspace-a',
    displayName: 'workspace-a',
    path: '/repo',
    sessions: [{ sessionId: 'session-a', title: 'repo', status: 'idle', activity: 'unknown', updatedAt: 1, blank: false, adapterId: 'codex' }],
  }])
})

test('远端摘要对缺失字段和空 baseline 保持容错', async () => {
  const source = createPeerHostRemoteSummarySource({
    scope,
    transport: {
      async rpc() { return {} },
      stream() { return asyncIterableOf([{ type: 'baseline', value: { items: [{ title: '缺少 ID' }, { workspaceId: 'workspace-b', sessionIds: ['missing-session'] }] } }]) },
    },
  })
  assert.deepEqual(await source.load(), [{
    workspaceId: 'workspace-b',
    displayName: 'workspace-b',
    // 目标未上报 path 时退回 workspaceId，保证原生视图字段完整。
    path: 'workspace-b',
    sessions: [{ sessionId: 'missing-session', title: 'missing-session', status: 'idle', activity: 'unknown', updatedAt: 0, blank: false }],
  }])

  const empty = createPeerHostRemoteSummarySource({
    scope,
    transport: {
      async rpc() { return { items: [] } },
      stream() { return asyncIterableOf([]) },
    },
  })
  assert.deepEqual(await empty.load(), [])
})

test('session/list 协议失败时仍保留已显式添加的远端工作区', async () => {
  const source = createPeerHostRemoteSummarySource({
    scope,
    visibleWorkspaceIds: ['workspace-a'],
    transport: {
      async rpc() {
        throw new Error('目标 Host 暂时不支持 session/list')
      },
      stream() {
        return asyncIterableOf([{
          type: 'baseline',
          value: {
            items: [{ workspaceId: 'workspace-a', title: '项目 A', path: '/repo/a', sessionIds: ['session-a'] }],
            archivedSessionIds: [],
          },
        }])
      },
    },
  })
  assert.deepEqual(await source.load(), [{
    workspaceId: 'workspace-a',
    displayName: '项目 A',
    path: '/repo/a',
    sessions: [{ sessionId: 'session-a', title: 'session-a', status: 'idle', activity: 'unknown', updatedAt: 0, blank: false }],
  }])
})

test('显式添加的工作区白名单只投影集合内的远端工作区', async () => {
  const source = createPeerHostRemoteSummarySource({
    scope,
    visibleWorkspaceIds: ['workspace-b'],
    transport: {
      async rpc() {
        return { items: [{ sessionId: 'session-b', cwd: '/Users/dev/project-b', updatedAt: 11 }] }
      },
      stream() {
        return asyncIterableOf([{
          type: 'baseline',
          value: {
            items: [
              { workspaceId: 'workspace-a', title: '项目 A', path: '/Users/dev/project-a', sessionIds: [] },
              { workspaceId: 'workspace-b', title: '项目 B', path: '/Users/dev/project-b', sessionIds: ['session-b'] },
            ],
            archivedSessionIds: [],
          },
        }])
      },
    },
  })
  assert.deepEqual((await source.load()).map((workspace) => workspace.workspaceId), ['workspace-b'])
})

test('未显式添加任何工作区时不访问目标 Host，直接返回空摘要', async () => {
  let touched = 0
  const source = createPeerHostRemoteSummarySource({
    scope,
    visibleWorkspaceIds: [],
    transport: {
      async rpc() { touched += 1; return { items: [] } },
      stream() { touched += 1; return asyncIterableOf([]) },
    },
  })
  assert.deepEqual(await source.load(), [])
  // 默认不显示远端工作区时不应该产生任何代理往返。
  assert.equal(touched, 0)
})

test('不传白名单时保持不过滤，供显式调用方使用', async () => {
  const source = createPeerHostRemoteSummarySource({
    scope,
    transport: {
      async rpc() { return { items: [] } },
      stream() {
        return asyncIterableOf([{
          type: 'baseline',
          value: {
            items: [
              { workspaceId: 'workspace-a', title: '项目 A', path: '/Users/dev/project-a', sessionIds: [] },
              { workspaceId: 'workspace-b', title: '项目 B', path: '/Users/dev/project-b', sessionIds: [] },
            ],
            archivedSessionIds: [],
          },
        }])
      },
    },
  })
  assert.deepEqual((await source.load()).map((workspace) => workspace.workspaceId), ['workspace-a', 'workspace-b'])
})

test('工作区候选读取不做可见性过滤，供“添加工作区”选择器使用', async () => {
  const candidates = await readPeerHostRemoteWorkspaceCandidates({
    scope,
    transport: {
      async rpc() { return { items: [] } },
      stream() {
        return asyncIterableOf([{
          type: 'baseline',
          value: {
            items: [
              { workspaceId: 'workspace-a', title: '项目 A', path: '/Users/dev/project-a', sessionIds: ['s1', 's2'] },
              { workspaceId: 'workspace-b', path: '/Users/dev/project-b', sessionIds: [] },
            ],
            archivedSessionIds: [],
          },
        }])
      },
    },
  })
  assert.deepEqual(candidates, [
    { workspaceId: 'workspace-a', displayName: '项目 A', path: '/Users/dev/project-a', sessionCount: 2 },
    { workspaceId: 'workspace-b', displayName: 'workspace-b', path: '/Users/dev/project-b', sessionCount: 0 },
  ])
})

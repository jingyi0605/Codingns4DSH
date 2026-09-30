import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostRemoteSummarySource } from '../data/build/dist/host/modules/peer-host/peer-host-remote-summary-source.js'

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
            { sessionId: 'session-a', cwd: '/Users/dev/project-a', running: true, updatedAt: 42, projections: { values: { title: '修复登录问题' } } },
            { sessionId: 'session-b', cwd: 'C:\\work\\project-b', updatedAt: 11 },
            { sessionId: 'session-archived', cwd: '/Users/dev/project-a', updatedAt: 7 },
            { sessionId: 'session-subagent', cwd: '/Users/dev/project-a', updatedAt: 8, origin: 'subagent' },
          ],
        }
      },
      stream(request) {
        calls.push(`${request.method}:${String(request.scope.targetHostId)}:${JSON.stringify(request.payload ?? null)}`)
        const frames = [
          { type: 'baseline', value: { items: [{ workspaceId: 'workspace-a', title: '项目 A', path: '/Users/dev/project-a', sessionIds: ['session-a', 'session-b', 'session-archived', 'session-subagent'] }], archivedSessionIds: ['session-archived'], pinnedSessionIds: [] } },
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
      { sessionId: 'session-a', title: '修复登录问题', status: 'running', updatedAt: 42 },
      { sessionId: 'session-b', title: 'project-b', status: 'idle', updatedAt: 11 },
    ],
    // 归档会话单独归类：原生侧栏默认隐藏，但归档入口与取消归档路由需要它们。
    archivedSessions: [
      { sessionId: 'session-archived', title: 'project-a', status: 'idle', updatedAt: 7 },
    ],
  }])
  assert.deepEqual(calls.sort(), [
    'session/list:peer-1:{"args":{"_request":{}}}',
    'workspace/follow:peer-1:null',
  ])
  assert.equal(closed, 1)
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
    sessions: [{ sessionId: 'missing-session', title: 'missing-session', status: 'idle', updatedAt: 0 }],
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

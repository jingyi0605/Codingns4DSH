import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostNativeProjection, createPeerHostWorkspaceDisplayPath } from '../data/build/dist/client/peer-host-native-projection.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../data/build/dist/shared/index.js'

interface SessionShape {
  readonly sessionId: string
  readonly title: string
  readonly status: string
  readonly updatedAt: number
  /** DSH 的临时“新建会话”占位标记。 */
  readonly blank: boolean
}

function remoteHost(
  sessions: readonly SessionShape[] = [{ sessionId: 'session-1', title: '远端会话', status: 'idle', updatedAt: 10, blank: false }],
  archivedSessions: readonly SessionShape[] = [],
): Record<string, unknown> {
  return {
    hostId: 'host-local',
    targetHostId: 'peer-1',
    hostLabel: '开发机',
    hostColor: '#1677ff',
    availability: 'ready',
    errorCode: null,
    workspaces: [{
      key: 'peer-1:workspace-1',
      hostId: 'host-local',
      targetHostId: 'peer-1',
      workspaceId: 'workspace-1',
      displayName: '远端工作区',
      path: '/Users/dev/project-a',
      hostLabel: '开发机',
      availability: 'ready',
      sessions: sessions.map((session) => toSessionRecord(session)),
      ...(archivedSessions.length === 0 ? {} : { archivedSessions: archivedSessions.map((session) => toSessionRecord(session)) }),
    }],
  }
}

function toSessionRecord(session: SessionShape): Record<string, unknown> {
  return {
    scope: { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: session.sessionId, scopeGeneration: 0 },
    title: session.title,
    status: session.status,
    updatedAt: session.updatedAt,
    blank: session.blank,
  }
}

function localHost(): Record<string, unknown> {
  return {
    hostId: 'host-local',
    targetHostId: null,
    hostLabel: '当前 Host',
    availability: 'ready',
    errorCode: null,
    workspaces: [{
      key: 'host-local:local-workspace',
      hostId: 'host-local',
      targetHostId: null,
      workspaceId: 'local-workspace',
      displayName: '本机工作区',
      hostLabel: '当前 Host',
      availability: 'ready',
      sessions: [{
        scope: { hostId: 'host-local', targetHostId: null, workspaceId: 'local-workspace', sessionId: 'local-session', scopeGeneration: 0 },
        title: '本机会话',
        status: 'idle',
        updatedAt: 5,
        blank: false,
      }],
    }],
  }
}

test('投影输出虚拟标识与展示元数据，本机资源不参与投影', () => {
  const projection = createPeerHostNativeProjection()
  projection.setAggregate([remoteHost(), localHost()] as never)

  assert.deepEqual(projection.workspaces(), [{
    workspaceId: createVirtualWorkspaceId('peer-1', 'workspace-1'),
    availability: 'ready',
    path: createPeerHostWorkspaceDisplayPath(createVirtualWorkspaceId('peer-1', 'workspace-1')),
    workspacePath: '/Users/dev/project-a',
    // Host 归属改由侧栏彩色标签表达，标题保持纯工作区名。
    title: '远端工作区',
    hostId: 'peer-1',
    hostLabel: '开发机',
    hostColor: '#1677ff',
    sessionIds: [createVirtualSessionId('peer-1', 'session-1')],
    archivedSessionIds: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(10).toISOString(),
  }])
  assert.deepEqual(projection.sessions(), [{
    agentAvailable: true,
    sessionId: createVirtualSessionId('peer-1', 'session-1'),
    updatedAt: 10,
    running: false,
    blank: false,
    cwd: '/Users/dev/project-a',
    projections: { kind: 'cached', asOfSeq: 0, values: { title: '远端会话' } },
  }])
})

test('归档会话保留成员槽位与标题，但进入独立的归档集合', () => {
  const projection = createPeerHostNativeProjection()
  projection.setAggregate([remoteHost(
    [{ sessionId: 'session-1', title: '远端会话', status: 'idle', updatedAt: 10, blank: false }],
    [{ sessionId: 'session-archived', title: '归档会话', status: 'idle', updatedAt: 4, blank: false }],
  )] as never)

  const workspace = projection.workspaces()[0]
  assert.deepEqual(workspace?.sessionIds, [
    createVirtualSessionId('peer-1', 'session-1'),
    createVirtualSessionId('peer-1', 'session-archived'),
  ])
  assert.deepEqual(workspace?.archivedSessionIds, [createVirtualSessionId('peer-1', 'session-archived')])
  // 原生会话目录仍需要归档会话的标题，否则原生列表行拿不到标题。
  assert.deepEqual(projection.sessions().map((session) => session.sessionId), [
    createVirtualSessionId('peer-1', 'session-1'),
    createVirtualSessionId('peer-1', 'session-archived'),
  ])
})

test('快照变化才通知订阅者，重复快照返回未变化', () => {
  const projection = createPeerHostNativeProjection()
  let notified = 0
  const unsubscribe = projection.subscribe(() => { notified += 1 })

  assert.equal(projection.setAggregate([remoteHost()] as never), true)
  assert.equal(notified, 1)
  assert.equal(projection.setAggregate([remoteHost()] as never), false)
  assert.equal(notified, 1)

  assert.equal(projection.setAggregate([remoteHost([{ sessionId: 'session-1', title: '远端会话', status: 'running', updatedAt: 30, blank: false }])] as never), true)
  assert.equal(notified, 2)
  assert.equal(projection.sessions()[0]?.running, true)
  assert.equal(projection.workspaces()[0]?.updatedAt, new Date(30).toISOString())

  // blank 是列表语义的一部分：新建后先是临时占位，首次交互后才变成普通会话。
  assert.equal(projection.setAggregate([remoteHost([{ sessionId: 'session-1', title: '远端会话', status: 'idle', updatedAt: 31, blank: true }])] as never), true)
  assert.equal(notified, 3)
  assert.equal(projection.sessions()[0]?.blank, true)
  assert.equal(projection.setAggregate([remoteHost([{ sessionId: 'session-1', title: '远端会话', status: 'idle', updatedAt: 32, blank: false }])] as never), true)
  assert.equal(notified, 4)
  assert.equal(projection.sessions()[0]?.blank, false)

  assert.equal(projection.setAggregate([localHost()] as never), true)
  assert.deepEqual(projection.workspaces(), [])
  assert.deepEqual(projection.sessions(), [])

  unsubscribe()
  projection.setAggregate([remoteHost()] as never)
  assert.equal(notified, 5)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { registerPeerHostReferenceSource } from '../src/client/peer-host-reference-source.js'
import { createVirtualSessionId } from '../src/shared/contracts/peer-host.js'
import { createPeerHostNativeProjection } from '../src/client/peer-host-native-projection.js'

function fixture(options: {
  readonly resolver?: { candidates(sessionId: string, query: string, signal: AbortSignal): Promise<unknown> }
  readonly binding?: boolean
  readonly selectedWorkspaceId?: string
} = {}) {
  const sources: any[] = []
  const services = new Map<string, unknown>([
    ['inputTriggers', { registerSource(source: unknown) { sources.push(source); return () => { sources.splice(sources.indexOf(source), 1) } } }],
    ['sessions', { binding: () => options.binding === true ? {} : undefined }],
  ])
  if (options.selectedWorkspaceId !== undefined) {
    services.set('uiWorkspace', { selection: { getSnapshot: () => ({ sessionId: 'real-current', workspaceId: options.selectedWorkspaceId }) } })
  }
  if (options.resolver !== undefined) services.set('remote.sessionReferenceResolver', options.resolver)
  const ctx = { get(name: string) { const value = services.get(name); if (value === undefined) throw new Error(`missing ${name}`); return value } }
  const current = createVirtualSessionId('peer-a', 'current')
  const projection = {
    hasAggregate: () => true,
    sessions: () => [
      { sessionId: current, blank: false, cwd: '/remote/project', projections: { values: { title: '当前会话' } } },
      { sessionId: createVirtualSessionId('peer-a', 'other'), blank: false, cwd: '/remote/project', projections: { values: { title: '远程对话' } } },
      { sessionId: createVirtualSessionId('peer-b', 'other'), blank: false, cwd: '/other/project', projections: { values: { title: '另一台 Host' } } },
    ],
  } as any
  const dispose = registerPeerHostReferenceSource(ctx as never, projection)
  return { source: sources[0]!, projection, current, dispose }
}

test('官方会话 Remote 失败时，@ 兜底源显示同一远端 Host 的聚合会话', async () => {
  const f = fixture()
  const rows = await f.source.candidates({ sessionId: f.current }, { query: '', signal: new AbortController().signal })
  assert.deepEqual(rows.map((row: any) => row.name), ['远程对话'])
  assert.equal(rows[0].section, '对话')
  assert.match(rows[0].value, /^@\[远程对话\]\(dsh-session:/u)
  const picked = f.source.onPick({ candidate: rows[0] })
  assert.equal(picked.insert.source, 'reference')
  assert.equal(picked.insert.ref, rows[0].value)
  f.dispose()
})

test('官方候选正常返回且当前会话已保留时，兜底源不重复渲染', async () => {
  const f = fixture({ binding: true, resolver: {
    async candidates() {
      return { ok: true, value: [{ sessionId: createVirtualSessionId('peer-a', 'other'), mention: '@[远程对话](dsh-session:abc)', label: '远程对话' }] }
    },
  } })
  const rows = await f.source.candidates({ sessionId: f.current }, { query: '', signal: new AbortController().signal })
  assert.deepEqual(rows, [])
  f.dispose()
})

test('官方 Resolver 返回空结果时，已保留的远程会话仍回退到聚合清单', async () => {
  const f = fixture({ binding: true, resolver: {
    async candidates() {
      return { ok: true, value: [] }
    },
  } })
  const rows = await f.source.candidates({ sessionId: f.current }, { query: '', signal: new AbortController().signal })
  assert.deepEqual(rows.map((row: any) => row.name), ['远程对话'])
  f.dispose()
})

test('远程会话尚未被本地 Session Controller 保留时，直接使用目标 Host 候选', async () => {
  const f = fixture({ resolver: {
    async candidates() {
      return { ok: true, value: [{ sessionId: createVirtualSessionId('peer-a', 'other'), mention: '@[远端对话](dsh-session:abc)', label: '远端对话' }] }
    },
  } })
  const rows = await f.source.candidates({ sessionId: f.current }, { query: '', signal: new AbortController().signal })
  assert.deepEqual(rows.map((row: any) => row.name), ['远端对话'])
  assert.equal(rows[0].section, '对话')
  f.dispose()
})

test('远程候选查询带关键词时仍按聚合摘要过滤', async () => {
  const f = fixture()
  const rows = await f.source.candidates({ sessionId: f.current }, { query: '另一台', signal: new AbortController().signal })
  assert.deepEqual(rows, [])
  const rows2 = await f.source.candidates({ sessionId: f.current }, { query: '远程', signal: new AbortController().signal })
  assert.deepEqual(rows2.map((row: any) => row.name), ['远程对话'])
  f.dispose()
})

test('导航仍保留真实会话 ID 时，远程新旧会话都能使用聚合对话清单', async () => {
  const f = fixture({ selectedWorkspaceId: 'codingns:peer-host:v1:workspace:peer-a:workspace-1' })
  const rows = await f.source.candidates({ sessionId: 'real-current' }, { query: '', signal: new AbortController().signal })
  assert.ok(rows.some((row: any) => row.name === '远程对话'))
  f.dispose()
})

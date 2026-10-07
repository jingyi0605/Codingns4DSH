import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantManagementTools } from '../src/host/features/assistant-management-tools.js'
import { AssistantDispatcher } from '../src/host/features/assistant-dispatch.js'
import { createAssistantScope } from '../src/host/features/assistant-scope.js'

function fixture() {
  const entries = [
    { hostId: 'host-a', workspaceId: 'w1', workspaceName: '一', sessionId: 'same-id', title: '本地', status: 'unknown' as const, waiting: null, updatedAt: 1 },
    { hostId: 'host-b', workspaceId: 'w2', workspaceName: '二', sessionId: 'same-id', title: '远端', status: 'unknown' as const, waiting: null, updatedAt: 2 },
  ]
  let current = entries
  let archived: string[] = []
  let warnings: string[] = []
  let afterRead = () => {}
  const sent: any[] = []
  const dispatcher = new AssistantDispatcher(async (request, signal) => { signal?.throwIfAborted(); sent.push({ request, signal }) })
  const tools = createAssistantManagementTools({ dispatcher,
    snapshot: async (signal) => { signal.throwIfAborted(); return { scope: createAssistantScope(['w1', 'w2']), entries: current.filter((item) => !archived.includes(item.sessionId)), archivedSessionIds: archived, indexGeneration: 7, warnings, workspaces: [{ workspaceId: 'w1', name: '一', path: null }, { workspaceId: 'w2', name: '二', path: null }] } },
    read: async (entry) => { afterRead(); return `摘录-${entry.hostId}` },
  })
  const execute = (name: string, args: unknown, callId = 'call-1', signal = new AbortController().signal) => tools.find((tool) => tool.name === name)!.execute(args, { callId, signal })
  const target = { hostId: 'host-b', workspaceId: 'w2', sessionId: 'same-id', generation: 7, updatedAt: 2, message: '现在进展如何？' }
  return { tools, execute, target, sent, archive: () => { archived = ['same-id'] }, change: () => { current = current.map((item) => ({ ...item, updatedAt: 3 })) }, onRead: (callback: () => void) => { afterRead = callback }, unavailable: () => { current = []; warnings = ['远端 Host 状态读取失败'] } }
}

test('助理只有四个管理工具，列表和读取不触发派发，完整元组区分同名会话', async () => {
  const f = fixture()
  assert.deepEqual(f.tools.map((tool) => tool.name), ['assistant_list_workspaces', 'assistant_list_sessions', 'assistant_read_session', 'assistant_follow_up_session'])
  await f.execute('assistant_list_workspaces', {})
  const list: any = await f.execute('assistant_list_sessions', { workspaceId: 'w2' })
  assert.equal(list.sessions.length, 1)
  const result: any = await f.execute('assistant_read_session', f.target)
  assert.equal(result.summary, '摘录-host-b')
  assert.equal(f.sent.length, 0)
  await assert.rejects(f.execute('assistant_list_sessions', { workspaceId: 'outside' }), /范围/)
  await assert.rejects(f.execute('assistant_read_session', { ...f.target, hostId: 'host-c' }), /范围/)
})

test('跟进发送指定 Host 的会话，排队、传递取消信号且重复调用只送一次', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  const first: any = await f.execute('assistant_follow_up_session', f.target, 'call-1', signal)
  const second = await f.execute('assistant_follow_up_session', f.target)
  assert.deepEqual(first, second)
  assert.equal(first.accepted, true)
  assert.equal(first.completed, false)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].request.hostId, 'host-b')
  assert.equal(f.sent[0].request.mode, 'queue')
  assert.equal(f.sent[0].signal, signal)
  assert.match(f.sent[0].request.content[0].text, /不新增编码任务/)
})

test('归档、范围或版本变化以及取消阻止发送；读取期间变化也不返回旧材料', async () => {
  const f = fixture()
  await assert.rejects(f.execute('assistant_follow_up_session', { ...f.target, generation: 6 }), /版本/)
  await assert.rejects(f.execute('assistant_follow_up_session', { ...f.target, updatedAt: 1 }), /版本/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(f.execute('assistant_follow_up_session', f.target, 'abort', abort.signal))
  f.onRead(f.change)
  await assert.rejects(f.execute('assistant_read_session', f.target), /更新/)
  f.archive()
  await assert.rejects(f.execute('assistant_follow_up_session', f.target), /归档/)
  assert.equal(f.sent.length, 0)
})

test('来源不可用保留诊断，不能把失败的空列表当作已归档或正常零会话', async () => {
  const f = fixture()
  f.unavailable()
  const value: any = await f.execute('assistant_list_sessions', {})
  assert.deepEqual(value.warnings, ['远端 Host 状态读取失败'])
  await assert.rejects(f.execute('assistant_follow_up_session', f.target), /无法确认.*读取失败/)
  assert.equal(f.sent.length, 0)
})

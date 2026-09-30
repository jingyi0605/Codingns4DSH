import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshNativeSummarySource } from '../data/build/dist/host/modules/peer-host/dsh-native-summary-source.js'

test('原生摘要 source 从 workspaceRegistry 和 sessionController 生成工作区会话摘要', async () => {
  const source = createDshNativeSummarySource({
    get(name: string) {
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'workspace-a', title: '本地工作区', path: '/Users/dev/local' }] }
      return undefined
    },
  } as never, {
    list: () => [],
    async listRemote() {
      return [
        // blank 会话由 DSH 原生 UI 显示“新建会话”，不能把临时标题投影成正式标题。
        { id: 'session-a', workspaceId: 'workspace-a', title: '远端记录', status: 'running', updatedAt: 123, blank: true },
        { id: 'session-b', workspaceId: 'workspace-a', title: '已完成会话', status: 'idle', updatedAt: 122, blank: false },
      ]
    },
  })
  assert.equal(source.available, true)
  assert.deepEqual(await source.load(), [{
    workspaceId: 'workspace-a',
    displayName: '本地工作区',
    path: '/Users/dev/local',
    sessions: [
      { sessionId: 'session-a', title: '', status: 'running', updatedAt: 123, blank: true },
      { sessionId: 'session-b', title: '已完成会话', status: 'idle', updatedAt: 122, blank: false },
    ],
  }])
})

test('缺少稳定 DSH 服务时 source 明确降级而不是伪造空成功', async () => {
  const source = createDshNativeSummarySource({ get: () => undefined } as never, undefined)
  assert.equal(source.available, false)
  assert.match(source.reason ?? '', /未提供/u)
  assert.deepEqual(await source.load(), [])
})

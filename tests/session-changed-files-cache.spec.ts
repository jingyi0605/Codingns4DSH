import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSessionChangedFilesSnapshot } from '../src/client/session-changed-files-view.js'

test('会话修改文件正文与计数器并发共享同一组快照请求', async () => {
  const calls: string[] = []
  const rpc = {
    call: async (_channel: string, endpoint: string): Promise<any> => {
      calls.push(endpoint)
      await Promise.resolve()
      return endpoint === 'fileManagement/session-changes'
        ? { ok: true, value: { paths: ['src/app.ts'] } }
        : { ok: true, value: { changes: [{ path: 'src/app.ts', oldPath: null }] } }
    },
  }

  const first = loadSessionChangedFilesSnapshot(rpc, 'session-1', 'workspace-1')
  const second = loadSessionChangedFilesSnapshot(rpc, 'session-1', 'workspace-1')
  assert.strictEqual(first, second)
  await Promise.all([first, second])
  assert.deepEqual(calls.sort(), ['fileManagement/session-changes', 'git/status'])

  await loadSessionChangedFilesSnapshot(rpc, 'session-1', 'workspace-1')
  assert.equal(calls.length, 2)

  await loadSessionChangedFilesSnapshot(rpc, 'session-1', 'workspace-1', true)
  assert.equal(calls.length, 4)
})

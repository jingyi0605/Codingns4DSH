import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { readSessionChangedFiles } from '../data/build/dist/host/session-changes.js'
import { createFileManagementFeature } from '../data/build/dist/host/features/file-management.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { registerSessionChangedFilesView, selectSessionChangedFiles } from '../data/build/dist/client/session-changed-files-view.js'

test('会话修改文件优先从 DSH 原生 tool/call 事件提取并过滤工作区外路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-session-changes-'))
  try {
    const result = await readSessionChangedFiles({
      nativeSessions: {
        get: () => ({ snapshotEvents: () => [
          { type: 'tool/call', data: { name: 'write_file', arguments: JSON.stringify({ path: 'src/index.ts' }) } },
          { type: 'tool/call', data: { name: 'apply_patch', arguments: '*** Update File: src/app.ts\n*** Update File: ../outside.ts' } },
        ] }),
      },
    }, 'session-1', root)
    assert.deepEqual(result.paths, ['src/app.ts', 'src/index.ts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('原生事件没有文件路径时回退读取会话 JSONL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-session-jsonl-'))
  const jsonl = join(root, 'session.jsonl')
  try {
    await writeFile(jsonl, [
      JSON.stringify({ type: 'session', id: 'session-2' }),
      JSON.stringify({ type: 'tool/call', data: { arguments: JSON.stringify({ file_path: 'src/from-jsonl.ts' }) } }),
      '不完整尾行',
    ].join('\n'), 'utf8')
    const result = await readSessionChangedFiles({
      nativeSessions: {
        get: () => ({ snapshotEvents: () => [], rawStoreRef: jsonl }),
      },
    }, 'session-2', root)
    assert.deepEqual(result.paths, ['src/from-jsonl.ts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('提交后 Git 状态清空时会话修改文件选择结果归零', () => {
  const sessionFiles = { paths: ['src/one.ts', 'src/two.ts'] }
  const beforeCommit = {
    snapshot: { workspaceId: 'workspace-1', repoRoot: '/workspace', enabled: true, branch: 'main', ahead: 0, behind: 0, hasRemote: false, isDirty: true, lastFetchedAt: null },
    changes: [
      { path: 'src/one.ts', status: 'M', staged: true, oldPath: null, binary: false, stagedStatus: 'M', worktreeStatus: null },
      { path: 'src/two.ts', status: 'M', staged: false, oldPath: null, binary: false, stagedStatus: null, worktreeStatus: 'M' },
    ],
  }
  const afterCommit = { ...beforeCommit, snapshot: { ...beforeCommit.snapshot, isDirty: false }, changes: [] }
  assert.equal(selectSessionChangedFiles(sessionFiles, beforeCommit).length, 2)
  assert.equal(selectSessionChangedFiles(sessionFiles, afterCommit).length, 0)
})

test('文件管理 Host 注册会话修改查询 RPC', () => {
  const table = new CodingNsRpcTable()
  const feature = createFileManagementFeature()
  const resources = { add(disposer: () => void) { this.disposer = disposer }, disposer: () => undefined }
  feature.start({ descriptor: feature.descriptor, resources, services: { rpc: table } })
  assert.ok(table.resolve('fileManagement/session-changes'))
  resources.disposer()
})

test('没有 uiConversation.views 时仍注册 conversation.view 标签', () => {
  const registrations: Array<{ readonly options: Record<string, unknown>; readonly component: unknown }> = []
  const disposers: Array<() => void> = []
  const slots = {
    inject(_key: string, callback: () => (() => void) | undefined) {
      const dispose = callback()
      if (dispose !== undefined) disposers.push(dispose)
      return () => undefined
    },
    register(this: typeof slots, options: Record<string, unknown>, component: unknown) {
      assert.equal(this, slots)
      registrations.push({ options, component })
      return () => undefined
    },
  }
  const dispose = registerSessionChangedFilesView({ slots }, { call: async () => ({ ok: true, value: undefined }) })
  assert.equal(registrations.length, 2)
  const view = registrations.find((entry) => entry.options.id === 'codingns4dsh/session-changed-files')
  assert.ok(view)
  const label = view.options.label
  assert.equal(typeof label, 'function')
  assert.equal((label as () => string)(), '修改文件 0')
  const injected = (view.options.inject as () => { reportCount: (sessionId: string, count: number) => void })()
  injected.reportCount('session-1', 5)
  const refreshedView = registrations.at(-1)
  assert.equal(refreshedView?.options.id, 'codingns4dsh/session-changed-files')
  assert.equal((refreshedView?.options.label as () => string)(), '修改文件 5')
  dispose?.()
  for (const disposer of disposers) disposer()
})

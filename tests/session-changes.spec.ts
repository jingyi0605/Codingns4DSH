import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { readSessionChangedFiles } from '../data/build/dist/host/session-changes.js'
import { createFileManagementFeature } from '../data/build/dist/host/features/file-management.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { registerSessionChangedFilesView, selectSessionChangedFiles } from '../data/build/dist/client/session-changed-files-view.js'

test('会话修改文件只提取成功写入工具的路径并过滤工作区外路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-session-changes-'))
  try {
    const result = await readSessionChangedFiles({
      nativeSessions: {
        get: () => ({ snapshotEvents: () => [
          { type: 'tool/call', data: { callId: 'write-1', name: 'write_file', arguments: JSON.stringify({ path: 'src/index.ts' }) } },
          { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'write-1', content: [] } } },
          { type: 'tool/call', data: { callId: 'read-1', name: 'read_file', arguments: JSON.stringify({ path: 'src/read-only.ts' }) } },
          { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'read-1', content: [] }, meta: { path: 'src/read-meta.ts' } } },
          { type: 'tool/call', data: { callId: 'failed-1', name: 'edit_file', arguments: JSON.stringify({ path: 'src/failed.ts' }) } },
          { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'failed-1', isError: true, content: [] } } },
          { type: 'tool/call', data: { callId: 'rename-1', name: 'rename_file', arguments: JSON.stringify({ sourcePath: 'src/old.ts', targetPath: 'src/new.ts' }) } },
          { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'rename-1', content: [] } } },
          { type: 'tool/call', data: { callId: 'delete-1', name: 'delete_file', arguments: JSON.stringify({ paths: ['src/deleted.ts'] }) } },
          { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'delete-1', content: [] } } },
          { type: 'tool/call', data: { callId: 'pending-1', name: 'write_file', arguments: JSON.stringify({ path: 'src/pending.ts' }) } },
          { type: 'tool/call', data: {
            callId: 'execute-1',
            name: 'execute',
            arguments: JSON.stringify({ toolCalls: [
              { tool: 'write_file', status: 'completed', input: { path: 'src/nested.ts' } },
              { tool: 'read_file', status: 'completed', input: { path: 'src/nested-read.ts' } },
              { tool: 'edit_file', status: 'failed', input: { path: 'src/nested-failed.ts' } },
            ] }),
          } },
          { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'execute-1', content: [] } } },
          { type: 'tool/call', data: { callId: 'patch-1', name: 'apply_patch', arguments: '*** Update File: src/app.ts\n*** Update File: ../outside.ts' } },
          { type: 'tool/result', data: {
            message: { role: 'tool', toolCallId: 'patch-1', content: [] },
            meta: { diffs: [{ path: 'src/meta.ts', oldText: '', newText: 'ok' }, { path: '../outside-meta.ts' }] },
          } },
        ] }),
      },
    }, 'session-1', root)
    assert.deepEqual(result.paths, ['src/app.ts', 'src/deleted.ts', 'src/index.ts', 'src/meta.ts', 'src/nested.ts', 'src/new.ts', 'src/old.ts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('会话修改文件识别 Grok search_replace 的编辑和空 old_string 新建', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-session-search-replace-'))
  try {
    const result = await readSessionChangedFiles({
      nativeSessions: {
        get: () => ({ snapshotEvents: () => [
          {
            type: 'tool/call',
            data: {
              callId: 'replace-1',
              name: 'search_replace',
              arguments: JSON.stringify({
                file_path: 'src/host/lan-access-dsh.ts',
                old_string: 'const dshPort = input.dshPort',
                new_string: 'const dshPort = resolveLanAccessDshStartPort(input.dshPort)',
              }),
            },
          },
          {
            type: 'tool/result',
            data: {
              message: {
                role: 'tool',
                toolCallId: 'replace-1',
                content: [{ type: 'text', text: '{"type":"SearchReplace","EditsApplied":{"absolute_path":"/outside/ignore.ts"}}' }],
              },
            },
          },
          {
            type: 'tool/call',
            data: {
              callId: 'create-1',
              name: 'search_replace',
              arguments: JSON.stringify({
                file_path: 'docs/开发记录/new.md',
                old_string: '',
                new_string: '# 记录\n',
              }),
            },
          },
          {
            type: 'tool/result',
            data: {
              message: { role: 'tool', toolCallId: 'create-1', content: [] },
            },
          },
          {
            type: 'tool/call',
            data: {
              callId: 'write-target',
              name: 'write',
              arguments: JSON.stringify({ target_file: 'src/client/features/lan-access-panel.ts', content: 'export {}\n' }),
            },
          },
          {
            type: 'tool/result',
            data: {
              message: { role: 'tool', toolCallId: 'write-target', content: [] },
            },
          },
        ] }),
      },
    }, 'session-search-replace', root)
    assert.deepEqual(result.paths, [
      'docs/开发记录/new.md',
      'src/client/features/lan-access-panel.ts',
      'src/host/lan-access-dsh.ts',
    ])
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
      JSON.stringify({ type: 'tool/call', data: { callId: 'jsonl-write', name: 'write_file', arguments: JSON.stringify({ file_path: 'src/from-jsonl.ts' }) } }),
      JSON.stringify({ type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'jsonl-write', content: [] } } }),
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

test('Session changes recover persisted Grok display titles without counting reads or failed edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-session-grok-titles-'))
  try {
    const events = [
      ['edited', 'Edit `src/edited.ts`', 'src/edited.ts', false],
      ['created', 'Write `src/created.ts`', 'src/created.ts', false],
      ['read', 'Read `src/read.ts`', 'src/read.ts', false],
      ['failed', 'Edit `src/failed.ts`', 'src/failed.ts', true],
      ['outside', 'Edit `../outside.ts`', '../outside.ts', false],
    ].flatMap(([callId, name, file_path, isError]) => [
      { type: 'tool/call', data: { callId, name, arguments: JSON.stringify({ file_path }) } },
      { type: 'tool/result', data: { message: { toolCallId: callId, isError, content: [] } } },
    ])
    const result = await readSessionChangedFiles({
      nativeSessions: { get: () => ({ snapshotEvents: () => events }) },
    }, 'grok-history', root)
    assert.deepEqual(result.paths, ['src/created.ts', 'src/edited.ts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Session changes use the same registered workspace root as Git when the terminal cache differs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-session-workspace-root-'))
  const disposers: Array<() => void> = []
  try {
    const table = new CodingNsRpcTable()
    const feature = createFileManagementFeature()
    feature.start({
      descriptor: feature.descriptor,
      resources: { add: (dispose: () => void) => disposers.push(dispose) },
      services: {
        rpc: table,
        resolveManagedWorkspaceRoot: () => root,
        resolveWorkspaceRoot: () => join(root, 'terminal-subdirectory'),
        nativeSessions: { get: () => ({ snapshotEvents: () => [
          { type: 'tool/call', data: { callId: 'edit', name: 'edit', arguments: { file_path: join(root, 'src/edited.ts') } } },
          { type: 'tool/result', data: { message: { toolCallId: 'edit', content: [] } } },
        ] }) },
      },
    })
    const route = table.resolve('fileManagement/session-changes')!
    const result = await route.handler(route.action, { sessionId: 'grok', workspaceId: 'workspace' })
    assert.deepEqual(result, { paths: ['src/edited.ts'] })
    assert.equal(selectSessionChangedFiles(result, {
      changes: [{ path: 'src/edited.ts', oldPath: null }, { path: 'src/unrelated.ts', oldPath: null }],
    } as never).length, 1)
  } finally {
    for (const dispose of disposers.reverse()) dispose()
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

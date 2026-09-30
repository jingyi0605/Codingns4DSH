import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test from 'node:test'
import { createCodingNsRpcHandler } from '../data/build/dist/host/rpc.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { createGitManagementFeature } from '../data/build/dist/host/features/git-management.js'
import { registerGitManagementUi, resolveGitWorkspaceId } from '../data/build/dist/client/git-management.js'

const execFile = promisify(execFileCallback)

interface ResourceScope {
  readonly disposers: Array<() => void | Promise<void>>
  add(disposer: () => void | Promise<void>): void
}

function startGitFeature(roots: Map<string, string>): { table: CodingNsRpcTable; resources: ResourceScope } {
  const table = new CodingNsRpcTable()
  const resources: ResourceScope = { disposers: [], add(disposer) { this.disposers.push(disposer) } }
  const feature = createGitManagementFeature()
  feature.start({
    descriptor: feature.descriptor,
    resources,
    services: { rpc: table, resolveWorkspaceRoot: (workspaceId: string) => roots.get(workspaceId) ?? null },
  })
  return { table, resources }
}

async function rpc(table: CodingNsRpcTable, endpoint: string, payload: unknown): Promise<unknown> {
  return createCodingNsRpcHandler(table)(endpoint, payload, new AbortController().signal).then((result) => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  })
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFile('git', args, { cwd })
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFile('git', args, { cwd, encoding: 'utf8' }) as unknown as { stdout: string }
  return result.stdout.trim()
}

test('Git Host 模块能处理未初始化目录、状态、暂存、提交和历史', async () => {
  const root = await mkdtemp(`${tmpdir()}/codingns-git-`)
  try {
    const roots = new Map([['workspace-1', root]])
    const { table, resources } = startGitFeature(roots)

    const empty = await rpc(table, 'git/status', { workspaceId: 'workspace-1' }) as { snapshot: { enabled?: boolean }; changes: readonly unknown[] }
    assert.equal(empty.snapshot.enabled, false)
    assert.deepEqual(empty.changes, [])

    await rpc(table, 'git/init', { workspaceId: 'workspace-1' })
    await writeFile(`${root}/README.md`, '# Git\n', 'utf8')
    const changed = await rpc(table, 'git/status', { workspaceId: 'workspace-1' }) as { changes: readonly { path: string; staged: boolean }[] }
    assert.deepEqual(changed.changes.map((item) => [item.path, item.staged]), [['README.md', false]])

    const staged = await rpc(table, 'git/stage', { workspaceId: 'workspace-1', targets: ['README.md'] }) as { changes: readonly { path: string; staged: boolean }[] }
    assert.deepEqual(staged.changes.map((item) => [item.path, item.staged]), [['README.md', true]])

    await git(root, ['config', 'user.name', 'CodingNS Test'])
    await git(root, ['config', 'user.email', 'codingns-test@example.invalid'])
    const commit = await rpc(table, 'git/commit', { workspaceId: 'workspace-1', subject: '初始化 Git 管理测试' }) as { commitHash: string }
    assert.match(commit.commitHash, /^[0-9a-f]{40}$/u)
    const history = await rpc(table, 'git/history', { workspaceId: 'workspace-1', limit: 20 }) as { items: readonly { commitHash: string; subject: string }[]; totalCount: number }
    assert.equal(history.items[0]?.commitHash, commit.commitHash)
    assert.equal(history.items[0]?.subject, '初始化 Git 管理测试')
    assert.equal(history.totalCount, 1)

    await assert.rejects(() => rpc(table, 'git/stage', { workspaceId: 'workspace-1', targets: ['../outside'] }), /Git 路径无效/u)
    for (const dispose of resources.disposers.reverse()) await dispose()
    assert.equal(table.resolve('git/status'), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Git Host 模块拒绝不存在的 Workspace', async () => {
  const { table } = startGitFeature(new Map())
  await assert.rejects(() => rpc(table, 'git/status', { workspaceId: 'missing' }), /当前 Workspace 没有可用的本地目录/u)
})

test('Git Host 模块支持提交 Diff 和撤销最近提交', async () => {
  const root = await mkdtemp(`${tmpdir()}/codingns-git-undo-`)
  try {
    const { table } = startGitFeature(new Map([['workspace-undo', root]]))
    await rpc(table, 'git/init', { workspaceId: 'workspace-undo' })
    await git(root, ['config', 'user.name', 'CodingNS Test'])
    await git(root, ['config', 'user.email', 'codingns-test@example.invalid'])

    await writeFile(`${root}/README.md`, 'first\n', 'utf8')
    await rpc(table, 'git/stage', { workspaceId: 'workspace-undo', targets: ['README.md'] })
    const first = await rpc(table, 'git/commit', { workspaceId: 'workspace-undo', subject: '第一次提交' }) as { commitHash: string }

    await writeFile(`${root}/README.md`, 'second\n', 'utf8')
    await rpc(table, 'git/stage', { workspaceId: 'workspace-undo', targets: ['README.md'] })
    const second = await rpc(table, 'git/commit', { workspaceId: 'workspace-undo', subject: '第二次提交' }) as { commitHash: string }

    const diff = await rpc(table, 'git/commit-diff', { workspaceId: 'workspace-undo', commitHash: second.commitHash }) as { commitHash: string; files: readonly { path: string; status: string }[]; content: string }
    assert.equal(diff.commitHash, second.commitHash)
    assert.deepEqual(diff.files, [{ path: 'README.md', oldPath: null, status: 'M', binary: false }])
    assert.match(diff.content, /second/u)

    const pagedHistory = await rpc(table, 'git/history', { workspaceId: 'workspace-undo', limit: 1, offset: 1 }) as { items: readonly { commitHash: string }[]; cursor: string; nextCursor: string | null }
    assert.equal(pagedHistory.items[0]?.commitHash, first.commitHash)
    assert.equal(pagedHistory.cursor, '1')
    assert.equal(pagedHistory.nextCursor, null)

    const undone = await rpc(table, 'git/undo', { workspaceId: 'workspace-undo' }) as { changes: readonly { path: string; staged: boolean }[] }
    assert.deepEqual(undone.changes.map((item) => [item.path, item.staged]), [['README.md', true]])
    const history = await rpc(table, 'git/history', { workspaceId: 'workspace-undo', limit: 20 }) as { items: readonly { commitHash: string }[] }
    assert.deepEqual(history.items.map((item) => item.commitHash), [first.commitHash])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Git Host 历史记录带分支标签并支持文件 Diff', async () => {
  const root = await mkdtemp(`${tmpdir()}/codingns-git-refs-`)
  try {
    const { table } = startGitFeature(new Map([['workspace-refs', root]]))
    await rpc(table, 'git/init', { workspaceId: 'workspace-refs' })
    await git(root, ['config', 'user.name', 'CodingNS Test'])
    await git(root, ['config', 'user.email', 'codingns-test@example.invalid'])
    await writeFile(`${root}/README.md`, 'refs\n', 'utf8')

    const unstaged = await rpc(table, 'git/diff', { workspaceId: 'workspace-refs', path: 'README.md', staged: false }) as { staged: boolean; content: string }
    assert.equal(unstaged.staged, false)
    assert.match(unstaged.content, /\+refs/u)

    await rpc(table, 'git/stage', { workspaceId: 'workspace-refs', targets: ['README.md'] })
    const staged = await rpc(table, 'git/diff', { workspaceId: 'workspace-refs', path: 'README.md', staged: true }) as { staged: boolean; content: string }
    assert.equal(staged.staged, true)
    assert.match(staged.content, /\+refs/u)

    await rpc(table, 'git/commit', { workspaceId: 'workspace-refs', subject: '记录分支标签' })
    await git(root, ['branch', 'feature/refs'])
    const currentBranch = await gitOutput(root, ['branch', '--show-current'])

    const history = await rpc(table, 'git/history', { workspaceId: 'workspace-refs', limit: 5 }) as { items: readonly { refs: readonly { name: string; kind: string; remoteName: string | null }[] }[] }
    const refs = history.items[0]?.refs ?? []
    assert.ok(refs.some((ref) => ref.name === currentBranch && ref.kind === 'head'), `期望当前分支以 head 出现，实际 ${JSON.stringify(refs)}`)
    assert.ok(refs.some((ref) => ref.name === 'feature/refs' && ref.kind === 'local'), `期望本地分支以 local 出现，实际 ${JSON.stringify(refs)}`)

    const branches = await rpc(table, 'git/branches', { workspaceId: 'workspace-refs' }) as { currentBranch: string; local: readonly { name: string; current: boolean }[] }
    assert.equal(branches.currentBranch, currentBranch)
    assert.deepEqual(branches.local.map((branch) => branch.name).sort(), ['feature/refs', currentBranch].sort())
    assert.deepEqual(branches.local.filter((branch) => branch.current).map((branch) => branch.name), [currentBranch])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Git Host 历史记录返回父提交、标签与提交归属', async () => {
  const root = await mkdtemp(`${tmpdir()}/codingns-git-origin-`)
  interface HistoryItem { commitHash: string; parents?: readonly string[]; origin?: string; refs: readonly { name: string; kind: string; remoteName: string | null }[] }
  interface HistoryPage { items: readonly HistoryItem[]; totalCount: number }
  try {
    const { table } = startGitFeature(new Map([['workspace-origin', root]]))
    await rpc(table, 'git/init', { workspaceId: 'workspace-origin' })
    await git(root, ['config', 'user.name', 'CodingNS Test'])
    await git(root, ['config', 'user.email', 'codingns-test@example.invalid'])
    const trunk = await gitOutput(root, ['branch', '--show-current'])

    // A：主线基线，同时挂标签与远程跟踪 ref（origin/main 之后停在 A）。
    await writeFile(`${root}/README.md`, 'A\n', 'utf8')
    await rpc(table, 'git/stage', { workspaceId: 'workspace-origin', targets: ['README.md'] })
    const a = (await rpc(table, 'git/commit', { workspaceId: 'workspace-origin', subject: 'A 基线' }) as { commitHash: string }).commitHash
    await git(root, ['tag', 'v1'])
    // B：只属于本地特性分支，随后被合并进主线。
    await git(root, ['switch', '-c', 'feature/topic'])
    await writeFile(`${root}/feature.md`, 'B\n', 'utf8')
    await rpc(table, 'git/stage', { workspaceId: 'workspace-origin', targets: ['feature.md'] })
    const b = (await rpc(table, 'git/commit', { workspaceId: 'workspace-origin', subject: 'B 特性' }) as { commitHash: string }).commitHash
    // C：主线新增提交，尚未出现在远程跟踪分支上。
    await git(root, ['switch', trunk])
    await writeFile(`${root}/README.md`, 'C\n', 'utf8')
    await rpc(table, 'git/stage', { workspaceId: 'workspace-origin', targets: ['README.md'] })
    const c = (await rpc(table, 'git/commit', { workspaceId: 'workspace-origin', subject: 'C 主线' }) as { commitHash: string }).commitHash
    await git(root, ['merge', '--no-ff', '-m', 'M 合并特性', 'feature/topic'])
    const m = await gitOutput(root, ['rev-parse', 'HEAD'])
    await git(root, ['update-ref', 'refs/remotes/origin/main', a])
    // D：只被远程跟踪 ref 包含（本地分支随后删除）。
    await git(root, ['switch', '-c', 'tmp/remote', a])
    await writeFile(`${root}/remote.md`, 'D\n', 'utf8')
    await rpc(table, 'git/stage', { workspaceId: 'workspace-origin', targets: ['remote.md'] })
    const d = (await rpc(table, 'git/commit', { workspaceId: 'workspace-origin', subject: 'D 仅远程' }) as { commitHash: string }).commitHash
    await git(root, ['update-ref', 'refs/remotes/origin/tmp', d])
    await git(root, ['switch', trunk])
    await git(root, ['branch', '-D', 'tmp/remote'])

    const headPage = await rpc(table, 'git/history', { workspaceId: 'workspace-origin', limit: 20, scope: 'head' }) as HistoryPage
    assert.deepEqual(headPage.items.map((item) => item.commitHash).sort(), [a, b, c, m].sort())
    assert.equal(headPage.totalCount, 4)
    const headByHash = new Map(headPage.items.map((item) => [item.commitHash, item]))
    assert.equal(headByHash.get(m)?.parents?.length, 2, '合并提交应有两个父提交')
    assert.equal(headByHash.get(a)?.parents?.length, 0, '根提交没有父提交')
    assert.equal(headByHash.get(c)?.parents?.[0], a)
    assert.equal(headByHash.get(m)?.origin, 'local')
    assert.equal(headByHash.get(b)?.origin, 'local')
    assert.equal(headByHash.get(a)?.origin, 'synced')
    assert.ok(headByHash.get(a)?.refs.some((ref) => ref.kind === 'tag' && ref.name === 'v1'), `期望 A 带标签，实际 ${JSON.stringify(headByHash.get(a)?.refs)}`)
    assert.ok(headByHash.get(b)?.refs.some((ref) => ref.kind === 'local' && ref.name === 'feature/topic'), `期望 B 带本地分支标签，实际 ${JSON.stringify(headByHash.get(b)?.refs)}`)
    assert.ok(headByHash.get(m)?.refs.some((ref) => ref.kind === 'head' && ref.name === trunk), `期望 M 带当前分支标签，实际 ${JSON.stringify(headByHash.get(m)?.refs)}`)

    const allPage = await rpc(table, 'git/history', { workspaceId: 'workspace-origin', limit: 20, scope: 'all' }) as HistoryPage
    assert.deepEqual(allPage.items.map((item) => item.commitHash).sort(), [a, b, c, d, m].sort())
    assert.equal(allPage.totalCount, 5)
    const allByHash = new Map(allPage.items.map((item) => [item.commitHash, item]))
    assert.equal(allByHash.get(d)?.origin, 'remote')
    assert.equal(allByHash.get(a)?.origin, 'synced')
    assert.ok(allByHash.get(d)?.refs.some((ref) => ref.kind === 'remote' && ref.name === 'origin/tmp' && ref.remoteName === 'origin'), `期望 D 带远程分支标签，实际 ${JSON.stringify(allByHash.get(d)?.refs)}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Git Host 允许脏工作区 Push，并在 Pull 后恢复本地改动', async () => {
  const root = await mkdtemp(`${tmpdir()}/codingns-git-sync-`)
  const remote = await mkdtemp(`${tmpdir()}/codingns-git-remote-`)
  const peerParent = await mkdtemp(`${tmpdir()}/codingns-git-peer-`)
  const peer = `${peerParent}/clone`
  try {
    await git(remote, ['init', '--bare'])
    await git(root, ['init'])
    await git(root, ['config', 'user.name', 'CodingNS Test'])
    await git(root, ['config', 'user.email', 'codingns-test@example.invalid'])
    await writeFile(`${root}/README.md`, 'base\n', 'utf8')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', '基础提交'])
    await git(root, ['branch', '-M', 'main'])
    await git(root, ['remote', 'add', 'origin', remote])
    await git(root, ['push', '--set-upstream', 'origin', 'main'])

    const roots = new Map([['workspace-sync', root]])
    const { table } = startGitFeature(roots)
    await writeFile(`${root}/pushed.md`, '待推送提交\n', 'utf8')
    await rpc(table, 'git/stage', { workspaceId: 'workspace-sync', targets: ['pushed.md'] })
    await rpc(table, 'git/commit', { workspaceId: 'workspace-sync', subject: '脏工作区前的提交' })
    await writeFile(`${root}/README.md`, 'base\n本地未提交改动\n', 'utf8')

    // Push 只发送提交对象，工作区仍有未提交改动时也必须能够完成。
    await rpc(table, 'git/push', { workspaceId: 'workspace-sync' })
    // 裸仓库的默认 HEAD 在不同 Git 发行版中可能仍指向 master，显式检出 main 才能
    // 验证 push 后的提交内容，而不是依赖运行环境的 init.defaultBranch 配置。
    await execFile('git', ['clone', '--branch', 'main', remote, peer])
    assert.equal(await readFile(`${peer}/pushed.md`, 'utf8'), '待推送提交\n')

    await git(peer, ['config', 'user.name', 'CodingNS Peer'])
    await git(peer, ['config', 'user.email', 'codingns-peer@example.invalid'])
    await writeFile(`${peer}/remote.md`, '远程新增提交\n', 'utf8')
    await git(peer, ['add', 'remote.md'])
    await git(peer, ['commit', '-m', '远程新增提交'])
    await git(peer, ['push'])

    // Pull 使用 autostash：快进远程提交后，本地已跟踪改动仍然保留。
    await rpc(table, 'git/pull', { workspaceId: 'workspace-sync' })
    assert.equal(await readFile(`${root}/README.md`, 'utf8'), 'base\n本地未提交改动\n')
    assert.equal(await readFile(`${root}/remote.md`, 'utf8'), '远程新增提交\n')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
    await rm(peerParent, { recursive: true, force: true })
  }
})

test('Git Client 与 Host 接线包含侧栏面板和所有版本 RPC', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { dsh: { client: { inject: string[] } } }
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'))
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'))
  const source = await readFile(new URL('../src/client/git-management.ts', import.meta.url), 'utf8')
  const hostRpc = await readFile(new URL('../src/host/rpc.ts', import.meta.url), 'utf8')
  for (const marker of ['sidebarRightTabs.register', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'git/status', 'git/commit', 'git/commit-diff', 'git/history', 'git/branches', 'git/${action}', 'buildChangeTree', 'collectTreeTargets', 'onBatchAction', 'git.unstageDirectory', 'git.discardDirectory', 'hoveredPath', 'contentGridStyle', 'commitSectionStyle', 'commitEditorRowStyle', 'git.commitChanges', 'submitActionStyle', 'gitPanelClass.buttonPrimary', 'gitPanelClass.segment', 'git.commitPlaceholder', '生成提交信息', 'commitActionsStyle', 'git.stageAll', 'git.viewAllVersions', "onOperation('refresh')", 'groupHistoryByDate', 'historyDateHeaderStyle', 'historyTimeStyle', 'formatHistoryTimestamp', 'git.switchToFiles', 'git.switchToHistory', 'columnSwitchStyle', 'SegmentedControl', 'gitPanelClass', 'installGitPanelStyles', 'singleColumn && activeColumn !== \'history\'', 'contentGridRef', 'ResizeObserver', 'onDoubleClick', "'git/diff'", 'FileDiffViewer', 'historyRefPillStyle', 'historyRefListStyle', 'REMOTE_REF_PALETTE', "position: 'relative', userSelect: 'none'", 'buildHistoryGraph', 'GitGraphTrack', 'GitGraphRails', 'describeCommitOrigin', 'describeCommitNode', 'dashProps', 'historyListStyle', 'segmentStroke(row.incomingOrigin', 'laneColor(row.color)', 'laneStroke', 'laneDashed', 'git.graphLegend', 'graphRailStyle', 'scopeSelectStyle', 'git.currentBranch', 'git.allBranches', 'scope: historyScope']) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  }
  assert.doesNotMatch(source, /snapshot\.repoRoot/u)
  assert.match(source, /historyRowMainStyle: CSSProperties = \{[^}]*minHeight: 28/u)
  assert.doesNotMatch(source, /historyRowStyle: CSSProperties = \{[^}]*padding/u)
  assert.match(source, /cached !== null && !historyExpanded\.current/u)
  assert.match(source, /preserveExpandedHistory = action === 'git\/status'/u)
  assert.doesNotMatch(source, /sidebar\.panellist/u)
  assert.doesNotMatch(source, /name: 'main'/u)
  assert.match(source, /String\(props\.sessionId\)/u)
  assert.doesNotMatch(source, /info\.tab\.sessionId/u)
  for (const marker of ['git/status', 'git/init', 'git/diff', 'git/stage', 'git/unstage', 'git/discard', 'git/commit', 'git/commit-diff', 'git/history', 'git/branches', 'git/switch', 'git/fetch', 'git/pull', 'git/push', 'git/undo']) {
    assert.match(hostRpc, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  }
})

test('Git Client 遇到热重载残留的 Sidebar 注册时保持幂等', () => {
  const ctx = {
    sidebarRight: {},
    sidebarRightTabs: {
      register: () => { throw new Error('sidebarRight: tab type id "codingns4dsh/git" is already registered') },
    },
    slots: {},
  } as unknown as Parameters<typeof registerGitManagementUi>[0]
  assert.doesNotThrow(() => registerGitManagementUi(ctx, { rpc: {} as never }))
})

test('Git Client 按当前会话归属解析 Workspace', async () => {
  const follow = (value: unknown): AsyncIterable<unknown> => (async function* () { yield value })()
  const bySessionId = await resolveGitWorkspaceId({
    workspace: { follow: async () => follow({ value: { items: [{ workspaceId: 'workspace-a', path: '/work/a', sessionIds: ['session-a'] }] } }) },
  }, 'session-a')
  assert.equal(bySessionId, 'workspace-a')

  const byRemoteResult = await resolveGitWorkspaceId({
    workspace: { follow: async () => follow({ ok: true, value: { items: [{ workspaceId: 'workspace-b', path: '/work/b', sessionIds: ['session-b'] }] } }) },
  }, 'session-b')
  assert.equal(byRemoteResult, 'workspace-b')

  const byCwd = await resolveGitWorkspaceId({
    workspace: { follow: async () => follow({ value: { items: [
      { workspaceId: 'workspace-parent', path: '/work', sessionIds: [] },
      { workspaceId: 'workspace-child', path: 'C:\\work\\repo', sessionIds: [] },
      { workspaceId: 'workspace-similar', path: '/work/repository', sessionIds: [] },
    ] } }) },
    session: { list: async () => ({ items: [{ sessionId: 'session-c', cwd: 'C:\\work\\repo\\src' }] }) },
  }, 'session-c')
  assert.equal(byCwd, 'workspace-child')

  const bySingleWorkspaceFallback = await resolveGitWorkspaceId({
    workspace: { follow: async () => follow({ value: { items: [{ workspaceId: 'workspace-only', path: '/work/only', sessionIds: [] }] } }) },
    session: { list: async () => ({ items: [] }) },
  }, 'session-missing')
  assert.equal(bySingleWorkspaceFallback, 'workspace-only')
})

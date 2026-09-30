import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute, relative, resolve } from 'node:path'
import type { FeatureModule } from '../../shared/contracts/feature.js'
import type {
  GitBranchItem,
  GitBranchSnapshot,
  GitChangeItem,
  GitCommitChangedFile,
  GitCommitDiff,
  GitCommitResult,
  GitDiff,
  GitHistoryItem,
  GitHistoryOrigin,
  GitHistoryPage,
  GitHistoryRef,
  GitHistoryScope,
  GitStatus,
} from '../../shared/contracts/git.js'
import { CodingNsRpcError } from '../rpc-table.js'
import type { CodingNsHostServices } from './types.js'

const execFile = promisify(execFileCallback)
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_DIFF_BYTES = 60_000

/** Host 侧 Git 工作区服务；所有路径都由 resolveWorkspaceRoot 权威解析。 */
export function createGitManagementFeature(): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'gitManagement',
      version: '0.1.0',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
    },
    start(context) {
      context.resources.add(context.services.rpc.register('git', async (action, payload) => {
        const input = record(payload)
        const workspaceId = requiredString(input.workspaceId, 'workspaceId')
        const root = context.services.resolveWorkspaceRoot?.(workspaceId)
        if (root === null || root === undefined) throw new CodingNsRpcError('GIT_WORKSPACE_UNAVAILABLE', '当前 Workspace 没有可用的本地目录')
        switch (action) {
          case 'status': return readStatus(workspaceId, root)
          case 'init': return runGit(root, ['init']).then(() => readStatus(workspaceId, root))
          case 'diff': return readDiff(workspaceId, root, requiredString(input.path, 'path'), input.staged === true)
          case 'stage': return mutateTargets(workspaceId, root, input.targets, 'add')
          case 'unstage': return mutateTargets(workspaceId, root, input.targets, 'reset')
          case 'discard': return discardTargets(workspaceId, root, input.targets)
          case 'commit': return commit(workspaceId, root, requiredString(input.subject, 'subject'))
          case 'commit-diff': return readCommitDiff(root, requiredString(input.commitHash, 'commitHash'))
          case 'history': return readHistory(workspaceId, root, input.limit, input.offset, input.scope)
          case 'branches': return readBranches(root)
          case 'switch': return switchBranch(root, requiredString(input.branchName, 'branchName'), input.create === true)
          case 'fetch': return syncRemote(workspaceId, root, ['fetch', '--all', '--prune'])
          // 自动暂存已跟踪的本地改动，快进完成后再恢复，避免本地未提交文件阻塞拉取。
          // `--ff-only` 仍然保留：远程与本地已经分叉时必须明确处理，不能偷偷创建合并提交。
          case 'pull': return syncRemote(workspaceId, root, ['pull', '--ff-only', '--autostash'])
          case 'push': return syncRemote(workspaceId, root, ['push'])
          case 'undo': return undoLastCommit(workspaceId, root)
          default: throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 Git RPC: git/${action}`)
        }
      }))
    },
  }
}

async function readStatus(workspaceId: string, root: string): Promise<GitStatus> {
  let result: { stdout: string; stderr: string }
  try {
    result = await runGit(root, ['status', '--porcelain=v1', '-z', '--branch'])
  } catch (error) {
    if (!isNotGitRepositoryError(error)) throw error
    return {
      snapshot: { workspaceId, repoRoot: root, enabled: false, branch: 'HEAD', ahead: 0, behind: 0, hasRemote: false, isDirty: false, lastFetchedAt: null },
      changes: [],
    }
  }
  const tokens = result.stdout.split('\0')
  const changes: GitChangeItem[] = []
  let branch = 'HEAD'
  let ahead = 0
  let behind = 0
  let hasRemote = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue
    if (token.startsWith('## ')) {
      const tracking = parseBranchLine(token.slice(3))
      branch = tracking.branch
      ahead = tracking.ahead
      behind = tracking.behind
      hasRemote = tracking.hasRemote
      continue
    }
    if (token.length < 3) continue
    const stagedStatus = token[0] === ' ' || token[0] === '?' || token[0] === '!' ? null : token[0] ?? null
    const worktreeStatus = token[1] === ' ' || token[1] === '?' || token[1] === '!' ? null : token[1] ?? null
    const status = `${token[0] ?? ' '}${token[1] ?? ' '}`.trim() || '?'
    const path = normalizeGitPath(token.slice(3))
    let oldPath: string | null = null
    if ((token[0] === 'R' || token[0] === 'C' || token[1] === 'R' || token[1] === 'C') && tokens[index + 1]) {
      oldPath = normalizeGitPath(tokens[index + 1] ?? '')
      index += 1
    }
    changes.push({ path, status, staged: stagedStatus !== null, oldPath, binary: false, stagedStatus, worktreeStatus })
  }
  return {
    snapshot: { workspaceId, repoRoot: root, enabled: true, branch, ahead, behind, hasRemote, isDirty: changes.length > 0, lastFetchedAt: null },
    changes,
  }
}

function parseBranchLine(value: string): { branch: string; ahead: number; behind: number; hasRemote: boolean } {
  const [rawBranch, rawTracking] = value.split('...')
  const branch = (rawBranch ?? 'HEAD').replace(/^No commits yet on /u, '').trim() || 'HEAD'
  const tracking = rawTracking ?? ''
  const ahead = Number(/\[ahead (\d+)/u.exec(tracking)?.[1] ?? 0)
  const behind = Number(/\[behind (\d+)/u.exec(tracking)?.[1] ?? 0)
  return { branch, ahead, behind, hasRemote: rawTracking !== undefined }
}

async function readDiff(workspaceId: string, root: string, target: string, staged: boolean): Promise<GitDiff> {
  const path = safeTarget(root, target)
  try {
    const result = await runGit(root, [...(staged ? ['diff', '--cached'] : ['diff']), '--binary', '--', path])
    if (!staged && result.stdout === '' && await isUntracked(root, path)) {
      try {
        await runGit(root, ['diff', '--no-index', '--binary', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', path])
      } catch (error) {
        if (error instanceof GitCommandError && error.stdout !== '') {
          const content = error.stdout.slice(0, MAX_DIFF_BYTES)
          return { workspaceId, path: normalizeGitPath(target), staged, binary: /Binary files /u.test(error.stdout), truncated: error.stdout.length > content.length, content }
        }
      }
    }
    const content = result.stdout.slice(0, MAX_DIFF_BYTES)
    return { workspaceId, path: normalizeGitPath(target), staged, binary: /Binary files /u.test(result.stdout), truncated: result.stdout.length > content.length, content }
  } catch (error) {
    if (error instanceof GitCommandError && error.stderr.includes('unknown revision')) throw error
    return { workspaceId, path: normalizeGitPath(target), staged, binary: false, truncated: false, content: '' }
  }
}

async function isUntracked(root: string, path: string): Promise<boolean> {
  try {
    await runGit(root, ['ls-files', '--error-unmatch', '--', path])
    return false
  } catch {
    return true
  }
}

async function mutateTargets(workspaceId: string, root: string, rawTargets: unknown, action: 'add' | 'reset'): Promise<GitStatus> {
  const targets = safeTargets(root, rawTargets)
  if (targets.length > 0) await runGit(root, action === 'add' ? ['add', '--', ...targets] : ['reset', '--', ...targets])
  return readStatus(workspaceId, root)
}

async function discardTargets(workspaceId: string, root: string, rawTargets: unknown): Promise<GitStatus> {
  const targets = safeTargets(root, rawTargets)
  if (targets.length > 0) {
    await runGit(root, ['restore', '--worktree', '--staged', '--', ...targets]).catch(() => undefined)
    await runGit(root, ['clean', '-f', '--', ...targets]).catch(() => undefined)
  }
  return readStatus(workspaceId, root)
}

async function commit(workspaceId: string, root: string, subject: string): Promise<GitCommitResult & { readonly status: GitStatus }> {
  if (subject.length > 200) throw new TypeError('subject 不能超过 200 个字符')
  const result = await runGit(root, ['commit', '-m', subject])
  const hash = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim()
  return { commitHash: hash, summary: result.stdout.trim() || `已提交 ${hash.slice(0, 8)}`, status: await readStatus(workspaceId, root) }
}

async function readCommitDiff(root: string, rawCommitHash: string): Promise<GitCommitDiff> {
  const commitHash = rawCommitHash.trim()
  if (!/^[0-9a-f]{7,40}$/iu.test(commitHash)) throw new TypeError('commitHash 无效')
  const [result, filesResult] = await Promise.all([
    runGit(root, ['-c', 'core.quotePath=false', 'show', '--format=', '--binary', '--no-ext-diff', '-M', commitHash, '--']),
    runGit(root, ['-c', 'core.quotePath=false', 'show', '--format=', '--name-status', '-M', commitHash, '--']),
  ])
  const content = result.stdout.slice(0, MAX_DIFF_BYTES)
  return { commitHash, files: parseCommitChangedFiles(filesResult.stdout, result.stdout), content, truncated: result.stdout.length > content.length }
}

function parseCommitChangedFiles(value: string, diffContent: string): readonly GitCommitChangedFile[] {
  const binaryPaths = new Set<string>()
  for (const line of diffContent.split(/\r?\n/u)) {
    const match = /^Binary files .* and .* differ$/u.exec(line)
    if (match !== null) {
      const paths = line.match(/(?:a|b)\/([^\s]+?)(?: differ)?$/u)
      if (paths?.[1] !== undefined) binaryPaths.add(paths[1])
    }
  }
  return value.split(/\r?\n/u).flatMap((line) => {
    const fields = line.split('\t')
    const statusToken = fields[0]?.trim() ?? ''
    if (statusToken === '' || fields.length < 2) return []
    const status = statusToken[0] ?? '?'
    const renamed = status === 'R' || status === 'C'
    const oldPath = renamed ? fields[1] ?? null : null
    const path = (renamed ? fields[2] : fields[1])?.trim() ?? ''
    if (path === '') return []
    return [{ path, oldPath, status, binary: binaryPaths.has(path) }]
  })
}

async function syncRemote(workspaceId: string, root: string, args: readonly string[]): Promise<GitStatus> {
  await runGit(root, args)
  return readStatus(workspaceId, root)
}

async function undoLastCommit(workspaceId: string, root: string): Promise<GitStatus> {
  await runGit(root, ['rev-parse', '--verify', 'HEAD'])
  await runGit(root, ['reset', '--soft', 'HEAD~1'])
  return readStatus(workspaceId, root)
}

async function readHistory(_workspaceId: string, root: string, rawLimit: unknown, rawOffset: unknown, rawScope: unknown): Promise<GitHistoryPage> {
  const limit = Math.max(1, Math.min(100, Number.isSafeInteger(rawLimit) ? Number(rawLimit) : 50))
  const offset = Math.max(0, Math.min(1_000_000, Number.isSafeInteger(rawOffset) ? Number(rawOffset) : 0))
  const scope: GitHistoryScope = rawScope === 'all' ? 'all' : 'head'
  // HEAD 之外的提交只有在 all 范围才可见；--date-order 保证父提交永远排在其子提交之后。
  // 空仓库没有 HEAD 时必须省略该 revision，否则 git log 会以 ambiguous argument 失败。
  const hasHead = await hasHeadCommit(root)
  if (scope === 'head' && !hasHead) return { items: [], cursor: String(offset), nextCursor: null, totalCount: 0 }
  const revisions = scope === 'all' ? [...(hasHead ? ['HEAD'] : []), '--branches', '--remotes'] : ['HEAD']
  let result: { stdout: string; stderr: string }
  try {
    result = await runGit(root, ['log', ...revisions, `--skip=${String(offset)}`, `--max-count=${String(limit)}`, '--date-order', '--decorate=short', `--format=${HISTORY_FORMAT}`])
  } catch (error) {
    if (isEmptyRepositoryError(error)) return { items: [], cursor: String(offset), nextCursor: null, totalCount: 0 }
    throw error
  }
  const refRecords = await readRefRecords(root)
  const refByShortName = new Map(refRecords.map((record) => [record.shortName, record] as const))
  const originByHash = await readOriginIndex(root, refRecords, hasHead)
  const items: GitHistoryItem[] = []
  for (const record of result.stdout.split('\x1e')) {
    const fields = record.trim().split('\x1f')
    if (fields.length < 6 || !fields[0]) continue
    const commitHash = fields[0]!
    const origin = originByHash?.get(commitHash)
    items.push({
      commitHash,
      authorName: fields[2] ?? '',
      authoredAt: fields[3] ?? '',
      subject: fields[4] ?? '',
      body: fields[5] ?? '',
      refs: parseHistoryRefs(fields[6] ?? '', refByShortName),
      parents: parseParentHashes(fields[1] ?? ''),
      ...(origin === undefined ? {} : { origin }),
    })
  }
  let total = 0
  try {
    total = Number((await runGit(root, ['rev-list', '--count', ...revisions])).stdout.trim() || 0)
  } catch (error) {
    if (!isEmptyRepositoryError(error)) throw error
  }
  return { items, cursor: String(offset), nextCursor: offset + items.length < total ? String(offset + items.length) : null, totalCount: total }
}

/** 提交字段分隔：哈希、父哈希、作者、时间、标题、正文、装饰；记录之间用 0x1e 分隔。 */
const HISTORY_FORMAT = '%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%b%x1f%D%x1e'

function parseParentHashes(value: string): readonly string[] {
  return value.split(' ').map((hash) => hash.trim()).filter((hash) => hash !== '')
}

/** HEAD 在空仓库或非仓库目录下不可解析；历史与归属统计都要先区分这两种情况。 */
async function hasHeadCommit(root: string): Promise<boolean> {
  try {
    await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/**
 * 统计每个提交的归属。三个 rev-list 集合都是一次图遍历，命中内存缓冲上限时返回 null，
 * 由 Client 退化为“只按分支标签显示”，不会给出错误结论。
 */
async function readOriginIndex(root: string, records: readonly GitRefRecord[], hasHead: boolean): Promise<Map<string, GitHistoryOrigin> | null> {
  const hasLocal = records.some((record) => record.kind === 'local')
  const hasRemote = records.some((record) => record.kind === 'remote')
  const [head, local, remote] = await Promise.all([
    hasHead ? revListHashes(root, ['HEAD']) : Promise.resolve(new Set<string>()),
    hasLocal ? revListHashes(root, ['--branches']) : Promise.resolve(new Set<string>()),
    hasRemote ? revListHashes(root, ['--remotes']) : Promise.resolve(new Set<string>()),
  ])
  if (head === null || local === null || remote === null) return null
  const index = new Map<string, GitHistoryOrigin>()
  for (const hash of new Set([...head, ...local, ...remote])) {
    if (head.has(hash)) index.set(hash, remote.has(hash) ? 'synced' : 'local')
    else if (local.has(hash)) index.set(hash, 'branch')
    else if (remote.has(hash)) index.set(hash, 'remote')
  }
  return index
}

async function revListHashes(root: string, args: readonly string[]): Promise<Set<string> | null> {
  try {
    const result = await runGit(root, ['rev-list', ...args])
    const hashes = new Set<string>()
    for (const line of result.stdout.split(/\r?\n/u)) {
      const hash = line.trim()
      if (hash !== '') hashes.add(hash)
    }
    return hashes
  } catch {
    return null
  }
}

interface GitRefRecord {
  readonly fullName: string
  readonly shortName: string
  readonly commitHash: string
  readonly upstream: string | null
  readonly current: boolean
  readonly kind: 'local' | 'remote'
  readonly remoteName: string | null
}

/** 读取本地与远程分支的 ref 表；记录之间换行分隔，字段使用 Git 原生支持的 NUL 分隔符（for-each-ref 不展开 %xNN）。 */
async function readRefRecords(root: string): Promise<readonly GitRefRecord[]> {
  const result = await runGit(root, ['for-each-ref', '--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)', 'refs/heads', 'refs/remotes'])
  const records: GitRefRecord[] = []
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line === '') continue
    const [fullName = '', shortName = '', commitHash = '', upstream = '', head = ''] = line.split('\0')
    if (shortName === '') continue
    const remote = fullName.startsWith('refs/remotes/')
    records.push({ fullName, shortName, commitHash, upstream: upstream.trim() || null, current: head.trim() === '*', kind: remote ? 'remote' : 'local', remoteName: remote && shortName.includes('/') ? shortName.split('/')[0] ?? null : null })
  }
  return records
}

/** 解析 git log 的 %D 装饰字段：HEAD -> 分支 记为 head，tag: x 记为 tag，其余通过 ref 表补全类型。 */
function parseHistoryRefs(decoration: string, refByShortName: ReadonlyMap<string, GitRefRecord>): readonly GitHistoryRef[] {
  const refs: GitHistoryRef[] = []
  for (const rawToken of decoration.split(',')) {
    const token = rawToken.trim()
    if (token === '') continue
    if (token === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'head', remoteName: null })
      continue
    }
    if (token.startsWith('HEAD -> ')) {
      const name = token.slice('HEAD -> '.length).trim()
      if (name !== '') refs.push({ name, kind: 'head', remoteName: null })
      continue
    }
    if (token.startsWith('tag: ')) {
      const name = token.slice('tag: '.length).trim()
      if (name !== '') refs.push({ name, kind: 'tag', remoteName: null })
      continue
    }
    const record = refByShortName.get(token)
    if (record === undefined || record.shortName.endsWith('/HEAD')) continue
    refs.push({ name: record.shortName, kind: record.kind, remoteName: record.remoteName })
  }
  return refs
}

async function readBranches(root: string): Promise<GitBranchSnapshot> {
  const currentBranch = (await runGit(root, ['branch', '--show-current'])).stdout.trim() || 'HEAD'
  const records = await readRefRecords(root)
  const toItem = (record: GitRefRecord): GitBranchItem => ({ name: record.shortName, current: record.current, upstream: record.upstream, remote: record.kind === 'remote' })
  return { currentBranch, local: records.filter((record) => record.kind === 'local').map(toItem), remote: records.filter((record) => record.kind === 'remote').map(toItem) }
}

async function switchBranch(root: string, branchName: string, create: boolean): Promise<GitBranchSnapshot> {
  if (!/^[A-Za-z0-9._/-]+$/u.test(branchName) || branchName.startsWith('-')) throw new TypeError('branchName 无效')
  await runGit(root, create ? ['switch', '-c', branchName] : ['switch', branchName])
  return readBranches(root)
}

async function runGit(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile('git', [...args], { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, timeout: 30_000 }) as { stdout: string; stderr: string }
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; code?: string | number }
    throw new GitCommandError(`git ${args.join(' ')} 执行失败`, detail.stderr ?? detail.stdout ?? String(error), detail.code, detail.stdout ?? '')
  }
}

class GitCommandError extends Error {
  constructor(message: string, readonly stderr: string, readonly commandCode?: string | number, readonly stdout = '') { super(message) }
}

function safeTargets(root: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new TypeError('targets 必须是字符串数组')
  return value.map((item) => safeTarget(root, item)).filter((item, index, list) => list.indexOf(item) === index)
}

function safeTarget(root: string, value: string): string {
  const target = normalizeGitPath(value)
  if (!target || target.includes('\0') || isAbsolute(target) || target === '.' || target.split('/').includes('..')) throw new TypeError('Git 路径无效')
  const absolute = resolve(root, target)
  const escaped = relative(root, absolute)
  if (escaped.startsWith('..') || isAbsolute(escaped)) throw new TypeError('Git 路径超出 Workspace')
  return target
}

function normalizeGitPath(value: string): string { return value.replaceAll('\\', '/').replace(/^\.\//u, '').trim() }

function isNotGitRepositoryError(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false
  return error.commandCode === 128 && /not a git repository|not a git repository/u.test(error.stderr)
}

function isEmptyRepositoryError(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false
  return error.commandCode === 128 && /does not have any commits yet|your current branch/u.test(error.stderr)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Git RPC 参数必须是对象')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} 必须是非空字符串`)
  return value.trim()
}

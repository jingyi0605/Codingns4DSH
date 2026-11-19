import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WorkspaceMcpHandlerError } from './file-handler.js'

const execute = promisify(execFile)
const GIT_TIMEOUT_MS = 5_000
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024
const MAX_DIFF_JSON_BYTES = 4 * 1024 * 1024

export async function getWorkspaceGitStatus(root: string, signal: AbortSignal): Promise<unknown> {
  const output = await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.'], signal)
  const records = output.split('\0')
  let branch = 'HEAD'
  let tracking: string | undefined
  let ahead = 0
  let behind = 0
  const staged: string[] = []
  const unstaged: string[] = []
  const untracked: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const entry = records[index]!
    if (entry.startsWith('# branch.head ')) branch = entry.slice(14)
    else if (entry.startsWith('# branch.upstream ')) tracking = entry.slice(18)
    else if (entry.startsWith('# branch.ab ')) {
      const [plus, minus] = entry.slice(12).split(' ')
      ahead = Number(plus?.slice(1) ?? 0)
      behind = Number(minus?.slice(1) ?? 0)
    } else if (entry.startsWith('? ')) untracked.push(entry.slice(2))
    else {
      const pattern = entry[0] === '1' ? /^1 (\S{2}) (?:\S+ ){6}([\s\S]+)$/u
        : entry[0] === '2' ? /^2 (\S{2}) (?:\S+ ){7}([\s\S]+)$/u
          : /^u (\S{2}) (?:\S+ ){8}([\s\S]+)$/u
      const match = pattern.exec(entry)
      if (entry[0] === '2') index += 1 // The following record is the original rename path.
      if (match === null) continue
      const flags = match[1]!
      const path = match[2]!
      if (flags[0] !== '.') staged.push(path)
      if (flags[1] !== '.') unstaged.push(path)
    }
  }
  return { branch: branch === '(detached)' ? 'HEAD' : branch, ...(tracking === undefined ? {} : { tracking }), ahead, behind, staged, unstaged, untracked }
}

export async function getWorkspaceGitLog(root: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
  const limit = args.limit === undefined ? 10 : readInteger(args.limit, 1, 100, 'limit')
  const skip = args.skip === undefined ? 0 : readInteger(args.skip, 0, Number.MAX_SAFE_INTEGER, 'skip')
  const branch = args.branch === undefined ? undefined : readRevisionRange(args.branch)
  const output = await git(root, [
    'log', '--no-show-signature', `--max-count=${limit}`, `--skip=${skip}`,
    '-z', '--format=%H%x00%an%x00%aI%x00%s', ...(branch === undefined ? [] : ['--end-of-options', branch]), '--', '.',
  ], signal, 'WORKSPACE_MCP_BRANCH_NOT_FOUND')
  const fields = output.split('\0')
  const commits = []
  for (let index = 0; index + 3 < fields.length; index += 4) {
    commits.push({ hash: fields[index], author: fields[index + 1], date: fields[index + 2], message: fields[index + 3] })
  }
  return { commits }
}

export async function getWorkspaceGitDiff(root: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
  const path = args.path === undefined ? undefined : readRelativePath(args.path)
  const fromRef = args.fromRef === undefined ? 'HEAD' : readRef(args.fromRef, 'fromRef')
  const toRef = args.toRef === undefined ? undefined : readRef(args.toRef, 'toRef')
  const output = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--relative', '--unified=3', fromRef,
    ...(toRef === undefined ? [] : [toRef]), '--', path ?? '.'], signal)
  let filesChanged = 0
  let insertions = 0
  let deletions = 0
  let inHunk = false
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ')) { filesChanged += 1; inHunk = false }
    else if (line.startsWith('@@ ')) inHunk = true
    else if (inHunk && line.startsWith('+')) insertions += 1
    else if (inHunk && line.startsWith('-')) deletions += 1
  }
  const diff = truncateJsonString(output, MAX_DIFF_JSON_BYTES)
  return { diff, stats: { insertions, deletions, filesChanged }, truncated: diff !== output }
}

async function git(root: string, args: readonly string[], signal: AbortSignal, refError = 'WORKSPACE_MCP_INVALID_REF'): Promise<string> {
  signal.throwIfAborted()
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
    const result = await execute('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], {
      cwd: root,
      env: { ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      signal,
      windowsHide: true,
    })
    return result.stdout
  } catch (error) {
    if (signal.aborted) throw error
    const value = typeof error === 'object' && error !== null ? error as { code?: unknown; killed?: unknown; signal?: unknown } : {}
    if (value.code === 'ENOENT') throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_GIT_UNAVAILABLE', 'Git is not available on this Host.')
    if (value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_GIT_OUTPUT_TOO_LARGE', 'Git output exceeds the 10 MiB limit.')
    if (value.killed === true || value.code === 'ETIMEDOUT') throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_GIT_TIMEOUT', 'Git operation exceeded the 5 second time limit.')
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : ''
    if (/not a git repository/iu.test(stderr)) throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_NOT_A_GIT_REPO', 'The managed workspace is not a Git repository.')
    if (/unknown revision|bad revision|ambiguous argument|bad object/iu.test(stderr)) throw new WorkspaceMcpHandlerError(refError, 'The requested Git revision was not found.')
    throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_GIT_ERROR', 'Git could not complete the requested read operation.')
  }
}

function readRevisionRange(value: unknown): string {
  if (typeof value !== 'string') return readRef(value, 'branch')
  const range = /^(.+?)(\.{2,3})([^.].*)$/u.exec(value)
  return range === null ? readRef(value, 'branch') : `${readRef(range[1], 'branch')}${range[2]}${readRef(range[3], 'branch')}`
}

function readRef(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 256 || !(/^[A-Za-z0-9][A-Za-z0-9._/-]*(?:[~^][0-9]*)*$/u.test(value)) || value.includes('..') || value.endsWith('/') || value.includes('//')) {
    throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_REF', `${name} is not a valid Git revision.`)
  }
  return value
}

function readRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_PATH', 'The path must stay inside the managed workspace.')
  }
  const path = value.replaceAll('\\', '/')
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.split('/').includes('..')) {
    throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_PATH', 'The path must stay inside the managed workspace.')
  }
  return path
}

function readInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_INPUT', `${name} is outside its allowed range.`)
  }
  return value
}

function truncateJsonString(value: string, maximum: number): string {
  const size = (text: string) => Buffer.byteLength(JSON.stringify(text), 'utf8')
  if (size(value) <= maximum) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (size(value.slice(0, middle)) <= maximum - 3) low = middle
    else high = middle - 1
  }
  return `${value.slice(0, low).replace(/[\uD800-\uDBFF]$/u, '')}...`
}

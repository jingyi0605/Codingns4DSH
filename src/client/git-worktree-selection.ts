import type { GitWorktreeItem } from '../shared/contracts/git.js'

/**
 * 统一路径写法后再比较：分隔符、末尾斜杠，以及 macOS 上 `/var` 与 `/private/var` 指向同一目录的差异。
 * 只做字符串处理，不访问文件系统。
 */
function normalizePath(value: string): string {
  const unified = value.trim().replaceAll('\\', '/')
  const withoutPrivate = unified.startsWith('/private/') ? unified.slice('/private'.length) : unified
  return withoutPrivate.length > 1 ? withoutPrivate.replace(/\/+$/u, '') : withoutPrivate
}

function isWithin(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(parent === '/' ? '/' : `${parent}/`)
}

/**
 * 按会话的当前目录选出对应的检出目录。
 *
 * linked worktree 常放在主检出之内（例如 `<repo>/.agents/worktrees/x`），所以要选包含该目录的
 * 最深一项，即路径最长的前缀匹配。目录不在任何检出之内时返回 undefined。
 */
export function selectWorktreeForDirectory(worktrees: readonly GitWorktreeItem[], directory: string | undefined): GitWorktreeItem | undefined {
  if (directory === undefined || directory.trim() === '') return undefined
  const target = normalizePath(directory)
  let best: GitWorktreeItem | undefined
  let bestLength = -1
  for (const item of worktrees) {
    const path = normalizePath(item.path)
    if (path.length > bestLength && isWithin(target, path)) { best = item; bestLength = path.length }
  }
  return best
}

/** 同一个检出目录（忽略写法差异）。 */
export function isSameWorktreePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

/** 系统判断会话所在检出的两条线索。 */
export interface WorktreeFollow {
  /** 会话的当前目录（DSH 的 workingDirectory 投影）。 */
  readonly directory: string | undefined
  /** 由会话最近写入的文件推断出的检出路径；没有依据时为 null。 */
  readonly inferredPath: string | null
}

/**
 * 自动推荐的检出。
 *
 * 会话目录落在 linked worktree 里是 DSH 明确记录的事实，直接采用。
 * 会话目录在主检出（或不在任何检出）时，再看写入路径：外部 Agent 常把 worktree 建在仓库外面，
 * 并不会更新会话目录，写入的文件才是它实际所在的位置。
 */
export function recommendWorktree(worktrees: readonly GitWorktreeItem[], follow: WorktreeFollow): GitWorktreeItem | undefined {
  const byDirectory = selectWorktreeForDirectory(worktrees, follow.directory)
  if (byDirectory !== undefined && !byDirectory.main) return byDirectory
  const inferred = follow.inferredPath === null ? undefined : worktrees.find((item) => isSameWorktreePath(item.path, follow.inferredPath as string))
  return inferred ?? byDirectory
}

/** 推荐依据的指纹；任何一条线索变化，用户的手动选择就作废。 */
export function followKey(follow: WorktreeFollow): string {
  return `${follow.directory ?? ''}\u0000${follow.inferredPath ?? ''}`
}

/** 用户在下拉框里手动选的检出目录；只对选择时的推荐依据有效。 */
export interface ManualWorktreeChoice {
  readonly path: string
  readonly forKey: string
}

/**
 * 面板最终显示的检出目录：手动选择优先，但推荐依据一变就作废，重新跟随会话。
 * 手动选择的目录已不在列表里（例如被删除）时同样作废。
 */
export function pickWorktree(
  worktrees: readonly GitWorktreeItem[],
  follow: WorktreeFollow,
  manual: ManualWorktreeChoice | null,
): GitWorktreeItem | undefined {
  if (manual !== null && manual.forKey === followKey(follow)) {
    const chosen = worktrees.find((item) => isSameWorktreePath(item.path, manual.path))
    if (chosen !== undefined) return chosen
  }
  return recommendWorktree(worktrees, follow)
}

/** 请求里携带的 worktreePath；主检出不带，Host 直接用工作区目录，缓存键和旧版一致。 */
export function worktreeRequestPath(item: GitWorktreeItem | undefined): string | undefined {
  return item === undefined || item.main ? undefined : item.path
}

export function sameWorktreeList(left: readonly GitWorktreeItem[], right: readonly GitWorktreeItem[]): boolean {
  return left.length === right.length && left.every((item, index) => item.path === right[index]?.path && item.branch === right[index]?.branch && item.main === right[index]?.main)
}

/**
 * 分支下拉框的一个选项。
 *
 * 一个下拉框同时表达「分支」和「检出目录」：被某个检出占用的分支，选中它就是切换到那个检出
 * （不执行 `git switch`，一个分支同一时刻只能被一个检出占用）；其余本地分支才是真正的分支切换。
 */
export interface BranchOption {
  /** 下拉框的 value；检出用 `worktree:<path>`，普通分支用 `branch:<name>`。 */
  readonly value: string
  readonly kind: 'worktree' | 'branch'
  readonly name: string
  /** 仅检出选项有值：对应的检出目录。 */
  readonly worktree?: GitWorktreeItem
  /** 该选项是会话当前目录自动推荐的检出，名称后要带「自动」标签。 */
  readonly auto: boolean
}

const WORKTREE_PREFIX = 'worktree:'
const BRANCH_PREFIX = 'branch:'

/** 检出目录选项的 value。 */
export function worktreeOptionValue(item: GitWorktreeItem): string { return `${WORKTREE_PREFIX}${item.path}` }
/** 普通分支选项的 value。 */
export function branchOptionValue(name: string): string { return `${BRANCH_PREFIX}${name}` }

/** 把选项里的 value 还原成动作；格式不符返回 undefined。 */
export function parseBranchOptionValue(value: string): { readonly kind: 'worktree' | 'branch'; readonly key: string } | undefined {
  if (value.startsWith(WORKTREE_PREFIX)) return { kind: 'worktree', key: value.slice(WORKTREE_PREFIX.length) }
  if (value.startsWith(BRANCH_PREFIX)) return { kind: 'branch', key: value.slice(BRANCH_PREFIX.length) }
  return undefined
}

/**
 * 生成分支下拉框的全部选项。
 *
 * - 只有主检出时（`worktrees.length <= 1`）与旧版完全一致：每个本地分支一项，没有「自动」标签。
 * - 有多个检出时：先列出每个检出（主检出 + linked worktree，游离 HEAD 的检出也在内），
 *   再列出没有被任何检出占用的本地分支。
 * - `followed` 是按会话目录自动推荐的检出；它对应的选项带 `auto`。用户手动选了别的检出后，
 *   推荐项仍然保留标签，所以用户能看出「系统本来推荐的是哪一个」。
 */
export function buildBranchOptions(
  localBranches: readonly string[],
  worktrees: readonly GitWorktreeItem[],
  followed: GitWorktreeItem | undefined,
): readonly BranchOption[] {
  if (worktrees.length <= 1) {
    return localBranches.map((name) => ({ value: branchOptionValue(name), kind: 'branch' as const, name, auto: false }))
  }
  const occupied = new Set(worktrees.flatMap((item) => (item.branch === null ? [] : [item.branch])))
  return [
    ...worktrees.map((item): BranchOption => ({
      value: worktreeOptionValue(item),
      kind: 'worktree',
      name: item.branch ?? '',
      worktree: item,
      auto: followed !== undefined && isSameWorktreePath(item.path, followed.path),
    })),
    ...localBranches.filter((name) => !occupied.has(name)).map((name): BranchOption => ({ value: branchOptionValue(name), kind: 'branch', name, auto: false })),
  ]
}

/**
 * 下拉框的分组。
 *
 * 检出目录只是换面板查看的位置，不改动任何检出；空闲分支才会对当前检出执行 `git switch`。
 * 两者混在一起看起来都是「切换」，所以有多个检出时分成两组，由调用方用 optgroup 展示。
 * 只有一个检出时不分组（和旧版一致）。
 */
export interface BranchOptionGroup {
  /** 分组标识；null 表示不分组、直接平铺。 */
  readonly kind: 'worktree' | 'branch' | null
  readonly options: readonly BranchOption[]
}

export function groupBranchOptions(options: readonly BranchOption[]): readonly BranchOptionGroup[] {
  const worktrees = options.filter((option) => option.kind === 'worktree')
  if (worktrees.length === 0) return [{ kind: null, options }]
  const branches = options.filter((option) => option.kind === 'branch')
  return [{ kind: 'worktree', options: worktrees }, ...(branches.length === 0 ? [] : [{ kind: 'branch' as const, options: branches }])]
}

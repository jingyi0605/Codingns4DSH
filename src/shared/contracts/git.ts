/** Git 工作区面板在 Host 与 Client 之间传输的稳定契约。 */

export interface GitRepoSnapshot {
  readonly workspaceId: string
  readonly repoRoot: string
  /** 当前工作区是否已经初始化为 Git 仓库；旧 Host 未提供时按 true 兼容。 */
  readonly enabled?: boolean
  readonly branch: string
  readonly ahead: number
  readonly behind: number
  readonly hasRemote: boolean
  readonly isDirty: boolean
  readonly lastFetchedAt: string | null
}

export interface GitChangeItem {
  readonly path: string
  readonly status: string
  readonly staged: boolean
  readonly oldPath: string | null
  readonly binary: boolean
  readonly stagedStatus: string | null
  readonly worktreeStatus: string | null
}

export interface GitStatus {
  readonly snapshot: GitRepoSnapshot
  readonly changes: readonly GitChangeItem[]
}

export interface GitDiff {
  readonly workspaceId: string
  readonly path: string
  readonly staged: boolean
  readonly binary: boolean
  readonly truncated: boolean
  readonly content: string
}

export interface GitHistoryItem {
  readonly commitHash: string
  readonly authorName: string
  readonly authoredAt: string
  readonly subject: string
  readonly body: string
  readonly refs: readonly GitHistoryRef[]
  /** 父提交哈希；旧 Host 未提供时 Client 退化为线性轨道，不绘制分支/合并连线。 */
  readonly parents?: readonly string[]
  /** 提交相对当前分支与远程分支的归属；旧 Host 未提供或仓库过大时省略。 */
  readonly origin?: GitHistoryOrigin
}

export interface GitHistoryRef {
  readonly name: string
  readonly kind: 'head' | 'local' | 'remote' | 'tag'
  readonly remoteName: string | null
}

/** 版本历史的取值范围：仅当前分支，或全部本地分支与远程跟踪分支。 */
export type GitHistoryScope = 'head' | 'all'

/**
 * 提交归属：
 * - `local`：只在本机分支上，没有任何远程跟踪分支包含它（未推送）；
 * - `synced`：当前分支与至少一个远程跟踪分支都包含它；
 * - `remote`：只有远程跟踪分支包含它（本地还没有，例如拉取前）；
 * - `branch`：只有其他本地分支包含它，当前分支与远程都没有。
 */
export type GitHistoryOrigin = 'local' | 'synced' | 'remote' | 'branch'

export interface GitHistoryPage {
  readonly items: readonly GitHistoryItem[]
  readonly cursor: string | null
  readonly nextCursor: string | null
  readonly totalCount: number
}

export interface GitBranchItem {
  readonly name: string
  readonly current: boolean
  readonly upstream: string | null
  readonly remote: boolean
}

export interface GitBranchSnapshot {
  readonly currentBranch: string
  readonly local: readonly GitBranchItem[]
  readonly remote: readonly GitBranchItem[]
}

export interface GitCommitResult {
  readonly commitHash: string
  readonly summary: string
}

export interface GitCommitChangedFile {
  readonly path: string
  readonly oldPath: string | null
  readonly status: string
  readonly binary: boolean
}

export interface GitCommitDiff {
  readonly commitHash: string
  /** 旧版 Host 未提供时由 Client 从 diff 头部回退解析。 */
  readonly files?: readonly GitCommitChangedFile[]
  readonly content: string
  readonly truncated: boolean
}

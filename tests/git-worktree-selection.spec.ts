import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBranchOptions, parseBranchOptionValue, pickWorktree, selectWorktreeForDirectory, worktreeRequestPath } from '../data/build/dist/client/git-worktree-selection.js'

const main = { path: '/code/repo', branch: 'main', main: true }
const linked = { path: '/code/repo/.agents/worktrees/feature', branch: 'feature', main: false }
const outer = { path: '/code/repo.worktrees/hotfix', branch: 'hotfix', main: false }
const worktrees = [main, linked, outer]

test('会话目录在 worktree 内部时选中最深的检出，而不是外层主检出', () => {
  assert.equal(selectWorktreeForDirectory(worktrees, '/code/repo/.agents/worktrees/feature'), linked)
  assert.equal(selectWorktreeForDirectory(worktrees, '/code/repo/.agents/worktrees/feature/src'), linked)
  assert.equal(selectWorktreeForDirectory(worktrees, '/code/repo/src'), main)
})

test('目录前缀必须在路径边界上匹配，同名前缀的兄弟目录不算', () => {
  assert.equal(selectWorktreeForDirectory(worktrees, '/code/repo.worktrees/hotfix/a'), outer)
  assert.equal(selectWorktreeForDirectory([main], '/code/repo-other'), undefined)
  assert.equal(selectWorktreeForDirectory(worktrees, '/elsewhere'), undefined)
})

test('/private 前缀和末尾斜杠不影响匹配', () => {
  const tmp = { path: '/var/folders/x/repo', branch: 'main', main: true }
  assert.equal(selectWorktreeForDirectory([tmp], '/private/var/folders/x/repo/'), tmp)
  const privateForm = { ...tmp, path: '/private/var/folders/x/repo' }
  assert.equal(selectWorktreeForDirectory([privateForm], '/var/folders/x/repo'), privateForm)
})

test('没有会话目录时不选择任何检出', () => {
  assert.equal(selectWorktreeForDirectory(worktrees, undefined), undefined)
  assert.equal(selectWorktreeForDirectory(worktrees, '  '), undefined)
})

test('手动选择只在会话目录不变时生效，目录变化后重新跟随会话', () => {
  const manual = { path: main.path, forDirectory: linked.path }
  assert.equal(pickWorktree(worktrees, linked.path, manual), main)
  assert.equal(pickWorktree(worktrees, outer.path, manual), outer)
  assert.equal(pickWorktree(worktrees, linked.path, null), linked)
})

test('手动选择的检出已被删除时回退到会话所在的检出', () => {
  assert.equal(pickWorktree([main], '/code/repo/src', { path: linked.path, forDirectory: '/code/repo/src' }), main)
})

test('主检出不带 worktreePath，linked worktree 才带', () => {
  assert.equal(worktreeRequestPath(main), undefined)
  assert.equal(worktreeRequestPath(undefined), undefined)
  assert.equal(worktreeRequestPath(linked), linked.path)
})

test("只有主检出时分支下拉框与旧版一致，没有自动标签", () => {
  const options = buildBranchOptions(["main", "dev"], [main], main)
  assert.deepEqual(options.map((option) => [option.kind, option.name, option.auto]), [["branch", "main", false], ["branch", "dev", false]])
  assert.deepEqual(buildBranchOptions(["main"], [], undefined).map((option) => option.kind), ["branch"])
})

test("有多个检出时先列检出，再列没有被占用的分支，自动推荐的检出带标签", () => {
  const options = buildBranchOptions(["main", "feature", "hotfix", "idle"], worktrees, linked)
  assert.deepEqual(options.map((option) => [option.kind, option.name, option.auto]), [
    ["worktree", "main", false], ["worktree", "feature", true], ["worktree", "hotfix", false],
    ["branch", "idle", false],
  ])
})

test("手动选了别的检出时，系统推荐的那一项仍然保留自动标签", () => {
  const options = buildBranchOptions(["main", "feature"], worktrees, linked)
  assert.equal(options.filter((option) => option.auto).length, 1)
  assert.equal(options.find((option) => option.auto)?.worktree, linked)
})

test("会话目录不在任何检出里时没有选项带自动标签", () => {
  assert.equal(buildBranchOptions(["main", "feature"], worktrees, undefined).some((option) => option.auto), false)
})

test("游离 HEAD 的检出也能选，且不会占用任何分支名", () => {
  const detached = { path: "/code/repo/.agents/worktrees/tmp", branch: null, main: false }
  const options = buildBranchOptions(["main", "feature"], [main, detached], detached)
  assert.deepEqual(options.map((option) => [option.kind, option.name, option.auto]), [["worktree", "main", false], ["worktree", "", true], ["branch", "feature", false]])
})

test("选项 value 能还原成动作，路径里带冒号也不会被截断", () => {
  const [first, second] = buildBranchOptions(["idle"], [main, { path: "/code/a:b", branch: "x", main: false }], undefined)
  assert.deepEqual(parseBranchOptionValue(first.value), { kind: "worktree", key: "/code/repo" })
  assert.deepEqual(parseBranchOptionValue(second.value), { kind: "worktree", key: "/code/a:b" })
  assert.deepEqual(parseBranchOptionValue("branch:release/1.0"), { kind: "branch", key: "release/1.0" })
  assert.equal(parseBranchOptionValue("garbage"), undefined)
})

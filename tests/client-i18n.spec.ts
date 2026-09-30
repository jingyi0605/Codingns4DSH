import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const guard = join(root, 'scripts/check-client-i18n.mjs')

/** 运行守卫并返回 { status, stdout }；非零退出不抛异常。 */
function runGuard(args: readonly string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [guard, ...args], { cwd: root, encoding: 'utf8' })
    return { status: 0, stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string }
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '' }
  }
}

test('前端文案国际化守卫：当前工作区没有硬编码用户可见文案', () => {
  const result = runGuard([])
  assert.equal(result.status, 0, `国际化守卫未通过：\n${result.stdout}`)
})

test('前端文案国际化守卫：词典无重复键且 en/zh 键集合一致', () => {
  const result = runGuard(['--json'])
  assert.equal(result.status, 0, `国际化守卫未通过：\n${result.stdout}`)
  const report = JSON.parse(result.stdout) as {
    summary: { dictionaryEn: number; dictionaryZh: number; violations: number }
    blocking: Array<{ rule: string }>
    unusedAllowlist: string[]
  }
  assert.equal(report.summary.dictionaryEn, report.summary.dictionaryZh)
  assert.equal(report.summary.violations, 0)
  assert.deepEqual(report.blocking, [])
  assert.deepEqual(report.unusedAllowlist, [], 'allowlist 存在失效条目，请删除')
})

test('前端文案国际化守卫：warn-only 模式只报告不阻断', () => {
  const result = runGuard(['--warn-only', '--json'])
  assert.equal(result.status, 0)
  const report = JSON.parse(result.stdout) as { summary: { warnings: number } }
  assert.equal(typeof report.summary.warnings, 'number')
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 设置写入结果门禁。
 *
 * `settings.mutate` / `settings.set` 返回 false 或 undefined 表示 Host 没有接受这次写入。
 * 设置页、工作区子设置和终端设置都必须在发出成功提示之前拦下它，否则用户会看到
 * “已保存”，而设置实际没有生效。规范见 docs/开发规范/20260922-设置选项与表单开发规则.md。
 *
 * 这里按写入点切分源码而不是断言整份文件：同一个文件里既有成功路径也有失败路径，
 * 只有“成功提示之前存在失败守卫”才说明该写入点被正确保护。
 */

/** 被覆盖的设置写入入口；新增设置面板时应一并登记。 */
const WRITE_FILES = [
  'src/client/avatar/settings-panel.ts',
  'src/client/settings-section.ts',
  'src/client/features/workspace-session-enhancement-panel.ts',
  'src/client/features/terminal-enhancement-panel.ts',
  'src/client/features/file-management-panel.ts',
  'src/client/features/subscription-usage-panel.ts',
  'src/client/features/mobile-access-panel.ts',
  'src/client/features/cli-adapters.ts',
] as const

const WRITE_CALL = /settings\s*\.\s*(?:mutate|set)\s*\(/gu
/** 返回值为假时的守卫，例如 `if (!accepted) {`、`if (!written) {`。 */
const FALSY_GUARD = /if\s*\(\s*!(?:accepted|written)\s*\)/u
/** 三元表达式形态：`kind: accepted ? 'success' : 'error'`。 */
const TERNARY_GUARD = /accepted\s*\?\s*'success'\s*:\s*'error'/u
const SUCCESS_NOTIFY = /kind:\s*'success'/u
/** 守卫分支必须给出失败提示或抛出，不能静默继续走成功路径。 */
const FAILURE_SIGNAL = /settings\.moduleWriteRejected|terminal\.saveRejected/u

interface WriteSite {
  readonly file: string
  readonly index: number
  readonly slice: string
}

/** 找到写入调用的右括号位置，避免把后续代码算进同一个写入点。 */
function callEnd(source: string, start: number): number {
  const open = source.indexOf('(', start)
  if (open === -1) return source.length
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1
    else if (source[index] === ')') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return source.length
}

async function collectWriteSites(file: string): Promise<readonly WriteSite[]> {
  const source = await readFile(join(root, file), 'utf8')
  const starts = [...source.matchAll(WRITE_CALL)].map((match) => match.index)
  return starts.map((start, index) => ({
    file,
    index,
    slice: source.slice(callEnd(source, start), index + 1 < starts.length ? starts[index + 1] : source.length),
  }))
}

test('设置写入点在返回 false/undefined 时不得显示成功', async () => {
  const sites = (await Promise.all(WRITE_FILES.map(collectWriteSites))).flat()
  assert.ok(sites.length >= 9, `设置写入点少于预期，实际只找到 ${sites.length} 个`)

  for (const site of sites) {
    const label = `${site.file} 第 ${site.index + 1} 个写入点`
    if (!SUCCESS_NOTIFY.test(site.slice)) continue

    const guarded = FALSY_GUARD.test(site.slice) || TERNARY_GUARD.test(site.slice)
    assert.ok(guarded, `${label}：发出成功提示前没有拦截 false/undefined 写入结果`)

    if (TERNARY_GUARD.test(site.slice)) continue
    assert.ok(FAILURE_SIGNAL.test(site.slice), `${label}：失败分支没有给出可诊断的拒绝提示`)
    assert.ok(
      site.slice.search(FALSY_GUARD) < site.slice.search(SUCCESS_NOTIFY),
      `${label}：成功提示出现在失败守卫之前`,
    )
  }
})

test('设置写入点覆盖设置页、工作区子设置与终端设置', async () => {
  const sites = (await Promise.all(WRITE_FILES.map(collectWriteSites))).flat()
  const guardedFiles = new Set(sites.filter((site) => FALSY_GUARD.test(site.slice) || TERNARY_GUARD.test(site.slice)).map((site) => site.file))

  // 技能与规范点名的三类入口都必须落在门禁范围内。
  for (const file of [
    'src/client/settings-section.ts',
    'src/client/features/workspace-session-enhancement-panel.ts',
    'src/client/features/terminal-enhancement-panel.ts',
  ]) {
    assert.ok(guardedFiles.has(file), `${file} 缺少写入结果守卫`)
  }
})

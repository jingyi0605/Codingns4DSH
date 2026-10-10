import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SUPPORTED_DSH_COMPATIBILITY, SUPPORTED_DSH_VERSION } from '../data/build/dist/shared/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const matrixScript = fileURLToPath(new URL('../scripts/check-dsh-matrix.mjs', import.meta.url))

/**
 * `check:dsh-matrix` 的 Desktop runtime 分支必须按「兼容范围」判定，而不是
 * 「精确等于测试版本」。
 *
 * 背景：插件的 `engines.dsh` 声明覆盖 rc.2 到当前验证的 alpha.2，桌面端只要
 * 落在这个范围内就应通过；越过 alpha.2 的预发布版本必须重新验证后再放行。
 */
const cleanups = []
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

/** 造一个只含版本描述文件的 Desktop runtime 根。 */
function makeRuntimeRoot(version, fileName = 'runtime.json') {
  const root = mkdtempSync(join(tmpdir(), 'codingns-desktop-runtime-'))
  cleanups.push(root)
  writeFileSync(join(root, fileName), `${JSON.stringify({ desktopVersion: version })}\n`)
  return root
}

function runMatrix(runtimeRoot) {
  return spawnSync(process.execPath, [matrixScript, runtimeRoot], { encoding: 'utf8' })
}

test('Desktop runtime 落在兼容范围内时通过（兼容范围下界即当前最低支持版本）', () => {
  const result = runMatrix(makeRuntimeRoot('0.2.0-rc.2'))
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /依赖矩阵校验通过/u)
})

test('Desktop runtime 等于当前测试版本时通过', () => {
  const result = runMatrix(makeRuntimeRoot(SUPPORTED_DSH_VERSION))
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('Desktop runtime 超过当前验证版本时被拒绝', () => {
  const result = runMatrix(makeRuntimeRoot('0.2.1-beta.1'))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /不在插件兼容范围/u)
  assert.match(result.stderr, /0\.2\.1-beta\.1/u)
})

test('Desktop runtime 超出兼容范围下界时被拒绝', () => {
  const result = runMatrix(makeRuntimeRoot('0.1.7-rc.2'))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /不在插件兼容范围/u)
  assert.match(result.stderr, /0\.1\.7-rc\.2/u)
})

test('Desktop runtime 根缺少可识别描述文件时给出报告而不是崩溃', () => {
  const empty = mkdtempSync(join(tmpdir(), 'codingns-desktop-empty-'))
  cleanups.push(empty)
  const result = runMatrix(empty)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /未找到可识别的版本描述文件/u)
  // 未捕获异常会带 Node 堆栈；门禁失败只应是结构化报告。
  assert.doesNotMatch(result.stderr, /^\s+at .*node:internal/mu)
})

test('Desktop runtime 支持 node_modules 平铺布局', () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-desktop-node-modules-'))
  cleanups.push(root)
  const packageDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version: SUPPORTED_DSH_VERSION })}\n`)
  const result = runMatrix(root)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('兼容范围与 Desktop 判定共用同一事实源', () => {
  // 事实源是根目录 version.json：Desktop 判定与插件声明都从它派生。
  // 这里不再写死字面量，否则每次升级 DSH 都要手工改测试，反而制造第二个事实源。
  const versionFile = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8')) as { dshCompatibility?: string }
  assert.equal(SUPPORTED_DSH_COMPATIBILITY, versionFile.dshCompatibility)
})

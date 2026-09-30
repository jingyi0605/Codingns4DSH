import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const cleanDistScript = fileURLToPath(new URL('../scripts/clean-dist.mjs', import.meta.url))

/**
 * clean-dist 只允许清理可重建产物。
 *
 * `data/build/npm` 存放 `scripts/publish-npm-package.sh` 打出的 tarball，
 * 一旦被整目录删除，打包后任何一次 build/test（或并发 dev:watch）都会让
 * 「已生成」的产物凭空消失。
 */
test('clean-dist 清理 dist 与 h5，但保留 npm 打包目录', () => {
  const buildDir = mkdtempSync(join(tmpdir(), 'codingns-clean-dist-'))
  try {
    mkdirSync(join(buildDir, 'dist', 'client'), { recursive: true })
    writeFileSync(join(buildDir, 'dist', 'index.js'), 'export {}\n')
    mkdirSync(join(buildDir, 'h5'), { recursive: true })
    writeFileSync(join(buildDir, 'h5', 'runtime.js'), 'void 0\n')
    mkdirSync(join(buildDir, 'npm'), { recursive: true })
    const tarball = join(buildDir, 'npm', 'jingyi0605-codingns4dsh-0.0.0-test.tgz')
    writeFileSync(tarball, 'fake tarball\n')

    const result = spawnSync(process.execPath, [cleanDistScript, buildDir], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)

    assert.equal(existsSync(join(buildDir, 'dist')), false, 'dist 应被清理')
    assert.equal(existsSync(join(buildDir, 'h5')), false, 'h5 应被清理')
    assert.equal(existsSync(tarball), true, 'npm 打包目录中的 tarball 不应被清理')
  } finally {
    rmSync(buildDir, { recursive: true, force: true })
  }
})

/** 打包脚本默认输出目录必须落在 data/build/npm，且与 clean-dist 的保留范围一致。 */
test('publish-npm-package.sh 的默认输出目录位于 data/build/npm', () => {
  const script = readFileSync(fileURLToPath(new URL('../scripts/publish-npm-package.sh', import.meta.url)), 'utf8')
  assert.match(script, /NPM_PACKAGE_OUTPUT_DIR:-\$ROOT_DIR\/data\/build\/npm/u)
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('旧能力矩阵包含替代路由和未来退休版本', async () => {
  const matrix = await readFile(new URL('../src/dsh-capabilities/matrix.ts', import.meta.url), 'utf8')
  assert.match(matrix, /'no-peer-context'/u)
  assert.match(matrix, /'deprecated'/u)
  assert.match(matrix, /'0\.1\.8-0'/u)
  assert.match(matrix, /'peer-scope'/u)
})

test('能力报告和退休脚本不应写入秘密配置字段', async () => {
  const report = await readFile(new URL('../docs/生成报告/20260925-能力路由报告.md', import.meta.url), 'utf8')
  assert.doesNotMatch(report, /token|password|secret|credential/iu)
})

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const matrix = await readFile(join(root, 'src/dsh-capabilities/matrix.ts'), 'utf8')
const version = await readFile(join(root, 'version.json'), 'utf8').then(JSON.parse)
const failures = []

for (const line of matrix.split('\n')) {
  if (!line.includes("'deprecated'")) continue
  const removal = [...line.matchAll(/'([^']+)'/gu)].at(-1)?.[1]
  const block = line.trim()
  if (removal === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(removal)) continue
  if (compare(version.dshTestedVersion, removal) >= 0) {
    failures.push(`路由已达到 removableAfter=${removal}，必须先移除矩阵、代码、测试和文档引用: ${block.slice(0, 120)}`)
  }
}

if (failures.length > 0) {
  console.error(['能力退休检查失败：', ...failures.map((item) => `- ${item}`)].join('\n'))
  process.exitCode = 1
} else {
  console.log('能力退休检查通过：当前 DSH 版本没有到期的旧路由')
}

function compare(left, right) {
  const a = parse(left); const b = parse(right)
  if (!a || !b) return -1
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index]
  return String(a[3]).localeCompare(String(b[3]))
}

function parse(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''] : undefined
}

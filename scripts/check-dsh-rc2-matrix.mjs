import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const expected = '0.2.0-rc.2'
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const lockfile = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')
const failures = []

const dshDependencies = Object.entries({
  ...manifest.dependencies,
  ...manifest.devDependencies,
}).filter(([name]) => name.startsWith('@deepseek-ai/dsh'))

for (const [name, version] of dshDependencies) {
  if (version !== expected) failures.push(`${name} 声明为 ${String(version)}，必须精确固定为 ${expected}`)
  const importer = new RegExp(`^\\s{6}'?${escapeRegExp(name)}'?[\\s\\S]*?^\\s{8}specifier: ([^\\n]+)`, 'mu').exec(lockfile)
  if (importer?.[1]?.trim() !== expected) failures.push(`pnpm-lock importer 中 ${name} 为 ${importer?.[1]?.trim() ?? '缺失'}，必须为 ${expected}`)
}

if (/@deepseek-ai\/dsh[^\n]*0\.2\.0-rc\.1/u.test(lockfile)) failures.push('pnpm-lock.yaml 仍包含 DSH rc.1 依赖，ABI 矩阵不干净')
if (manifest.engines?.dsh !== '>=0.2.0-rc.2 <=0.2.0-rc.2') failures.push(`engines.dsh 不是精确 rc.2：${String(manifest.engines?.dsh)}`)
if (manifest.peerDependencies?.['@deepseek-ai/dsh'] !== '>=0.2.0-rc.2 <=0.2.0-rc.2') failures.push('peerDependencies.@deepseek-ai/dsh 不是精确 rc.2')

const runtimeRoot = process.argv[2] ?? process.env.DSH_DESKTOP_RUNTIME_ROOT
if (runtimeRoot) {
  const runtimeManifest = JSON.parse(await readFile(join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  if (runtimeManifest.version !== expected) failures.push(`Desktop runtime 的 @deepseek-ai/dsh 为 ${runtimeManifest.version}，必须为 ${expected}`)
  const runtime = JSON.parse(await readFile(join(runtimeRoot, 'desktop-runtime.json'), 'utf8'))
  if (runtime.release?.version !== expected) failures.push(`Desktop runtime release 为 ${String(runtime.release?.version)}，必须为 ${expected}`)
  const mismatches = (runtime.sharedPackages ?? []).filter((item) => item.name.startsWith('@deepseek-ai/dsh') && item.version !== expected)
  if (mismatches.length > 0) failures.push(`Desktop runtime 存在非 rc.2 DSH 包：${mismatches.map((item) => `${item.name}@${item.version}`).join(', ')}`)
}

if (failures.length > 0) {
  console.error(['DSH 0.2.0-rc.2 依赖矩阵校验失败：', ...failures.map((failure) => `- ${failure}`)].join('\n'))
  process.exit(1)
}

console.log(`DSH 0.2.0-rc.2 依赖矩阵校验通过：${dshDependencies.length} 个 DSH 依赖精确锁定`)

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\\]\\]/gu, '\\$&')
}

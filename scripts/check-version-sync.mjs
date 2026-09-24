import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const readJson = async (relativePath) => JSON.parse(await readFile(join(root, relativePath), 'utf8'))
const manifest = await readJson('package.json')
const profile = await readJson('profile/package.json')
const source = await readFile(join(root, 'src/shared/contracts/version.ts'), 'utf8')
const sourceVersion = /^export const DSH_VERSION = '([^']+)'/mu.exec(source)?.[1]
const dshVersion = manifest.engines?.dsh

const failures = []
const expectEqual = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: ${String(actual)} != ${String(expected)}`)
}

if (typeof dshVersion !== 'string' || !/^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(dshVersion)) {
  failures.push(`package.engines.dsh 不是合法 DSH 版本: ${String(dshVersion)}`)
} else {
  expectEqual('package.version', manifest.version, dshVersion)
  expectEqual('profile.version', profile.version, dshVersion)
  expectEqual('profile.engines.dsh', profile.engines?.dsh, dshVersion)
  expectEqual('profile.dependencies.dsh-codingns', profile.dependencies?.['dsh-codingns'], dshVersion)
  expectEqual('src/shared/contracts/version.ts', sourceVersion, dshVersion)
  for (const sectionName of ['dependencies', 'devDependencies']) {
    const section = manifest[sectionName] ?? {}
    for (const [name, version] of Object.entries(section)) {
      if (name.startsWith('@deepseek-ai/dsh-')) expectEqual(`${sectionName}.${name}`, version, dshVersion)
    }
  }
}

if (failures.length > 0) {
  console.error(['DSH/CodingNS 版本未同步：', ...failures.map(item => `- ${item}`)].join('\n'))
  process.exitCode = 1
} else {
  console.log(`DSH/CodingNS 版本一致: ${dshVersion}`)
}

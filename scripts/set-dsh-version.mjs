import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const nextVersion = process.argv[2]?.trim()
if (!nextVersion || !/^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(nextVersion)) {
  throw new Error('用法: pnpm run version:set-dsh -- 0.1.7-rc.1')
}

const root = fileURLToPath(new URL('../', import.meta.url))
const readJson = async relativePath => JSON.parse(await readFile(join(root, relativePath), 'utf8'))
const writeJson = async (relativePath, value) => {
  await writeFile(join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`)
}

const manifest = await readJson('package.json')
const previousVersion = manifest.engines?.dsh
manifest.version = nextVersion
manifest.engines.dsh = nextVersion
for (const sectionName of ['dependencies', 'devDependencies']) {
  const section = manifest[sectionName] ?? {}
  for (const name of Object.keys(section)) {
    if (name.startsWith('@deepseek-ai/dsh-')) section[name] = nextVersion
  }
}
await writeJson('package.json', manifest)

const profile = await readJson('profile/package.json')
profile.version = nextVersion
profile.engines.dsh = nextVersion
profile.dependencies['dsh-codingns'] = nextVersion
await writeJson('profile/package.json', profile)

const versionPath = join(root, 'src/shared/contracts/version.ts')
const source = await readFile(versionPath, 'utf8')
const updated = source.replace(/^(export const DSH_VERSION = ')[^']+(' as const)$/mu, `$1${nextVersion}$2`)
if (updated === source) throw new Error('没有找到 src/shared/contracts/version.ts 中的 DSH_VERSION')
await writeFile(versionPath, updated)

for (const relativePath of ['README.md', 'profile/README.md']) {
  const documentPath = join(root, relativePath)
  const document = await readFile(documentPath, 'utf8')
  if (typeof previousVersion === 'string' && previousVersion !== nextVersion) {
    await writeFile(documentPath, document.replaceAll(previousVersion, nextVersion))
  }
}

console.log(`已将 CodingNS 与 DSH 版本切换为 ${nextVersion}`)
console.log('请随后运行 pnpm install --lockfile-only 和 pnpm run version:check')

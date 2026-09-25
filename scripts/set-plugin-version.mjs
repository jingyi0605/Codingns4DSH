import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const nextVersion = process.argv[2]?.trim()
if (!nextVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(nextVersion)) {
  throw new Error('用法: pnpm run version:set-plugin -- 0.1.1')
}

const root = fileURLToPath(new URL('../', import.meta.url))
const readJson = async (relativePath) => JSON.parse(await readFile(join(root, relativePath), 'utf8'))
const writeJson = async (relativePath, value) => {
  await writeFile(join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`)
}

const versionFile = await readJson('version.json')
const previousVersion = versionFile.pluginVersion
versionFile.pluginVersion = nextVersion
await writeJson('version.json', versionFile)

const manifest = await readJson('package.json')
manifest.version = nextVersion
await writeJson('package.json', manifest)

const profile = await readJson('profile/package.json')
profile.version = nextVersion
profile.dependencies['dsh-codingns'] = nextVersion
await writeJson('profile/package.json', profile)
const profileVersion = await readJson('profile/version.json')
profileVersion.pluginVersion = nextVersion
await writeJson('profile/version.json', profileVersion)

const versionPath = join(root, 'src/shared/contracts/version.ts')
const source = await readFile(versionPath, 'utf8')
const updated = source.replace(/^(export const CODINGNS_VERSION = ')[^']+(' as const)$/mu, `$1${nextVersion}$2`)
if (updated === source) throw new Error('没有找到 CODINGNS_VERSION')
await writeFile(versionPath, updated)

for (const relativePath of ['README.md', 'README.en.md', 'profile/README.md']) {
  const documentPath = join(root, relativePath)
  const document = await readFile(documentPath, 'utf8')
  if (typeof previousVersion === 'string' && previousVersion !== nextVersion) {
    const updatedDocument = document
      .replaceAll(`dsh-codingns@${previousVersion}`, `dsh-codingns@${nextVersion}`)
      .replaceAll(`v${previousVersion}`, `v${nextVersion}`)
      .replaceAll(`插件版本为 \`${previousVersion}\``, `插件版本为 \`${nextVersion}\``)
      .replaceAll(`当前插件版本为 \`${previousVersion}\``, `当前插件版本为 \`${nextVersion}\``)
    if (updatedDocument !== document) await writeFile(documentPath, updatedDocument)
  }
}

console.log(`已将 CodingNS 插件版本切换为 ${nextVersion}`)
console.log('请随后运行 pnpm run version:check')

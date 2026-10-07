import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
const profileName = process.argv[2] ?? 'stage0'
const explicitDshHome = process.env.DSH_HOME?.trim()
const defaultDshHome = profileName === 'stage0'
  ? process.env.DSH_STAGE0_HOME?.trim() || join(homedir(), '.dsh-stage0-020')
  : join(homedir(), '.dsh')

// stage0 是源码开发入口，不能把仓库链接进 Desktop 共用的 ~/.dsh。
// 允许测试或其他隔离环境传入自定义 DSH_HOME，但明确拒绝 Desktop 默认根，
// 这样即使用户忘记设置 DSH_STAGE0_HOME，也不会污染桌面 Profile。
if (profileName === 'stage0' && explicitDshHome !== undefined &&
  resolve(explicitDshHome) === resolve(join(homedir(), '.dsh'))) {
  throw new Error('拒绝把 stage0 源码链接到 Desktop DSH_HOME（~/.dsh）；请使用 DSH_STAGE0_HOME 或 ~/.dsh-stage0-020')
}

const configuredDshHome = explicitDshHome || defaultDshHome
const profileRoot = join(configuredDshHome, 'profiles', profileName)
const target = join(profileRoot, 'node_modules', packageManifest.name)

if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(profileName)) {
  throw new Error(`Profile 名称非法: ${profileName}`)
}
if (!existsSync(join(profileRoot, 'package.json'))) {
  throw new Error(`找不到 DSH Profile: ${profileRoot}`)
}
if (!existsSync(join(profileRoot, 'node_modules'))) mkdirSync(join(profileRoot, 'node_modules'), { recursive: true })
if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true })

if (existsSync(target)) {
  const current = lstatSync(target).isSymbolicLink() ? realpathSync(target) : undefined
  if (current === repositoryRoot) {
    console.log(`已链接 ${target} -> ${repositoryRoot}`)
    process.exit(0)
  }
  const backup = `${target}.bak-dev-${timestamp()}`
  renameSync(target, backup)
  console.log(`已保留原插件目录: ${backup}`)
}

symlinkSync(repositoryRoot, target, process.platform === 'win32' ? 'junction' : 'dir')
console.log(`开发链接已创建: ${target} -> ${repositoryRoot}`)
console.log(profileName === 'stage0'
  ? '以后运行 dsh-stage0 或 pnpm run dsh:stage0 即可自动编译并重载，无需另开 dev:watch 或重新安装插件。'
  : '以后只需保持 pnpm dev:watch 运行并重启 DSH，无需重新安装插件。')

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)
}

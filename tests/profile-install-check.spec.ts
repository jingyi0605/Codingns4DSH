import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SUPPORTED_DSH_VERSION } from '../data/build/dist/shared/index.js'

const sourceScript = fileURLToPath(new URL('../profile/scripts/check-dsh-install.mjs', import.meta.url))
const sourceManifest = fileURLToPath(new URL('../profile/package.json', import.meta.url))

/** 版本号里的 `.` 在正则中是通配符，直接拼进 RegExp 会误匹配，必须先转义。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * 把安装期检查脚本复制到临时 Profile 中运行。
 *
 * 必须隔离：仓库内的 profile/ 能沿 node_modules 向上解析到 devDependency
 * 的 @deepseek-ai/dsh，那会命中 module 分支，掩盖 PATH 回退路径的真实行为。
 */
function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'codingns-profile-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'package.json'), readFileSync(sourceManifest, 'utf8'))
  writeFileSync(join(root, 'scripts', 'check-dsh-install.mjs'), readFileSync(sourceScript, 'utf8'))
  return root
}

/** 造一个只含 @deepseek-ai/dsh 清单的假 Runtime 根，供 process.resourcesPath 探测。 */
function makeFakeResources(version) {
  const resources = mkdtempSync(join(tmpdir(), 'codingns-resources-'))
  const packageDir = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  return resources
}

/** 清除运行时版本来源和宿主 PATH，不能探测开发机上的真实 dsh。 */
function scrubbedEnv() {
  return { ...process.env, DSH_RUNTIME_VERSION: undefined, DSH_VERSION: undefined, DSH_HOME: undefined, PATH: '' }
}

/**
 * 仅在隔离子进程中模拟版本命令的返回值，脚本的版本解析和安装判定仍真实执行。
 * 全量测试并发时，临时可执行文件的首次启动可能超过生产探测的 2 秒上限；
 * 测试不应因此从「旧版本提示」随机变成「未检测到运行时」，也不应放宽生产超时。
 */
function runSandbox(sandbox, { env, resourcesPath, commandResult }) {
  const script = join(sandbox, 'scripts', 'check-dsh-install.mjs')
  if (resourcesPath === undefined && commandResult === undefined) return spawnSync(process.execPath, [script], { encoding: 'utf8', env })
  const runner = join(sandbox, 'runner.mjs')
  const setup = []
  if (resourcesPath !== undefined) setup.push(`process.resourcesPath = ${JSON.stringify(resourcesPath)}`)
  if (commandResult !== undefined) setup.push(`
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
childProcess.spawnSync = (command, args) => {
  assert.equal(command, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  assert.deepEqual(args, ['--version'])
  return ${JSON.stringify(commandResult)}
}
syncBuiltinESMExports()
`)
  setup.push(`await import(${JSON.stringify(pathToFileURL(script).href)})`)
  writeFileSync(runner, `${setup.join('\n')}\n`)
  return spawnSync(process.execPath, [runner], { encoding: 'utf8', env })
}

const cleanups = []
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

test('Profile 安装检查接受当前测试 DSH 版本的兼容范围', () => {
  const sandbox = makeSandbox()
  cleanups.push(sandbox)
  const result = runSandbox(sandbox, { env: { ...scrubbedEnv(), DSH_RUNTIME_VERSION: SUPPORTED_DSH_VERSION, PATH: '' } })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, new RegExp(`DSH ${escapeRegExp(SUPPORTED_DSH_VERSION)}（来源 env）`, 'u'))
})

test('Profile 安装检查接受范围内更早的 0.2 世代版本', () => {
  // 兼容范围覆盖 rc.2：已发布的旧环境不能因为插件升级而被拒绝安装。
  const sandbox = makeSandbox()
  cleanups.push(sandbox)
  const result = runSandbox(sandbox, { env: { ...scrubbedEnv(), DSH_RUNTIME_VERSION: '0.2.0-rc.2', PATH: '' } })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /DSH 0\.2\.0-rc\.2（来源 env）/u)
})

test('Profile 安装检查仍拒绝兼容范围下界之前的 DSH', () => {
  const sandbox = makeSandbox()
  cleanups.push(sandbox)
  const result = runSandbox(sandbox, { env: { ...scrubbedEnv(), DSH_RUNTIME_VERSION: '0.1.7-rc.2', PATH: '' } })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /不在 Profile 支持范围/u)
  assert.match(`${result.stdout}\n${result.stderr}`, /版本来源：env/u)
})

test('PATH 上的旧 dsh 不再阻断安装，只作为提示', () => {
  const sandbox = makeSandbox()
  cleanups.push(sandbox)
  const result = runSandbox(sandbox, {
    env: scrubbedEnv(),
    commandResult: { status: 0, stdout: '0.1.7-rc.2\n', stderr: '' },
  })
  assert.equal(result.status, 0, `PATH 旧 dsh 不应阻断安装：\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /PATH 上的 dsh 0\.1\.7-rc\.2 不在/u)
  assert.match(result.stderr, /已跳过阻断/u)
})

test('PATH 上的兼容 dsh 仍只作为提示，不能证明当前运行时兼容', () => {
  const sandbox = makeSandbox()
  cleanups.push(sandbox)
  const result = runSandbox(sandbox, {
    env: scrubbedEnv(),
    commandResult: { status: 0, stdout: `${SUPPORTED_DSH_VERSION}\n`, stderr: '' },
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, new RegExp(`PATH 上的 dsh ${escapeRegExp(SUPPORTED_DSH_VERSION)} 在`, 'u'))
  assert.match(result.stderr, /已跳过阻断/u)
  assert.doesNotMatch(result.stdout, /安装期版本检查通过/u)
})

test('PATH 版本探测超时不阻断安装，保留运行期再次校验提示', () => {
  const sandbox = makeSandbox()
  cleanups.push(sandbox)
  const result = runSandbox(sandbox, {
    env: scrubbedEnv(),
    commandResult: { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } },
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /未检测到当前 DSH 运行时/u)
  assert.match(result.stderr, /运行期仍会再次校验/u)
  assert.doesNotMatch(result.stdout, /安装期版本检查通过/u)
})

test('Runtime 根探测优先于 PATH，并识别真实 DSH 版本', () => {
  const sandbox = makeSandbox()
  const resources = makeFakeResources(SUPPORTED_DSH_VERSION)
  cleanups.push(sandbox, resources)
  const result = runSandbox(sandbox, {
    env: scrubbedEnv(),
    resourcesPath: resources,
    commandResult: { status: 0, stdout: '0.1.7-rc.2\n', stderr: '' },
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, new RegExp(`DSH ${escapeRegExp(SUPPORTED_DSH_VERSION)}（来源 runtime）`, 'u'))
  assert.doesNotMatch(result.stderr, /已跳过阻断/u)
})

test('Runtime 根解析出的范围外版本仍然被拒绝', () => {
  const sandbox = makeSandbox()
  const resources = makeFakeResources('0.1.7-rc.2')
  cleanups.push(sandbox, resources)
  const result = runSandbox(sandbox, { env: { ...scrubbedEnv(), PATH: '' }, resourcesPath: resources })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /不在 Profile 支持范围/u)
  assert.match(`${result.stdout}\n${result.stderr}`, /版本来源：runtime/u)
})

test('Profile 的 preinstall 钩子仍指向安装期检查脚本', () => {
  const profile = JSON.parse(readFileSync(sourceManifest, 'utf8'))
  assert.equal(profile.scripts.preinstall, 'node scripts/check-dsh-install.mjs')
})

test('根包不再声明 preinstall，避免 pnpm 11 构建审批门禁阻断安装', () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  assert.equal(manifest.scripts.preinstall, undefined, 'preinstall 会让 pnpm 11 判定 requiresBuild 并要求 approve-builds')
  assert.equal(manifest.scripts['check:dsh-install'], 'node scripts/check-dsh-install.mjs')
})

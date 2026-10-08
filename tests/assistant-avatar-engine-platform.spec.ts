import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { systemTarCommand } from '../src/host/tar-archive.js'
import { assistantAvatarEngineDirectory, installAssistantAvatarEngine, readAssistantAvatarEngine, runEngineProcess } from '../src/host/avatar/engine.js'
import { createAssistantAvatarRuntimeHandler } from '../src/host/features/assistant-avatar-runtime.js'
import { ASSISTANT_AVATAR_ENGINE_ENTRY, ASSISTANT_AVATAR_ENGINE_MIN_ENTRY_BYTES, ASSISTANT_AVATAR_ENGINE_VERSION } from '../src/shared/assistant-avatar-engine.js'
import { ASSISTANT_AVATAR_RUNTIME_PATH } from '../src/shared/assistant-avatar.js'

/** 测试文件只落在仓库 data 内，每次使用独立目录，不读取或安装任何用户 Profile。 */
async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const data = fileURLToPath(new URL('../data/', import.meta.url))
  await mkdir(data, { recursive: true })
  const root = await mkdtemp(join(data, 'live2d-platform-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('Windows 系统 tar 不受 Git PATH 干扰，支持大小写环境变量、盘符和 UNC 路径', () => {
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'systemroot', 'WinDir', 'windir']) {
    for (const root of ['C:\\Windows', 'D:\\系统 目录\\Windows', '\\\\server\\共享 目录\\Windows']) {
      assert.equal(systemTarCommand('win32', { [key]: root, Path: 'C:\\Program Files\\Git\\usr\\bin' }), `${root}\\System32\\tar.exe`)
    }
  }
  assert.equal(systemTarCommand('win32', { SystemRoot: 'D:\\Windows', WINDIR: 'C:\\Windows' }), 'D:\\Windows\\System32\\tar.exe')
  for (const root of ['', 'relative', 'C:Windows']) assert.throws(() => systemTarCommand('win32', { SystemRoot: root }), /SystemRoot/u)
  assert.equal(systemTarCommand('darwin', {}), 'tar')
})

test('引擎目录按当前系统拼接，中文空格路径与显式覆盖保持原意', () => {
  const root = join(homedir(), '中文 用户', '独立 Host')
  assert.equal(assistantAvatarEngineDirectory({ DSH_HOME: root }), join(root, 'codingns4dsh', 'avatar-engine', `l2d-${ASSISTANT_AVATAR_ENGINE_VERSION}`))
  assert.equal(assistantAvatarEngineDirectory({ DSH_HOME: root, CODINGNS4DSH_AVATAR_ENGINE_DIR: join(root, '引擎 缓存') }), join(root, '引擎 缓存'))
  assert.equal(assistantAvatarEngineDirectory({ DSH_HOME: '  ', CODINGNS4DSH_AVATAR_ENGINE_DIR: '  ' }),
    join(homedir(), '.dsh', 'codingns4dsh', 'avatar-engine', `l2d-${ASSISTANT_AVATAR_ENGINE_VERSION}`))
})

test('进程参数原样传递中文、空格和 Windows 路径，不经过 shell 解释', async (t) => {
  const root = await fixture(t)
  const target = join(root, '参数 记录.json')
  const args = ['C:\\用户 目录\\引擎', '\\\\server\\共享 空间\\', '引擎 & %PATH% $HOME ; 文件']
  await runEngineProcess(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))", target, ...args], new AbortController().signal)
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), args)
})

test('真实系统 tar 在中文空格目录解压并替换损坏安装，重复安装不下载', async (t) => {
  const root = await fixture(t)
  const source = join(root, '归档 来源')
  const archive = join(root, '引擎 包.tgz')
  const entry = join(source, ASSISTANT_AVATAR_ENGINE_ENTRY)
  await mkdir(dirname(entry), { recursive: true })
  const javascript = `export function init() {}\n/*${'x'.repeat(ASSISTANT_AVATAR_ENGINE_MIN_ENTRY_BYTES)}*/`
  await writeFile(entry, javascript)
  await runEngineProcess(systemTarCommand(), ['-czf', archive, '-C', source, 'package'], new AbortController().signal)
  const directory = join(root, '中文 用户 & 目录', 'l2d 引擎')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'ready.json'), '{broken')
  await writeFile(join(directory, '旧文件'), '损坏安装')
  let downloads = 0
  const install = () => installAssistantAvatarEngine({ directory, signal: new AbortController().signal,
    download: async (_url, file) => { downloads++; await copyFile(archive, file) } })
  await install()
  assert.equal(await readAssistantAvatarEngine({ directory }), javascript)
  assert.deepEqual((await readdir(dirname(directory))).sort(), ['l2d 引擎'])
  assert.deepEqual((await readdir(directory)).sort(), ['package', 'ready.json'])
  await install(); assert.equal(downloads, 1)
})

test('解压失败保留旧目录并清理暂存，后续安装仍可重试', async (t) => {
  const root = await fixture(t)
  const directory = join(root, '原有引擎')
  await mkdir(directory)
  await writeFile(join(directory, '用户预置记录'), '保留原有文件')
  await assert.rejects(installAssistantAvatarEngine({ directory, signal: new AbortController().signal,
    download: async (_url, file) => { await writeFile(file, 'invalid gzip') } }), /解压失败/u)
  assert.equal(await readFile(join(directory, '用户预置记录'), 'utf8'), '保留原有文件')
  assert.deepEqual(await readdir(root), ['原有引擎'])
  assert.equal(await readAssistantAvatarEngine({ directory }), undefined)
})

test('解压进程取消及不存在的命令均结束等待，中文错误流保持完整', async (t) => {
  const root = await fixture(t)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 100)
  try { await assert.rejects(runEngineProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], controller.signal), /取消/u) }
  finally { clearTimeout(timer) }
  await assert.rejects(runEngineProcess(join(root, '不存在的 tar'), [], new AbortController().signal), /无法运行解压命令/u)
  const code = "const b = Buffer.from('中文解压错误'); process.stderr.write(b.subarray(0, 2)); setTimeout(() => { process.stderr.write(b.subarray(2)); process.exitCode = 1 }, 20)"
  await assert.rejects(runEngineProcess(process.execPath, ['-e', code], new AbortController().signal), /中文解压错误/u)
})

test('并发安装只下载一次，排队取消不会继续下载或解压', async (t) => {
  const root = await fixture(t)
  const directory = join(root, '引擎')
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  let downloads = 0; let extracts = 0
  const options = { directory, signal: new AbortController().signal,
    download: async () => { downloads++; started(); await gate },
    run: async (_command: string, args: readonly string[]) => {
      extracts++
      const entry = join(args[args.indexOf('-C') + 1]!, ASSISTANT_AVATAR_ENGINE_ENTRY)
      await mkdir(dirname(entry), { recursive: true }); await writeFile(entry, 'x'.repeat(ASSISTANT_AVATAR_ENGINE_MIN_ENTRY_BYTES))
    } }
  const first = installAssistantAvatarEngine(options)
  await waiting
  const controller = new AbortController()
  const cancelled = installAssistantAvatarEngine({ ...options, signal: controller.signal })
  const rejection = assert.rejects(cancelled, { name: 'AbortError' })
  const repeated = installAssistantAvatarEngine(options)
  controller.abort(); release()
  await Promise.all([first, rejection, repeated])
  assert.equal(downloads, 1); assert.equal(extracts, 1)
  assert.deepEqual(await readdir(root), ['引擎'])
})

test('真实 npm 下载、摘要校验、系统解压及 dsh-app 运行时接口闭环', {
  skip: process.env.CODINGNS_LIVE2D_NETWORK_TEST !== '1' ? '设置 CODINGNS_LIVE2D_NETWORK_TEST=1 启用真实联网验证' : false,
  timeout: 200_000,
}, async (t) => {
  const root = await fixture(t)
  const directory = join(root, '中文 空格引擎')
  const phases: string[] = []
  await installAssistantAvatarEngine({ directory, signal: AbortSignal.timeout(180_000), progress: (value) => { phases.push(value.phase) } })
  assert.ok(phases.includes('downloading')); assert.ok(phases.includes('extracting')); assert.equal(phases.at(-1), 'ready')
  const source = await readAssistantAvatarEngine({ directory })
  assert.ok(source && source.length >= ASSISTANT_AVATAR_ENGINE_MIN_ENTRY_BYTES)
  assert.match(source, /\bas init\b/u)
  const handler = createAssistantAvatarRuntimeHandler(async () => source)
  for (const origin of ['dsh-app://app', 'http://localhost']) {
    const response = await handler(new Request(`${origin}${ASSISTANT_AVATAR_RUNTIME_PATH}?v=${ASSISTANT_AVATAR_ENGINE_VERSION}`))
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /javascript/u)
    assert.equal(await response.text(), source)
  }
  await installAssistantAvatarEngine({ directory, signal: new AbortController().signal,
    download: async () => { assert.fail('就绪副本不应重复下载') } })
  assert.deepEqual(await readdir(root), ['中文 空格引擎'])
  t.diagnostic(`${process.platform}/${process.arch}，${process.version}，真实入口 ${Buffer.byteLength(source)} 字节`)
})

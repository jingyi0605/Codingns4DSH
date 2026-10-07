import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const stage0Script = fileURLToPath(new URL('../scripts/run-dsh-stage0.sh', import.meta.url))

/**
 * 建立一个只模拟 DSH 入口的启动器。它不会读取配置，也不会监听端口，
 * 只按测试要求返回退出码或给自己发送退出信号。
 */
function createFakeLauncher(root: string): string {
  const launcher = join(root, 'fake-dsh.mjs')
  writeFileSync(launcher, `
const mode = process.env.CODINGNS_TEST_FAKE_DSH_MODE
if (mode === 'exit') {
  process.exit(Number(process.env.CODINGNS_TEST_FAKE_DSH_CODE ?? '17'))
}
if (mode === 'signal') {
  process.kill(process.pid, process.env.CODINGNS_TEST_FAKE_DSH_SIGNAL ?? 'SIGTERM')
}
`, 'utf8')
  return launcher
}

/**
 * 准备 stage0 启动器需要的最小目录。写入 package.json 可以跳过首次 profile
 * 初始化，测试因此不会触发真实 DSH 的 profile 或插件安装逻辑。
 */
function createEnvironment(mode: 'exit' | 'signal', launcher: string, root: string): NodeJS.ProcessEnv {
  const home = join(root, 'dsh-home')
  mkdirSync(join(home, 'profiles', 'stage0'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'stage0', 'package.json'), '{"name":"stage0"}\n', 'utf8')
  return {
    ...process.env,
    DSH_STAGE0_LAUNCHER: launcher,
    DSH_STAGE0_HOME: home,
    CODINGNS4DSH_STAGE0_STATE_DIR: join(root, 'state'),
    DSH_STAGE0_PORT: '0',
    DSH_STAGE0_WATCH: '0',
    CODINGNS4DSH_DEBUG: 'warn',
    CODINGNS_TEST_FAKE_DSH_MODE: mode,
  }
}

function runStage0(env: NodeJS.ProcessEnv) {
  return spawnSync('/bin/bash', [stage0Script], { encoding: 'utf8', env, timeout: 10_000 })
}

test('stage0 启动器透传 DSH 退出码并输出退出诊断', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-stage0-launcher-'))
  try {
    const launcher = createFakeLauncher(root)
    const result = runStage0(createEnvironment('exit', launcher, root))
    assert.equal(result.status, 17, `${result.stdout}\n${result.stderr}`)
    assert.match(`${result.stdout}\n${result.stderr}`, /退出码\s*17|exit(?:ed)?\s*(?:with\s*)?code\s*17/iu)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stage0 启动器报告 DSH 信号退出并透传终止状态', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-stage0-signal-'))
  try {
    const launcher = createFakeLauncher(root)
    const result = runStage0(createEnvironment('signal', launcher, root))
    const output = `${result.stdout}\n${result.stderr}`
    // 直接 exec 时 spawnSync 返回 signal；shell wait/trap 实现通常返回 128+15。
    assert.ok(result.signal === 'SIGTERM' || result.status === 143, `${output}\nstatus=${String(result.status)} signal=${String(result.signal)}`)
    assert.match(output, /SIGTERM|信号\s*15|signal\s*SIGTERM|143/iu)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

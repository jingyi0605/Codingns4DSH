import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { detectRuntimeDshVersion } from '../data/build/dist/host/dsh-runtime-version.js'

async function withRuntimeArg(runtimeRoot: string, callback: () => void, hostEntry = '/tmp/dsh-desktop-host/lib/index.js'): Promise<void> {
  const originalArgv = process.argv.slice()
  const originalRuntimeVersion = process.env.DSH_RUNTIME_VERSION
  const originalDshVersion = process.env.DSH_VERSION
  try {
    delete process.env.DSH_RUNTIME_VERSION
    delete process.env.DSH_VERSION
    // Desktop 当前参数顺序为：--expose-internals、Host 入口、Runtime 根目录。
    process.argv[2] = hostEntry
    process.argv[3] = runtimeRoot
    callback()
  } finally {
    process.argv.length = 0
    process.argv.push(...originalArgv)
    if (originalRuntimeVersion === undefined) delete process.env.DSH_RUNTIME_VERSION
    else process.env.DSH_RUNTIME_VERSION = originalRuntimeVersion
    if (originalDshVersion === undefined) delete process.env.DSH_VERSION
    else process.env.DSH_VERSION = originalDshVersion
  }
}

test('Host 从 Desktop Runtime 根目录读取实际 DSH 包版本', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'codingns-dsh-runtime-'))
  try {
    const packageRoot = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }), 'utf8')
    const hostEntry = join(runtimeRoot, 'host', 'lib', 'index.js')
    await mkdir(join(runtimeRoot, 'host', 'lib'), { recursive: true })
    await writeFile(hostEntry, '', 'utf8')
    await withRuntimeArg(runtimeRoot, () => {
      assert.equal(detectRuntimeDshVersion(), '0.2.0-rc.2')
    }, hostEntry)
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true })
  }
})

test('Host 版本环境变量优先于 Desktop Runtime 参数', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'codingns-dsh-runtime-priority-'))
  try {
    await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.1.6-alpha.2' } }), 'utf8')
    await withRuntimeArg(runtimeRoot, () => {
      process.env.DSH_RUNTIME_VERSION = '0.2.0-rc.2'
      assert.equal(detectRuntimeDshVersion(), '0.2.0-rc.2')
    })
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true })
  }
})

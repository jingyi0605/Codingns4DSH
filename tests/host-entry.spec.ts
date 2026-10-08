import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../data/build/dist/host/index.js'
import { CodingNsConfigSchema } from '../data/build/dist/host/settings.js'

test('Host entry 可以加载并卸载且不创建资源', async () => {
  await assert.doesNotReject(() => apply())
})

test('Host 装配从入口 Fiber 读取配置，不读取注入子 Fiber 的空配置', async () => {
  const tasks: Promise<unknown>[] = []
  const previousVersion = process.env.DSH_RUNTIME_VERSION
  process.env.DSH_RUNTIME_VERSION = '0.2.1-alpha.1'
  try {
    const ctx = {
      fiber: { config: CodingNsConfigSchema({ modules: { terminalEnhancement: true } } as never) },
      inject(dependencies: string[], callback: (context: unknown) => Promise<void>) {
        if (!dependencies.includes('settings')) return
        tasks.push(callback({
          fiber: { config: undefined },
          settings: { describe: () => [] },
          connection: {},
          webServer: { port: 13080 },
          on: () => () => undefined,
          effect: () => undefined,
        }))
      },
    }
    await apply(ctx as unknown as Context)
    // 未提供持久目录，启用的终端必须在创建 controller 前明确报错；不会写文件或启动进程。
    await assert.rejects(tasks[0]!, /终端增强需要文件型 DSH 设置 Provider/u)
  } finally {
    if (previousVersion === undefined) delete process.env.DSH_RUNTIME_VERSION
    else process.env.DSH_RUNTIME_VERSION = previousVersion
  }
})

test('Host 重载撤销自己的会话读取包装，不覆盖后来安装的包装', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-host-hmr-'))
  const previousVersion = process.env.DSH_RUNTIME_VERSION
  process.env.DSH_RUNTIME_VERSION = '0.2.1-alpha.1'
  try {
    const directory = join(root, '_no-cwd', 'legacy')
    mkdirSync(directory, { recursive: true })
    const log = join(directory, 'session.v3.jsonl')
    const source = [
      { type: 'session', version: 3 },
      { type: 'tool/call', seq: 0, data: { callId: 'one', name: 'read', arguments: '{}', turn: 1, step: 1 } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n'
    writeFileSync(log, source)
    const original = async (id?: string) => {
      if (id === 'legacy') assert.match(readFileSync(log, 'utf8'), /assistant\/message/u, '先修复，再进入官方 open')
      return 'opened'
    }
    const persistence = { root, open: original }
    const disposers: Array<() => void> = []
    const tasks: Promise<unknown>[] = []
    const ctx = {
      inject(dependencies: string[], callback: (context: unknown) => Promise<void>) {
        if (!dependencies.includes('sessionPersistence')) return
        tasks.push(callback({
          get: (name: string) => name === 'sessionPersistence' ? persistence : undefined,
          effect(factory: () => () => void) { disposers.push(factory()) },
        }))
      },
    }
    await apply(ctx as unknown as Context)
    await Promise.all(tasks)
    assert.notEqual(persistence.open, original)
    assert.equal(readFileSync(log, 'utf8'), source, '插件启动不能全量修复历史日志')
    assert.equal(await persistence.open(), 'opened')
    assert.equal(readFileSync(log, 'utf8'), source, '未知 open 参数不能退回全量扫描')
    assert.equal(await persistence.open('legacy'), 'opened')
    disposers[0]!()
    assert.equal(persistence.open, original)

    await apply(ctx as unknown as Context)
    await Promise.all(tasks)
    const previousOpen = persistence.open
    const newer = async () => `newer:${await previousOpen()}`
    persistence.open = newer
    disposers[1]!()
    assert.equal(persistence.open, newer)
    assert.equal(await persistence.open(), 'newer:opened', '新包装仍可调用已卸载的旧层')
  } finally {
    if (previousVersion === undefined) delete process.env.DSH_RUNTIME_VERSION
    else process.env.DSH_RUNTIME_VERSION = previousVersion
    rmSync(root, { recursive: true, force: true })
  }
})

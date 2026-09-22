import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const clientBundle = join(dirname(fileURLToPath(import.meta.url)), '../dist/client/index.js')
const clientSource = join(dirname(fileURLToPath(import.meta.url)), '../src/client/index.ts')

test('Client 入口以 DSH Loader factory 格式构建', async () => {
  const source = await readFile(clientBundle, 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load/u)
  assert.match(source, /id:\s*["']dsh-codingns["']/u)
  assert.match(source, /factory:\s*\(require\)/u)
})

test('Client 构建产物不包含 Node 专属模块', async () => {
  const source = await readFile(clientBundle, 'utf8')
  for (const specifier of ['node:crypto', 'node:fs', 'node:net', 'node:child_process']) {
    assert.equal(source.includes(specifier), false, `Client 产物包含 ${specifier}`)
  }
})

test('Client 构建产物包含模块卡片、设置面板和 Host RPC 调用', async () => {
  const source = await readFile(clientBundle, 'utf8')
  for (const marker of [
    'type: "password"', 'auth/login', 'auth/logout',
    'settings.section', 'id: "codingns"', 'label: "CodingNS"', 'CodingNS 功能模块',
    'details', 'summary', 'role: "switch"', 'aria-label', 'aria-disabled', 'pointerEvents',
    'disabled: disabled || busy',
    '局域网访问', '自动补齐 crypto.randomUUID', '中转访问服务', '绑定 Host',
    'settings.subscribe(listener)', 'settings.getSnapshot()',
    'crypto', 'randomUUID',
  ]) {
    assert.equal(source.includes(marker), true, `Client 产物缺少 ${marker}`)
  }
})

test('设置页由注册表驱动：遍历模块清单并同步启停', async () => {
  const source = await readFile(clientBundle, 'utf8')
  for (const marker of [
    'settingsModules',
    'CLIENT_FEATURES',
    'settingsPanel',
    'alwaysEnabled',
    'reconcile',
    'dsh-codingns: 功能模块启停同步',
  ]) {
    assert.equal(source.includes(marker), true, `Client 产物缺少 ${marker}`)
  }
})

test('设置页不再按模块名硬编码渲染分支', async () => {
  const bundle = await readFile(clientBundle, 'utf8')
  assert.equal(/\.id\s*===\s*["']reverseProxy["']/u.test(bundle), false, '产物仍按模块 id 分支')

  const source = await readFile(clientSource, 'utf8')
  assert.equal(/module\.id\s*===/u.test(source), false, '入口仍按模块 id 分支')
  assert.equal(source.includes('CODINGNS_MODULES'), false, '入口仍维护硬编码模块清单')
})

test('Client 构建产物声明 Cordis 服务依赖', async () => {
  const source = await readFile(clientBundle, 'utf8')
  assert.match(source, /exports\.inject\s*=\s*inject/u)
})

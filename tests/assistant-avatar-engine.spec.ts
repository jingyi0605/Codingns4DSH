import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AssistantAvatarEngineDialog,
  AssistantAvatarEngineProgress,
} from '../data/build/dist/client/avatar/engine.js'
import type { AssistantAvatarEngineController } from '../data/build/dist/client/avatar/engine.js'
import {
  ASSISTANT_AVATAR_ENGINE_CONSENT_VERSION,
  ASSISTANT_AVATAR_ENGINE_ENTRY,
  ASSISTANT_AVATAR_ENGINE_MIN_ENTRY_BYTES,
  ASSISTANT_AVATAR_ENGINE_SHA512,
  ASSISTANT_AVATAR_ENGINE_VERSION,
} from '../data/build/dist/shared/assistant-avatar-engine.js'
import {
  assistantAvatarEngineDirectory,
  assistantAvatarEngineInstalled,
  installAssistantAvatarEngine,
  readAssistantAvatarEngine,
} from '../data/build/dist/host/avatar/engine.js'
import { AssistantAvatarPackages } from '../data/build/dist/host/avatar/packages.js'
import { AssistantAvatarCatalog } from '../data/build/dist/host/avatar/catalog.js'
import { AssistantAvatarTemporaryPreviews } from '../data/build/dist/host/avatar/temporary-previews.js'
import { createAssistantAvatarRuntimeFeature, readAssistantAvatarEngineStatus } from '../data/build/dist/host/features/assistant-avatar-runtime.js'
import { FeatureRegistry } from '../data/build/dist/features/index.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'

async function temporaryRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'codingns-avatar-engine-'))
}

/** 模拟解压：真实 tar 只在 -C 指定目录产出 package/ 前缀的入口文件。 */
function fakeExtract(write = true) {
  return async (_command: string, args: readonly string[]): Promise<void> => {
    if (!write) return
    const staging = args[args.indexOf('-C') + 1]!
    await mkdir(join(staging, 'package', 'dist'), { recursive: true })
    await writeFile(join(staging, ASSISTANT_AVATAR_ENGINE_ENTRY), 'x'.repeat(ASSISTANT_AVATAR_ENGINE_MIN_ENTRY_BYTES + 1))
  }
}
const fakeDownload = async (_url: string, file: string): Promise<void> => { await writeFile(file, 'engine-archive') }

test('引擎目录随 DSH_HOME 隔离，并允许显式覆盖', () => {
  assert.equal(assistantAvatarEngineDirectory({ DSH_HOME: '/tmp/dsh-home' }),
    join('/tmp/dsh-home', 'codingns4dsh', 'avatar-engine', `l2d-${ASSISTANT_AVATAR_ENGINE_VERSION}`))
  assert.equal(assistantAvatarEngineDirectory({ DSH_HOME: '/tmp/dsh-home', CODINGNS4DSH_AVATAR_ENGINE_DIR: '/tmp/engine' }), '/tmp/engine')
  assert.equal(assistantAvatarEngineDirectory({ CODINGNS4DSH_AVATAR_ENGINE_DIR: '  ', DSH_HOME: '/tmp/dsh-home' }),
    join('/tmp/dsh-home', 'codingns4dsh', 'avatar-engine', `l2d-${ASSISTANT_AVATAR_ENGINE_VERSION}`))
})

test('安装只写自有目录：校验就绪标记、原子提升并清理暂存目录', async () => {
  const root = await temporaryRoot()
  try {
    const directory = join(root, 'engine')
    await installAssistantAvatarEngine({ signal: new AbortController().signal, directory, download: fakeDownload, run: fakeExtract() })
    const source = await readAssistantAvatarEngine({ directory })
    assert.equal(source?.length, ASSISTANT_AVATAR_ENGINE_MIN_ENTRY_BYTES + 1)
    const marker = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8'))
    assert.deepEqual(marker, { version: ASSISTANT_AVATAR_ENGINE_VERSION, sha512: ASSISTANT_AVATAR_ENGINE_SHA512 })
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.prepare-')), [])
    // 已就绪时重复安装不再下载。
    let downloads = 0
    await installAssistantAvatarEngine({ signal: new AbortController().signal, directory,
      download: async (url, file) => { downloads += 1; await fakeDownload(url, file) }, run: fakeExtract() })
    assert.equal(downloads, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('解压不完整或取消都不留下伪就绪标记', async () => {
  const root = await temporaryRoot()
  try {
    const directory = join(root, 'engine')
    await assert.rejects(installAssistantAvatarEngine({ signal: new AbortController().signal, directory,
      download: fakeDownload, run: fakeExtract(false) }), /解压结果不完整/u)
    assert.equal(await assistantAvatarEngineInstalled({ directory }), false)
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.prepare-')), [])

    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(installAssistantAvatarEngine({ signal: aborted.signal, directory, download: fakeDownload, run: fakeExtract() }),
      (error: unknown) => (error as { name?: string }).name === 'AbortError')
    assert.equal(await assistantAvatarEngineInstalled({ directory }), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('就绪标记版本漂移或摘要不符时不作为已安装引擎', async () => {
  const root = await temporaryRoot()
  try {
    const directory = join(root, 'engine')
    await mkdir(join(directory, 'package', 'dist'), { recursive: true })
    await writeFile(join(directory, ASSISTANT_AVATAR_ENGINE_ENTRY), 'x'.repeat(ASSISTANT_AVATAR_ENGINE_MIN_ENTRY_BYTES + 1))
    await writeFile(join(directory, 'ready.json'), JSON.stringify({ version: '0.0.0', sha512: ASSISTANT_AVATAR_ENGINE_SHA512 }))
    assert.equal(await readAssistantAvatarEngine({ directory }), undefined)
    await writeFile(join(directory, 'ready.json'), JSON.stringify({ version: ASSISTANT_AVATAR_ENGINE_VERSION, sha512: 'wrong' }))
    assert.equal(await readAssistantAvatarEngine({ directory }), undefined)
    // 入口文件过小同样视为不完整。
    await writeFile(join(directory, 'ready.json'), JSON.stringify({ version: ASSISTANT_AVATAR_ENGINE_VERSION, sha512: ASSISTANT_AVATAR_ENGINE_SHA512 }))
    await writeFile(join(directory, ASSISTANT_AVATAR_ENGINE_ENTRY), 'small')
    assert.equal(await readAssistantAvatarEngine({ directory }), undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('默认下载校验 SHA-512，内容不匹配时拒绝安装', async () => {
  const root = await temporaryRoot()
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3, 4]))) as typeof fetch
    await assert.rejects(installAssistantAvatarEngine({ signal: new AbortController().signal, directory: join(root, 'engine'), run: fakeExtract() }),
      /完整性校验失败/u)
    assert.equal(await assistantAvatarEngineInstalled({ directory: join(root, 'engine') }), false)
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }) }
})

test('avatar/engineStatus 与 avatar/installEngine 遵守许可与只读边界', async () => {
  const root = await temporaryRoot()
  const previous = process.env.CODINGNS4DSH_AVATAR_ENGINE_DIR
  const managed = join(root, 'engine')
  try {
    await installAssistantAvatarEngine({ signal: new AbortController().signal, directory: managed, download: fakeDownload, run: fakeExtract() })
    process.env.CODINGNS4DSH_AVATAR_ENGINE_DIR = managed
    const appearance: Record<string, unknown> = { models: [], selectedId: 'codingns-default' }
    let writable = true
    let handler: ((action: string, payload: unknown, context?: unknown) => Promise<unknown>) | undefined
    const services = {
      rpc: { register: (_namespace: string, value: typeof handler) => { handler = value; return () => undefined } },
      settings: { get: () => ({ assistant: { appearance } }) },
      get settingsProvider() { return { writable } },
    } as unknown as CodingNsHostServices
    const registry = new FeatureRegistry(services)
    const catalog = new AssistantAvatarCatalog()
    registry.register(createAssistantAvatarRuntimeFeature({ packages: new AssistantAvatarPackages(join(root, 'packages')),
      catalog, temporary: new AssistantAvatarTemporaryPreviews(catalog) }))
    await registry.reconcile(['assistantAvatarRuntime'])
    try {
      assert.ok(handler !== undefined, 'feature 必须登记 avatar RPC 命名空间')
      const call = handler!
      assert.deepEqual(await call('engineStatus', {}, {}),
        { installed: true, version: ASSISTANT_AVATAR_ENGINE_VERSION, source: 'managed' })
      await assert.rejects(call('installEngine', {}, {}), /引擎许可/u)
      const engineConsent = { version: ASSISTANT_AVATAR_ENGINE_CONSENT_VERSION, acceptedAt: 1 }
      for (const invalid of [null, true, { ...engineConsent, version: 'old' }, { ...engineConsent, acceptedAt: 0 }]) {
        await assert.rejects(call('installEngine', { engineConsent: invalid }, {}), /引擎许可/u)
      }
      // 首次在草稿中确认许可时，Host 尚无已保存记录；只授权安装，不修改正式配置。
      assert.deepEqual(await call('installEngine', { engineConsent }, {}),
        { installed: true, version: ASSISTANT_AVATAR_ENGINE_VERSION, source: 'managed' })
      assert.equal(appearance.engineConsent, undefined)
      appearance.engineConsent = { version: ASSISTANT_AVATAR_ENGINE_CONSENT_VERSION, acceptedAt: 1 }
      assert.deepEqual(await call('installEngine', {}, {}),
        { installed: true, version: ASSISTANT_AVATAR_ENGINE_VERSION, source: 'managed' })
      writable = false
      await assert.rejects(call('installEngine', {}, {}), /只读/u)
      await assert.rejects(call('installEngine', { engineConsent }, {}), /只读/u)
    } finally { await registry.reconcile([]) }
  } finally {
    if (previous === undefined) delete process.env.CODINGNS4DSH_AVATAR_ENGINE_DIR
    else process.env.CODINGNS4DSH_AVATAR_ENGINE_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('Host 状态优先自有目录，其次源码开发或手工安装的依赖', async () => {  const root = await temporaryRoot()
  const previous = process.env.CODINGNS4DSH_AVATAR_ENGINE_DIR
  try {
    process.env.CODINGNS4DSH_AVATAR_ENGINE_DIR = join(root, 'missing')
    const dependency = await readAssistantAvatarEngineStatus()
    assert.equal(dependency.installed, true, '仓库开发依赖应可解析')
    assert.equal(dependency.source, 'dependency')

    const managed = join(root, 'engine')
    await installAssistantAvatarEngine({ signal: new AbortController().signal, directory: managed, download: fakeDownload, run: fakeExtract() })
    process.env.CODINGNS4DSH_AVATAR_ENGINE_DIR = managed
    const status = await readAssistantAvatarEngineStatus()
    assert.deepEqual(status, { installed: true, version: ASSISTANT_AVATAR_ENGINE_VERSION, source: 'managed' })
  } finally {
    if (previous === undefined) delete process.env.CODINGNS4DSH_AVATAR_ENGINE_DIR
    else process.env.CODINGNS4DSH_AVATAR_ENGINE_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('引擎许可对话框与安装进度按状态渲染', () => {
  const t = (key: string): string => key
  const base = {
    status: undefined, installing: false, cancelled: false, error: '', consentOpen: false, agreed: false,
    ensure: async () => false, setAgreed: () => undefined, acceptConsent: async () => undefined,
    cancelConsent: () => undefined, cancelInstall: () => undefined, retry: () => undefined,
  } as unknown as AssistantAvatarEngineController
  const render = (patch: Partial<AssistantAvatarEngineController>): string => renderToStaticMarkup(createElement('div', null,
    createElement(AssistantAvatarEngineProgress, { controller: { ...base, ...patch }, t }),
    createElement(AssistantAvatarEngineDialog, { controller: { ...base, ...patch }, t })))
  // 未安装且未确认时不渲染任何内容，避免误触发下载或设置写入。
  assert.equal(render({}), '<div></div>')
  const installing = render({ installing: true })
  assert.ok(installing.includes('avatar.engineInstalling'))
  assert.ok(installing.includes('<progress'))
  assert.ok(installing.includes('avatar.engineCancel'))
  const cancelled = render({ cancelled: true })
  assert.ok(cancelled.includes('avatar.engineCancelled'))
  assert.ok(cancelled.includes('avatar.engineRetry'))
  const failed = render({ error: '网络不可达' })
  assert.ok(failed.includes('avatar.engineInstallFailed'))
  assert.ok(failed.includes('avatar.engineRetry'))
  const consent = render({ consentOpen: true, agreed: true })
  assert.ok(consent.includes('avatar.engineTerms'))
  assert.ok(consent.includes('avatar.engineTermsContent'))
  assert.ok(consent.includes('avatar.engineAgree'))
})

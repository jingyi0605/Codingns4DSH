import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { parse } from 'yaml'
import { createAssistantAvatarRuntimeHandler } from '../data/build/dist/host/features/assistant-avatar-runtime.js'
import { ASSISTANT_AVATAR_RUNTIME_PATH } from '../data/build/dist/shared/assistant-avatar.js'
import { createAssistantAvatarRuntimeFeature } from '../data/build/dist/host/features/assistant-avatar-runtime.js'
import { FeatureRegistry } from '../data/build/dist/features/index.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'

test('运行时只读固定 GET 路径，缓存引擎但不加载用户路径', async () => {
  let reads = 0
  const handler = createAssistantAvatarRuntimeHandler(async () => { reads += 1; return 'export function init() {}' })
  const url = `http://localhost${ASSISTANT_AVATAR_RUNTIME_PATH}`
  assert.equal((await handler(new Request(`${url}/other`))).status, 404)
  assert.equal((await handler(new Request(url, { method: 'POST' }))).status, 405)
  assert.equal(reads, 0)
  const response = await handler(new Request(url))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /javascript/u)
  assert.match(await response.text(), /export function init/u)
  await handler(new Request(`${url}?path=/etc/passwd`))
  assert.equal(reads, 1)
})

test('缺失依赖返回 503，恢复后重试，不永久缓存失败', async () => {
  let reads = 0
  const handler = createAssistantAvatarRuntimeHandler(async () => { if (++reads === 1) throw new Error('missing'); return 'export const init = () => null' })
  const request = () => new Request(`http://localhost${ASSISTANT_AVATAR_RUNTIME_PATH}`)
  assert.equal((await handler(request())).status, 503)
  assert.equal((await handler(request())).status, 200)
})

test('已单独安装的外部引擎能通过固定入口返回浏览器独立模块', async (t) => {
  try { createRequire(import.meta.url).resolve('l2d/package.json') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
    t.skip('当前环境未安装可选 Live2D 引擎'); return
  }
  const response = await createAssistantAvatarRuntimeHandler()(new Request(`http://localhost${ASSISTANT_AVATAR_RUNTIME_PATH}`))
  assert.equal(response.status, 200)
  const source = await response.text()
  assert.ok(source.length > 1000)
  assert.ok(/export\s*\{/u.test(source), '运行时必须是 ESM，不能误用 IIFE 文件')
  assert.ok(/\bas init\b/u.test(source), '运行时应导出 init')
  assert.ok(!source.includes('sourceMappingURL='))
})

test('开发依赖准备 Live2D 引擎，发布包仍保持可选 Host 外部依赖边界', async () => {
  const root = new URL('../', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const lock = parse(await readFile(new URL('pnpm-lock.yaml', root), 'utf8'))
  assert.equal(manifest.peerDependencies.l2d, '2.1.1')
  assert.equal(manifest.peerDependenciesMeta.l2d.optional, true)
  for (const kind of ['dependencies', 'optionalDependencies']) {
    assert.equal(manifest[kind]?.l2d, undefined, kind)
    assert.equal(lock.importers['.'][kind]?.l2d, undefined, `lock: ${kind}`)
  }
  assert.equal(manifest.devDependencies.l2d, '2.1.1')
  assert.equal(lock.importers['.'].devDependencies.l2d.specifier, '2.1.1')
  assert.equal(lock.importers['.'].devDependencies.l2d.version, '2.1.1')
  assert.ok(lock.packages['l2d@2.1.1'].resolution.integrity)
  assert.deepEqual(lock.snapshots['l2d@2.1.1'], {})
  assert.ok(!(manifest.bundledDependencies ?? manifest.bundleDependencies ?? []).includes('l2d'))
  assert.ok(manifest.files.includes('avatar-packages/catalog.json'))
  assert.ok(manifest.files.includes('avatar-packages/manifests/*.avatar.json'))
  assert.ok(!manifest.files.some((path: string) => /live2d|l2d/u.test(path)))
  assert.ok(!manifest.files.includes('avatar-packages/**'), '只携带目录元数据，不能打包第三方素材')
})

test('运行时模块重复启停不会残留资源路由', async () => {
  let active = 0
  const services = { registerAssistantAvatarRuntimeRoute: () => { active++; return () => { active-- } } } as unknown as CodingNsHostServices
  const registry = new FeatureRegistry(services)
  registry.register(createAssistantAvatarRuntimeFeature())
  await registry.reconcile(['assistantAvatarRuntime'])
  await registry.reconcile(['assistantAvatarRuntime'])
  assert.equal(active, 1)
  await registry.reconcile([])
  assert.equal(active, 0)
})

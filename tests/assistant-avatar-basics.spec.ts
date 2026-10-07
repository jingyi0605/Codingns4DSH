import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createAssistantAvatarBasicHandler } from '../src/host/features/assistant-avatar-basics.js'
import { createAssistantAvatarRouteHandler, registerAssistantAvatarRoutes } from '../src/host/features/assistant-avatar-runtime.js'
import { BUILTIN_ASSISTANT_AVATAR_SOURCES } from '../src/shared/assistant-avatar.js'
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'

const paths = Object.values(BUILTIN_ASSISTANT_AVATAR_SOURCES)
const request = (path: string, method = 'GET') => new Request(`http://localhost${path}`, { method })

test('新用户通过已登记 URL 获取随包透明生图 PNG，不需要外部引擎或形象安装', async () => {
  const handler = createAssistantAvatarRouteHandler()
  const registered = new Map<string, (request: Request) => Promise<Response>>()
  const routes = { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
    registered.set(route.path, route.fetch); return async () => { registered.delete(route.path) }
  } } as unknown as HostConnectionFetch
  const release = registerAssistantAvatarRoutes(routes, handler)
  try {
    for (const path of paths) {
      const response = await registered.get(path)!(request(path))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'image/png')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      assert.equal(bytes.readUInt32BE(16), 1024)
      assert.equal(bytes.readUInt32BE(20), 1536)
      assert.equal(bytes[25], 6, '素材必须保留 RGBA 透明通道')
      const file = path.slice(path.lastIndexOf('/') + 1)
      assert.deepEqual(bytes, await readFile(new URL(`../assets/assistant-basics/${file}`, import.meta.url)))
    }
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.ok(manifest.files.includes('assets/assistant-basics/*.png'))
  } finally { await release() }
  assert.equal(registered.size, 0)
})

test('基础图片拒绝任意路径和写请求，首次读取按需发生且并发请求共用缓存', async () => {
  const reads: string[] = []
  const handler = createAssistantAvatarBasicHandler(async (filename) => { reads.push(filename); return new Uint8Array([1, 2, 3]) })
  assert.equal(reads.length, 0)
  for (const path of ['/api/codingns/assistant-avatar-basic/missing.png', '/api/codingns/assistant-avatar-basic/%2e%2e/package.json']) {
    assert.equal((await handler(request(path))).status, 404)
  }
  assert.equal((await handler(request(paths[0]!, 'POST'))).status, 405)
  assert.equal(reads.length, 0)
  const results = await Promise.all([handler(request(paths[0]!)), handler(request(`${paths[0]}?path=/etc/passwd`))])
  assert.ok(results.every((result) => result.status === 200))
  assert.deepEqual(reads, ['female-v1.png'])
  await handler(request(paths[1]!))
  assert.deepEqual(reads, ['female-v1.png', 'male-v1.png'])
})

test('基础图片读取失败允许恢复重试', async () => {
  let reads = 0
  const handler = createAssistantAvatarBasicHandler(async () => { if (++reads === 1) throw new Error('missing'); return new Uint8Array([1]) })
  assert.equal((await handler(request(paths[0]!))).status, 503)
  assert.equal((await handler(request(paths[0]!))).status, 200)
  assert.equal(reads, 2)
})

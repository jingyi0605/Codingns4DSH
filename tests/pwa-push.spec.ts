import assert from 'node:assert/strict'
import test from 'node:test'
import { createDecipheriv, createECDH, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PwaPushService, encryptPushPayload } from '../data/build/dist/host/modules/pwa/index.js'

function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Buffer {
  return createHmac('sha256', salt).update(ikm).digest()
}

function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Buffer {
  const blocks = Math.ceil(length / 32)
  let previous = Buffer.alloc(0)
  const output: Buffer[] = []
  for (let index = 1; index <= blocks; index += 1) {
    const hmac = createHmac('sha256', prk)
    hmac.update(previous)
    hmac.update(info)
    hmac.update(Buffer.from([index]))
    previous = hmac.digest()
    output.push(previous)
  }
  return Buffer.concat(output).subarray(0, length)
}

/** 与发送端对称的 RFC 8291 解密，用来验证密文确实能被浏览器解开。 */
function decryptPushPayload(body: Uint8Array, clientPrivate: Buffer, clientPublic: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16)
  const idLength = body[20]!
  const serverPublic = body.subarray(21, 21 + idLength)
  const ciphertext = body.subarray(21 + idLength)
  const server = createECDH('prime256v1')
  server.setPrivateKey(clientPrivate)
  const sharedSecret = server.computeSecret(serverPublic)
  const info = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), clientPublic, serverPublic])
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, auth, info, 32))
  const prk = hkdfExtract(salt, ikm)
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12)
  const tag = ciphertext.subarray(ciphertext.length - 16)
  const data = ciphertext.subarray(0, ciphertext.length - 16)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()])
  // 去掉记录分隔符（单条记录的最后一条为 0x02）。
  assert.equal(plaintext[plaintext.length - 1], 0x02)
  return plaintext.subarray(0, plaintext.length - 1).toString('utf8')
}

async function createStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codingns4dsh-pwa-'))
}

test('推送载荷可被订阅端密钥解开', () => {
  const client = createECDH('prime256v1')
  client.generateKeys()
  const clientPublic = client.getPublicKey()
  const auth = randomBytes(16)
  const payload = new TextEncoder().encode(JSON.stringify({ title: 'DSH', body: '完成' }))
  const body = encryptPushPayload(payload, { p256dh: clientPublic.toString('base64url'), auth: auth.toString('base64url') })
  const plaintext = decryptPushPayload(body, client.getPrivateKey(), clientPublic, auth)
  assert.deepEqual(JSON.parse(plaintext), { title: 'DSH', body: '完成' })
})

test('推送载荷每次使用新的临时密钥与盐', () => {
  const client = createECDH('prime256v1')
  client.generateKeys()
  const keys = { p256dh: client.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }
  const first = encryptPushPayload(new Uint8Array([1]), keys)
  const second = encryptPushPayload(new Uint8Array([1]), keys)
  assert.notDeepEqual([...first.subarray(0, 16)], [...second.subarray(0, 16)])
  assert.notDeepEqual([...first.subarray(21, 86)], [...second.subarray(21, 86)])
})

test('非法订阅密钥被拒绝', () => {
  assert.throws(() => encryptPushPayload(new Uint8Array([1]), { p256dh: Buffer.alloc(10).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') }), /p256dh/u)
  assert.throws(() => encryptPushPayload(new Uint8Array([1]), { p256dh: Buffer.alloc(65).toString('base64url'), auth: Buffer.alloc(8).toString('base64url') }), /auth/u)
})

test('VAPID 密钥持久化并保持稳定', async () => {
  const stateDir = await createStateDir()
  const service = new PwaPushService({ stateDir })
  const first = await service.vapidKeys()
  assert.equal(Buffer.from(first.publicKey, 'base64url').length, 65)
  const second = await new PwaPushService({ stateDir }).vapidKeys()
  assert.equal(second.publicKey, first.publicKey)
  assert.equal(second.privateKeyJwk.d !== undefined, true)
  const stored = JSON.parse(await readFile(join(stateDir, 'pwa-vapid.json'), 'utf8')) as { publicKey: string }
  assert.equal(stored.publicKey, first.publicKey)
})

test('订阅按 endpoint 去重，可列出与删除', async () => {
  const stateDir = await createStateDir()
  const service = new PwaPushService({ stateDir })
  const input = { endpoint: 'https://push.example.com/sub/1', keys: { p256dh: 'A'.repeat(43), auth: 'B'.repeat(22) } }
  const record = await service.subscribe(input, 'iPhone')
  assert.equal(record.label, 'iPhone')
  await service.subscribe({ ...input, keys: { p256dh: 'C'.repeat(43), auth: 'D'.repeat(22) } }, 'iPad')
  const list = await service.listSubscriptions()
  assert.equal(list.length, 1)
  assert.equal(list[0]?.keys.p256dh, 'C'.repeat(43))
  assert.equal(await service.unsubscribe(input.endpoint), true)
  assert.equal(await service.unsubscribe(input.endpoint), false)
  assert.deepEqual(await service.listSubscriptions(), [])
  await assert.rejects(() => service.subscribe({ endpoint: 'http://insecure.example.com/sub', keys: input.keys }, ''), /https/u)
})

test('发送推送带 VAPID 认证头与加密正文，410 视为订阅失效', async () => {
  const stateDir = await createStateDir()
  const calls: { url: string; headers: Record<string, string>; body: Uint8Array }[] = []
  const responses = [new Response('', { status: 201 }), new Response('', { status: 410 })]
  const service = new PwaPushService({
    stateDir,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: new Uint8Array(init?.body as ArrayBuffer),
      })
      return responses.shift() ?? new Response('', { status: 201 })
    }) as typeof fetch,
  })
  const client = createECDH('prime256v1')
  client.generateKeys()
  const auth = randomBytes(16)
  await service.subscribe({
    endpoint: 'https://push.example.com/sub/a',
    keys: { p256dh: client.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  }, 'phone')
  await service.subscribe({ endpoint: 'https://push.example.com/sub/b', keys: { p256dh: client.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }, 'tablet')

  const summary = await service.sendToAll({ title: 'DSH', body: '任务完成' })
  assert.deepEqual(summary, { sent: 1, failed: 0, removed: 1, total: 2 })
  assert.equal(calls.length, 2)
  const [authorization, encoding] = [calls[0]?.headers.Authorization ?? '', calls[0]?.headers['Content-Encoding'] ?? '']
  assert.match(authorization, /^vapid t=/u)
  assert.equal(encoding, 'aes128gcm')
  const token = authorization.replace(/^vapid t=/u, '').split(', k=', 1)[0] ?? ''
  const [header, payload] = token.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8')), { typ: 'JWT', alg: 'ES256' })
  const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as { aud: string; exp: number; sub: string }
  assert.equal(claims.aud, 'https://push.example.com')
  assert.ok(claims.exp > Math.floor(Date.now() / 1000))
  assert.match(claims.sub, /^mailto:/u)
  // 加密正文必须能被订阅密钥解开，说明载荷格式对浏览器可用。
  const decrypted = decryptPushPayload(calls[0]!.body, client.getPrivateKey(), client.getPublicKey(), auth)
  assert.deepEqual(JSON.parse(decrypted), { title: 'DSH', body: '任务完成' })
  // 410 的订阅应被自动清理。
  assert.deepEqual((await service.listSubscriptions()).map((item) => item.endpoint), ['https://push.example.com/sub/a'])
})

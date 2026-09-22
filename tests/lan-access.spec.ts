import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureCryptoRandomUUID } from '../dist/client/lan-access.js'

test('已有 randomUUID 时不覆盖浏览器原生实现', () => {
  const native = () => 'native-uuid'
  const target = { crypto: { randomUUID: native } }

  assert.deepEqual(ensureCryptoRandomUUID(target), { available: true, installed: false })
  assert.equal(target.crypto.randomUUID, native)
})

test('缺少 randomUUID 时安装 RFC 4122 v4 兜底实现', () => {
  const target = {
    crypto: {
      getRandomValues(array: Uint8Array) {
        array.fill(0)
        return array
      },
    },
  }

  assert.deepEqual(ensureCryptoRandomUUID(target), { available: true, installed: true })
  const uuid = target.crypto.randomUUID?.()
  assert.match(uuid ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  assert.deepEqual(ensureCryptoRandomUUID(target), { available: true, installed: false })
})

test('没有 crypto 时安全返回不可用，不阻断页面启动', () => {
  assert.deepEqual(ensureCryptoRandomUUID({}), { available: false, installed: false })
})

test('getRandomValues 抛错时仍能生成合法 UUID', () => {
  const target = { crypto: { getRandomValues: () => { throw new Error('不可用') } } }
  const result = ensureCryptoRandomUUID(target)

  assert.deepEqual(result, { available: true, installed: true })
  assert.match(target.crypto.randomUUID?.() ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
})


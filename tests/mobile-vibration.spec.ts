import assert from 'node:assert/strict'
import test from 'node:test'
import { vibrateMobile } from '../data/build/dist/client/mobile-vibration.js'

test('振动能力存在时转发模式并返回成功', () => {
  const patterns: unknown[] = []
  const accepted = vibrateMobile([8, 12], {
    navigator: { vibrate: (pattern) => { patterns.push(pattern); return true } },
  })
  assert.equal(accepted, true)
  assert.deepEqual(patterns, [[8, 12]])
})

test('振动能力缺失或调用失败时安全降级', () => {
  assert.equal(vibrateMobile(10, {}), false)
  assert.equal(vibrateMobile(10, { navigator: { vibrate: () => { throw new Error('blocked') } } }), false)
})

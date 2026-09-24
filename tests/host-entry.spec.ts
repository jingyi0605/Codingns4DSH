import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../data/build/dist/host/index.js'

test('Host entry 可以加载并卸载且不创建资源', () => {
  assert.doesNotThrow(() => apply())
})

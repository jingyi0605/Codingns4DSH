import assert from 'node:assert/strict'
import test from 'node:test'
import { VoiceOutputController } from '../data/build/dist/client/voice-output.js'

test('播报先清理文本并取消旧队列', async () => {
  const calls: string[] = []
  const output = new VoiceOutputController({ cancel: () => { calls.push('cancel') }, speak: (text, epoch) => { calls.push(`${epoch}:${text}`) } })
  await output.speak('**进展** https://example.com')
  assert.deepEqual(calls, ['cancel', '1:进展 链接'])
})

test('interrupt 递增 epoch 并停止播放', async () => {
  const calls: string[] = []
  const output = new VoiceOutputController({ cancel: () => { calls.push('cancel') }, speak: () => undefined })
  await output.speak('你好')
  await output.interrupt()
  assert.equal(output.currentEpoch(), 2)
  assert.equal(calls.length, 2)
})

test('按句播报并在新 epoch 前停止旧句队列', async () => {
  const calls: string[] = []
  const output = new VoiceOutputController({ cancel: () => undefined, speak: (text, epoch) => { calls.push(`${epoch}:${text}`) } })
  await output.speak('第一句。第二句！')
  assert.deepEqual(calls, ['1:第一句。', '1:第二句！'])
})

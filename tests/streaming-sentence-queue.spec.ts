import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { StreamingSentenceQueue } from '../src/client/streaming-sentence-queue.js'

test('完整句子在流结束前播放，重复快照不重读，残句结束时补播', async () => {
  const spoken: string[] = []
  const queue = new StreamingSentenceQueue(async (text) => { spoken.push(text) }, () => true)
  queue.push('权限已修复。还需')
  await setImmediate()
  assert.deepEqual(spoken, ['权限已修复。'])
  queue.push('权限已修复。还需')
  queue.push('权限已修复。还需复测！剩余一句', true)
  await queue.drain()
  assert.deepEqual(spoken, ['权限已修复。', '还需复测！', '剩余一句'])
})

test('慢速 TTS 串行播放但不阻塞流式入队；打断丢弃排队句子', async () => {
  const spoken: string[] = []
  let current = true
  let release!: () => void
  const queue = new StreamingSentenceQueue(async (text) => { spoken.push(text); await new Promise<void>((resolve) => { release = resolve }) }, () => current)
  queue.push('第一句。第二句。', true)
  await setImmediate()
  assert.deepEqual(spoken, ['第一句。'])
  current = false; release()
  await queue.drain()
  assert.deepEqual(spoken, ['第一句。'])
})

test('小数、网址和未完成英文句号不被逐 token 拆开，中文引号随句末消费', async () => {
  const spoken: string[] = []
  const queue = new StreamingSentenceQueue(async (text) => { spoken.push(text) }, () => true)
  queue.push('值为3.14，地址example.com，答复“好了！”Next.')
  await setImmediate()
  assert.deepEqual(spoken, ['值为3.14，地址example.com，', '答复“好了！”'])
  queue.push('值为3.14，地址example.com，答复“好了！”Next. Done', true)
  await queue.drain()
  assert.deepEqual(spoken.slice(2), ['Next.', 'Done'])
})

test('逗号、分号和冒号提前提交有意义的短语，短语气词合并后再合成', async () => {
  const spoken: string[] = []
  const queue = new StreamingSentenceQueue(async (text) => { spoken.push(text) }, () => true)
  queue.push('好，那你慢慢看，')
  await setImmediate()
  assert.deepEqual(spoken, ['好，那你慢慢看，'])
  queue.push('好，那你慢慢看，我会在旁边等着；这里有几点建议：最后一句还没有结束')
  await setImmediate()
  assert.deepEqual(spoken, ['好，那你慢慢看，', '我会在旁边等着；', '这里有几点建议：'])
  queue.push('好，那你慢慢看，我会在旁边等着；这里有几点建议：最后一句还没有结束', true)
  await queue.drain()
  assert.equal(spoken.at(-1), '最后一句还没有结束')
})

test('数字分隔符、时间和网址冒号不切分，流结束不丢失文字', async () => {
  const spoken: string[] = []
  const queue = new StreamingSentenceQueue(async (text) => { spoken.push(text) }, () => true)
  queue.push('计划开始时间12:')
  queue.push('计划开始时间12:30，下载地址https:')
  queue.push('计划开始时间12:30，下载地址https://example.com:8080/a,b?x=1&y=2，总计123,')
  queue.push('计划开始时间12:30，下载地址https://example.com:8080/a,b?x=1&y=2，总计123,000元。', true)
  await queue.drain()
  assert.deepEqual(spoken, ['计划开始时间12:30，', '下载地址https://example.com:8080/a,b?x=1&y=2，', '总计123,000元。'])
})

test('没有标点时按等待时间或长度提交，重复轮询不重播，不切碎英文词', async () => {
  let time = 0
  const spoken: string[] = []
  const queue = new StreamingSentenceQueue(async (text) => { spoken.push(text) }, () => true, () => time)
  const first = '这个回复一直没有标点但应该先开始播报'
  queue.push(first)
  time = 699; queue.push(first); await setImmediate()
  assert.deepEqual(spoken, [])
  time = 700; queue.push(first); await setImmediate()
  assert.deepEqual(spoken, [first])
  queue.push(first + '甲'.repeat(70)); await setImmediate()
  assert.deepEqual(spoken, [first, '甲'.repeat(64)])
  queue.push(first + '甲'.repeat(70), true); await queue.drain()
  assert.equal(spoken.join(''), first + '甲'.repeat(70))
  const english: string[] = []
  const words = new StreamingSentenceQueue(async (text) => { english.push(text) }, () => true, () => time)
  words.push('Please check the configu')
  time += 700; words.push('Please check the configu'); await setImmediate()
  assert.deepEqual(english, ['Please check the'])
  words.push('Please check the configuration', true); await words.drain()
  assert.deepEqual(english, ['Please check the', 'configuration'])
})

test('改写已播报前缀或 TTS 失败被明确返回，不继续播报剩余句子', async () => {
  const queue = new StreamingSentenceQueue(async () => { throw new Error('TTS 不可用') }, () => true)
  queue.push('第一句。第二句。', true)
  await assert.rejects(queue.drain(), /TTS 不可用/)
  const rewritten = new StreamingSentenceQueue(async () => {}, () => true)
  rewritten.push('第一句。')
  assert.throws(() => rewritten.push('不同的第一句。'), /改写/)
})

test('Host 最终结算移除末尾换行时，不误报改写，也不重复播放', async () => {
  const spoken: string[] = []
  const queue = new StreamingSentenceQueue(async (text) => { spoken.push(text) }, () => true)
  queue.push('已完成。\n')
  queue.push('已完成。', true)
  await queue.drain()
  assert.deepEqual(spoken, ['已完成。'])
})

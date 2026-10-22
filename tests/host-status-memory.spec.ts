import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createHostStatusFeature,
  parseMacosVmStat,
  readHostMemory,
} from '../src/host/features/host-status.js'

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const MIB = 1024 * 1024

/** macOS 已用内存必须按活动监视器口径统计，不能把文件缓存算作占用。 */
test('macOS vm_stat 按活动监视器口径统计已用内存', async () => {
  const output = await fixture('host-status-macos-vm-stat.txt')
  const pageSize = 16384
  const pages = (308183 - 1199) + 242066 + 309214
  assert.equal(parseMacosVmStat(output), pages * pageSize)
})

test('macOS 不再用 totalmem - freemem 得出接近 100% 的占用率', async () => {
  const output = await fixture('host-status-macos-vm-stat.txt')
  const totalBytes = 16 * 1024 * MIB
  const sample = await readHostMemory({
    platform: 'darwin',
    totalBytes: () => totalBytes,
    // freemem 在 macOS 上只剩约 78 MiB，旧算法会得到 99.5%。
    freeBytes: () => 4823 * 16384,
    readVmStat: async () => output,
  })
  assert.equal(sample.totalBytes, totalBytes)
  assert.ok(sample.usedBytes > 13 * 1024 * MIB && sample.usedBytes < 14 * 1024 * MIB, `实际为 ${sample.usedBytes}`)
  const percent = (sample.usedBytes / sample.totalBytes) * 100
  assert.ok(percent > 75 && percent < 90, `实际为 ${percent.toFixed(1)}%`)
})

test('vm_stat 不可用时回退到 totalmem - freemem', async () => {
  const sample = await readHostMemory({
    platform: 'darwin',
    totalBytes: () => 16 * 1024 * MIB,
    freeBytes: () => 4 * 1024 * MIB,
    readVmStat: async () => null,
  })
  assert.deepEqual(sample, { usedBytes: 12 * 1024 * MIB, totalBytes: 16 * 1024 * MIB })
})

test('vm_stat 输出缺少计数器时回退，不返回部分结果', async () => {
  assert.equal(parseMacosVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1.\n'), null)
  assert.equal(parseMacosVmStat(''), null)
  const sample = await readHostMemory({
    platform: 'darwin',
    totalBytes: () => 16 * 1024 * MIB,
    freeBytes: () => 8 * 1024 * MIB,
    readVmStat: async () => 'Pages free: 1.\n',
  })
  assert.equal(sample.usedBytes, 8 * 1024 * MIB)
})

test('非 macOS 平台保持 totalmem - freemem', async () => {
  const sample = await readHostMemory({
    platform: 'linux',
    totalBytes: () => 8 * 1024 * MIB,
    freeBytes: () => 2 * 1024 * MIB,
    readVmStat: async () => { throw new Error('Linux 不应读取 vm_stat') },
  })
  assert.deepEqual(sample, { usedBytes: 6 * 1024 * MIB, totalBytes: 8 * 1024 * MIB })
})

test('host/status 返回的已用内存不超过总内存', async () => {
  let handler: ((action: string) => Promise<{ memoryPercent: number; memoryUsedBytes: number; memoryTotalBytes: number }>) | undefined
  createHostStatusFeature().start({
    services: { rpc: { register: (_namespace: string, value: typeof handler) => { handler = value; return () => undefined } } },
    resources: { add: () => undefined },
  } as never)
  assert.ok(handler !== undefined)
  const status = await handler('status')
  assert.ok(status.memoryUsedBytes >= 0)
  assert.ok(status.memoryUsedBytes <= status.memoryTotalBytes)
  assert.ok(status.memoryPercent >= 0 && status.memoryPercent <= 100)
  await assert.rejects(handler('unknown'), /未知 Host RPC/u)
})

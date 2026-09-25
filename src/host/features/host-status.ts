import { cpus, freemem, totalmem } from 'node:os'
import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { DshHostStatus } from '../../shared/contracts/host-status.js'
import type { CodingNsHostServices } from './types.js'

/** 暴露 Host 资源采样；状态保留在模块内，不写入设置和磁盘。 */
export function createHostStatusFeature(): FeatureModule<CodingNsHostServices> {
  let previous: CpuSample | undefined
  return {
    descriptor: {
      name: 'hostStatus',
      version: '0.1.0',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
    },
    start(context) {
      context.resources.add(context.services.rpc.register('host', async (action) => {
        if (action !== 'status') throw new Error(`未知 Host RPC: host/${action}`)
        const current = readCpuSample()
        const cpuPercent = previous === undefined ? 0 : cpuUsage(previous, current)
        previous = current
        const memoryTotalBytes = totalmem()
        const memoryUsedBytes = Math.max(0, memoryTotalBytes - freemem())
        const value: DshHostStatus = {
          cpuPercent,
          memoryPercent: memoryTotalBytes > 0 ? (memoryUsedBytes / memoryTotalBytes) * 100 : 0,
          memoryUsedBytes,
          memoryTotalBytes,
          sampledAt: Date.now(),
        }
        return value
      }))
    },
  }
}

interface CpuSample { idle: number; total: number }

function readCpuSample(): CpuSample {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    idle += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
  }
  return { idle, total }
}

function cpuUsage(previous: CpuSample, current: CpuSample): number {
  const idleDelta = Math.max(0, current.idle - previous.idle)
  const totalDelta = Math.max(0, current.total - previous.total)
  if (totalDelta === 0) return 0
  return clamp((1 - idleDelta / totalDelta) * 100)
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0))
}

export { cpuUsage, readCpuSample }

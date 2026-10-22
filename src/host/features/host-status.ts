import { execFile as execFileCallback } from 'node:child_process'
import { cpus, freemem, totalmem } from 'node:os'
import { promisify } from 'node:util'
import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { DshHostStatus } from '../../shared/contracts/host-status.js'
import type { CodingNsHostServices } from './types.js'

const execFile = promisify(execFileCallback)
const MAX_VM_STAT_BYTES = 256 * 1024
const VM_STAT_TIMEOUT_MS = 5_000

/** 暴露 Host 资源采样；状态保留在模块内，不写入设置和磁盘。 */
export function createHostStatusFeature(): FeatureModule<CodingNsHostServices> {
  let previous: CpuSample | undefined
  return {
    descriptor: {
      name: 'hostStatus',
      version: '0.1.2',
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
        const memory = await readHostMemory()
        const value: DshHostStatus = {
          cpuPercent,
          memoryPercent: memory.totalBytes > 0 ? (memory.usedBytes / memory.totalBytes) * 100 : 0,
          memoryUsedBytes: memory.usedBytes,
          memoryTotalBytes: memory.totalBytes,
          sampledAt: Date.now(),
        }
        return value
      }))
    },
  }
}

interface CpuSample { idle: number; total: number }

/** 内存采样结果；平台差异只在采集层消化，契约保持字节数。 */
export interface HostMemorySample { usedBytes: number; totalBytes: number }

/** 采样依赖；默认读取真实主机，测试可注入固定输出。 */
export interface HostMemorySources {
  readonly platform?: NodeJS.Platform
  readonly readVmStat?: () => Promise<string | null>
  readonly totalBytes?: () => number
  readonly freeBytes?: () => number
}

/**
 * 读取主机已用内存。
 *
 * macOS 的 `os.freemem()` 只返回完全空闲页，不包含可回收的 inactive、
 * speculative 与 purgeable 页，直接用 `totalmem - freemem` 会把缓存算成
 * 占用（常见 99%）。darwin 因此按活动监视器口径读取 `vm_stat`：已用内存 =
 * (匿名页 - 可清除页) + 联动页 + 压缩页。其余平台保持 `totalmem - freemem`。
 */
export async function readHostMemory(sources: HostMemorySources = {}): Promise<HostMemorySample> {
  const totalBytes = (sources.totalBytes ?? totalmem)()
  if ((sources.platform ?? process.platform) === 'darwin') {
    const usedBytes = parseMacosVmStat(await (sources.readVmStat ?? readMacosVmStat)() ?? '')
    if (usedBytes !== null) {
      return { usedBytes: Math.min(totalBytes, Math.max(0, usedBytes)), totalBytes }
    }
  }
  return { usedBytes: Math.max(0, totalBytes - (sources.freeBytes ?? freemem)()), totalBytes }
}

async function readMacosVmStat(): Promise<string | null> {
  try {
    const { stdout } = await execFile('vm_stat', [], {
      encoding: 'utf8',
      timeout: VM_STAT_TIMEOUT_MS,
      maxBuffer: MAX_VM_STAT_BYTES,
    })
    return stdout
  } catch {
    return null
  }
}

/**
 * 解析 `vm_stat` 输出为已用字节数；缺少任一计数器时返回 null，交给调用方回退。
 */
export function parseMacosVmStat(output: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/u.exec(output)?.[1])
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null
  const pages = (label: string): number | null => {
    const value = Number(new RegExp(`${label}:\\s+(\\d+)`, 'u').exec(output)?.[1])
    return Number.isFinite(value) ? value : null
  }
  const anonymous = pages('Anonymous pages')
  const purgeable = pages('Pages purgeable')
  const wired = pages('Pages wired down')
  const compressed = pages('Pages occupied by compressor')
  if (anonymous === null || purgeable === null || wired === null || compressed === null) return null
  return (Math.max(0, anonymous - purgeable) + wired + compressed) * pageSize
}

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

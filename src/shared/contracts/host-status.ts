/** DSH Host 当前资源与访问链路摘要。 */
export interface DshHostStatus {
  /** 当前进程采样得到的主机 CPU 使用率（0-100）。 */
  cpuPercent: number
  /** 当前主机物理内存使用率（0-100）。 */
  memoryPercent: number
  /** 已使用内存字节数。 */
  memoryUsedBytes: number
  /** 总内存字节数。 */
  memoryTotalBytes: number
  /** Host 采样时间戳。 */
  sampledAt: number
  /** 当前 Host 进程的 V8/原生内存计数；按需采样，不写入磁盘。 */
  processMemory?: HostProcessMemory
  /** 当前进程可观测的会话句柄计数；写句柄仍由 DSH 负责生命周期。 */
  sessionHandles?: HostSessionHandleStatus
}

export interface HostProcessMemory {
  rssBytes: number
  heapTotalBytes: number
  heapUsedBytes: number
  externalBytes: number
  arrayBuffersBytes: number
}

export interface HostSessionHandleStatus {
  openHandles: number
  openReadHandles: number
  openWriteHandles: number
  maxOpenHandles: number
  evictedTotal: number
}

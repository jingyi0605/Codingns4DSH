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
}

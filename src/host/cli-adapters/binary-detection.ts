import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import type { CodingNsCliDetection } from '../../shared/contracts/cli-adapter.js'
import { commandEnvironment, resolveCommandPath, runAsyncCommand, WINDOWS } from './process-utils.js'

export interface RpcBinaryOptions {
  readonly binaries: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly versionArgs?: readonly string[]
  readonly timeout?: number
  readonly parseVersion?: (output: string) => string | null
  /** OpenCode 旧协议允许成功退出但不返回语义版本，保持这一兼容行为。 */
  readonly allowUnknownVersion?: boolean
}

const absent: CodingNsCliDetection = { installed: false, version: null, command: null }
const messages = {
  launch: 'CLI 已找到或返回异常，但启动失败，请检查运行依赖后重新检测。',
  timeout: 'CLI 版本探测超时，请重新检测。',
  version: 'CLI 已运行，但未能识别版本输出。',
  protocol: 'CLI 不支持适配器需要的协议。',
} as const

/** 不回传原始 stderr、环境或参数，避免诊断泄露 Provider 凭据。 */
export function failedDetection(reason: NonNullable<CodingNsCliDetection['detectionFailure']>): CodingNsCliDetection {
  return { ...absent, detectionFailure: reason, diagnostic: messages[reason] }
}

/** 所有命令型适配器共用探测与兜底规则；一个别名失败不会掩盖后续可用入口。 */
export async function detectBinary(options: RpcBinaryOptions): Promise<CodingNsCliDetection> {
  const run = options.spawnSync ?? spawnSync
  const parseVersion = options.parseVersion ?? ((output: string) => output.match(/\d+\.\d+(?:\.\d+)?/u)?.[0] ?? null)
  let failure: CodingNsCliDetection | undefined
  for (const command of options.binaries) {
    const direct = await probe(command)
    if (direct.detection.installed) return direct.detection
    const resolved = await resolveCommandPath(command, run)
    if (resolved !== null && resolved !== command) {
      const fallback = await probe(resolved)
      if (fallback.detection.installed) return fallback.detection
      failure ??= fallback.detection.detectionFailure === undefined ? failedDetection('launch') : fallback.detection
    } else if (direct.detection.detectionFailure !== undefined) failure ??= direct.detection
    else if (resolved !== null && !isMissing(direct.result)) failure ??= failedDetection('launch')
  }
  return failure ?? { ...absent }

  async function probe(command: string): Promise<{ detection: CodingNsCliDetection; result: SpawnSyncReturns<string> }> {
    let result: SpawnSyncReturns<string>
    try {
      result = await runAsyncCommand(run, command, options.versionArgs ?? ['--version'], {
        timeout: options.timeout ?? 3_000, shell: WINDOWS, env: { ...commandEnvironment(command), ...options.environment },
      })
    } catch (error) {
      result = { status: null, stdout: '', stderr: '', error: error as Error } as SpawnSyncReturns<string>
    }
    const version = parseVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    if (result.status === 0 && (version !== null || options.allowUnknownVersion)) {
      return { detection: { installed: true, version, command }, result }
    }
    const reason = probeFailure(result)
    return { detection: reason === undefined ? absent : failedDetection(reason), result }
  }
}

/** 只有真正执行失败才报告错误；找不到候选名称允许继续尝试其他别名。 */
export function probeFailure(result: SpawnSyncReturns<string>, found = false): CodingNsCliDetection['detectionFailure'] {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code
  if (result.signal || code === 'ETIMEDOUT' || (result.error as Error & { killed?: boolean } | undefined)?.killed) return 'timeout'
  if (result.status === 0) return 'version'
  if (isMissing(result)) return undefined
  // execFile 把普通非零退出也包装成 Error，数字 code 本身不能证明 CLI 已找到。
  if (found || (result.error !== undefined && typeof code !== 'number') || (result.status !== null && ![1, 127, 9009].includes(result.status))) return 'launch'
  return undefined
}

function isMissing(result: SpawnSyncReturns<string>): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' || result.status === 127 || result.status === 9009
}

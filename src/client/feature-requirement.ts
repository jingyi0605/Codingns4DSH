import { useEffect, useMemo, useRef, useState } from 'react'
import type { MagpieInstallDetection } from '../shared/contracts/magpie-management.js'
import { callCodingNsRpcResult } from './rpc-call.js'
import type { CodingNsClientServices } from './features/types.js'

/** Magpie 安装探测的 RPC 端点；设置卡片与模块面板共用一个探测结果。 */
export const MAGPIE_DETECTION_ENDPOINT = 'magpie/management/detection'

export type FeatureRequirementState = 'checking' | 'ready' | 'missing' | 'unavailable'

export interface FeatureRequirement {
  readonly state: FeatureRequirementState
  /** 未安装时展示的原因文案键。 */
  readonly requirementKey: string
  /** 正在探测时展示的进度文案键。 */
  readonly checkingKey: string
  /** 最近一次探测结果；用于面板展示版本与入口路径。 */
  readonly detection: MagpieInstallDetection | null
  /** 探测失败的安全原因；不包含 Host 异常原文。 */
  readonly failure: 'host-rpc-outdated' | 'host-request-failed' | null
  /** 用户主动重新检测；面板里的“检测/重新检测”按钮使用它。 */
  readonly recheck: (options?: { readonly commandPath?: string; readonly force?: boolean }) => void
}

/**
 * 读取本机 Magpie 探测结果。
 *
 * 传入 `null` 表示当前卡片不依赖本机 Magpie：不发起任何 RPC，也不会渲染提示，
 * 因此其他模块的卡片不会出现“正在检测 Magpie”。
 *
 * 探测只能由 Host 执行，因此这里只做 RPC 读取并映射为四种稳定状态：
 * - `checking`：首次读取中，开关暂不可用，避免在未知状态下写入；
 * - `ready`：找到可运行的 Magpie，允许启用；
 * - `missing`：未安装或入口不可用，禁用开关并给出安装原因；
 * - `unavailable`：Host 上没有该 RPC（旧 Host），按“无法确认”处理，同样不放开启用。
 */
export function useMagpieInstallRequirement(services: Pick<CodingNsClientServices, 'rpc'> | null): FeatureRequirement {
  const [detection, setDetection] = useState<MagpieInstallDetection | null>(null)
  const [failure, setFailure] = useState<FeatureRequirement['failure']>(null)
  const [state, setState] = useState<FeatureRequirementState>('checking')
  const [request, setRequest] = useState<{ readonly commandPath?: string; readonly force?: boolean; readonly nonce: number } | null>(null)
  // Settings cards are re-expanded often; a confirmed install stays valid until the user re-detects.
  const confirmedMissing = useRef(false)

  useEffect(() => {
    // 不依赖本机 Magpie 的卡片：保持初始状态，不读取、不发请求。
    if (services === null) return
    // 卡片初始折叠，面板和开关都读同一份结果；未指定入口且已确认未安装时不打扰 Host。
    if (request === null && confirmedMissing.current) {
      setState('missing')
      return
    }
    let active = true
    void readMagpieDetection(services, request?.commandPath, request?.force === true)
      .then((result) => {
        if (!active) return
        setDetection(result.detection)
        setFailure(result.failure)
        setState(result.state)
        // 只有“确认未安装”才跨挂载复用；已安装与 Host 不可用都要重新读取，避免显示过期结论。
        confirmedMissing.current = result.state === 'missing'
      })
      .catch(() => {
        if (!active) return
        setDetection(null)
        setFailure('host-request-failed')
        setState('unavailable')
      })
    return () => { active = false }
  }, [services, request])

  const recheck = useMemo(() => (options: { readonly commandPath?: string; readonly force?: boolean } = {}): void => {
    setState('checking')
    setRequest((current) => ({ ...options, nonce: (current?.nonce ?? 0) + 1 }))
  }, [])

  return { state, requirementKey: 'settings.requirement.magpieInstall', checkingKey: 'settings.requirement.checking', detection, failure, recheck }
}

/** 供无 React 环境的调用方使用：直接返回探测结果与稳定状态。 */
export async function readMagpieDetection(
  services: Pick<CodingNsClientServices, 'rpc'>,
  commandPath?: string,
  force = false,
): Promise<{ readonly state: FeatureRequirementState; readonly detection: MagpieInstallDetection | null; readonly failure: FeatureRequirement['failure'] }> {
  const result = await callCodingNsRpcResult(services.rpc, MAGPIE_DETECTION_ENDPOINT, {
    ...(commandPath === undefined || commandPath.trim() === '' ? {} : { commandPath }),
    ...(force ? { force: true } : {}),
  })
  if (!result.ok) {
    const code = result.error.code
    const rpcOutdated = code === 'CODINGNS_RPC_NOT_FOUND' || /HTTP (?:404|405)\b|Unknown Magpie RPC/u.test(result.error.message)
    return { state: 'unavailable', detection: null, failure: rpcOutdated ? 'host-rpc-outdated' : 'host-request-failed' }
  }
  const detection = normalizeDetection(result.value)
  if (detection === null) return { state: 'unavailable', detection: null, failure: 'host-request-failed' }
  return { state: detection.installed && detection.command !== null && detection.version !== null ? 'ready' : 'missing', detection, failure: null }
}

/** 只接受形如探测结果的载荷；字段缺失或类型不符时返回 null，而不是猜测“已安装”。 */
export function normalizeDetection(value: unknown): MagpieInstallDetection | null {
  if (!isRecord(value)) return null
  const { installed, source, command, version, reason, checkedAt, platform } = value
  if (typeof installed !== 'boolean' || typeof checkedAt !== 'string') return null
  if (platform !== 'macos' && platform !== 'windows' && platform !== 'linux') return null
  if (source !== null && source !== 'path' && source !== 'custom' && source !== 'common-location') return null
  if (command !== null && typeof command !== 'string') return null
  if (version !== null && typeof version !== 'string') return null
  if (reason !== null && reason !== 'launch' && reason !== 'timeout' && reason !== 'version') return null
  return {
    installed,
    platform,
    source,
    command: command as string | null,
    version: version as string | null,
    reason,
    checkedAt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

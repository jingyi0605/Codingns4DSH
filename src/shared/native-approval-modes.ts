import type { CodingNsCliPermissionState, CodingNsCliSessionConfig, CodingNsNativeApprovalMode } from './contracts/cli-adapter.js'

const CODEX: readonly CodingNsNativeApprovalMode[] = ['manual', 'auto-review', 'read-only', 'full-access-confirm', 'full-access']
const ZCODE: readonly CodingNsNativeApprovalMode[] = ['manual', 'auto-review', 'read-only', 'accept-edits', 'full-access']
const ANTIGRAVITY: readonly CodingNsNativeApprovalMode[] = ['manual', 'accept-edits', 'read-only', 'full-access']

export function nativeApprovalModes(adapterId: string): readonly CodingNsNativeApprovalMode[] {
  return adapterId === 'codex' ? CODEX : adapterId === 'zcode' ? ZCODE : adapterId === 'antigravity' ? ANTIGRAVITY : []
}

export function isNativeApprovalMode(adapterId: string, value: unknown): value is CodingNsNativeApprovalMode {
  const modes = nativeApprovalModes(adapterId)
  return typeof value === 'string' && modes.length > 0 && (value === 'inherit' || modes.includes(value as CodingNsNativeApprovalMode))
}

export function resolveNativeApprovalMode(adapterId: string, value: CodingNsNativeApprovalMode | undefined): CodingNsNativeApprovalMode | undefined {
  const modes = nativeApprovalModes(adapterId)
  if (modes.length === 0) return undefined
  return value !== undefined && modes.includes(value) ? value : 'manual'
}

export function resolveNativeApprovalPermission(config: CodingNsCliSessionConfig, inherited: CodingNsCliPermissionState | undefined): CodingNsCliPermissionState | undefined {
  // An upgrade or model-only edit is not consent to replace an existing sandbox.
  if (config.adapterId !== 'antigravity' && (config.nativeApprovalMode === undefined || !nativeApprovalModes(config.adapterId).includes(config.nativeApprovalMode))) return inherited
  const mode = resolveNativeApprovalMode(config.adapterId, config.nativeApprovalMode)
  if (mode === undefined) return inherited
  if (config.adapterId === 'antigravity' && mode !== 'full-access') {
    // AGY plan 是执行模式而非操作系统只读沙箱，accept-edits 也仍会审查命令。
    return { approvalPolicy: 'ask', nativeApprovalMode: mode }
  }
  if (mode === 'read-only') return { sandboxMode: 'read-only', approvalPolicy: 'ask', nativeApprovalMode: mode }
  if (mode === 'full-access-confirm') return { sandboxMode: 'danger-full-access', approvalPolicy: 'ask', nativeApprovalMode: mode }
  if (mode === 'full-access') return { sandboxMode: 'danger-full-access', approvalPolicy: 'never', nativeApprovalMode: mode }
  // ZCode 自主模式由原生 guarded 执行风险策略，不宣称存在文件系统沙箱。
  return { ...(config.adapterId === 'codex' ? { sandboxMode: 'workspace-write' as const } : {}), approvalPolicy: 'ask', nativeApprovalMode: mode }
}

import type { CodingNsNativeApprovalMode } from '../shared/contracts/cli-adapter.js'
import { nativeApprovalModes, resolveNativeApprovalMode } from '../shared/native-approval-modes.js'
import type { CodingNsTranslator } from './locale.js'

export function canChangeNativeApproval(session: { readonly running?: boolean; readonly queue?: readonly unknown[] } | undefined): boolean {
  // This control edits the saved choice for the next turn, never a live driver's authority.
  return session !== undefined
}

export function nativeApprovalHintKey(adapterId: string, mode: CodingNsNativeApprovalMode): string {
  if (adapterId === 'antigravity') {
    return `nativeApproval.${{ 'auto-review': 'agyAutoHint', 'read-only': 'agyPlanHint', 'accept-edits': 'agyEditHint', 'full-access': 'agyFullHint', 'full-access-confirm': 'fullConfirmHint', inherit: 'agyManualHint', manual: 'agyManualHint' }[mode]}`
  }
  if (mode === 'auto-review') return adapterId === 'zcode' ? 'nativeApproval.zcodeHint' : 'nativeApproval.autoHint'
  return `nativeApproval.${{ inherit: 'inheritHint', manual: 'manualHint', 'read-only': 'readHint', 'accept-edits': 'editHint', 'full-access': 'fullHint', 'full-access-confirm': 'fullConfirmHint' }[mode]}`
}

/** 使用原生值保留 Auto/完全访问的原生图标与确认流程，Host 仍接收适配器模式。 */
export function nativeApprovalUiValue(mode: CodingNsNativeApprovalMode, adapterId?: string): string {
  if (adapterId === 'antigravity' && mode === 'manual') return 'default'
  if (adapterId === 'antigravity' && mode === 'read-only') return 'plan'
  return mode === 'auto-review' ? 'auto' : mode === 'full-access' ? 'danger-full-access' : mode
}

/** Until an explicit choice, display the existing host projection without saving a mode. */
export function nativeApprovalCurrentValue(adapterId: string, mode: CodingNsNativeApprovalMode | undefined, inherited: string | undefined): string {
  if (adapterId === 'antigravity' || (mode !== undefined && nativeApprovalModes(adapterId).includes(mode))) {
    return nativeApprovalUiValue(resolveNativeApprovalMode(adapterId, mode) ?? 'manual', adapterId)
  }
  return inherited === 'workspace-write' || inherited === undefined ? 'manual' : inherited
}

export { resolveNativeApprovalMode }

export function nativeApprovalModeForValue(adapterId: string, value: string): CodingNsNativeApprovalMode | undefined {
  return nativeApprovalModes(adapterId).find(mode => nativeApprovalUiValue(mode, adapterId) === value)
}

export function nativeApprovalCatalog(adapterId: string, t: CodingNsTranslator) {
  return { options: nativeApprovalModes(adapterId).map(mode => ({
    value: nativeApprovalUiValue(mode, adapterId),
    name: t(mode === 'manual' && adapterId === 'antigravity' ? 'nativeApproval.agyDefault'
      : mode === 'auto-review' && adapterId === 'zcode' ? 'nativeApproval.zcodeAuto'
      : mode === 'read-only' && (adapterId === 'zcode' || adapterId === 'antigravity') ? 'nativeApproval.plan' : `nativeApproval.${mode}`),
    description: t(nativeApprovalHintKey(adapterId, mode)),
  })) }
}

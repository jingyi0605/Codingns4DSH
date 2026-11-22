import { createElement, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { DshContextMenuAction, DshContextMenuAdapter } from '../dsh-capabilities/client/context-menu-adapter.js'
import { DshTooltip, resolveTrashIcon } from '../dsh-capabilities/client/primitives-adapter.js'
import { createSessionDeletionUiRefreshAdapter, type DshSessionDeletionUiRefreshAdapter } from '../dsh-capabilities/client/session-deletion-adapter.js'
import { parseVirtualSessionId } from '../shared/contracts/peer-host.js'
import type {
  SessionDeletionCancelResult,
  SessionDeletionCleanupItem,
  SessionDeletionCommitResult,
  SessionDeletionPrepareResult,
  SessionDeletionReasonCode,
  SessionDeletionStatusResult,
} from '../shared/contracts/session-deletion.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { CodingNsRpcClient } from './features/types.js'
import { uiFontSize } from './font-scale.js'
import { resolveCodingNsTranslator, useCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from './locale.js'
import { dshPopupSurfaceStyle, dshSettingsButtonStyle, dshThemeColor } from './theme.js'

export const SESSION_DELETION_MENU_ID = 'codingns.session.delete'
export const SESSION_DELETION_MENU_ORDER = 700
export const SESSION_DELETION_MENU_ICON_KEY = 'codingns.sessionDeletion.delete'
export const SESSION_DELETION_WORKSPACE_ICON_KEY = 'workspace.delete'
export const SESSION_DELETION_ROW_ACTION_ID = 'codingns-session-delete'
export const SESSION_DELETION_ROW_ACTION_ORDER = 50
const SESSION_DELETION_ROW_STYLE_ID = 'codingns4dsh-session-deletion-row-style'
const SESSION_DELETION_ROW_BUTTON_CLASS = 'codingns-session-deletion-row-button'
const SESSION_DELETION_ROW_CSS = `
.${SESSION_DELETION_ROW_BUTTON_CLASS} {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: -4px;
  border: none;
  border-radius: var(--dsw-radius-xs, 4px);
  padding: 0;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-tertiary);
}
.${SESSION_DELETION_ROW_BUTTON_CLASS} > svg {
  width: 14px;
  height: 14px;
}
.${SESSION_DELETION_ROW_BUTTON_CLASS}:focus-visible {
  outline-offset: -2px;
}
@media (hover: hover) {
  .${SESSION_DELETION_ROW_BUTTON_CLASS}:hover:not(:disabled) {
    color: var(--dsw-alias-label-primary);
  }
}
.${SESSION_DELETION_ROW_BUTTON_CLASS}:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
`

export type ParsedSessionMenuTarget =
  | { readonly kind: 'local'; readonly sessionId: string; readonly displayTitle: string }
  | { readonly kind: 'virtual'; readonly sessionId: string; readonly displayTitle: string }
  | { readonly kind: 'invalid' }

/** Strictly validate the unknown payload forwarded by DSH `target: 'session'` context menus. */
export function parseSessionContextMenuTarget(target: unknown): ParsedSessionMenuTarget {
  if (!isObject(target)) return { kind: 'invalid' }
  const rawId = target.sessionId
  if (typeof rawId !== 'string') return { kind: 'invalid' }
  const trimmed = rawId.trim()
  if (
    trimmed === ''
    || trimmed !== rawId
    || trimmed === '.'
    || trimmed === '..'
    || trimmed.length > 512
    || /[\u0000-\u001F\u007F/\\]/u.test(trimmed)
  ) {
    return { kind: 'invalid' }
  }
  const rawTitle = target.displayTitle
  const displayTitle = typeof rawTitle === 'string' && rawTitle.trim() !== '' ? rawTitle.trim() : trimmed
  if (parseVirtualSessionId(trimmed) !== null) {
    return { kind: 'virtual', sessionId: trimmed, displayTitle }
  }
  return { kind: 'local', sessionId: trimmed, displayTitle }
}

export type SessionDeletionDialogStage =
  | { readonly kind: 'preparing'; readonly sessionId: string; readonly displayTitle: string }
  | {
    readonly kind: 'ready'
    readonly sessionId: string
    readonly displayTitle: string
    readonly prepare: SessionDeletionPrepareResult
    readonly confirmed: boolean
    readonly busy: boolean
    readonly errorMessage?: string
  }
  | {
    readonly kind: 'status'
    readonly sessionId: string
    readonly displayTitle: string
    readonly status: SessionDeletionStatusResult
    readonly busy: boolean
    readonly errorMessage?: string
  }
  | {
    readonly kind: 'error'
    readonly sessionId: string
    readonly displayTitle: string
    readonly code?: string
    readonly message: string
  }

export interface SessionDeletionCoordinator {
  getState(): SessionDeletionDialogStage | null
  isQueued(sessionId: string): boolean
  isDeleting(sessionId: string): boolean
  subscribe(listener: () => void): () => void
  refreshActiveList(): Promise<void>
  openForSession(sessionId: string, displayTitle: string): Promise<void>
  setConfirmed(checked: boolean): void
  submitCommit(): Promise<void>
  cancelQueued(): Promise<void>
  cancelQueuedBySessionId(sessionId: string, displayTitle?: string): Promise<{ readonly cancelled: boolean; readonly unarchived: boolean }>
  refreshStatus(): Promise<void>
  retryCleanup(): Promise<void>
  close(): void
  dispose(): void
}

export interface SessionDeletionCoordinatorOptions {
  readonly rpc: CodingNsRpcClient
  readonly locale?: CodingNsLocale
  readonly uiRefresh?: DshSessionDeletionUiRefreshAdapter
  readonly notify?: (text: string, success?: boolean) => void
  readonly onSessionDeleted?: (sessionId: string) => void
  readonly onQueueChanged?: (sessionId: string) => void
}

export function createSessionDeletionCoordinator(
  options: SessionDeletionCoordinatorOptions,
): SessionDeletionCoordinator {
  const t = resolveCodingNsTranslator(options.locale)
  let state: SessionDeletionDialogStage | null = null
  let disposed = false
  const queuedIds = new Set<string>()
  const queuedOperationIds = new Map<string, string>()
  const deletingIds = new Set<string>()
  const activeWatchers = new Map<string, ReturnType<typeof setTimeout>>()
  const listeners = new Set<() => void>()

  const publish = (next: SessionDeletionDialogStage | null): void => {
    if (disposed && next !== null) return
    state = next
    for (const listener of [...listeners]) listener()
  }

  const clearWatcher = (operationId: string): void => {
    const timer = activeWatchers.get(operationId)
    if (timer !== undefined) {
      clearTimeout(timer)
      activeWatchers.delete(operationId)
    }
  }

  const watchBackgroundDeletion = (
    operationId: string,
    sessionId: string,
    displayTitle: string,
    delayMs = 350,
  ): void => {
    if (disposed || activeWatchers.has(operationId)) return
    const timer = setTimeout(async () => {
      activeWatchers.delete(operationId)
      if (disposed) return
      try {
        const res = await options.rpc.call(CODINGNS_RPC_CHANNEL, 'sessionDeletion/status', { operationId })
        if (disposed) return
        if (!res.ok) {
          deletingIds.delete(sessionId)
          options.onQueueChanged?.(sessionId)
          notifyUser(formatReason(res.error.code, res.error.message), false)
          return
        }
        const statusVal = res.value as SessionDeletionStatusResult
        if (statusVal.status === 'deleting') {
          watchBackgroundDeletion(operationId, sessionId, displayTitle, Math.min(1_500, Math.round(delayMs * 1.5)))
          return
        }
        deletingIds.delete(sessionId)
        if (statusVal.status === 'deleted') {
          applyPostLogRemovalUi(sessionId)
          options.onQueueChanged?.(sessionId)
          notifyUser(t('sessionDeletion.toastDeleted', { title: displayTitle }), true)
          return
        }
        if (statusVal.status === 'cleanup-pending') {
          applyPostLogRemovalUi(sessionId)
          options.onQueueChanged?.(sessionId)
          notifyUser(t('sessionDeletion.toastCleanupPending', { title: displayTitle }), false)
          return
        }
        options.onQueueChanged?.(sessionId)
        if (statusVal.status === 'failed' || statusVal.status === 'unknown') {
          notifyUser(formatReason(statusVal.code, statusVal.message), false)
        }
      } catch {
        if (!disposed) {
          watchBackgroundDeletion(operationId, sessionId, displayTitle, Math.min(1_500, delayMs + 400))
        }
      }
    }, delayMs)
    const unref = (timer as { unref?: () => void }).unref
    unref?.call(timer)
    activeWatchers.set(operationId, timer)
  }

  const refreshActiveList = async (): Promise<void> => {
    try {
      const result = await options.rpc.call(CODINGNS_RPC_CHANNEL, 'sessionDeletion/list', {})
      if (disposed || !result.ok || !Array.isArray(result.value)) return
      queuedIds.clear()
      queuedOperationIds.clear()
      deletingIds.clear()
      for (const item of result.value as readonly SessionDeletionStatusResult[]) {
        if (item.status === 'queued' && typeof item.sessionId === 'string') {
          queuedIds.add(item.sessionId)
          if (typeof item.operationId === 'string') {
            queuedOperationIds.set(item.sessionId, item.operationId)
          }
        } else if (item.status === 'deleting' && typeof item.sessionId === 'string') {
          deletingIds.add(item.sessionId)
          if (typeof item.operationId === 'string') {
            watchBackgroundDeletion(item.operationId, item.sessionId, item.sessionId)
          }
        }
      }
      if (queuedIds.size > 0 || deletingIds.size > 0) options.onQueueChanged?.('')
    } catch {
      // Best-effort initial sync; prepare() still discovers existing queued operations on demand.
    }
  }

  const notifyUser = (text: string, success = false): void => {
    options.notify?.(text, success)
  }

  const applyPostLogRemovalUi = (sessionId: string): void => {
    options.uiRefresh?.clearMainViewIfMatching(sessionId)
    options.uiRefresh?.refreshSessionList(sessionId)
    options.onSessionDeleted?.(sessionId)
  }

  const formatReason = (code: string | undefined, fallback?: string): string => {
    if (code !== undefined) {
      const key = `sessionDeletion.reason.${code}`
      const translated = t(key)
      if (translated !== key) return translated
    }
    return fallback ?? t('sessionDeletion.reason.SESSION_DELETION_FAILED')
  }

  const openForSession = async (sessionId: string, displayTitle: string): Promise<void> => {
    const parsed = parseSessionContextMenuTarget({ sessionId, displayTitle })
    if (parsed.kind === 'invalid') return
    if (parsed.kind === 'virtual') {
      publish({
        kind: 'error',
        sessionId: parsed.sessionId,
        displayTitle: parsed.displayTitle,
        code: 'SESSION_DELETION_VIRTUAL_SESSION_UNSUPPORTED',
        message: formatReason('SESSION_DELETION_VIRTUAL_SESSION_UNSUPPORTED'),
      })
      return
    }
    publish({ kind: 'preparing', sessionId: parsed.sessionId, displayTitle: parsed.displayTitle })
    try {
      const result = await options.rpc.call(CODINGNS_RPC_CHANNEL, 'sessionDeletion/prepare', {
        sessionId: parsed.sessionId,
      })
      // Ignore stale prepare responses if user opened another session or closed the dialog.
      if (state?.sessionId !== parsed.sessionId) return
      if (!result.ok) {
        publish({
          kind: 'error',
          sessionId: parsed.sessionId,
          displayTitle: parsed.displayTitle,
          code: result.error.code,
          message: formatReason(result.error.code, result.error.message),
        })
        return
      }
      const prepare = result.value as SessionDeletionPrepareResult
      if (prepare.existingOperation !== undefined) {
        if (prepare.existingOperation.status === 'deleting') {
          queuedIds.delete(prepare.sessionId)
          queuedOperationIds.delete(prepare.sessionId)
          deletingIds.add(prepare.sessionId)
          const title = prepare.title ?? parsed.displayTitle
          notifyUser(t('sessionDeletion.toastDeleting', { title }), true)
          publish(null)
          if (typeof prepare.existingOperation.operationId === 'string') {
            watchBackgroundDeletion(prepare.existingOperation.operationId, prepare.sessionId, title)
          }
          return
        }
        if (prepare.existingOperation.status === 'queued') {
          queuedIds.add(prepare.sessionId)
          if (typeof prepare.existingOperation.operationId === 'string') {
            queuedOperationIds.set(prepare.sessionId, prepare.existingOperation.operationId)
          }
        } else {
          queuedIds.delete(prepare.sessionId)
          queuedOperationIds.delete(prepare.sessionId)
        }
        publish({
          kind: 'status',
          sessionId: prepare.sessionId,
          displayTitle: prepare.title ?? parsed.displayTitle,
          status: prepare.existingOperation,
          busy: false,
        })
        return
      }
      queuedIds.delete(prepare.sessionId)
      publish({
        kind: 'ready',
        sessionId: prepare.sessionId,
        displayTitle: prepare.title ?? parsed.displayTitle,
        prepare,
        confirmed: false,
        busy: false,
      })
    } catch (error) {
      if (state?.sessionId !== parsed.sessionId) return
      publish({
        kind: 'error',
        sessionId: parsed.sessionId,
        displayTitle: parsed.displayTitle,
        message: error instanceof Error ? error.message : t('sessionDeletion.reason.SESSION_DELETION_FAILED'),
      })
    }
  }

  const setConfirmed = (checked: boolean): void => {
    if (state?.kind !== 'ready' || state.busy) return
    publish({ ...state, confirmed: checked })
  }

  const submitCommit = async (): Promise<void> => {
    if (state?.kind !== 'ready' || state.busy || !state.confirmed) return
    const { prepare, sessionId, displayTitle } = state
    if (prepare.mode === 'unsupported' || typeof prepare.operationId !== 'string') return
    publish({ ...state, busy: true })
    try {
      const result = await options.rpc.call(CODINGNS_RPC_CHANNEL, 'sessionDeletion/commit', {
        operationId: prepare.operationId,
        mode: prepare.mode,
        ...(prepare.mode === 'immediate' ? { background: true } : {}),
      })
      if (!result.ok) {
        if (state?.kind === 'ready' && state.sessionId === sessionId) {
          publish({
            ...state,
            busy: false,
            errorMessage: formatReason(result.error.code, result.error.message),
          })
        }
        return
      }
      const commitResult = result.value as SessionDeletionCommitResult
      if (commitResult.status === 'deleting') {
        queuedIds.delete(sessionId)
        queuedOperationIds.delete(sessionId)
        deletingIds.add(sessionId)
        options.uiRefresh?.clearMainViewIfMatching(sessionId)
        options.onQueueChanged?.(sessionId)
        notifyUser(t('sessionDeletion.toastDeleting', { title: displayTitle }), true)
        publish(null)
        watchBackgroundDeletion(commitResult.operationId, sessionId, displayTitle)
        return
      }
      if (commitResult.status === 'deleted') {
        queuedIds.delete(sessionId)
        queuedOperationIds.delete(sessionId)
        applyPostLogRemovalUi(sessionId)
        notifyUser(t('sessionDeletion.toastDeleted', { title: displayTitle }), true)
        publish(null)
        return
      }
      if (commitResult.status === 'queued') {
        queuedIds.add(sessionId)
        queuedOperationIds.set(sessionId, commitResult.operationId)
        options.uiRefresh?.clearMainViewIfMatching(sessionId)
        options.onQueueChanged?.(sessionId)
        notifyUser(
          t(
            commitResult.archived === true ? 'sessionDeletion.toastQueuedArchived' : 'sessionDeletion.toastQueued',
            { title: displayTitle },
          ),
          true,
        )
        publish(null)
        return
      }
      if (commitResult.status === 'cleanup-pending') {
        queuedIds.delete(sessionId)
        queuedOperationIds.delete(sessionId)
        applyPostLogRemovalUi(sessionId)
        notifyUser(t('sessionDeletion.toastCleanupPending', { title: displayTitle }), false)
        publish({
          kind: 'status',
          sessionId,
          displayTitle,
          status: {
            operationId: commitResult.operationId,
            sessionId,
            status: 'cleanup-pending',
            mode: prepare.mode,
            ...(commitResult.code === undefined ? {} : { code: commitResult.code }),
            ...(commitResult.message === undefined ? {} : { message: commitResult.message }),
            cancellable: false,
            retryableCleanup: true,
            pendingCleanupItems: commitResult.pendingCleanupItems ?? [],
            completedCleanupItems: commitResult.completedCleanupItems ?? [],
            updatedAt: Date.now(),
          },
          busy: false,
        })
        return
      }
      if (state?.kind === 'ready' && state.sessionId === sessionId) {
        publish({
          ...state,
          busy: false,
          errorMessage: formatReason(commitResult.code, commitResult.message),
        })
      }
    } catch (error) {
      if (state?.kind === 'ready' && state.sessionId === sessionId) {
        publish({
          ...state,
          busy: false,
          errorMessage: error instanceof Error ? error.message : t('sessionDeletion.reason.SESSION_DELETION_FAILED'),
        })
      }
    }
  }

  const cancelQueued = async (): Promise<void> => {
    if (state?.kind !== 'status' || state.busy || !state.status.cancellable || !state.status.operationId) return
    const { sessionId, displayTitle, status } = state
    publish({ ...state, busy: true })
    try {
      const result = await options.rpc.call(CODINGNS_RPC_CHANNEL, 'sessionDeletion/cancel', {
        operationId: status.operationId,
      })
      if (!result.ok) {
        if (state?.kind === 'status' && state.sessionId === sessionId) {
          publish({
            ...state,
            busy: false,
            errorMessage: formatReason(result.error.code, result.error.message),
          })
        }
        return
      }
      const cancelResult = result.value as SessionDeletionCancelResult
      if (cancelResult.cancelled) {
        queuedIds.delete(sessionId)
        queuedOperationIds.delete(sessionId)
        options.onQueueChanged?.(sessionId)
        notifyUser(t('sessionDeletion.toastCancelled', { title: displayTitle }), true)
        publish(null)
        return
      }
      if (state?.kind === 'status' && state.sessionId === sessionId) {
        publish({
          ...state,
          busy: false,
          errorMessage: formatReason(cancelResult.code, cancelResult.message),
        })
      }
    } catch (error) {
      if (state?.kind === 'status' && state.sessionId === sessionId) {
        publish({
          ...state,
          busy: false,
          errorMessage: error instanceof Error ? error.message : t('sessionDeletion.reason.SESSION_DELETION_FAILED'),
        })
      }
    }
  }

  const queryStatus = async (retryCleanup: boolean): Promise<void> => {
    if (state?.kind !== 'status' || state.busy) return
    const { sessionId, displayTitle, status } = state
    publish({ ...state, busy: true })
    try {
      const payload = status.operationId !== undefined
        ? { operationId: status.operationId, ...(retryCleanup ? { retryCleanup: true } : {}) }
        : { sessionId, ...(retryCleanup ? { retryCleanup: true } : {}) }
      const result = await options.rpc.call(CODINGNS_RPC_CHANNEL, 'sessionDeletion/status', payload)
      if (!result.ok) {
        if (state?.kind === 'status' && state.sessionId === sessionId) {
          publish({
            ...state,
            busy: false,
            errorMessage: formatReason(result.error.code, result.error.message),
          })
        }
        return
      }
      const nextStatus = result.value as SessionDeletionStatusResult
      if (nextStatus.status === 'queued') queuedIds.add(sessionId)
      else queuedIds.delete(sessionId)
      if (nextStatus.status === 'deleted') {
        applyPostLogRemovalUi(sessionId)
        notifyUser(t('sessionDeletion.toastDeleted', { title: displayTitle }), true)
        publish(null)
        return
      }
      if (state?.kind === 'status' && state.sessionId === sessionId) {
        publish({
          kind: 'status',
          sessionId,
          displayTitle,
          status: nextStatus,
          busy: false,
        })
      }
    } catch (error) {
      if (state?.kind === 'status' && state.sessionId === sessionId) {
        publish({
          ...state,
          busy: false,
          errorMessage: error instanceof Error ? error.message : t('sessionDeletion.reason.SESSION_DELETION_FAILED'),
        })
      }
    }
  }

  const close = (): void => {
    if (state?.kind === 'ready' && state.busy) return
    if (state?.kind === 'status' && state.busy) return
    publish(null)
  }

  const cancelQueuedBySessionId = async (
    sessionId: string,
    displayTitle?: string,
  ): Promise<{ readonly cancelled: boolean; readonly unarchived: boolean }> => {
    try {
      let operationId = queuedOperationIds.get(sessionId)
      if (operationId === undefined) {
        const statusRes = await options.rpc.call(CODINGNS_RPC_CHANNEL, 'sessionDeletion/status', { sessionId })
        if (!statusRes.ok) return { cancelled: false, unarchived: false }
        const statusVal = statusRes.value as SessionDeletionStatusResult
        if (!statusVal.cancellable || typeof statusVal.operationId !== 'string') {
          return { cancelled: false, unarchived: false }
        }
        operationId = statusVal.operationId
      }
      const res = await options.rpc.call(CODINGNS_RPC_CHANNEL, 'sessionDeletion/cancel', { operationId })
      if (!res.ok) return { cancelled: false, unarchived: false }
      const cancelResult = res.value as SessionDeletionCancelResult
      if (!cancelResult.cancelled) return { cancelled: false, unarchived: false }
      queuedIds.delete(sessionId)
      queuedOperationIds.delete(sessionId)
      options.onQueueChanged?.(sessionId)
      notifyUser(t('sessionDeletion.toastCancelled', { title: displayTitle ?? sessionId }), true)
      if (state?.sessionId === sessionId) publish(null)
      return { cancelled: true, unarchived: cancelResult.unarchived === true }
    } catch {
      return { cancelled: false, unarchived: false }
    }
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const opId of [...activeWatchers.keys()]) clearWatcher(opId)
    state = null
  }

  return {
    getState: () => state,
    isQueued: (sessionId: string) => queuedIds.has(sessionId),
    isDeleting: (sessionId: string) => deletingIds.has(sessionId),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refreshActiveList,
    openForSession,
    setConfirmed,
    submitCommit,
    cancelQueued,
    cancelQueuedBySessionId,
    refreshStatus: () => queryStatus(false),
    retryCleanup: () => queryStatus(true),
    close,
    dispose,
  }
}

export function createSessionDeletionMenuProvider(options: {
  readonly locale?: CodingNsLocale
  readonly coordinator: SessionDeletionCoordinator
  readonly iconKey?: string
}): {
  readonly id: string
  readonly target: 'session'
  readonly order: number
  readonly resolve: (target: unknown) => readonly DshContextMenuAction[]
} {
  const t = resolveCodingNsTranslator(options.locale)
  const iconKey = options.iconKey ?? SESSION_DELETION_WORKSPACE_ICON_KEY
  return {
    id: SESSION_DELETION_MENU_ID,
    target: 'session',
    order: SESSION_DELETION_MENU_ORDER,
    resolve: (target: unknown): readonly DshContextMenuAction[] => {
      const parsed = parseSessionContextMenuTarget(target)
      if (parsed.kind === 'invalid') return []
      if (parsed.kind === 'virtual') {
        return [{
          id: 'delete',
          label: t('sessionDeletion.menuLabel'),
          icon: { key: iconKey },
          danger: true,
          separatorBefore: true,
          disabled: true,
        }]
      }
      if (options.coordinator.isDeleting(parsed.sessionId)) {
        return [{
          id: 'delete',
          label: t('sessionDeletion.menuLabelDeleting'),
          icon: { key: iconKey },
          disabled: true,
          separatorBefore: true,
        }]
      }
      const queued = options.coordinator.isQueued(parsed.sessionId)
      return [{
        id: 'delete',
        label: queued ? t('sessionDeletion.menuLabelCancelQueued') : t('sessionDeletion.menuLabel'),
        ...(queued ? {} : { icon: { key: iconKey } }),
        danger: !queued,
        separatorBefore: true,
        run: () => {
          void options.coordinator.openForSession(parsed.sessionId, parsed.displayTitle)
        },
      }]
    },
  }
}

export interface SessionDeletionControllerHandle {
  readonly coordinator: SessionDeletionCoordinator
  dispose(): void
}

export interface SessionDeleteRowButtonProps {
  readonly sessionId: string
  readonly displayTitle?: string
  readonly coordinator: SessionDeletionCoordinator
  readonly locale?: CodingNsLocale
}

/** 渲染在 DSH 会话行悬停操作区中的同款垃圾桶图标按钮。 */
export function SessionDeleteRowButton(props: SessionDeleteRowButtonProps): ReactElement | null {
  const parsed = parseSessionContextMenuTarget({
    sessionId: props.sessionId,
    displayTitle: props.displayTitle,
  })
  const t = useCodingNsTranslator(props.locale ?? fallbackReactLocale)
  const [, setVersion] = useState(0)

  useEffect(() => props.coordinator.subscribe(() => {
    setVersion((prev) => prev + 1)
  }), [props.coordinator])

  if (parsed.kind !== 'local') return null
  const deleting = props.coordinator.isDeleting(parsed.sessionId)
  const queued = props.coordinator.isQueued(parsed.sessionId)
  const label = deleting
    ? t('sessionDeletion.menuLabelDeleting')
    : queued
      ? t('sessionDeletion.menuLabelCancelQueued')
      : t('sessionDeletion.menuLabel')
  const TrashIcon = resolveTrashIcon()

  return createElement(DshTooltip, {
    label,
    side: 'bottom',
    align: 'end',
    delayMs: 500,
    portal: true,
    children: createElement('button', {
      type: 'button',
      className: SESSION_DELETION_ROW_BUTTON_CLASS,
      'aria-label': label,
      disabled: deleting,
      'data-codingns-session-deletion-row-button': parsed.sessionId,
      onClick: (event: { stopPropagation(): void }) => {
        event.stopPropagation()
        void props.coordinator.openForSession(parsed.sessionId, parsed.displayTitle)
      },
    }, createElement(TrashIcon, { size: 14 })),
  })
}

function installRowButtonStyles(doc: Document | undefined): void {
  if (doc?.head == null) return
  if (doc.querySelector(`style[data-plugin-css="${SESSION_DELETION_ROW_STYLE_ID}"]`) !== null) return
  const style = doc.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = SESSION_DELETION_ROW_STYLE_ID
  style.textContent = SESSION_DELETION_ROW_CSS
  doc.head.appendChild(style)
}

interface DynamicSlotRegistrar {
  inject(name: string, register: () => () => void): () => void
  register(declaration: Record<string, unknown>, component: unknown): () => void
}

function registerSessionDeletionSlots(
  slots: SlotRegistry,
  coordinator: SessionDeletionCoordinator,
  locale: CodingNsLocale | undefined,
  doc: Document | undefined,
): () => void {
  installRowButtonStyles(doc)
  const registrar = slots as unknown as DynamicSlotRegistrar
  const TrashIcon = resolveTrashIcon()
  const disposeMenuIcon = registrar.inject('contextMenu.icon', () => registrar.register({
    name: 'contextMenu.icon',
    key: SESSION_DELETION_MENU_ICON_KEY,
  }, TrashIcon))
  const disposeRowAction = registrar.inject('sidebar.workspaces.session.row.action', () => registrar.register({
    name: 'sidebar.workspaces.session.row.action',
    id: SESSION_DELETION_ROW_ACTION_ID,
    order: SESSION_DELETION_ROW_ACTION_ORDER,
    inject: () => ({
      coordinator,
      ...(locale === undefined ? {} : { locale }),
    }),
  }, SessionDeleteRowButton))
  return () => {
    disposeRowAction()
    disposeMenuIcon()
  }
}

export function startSessionDeletionUi(options: {
  readonly contextMenus: DshContextMenuAdapter
  readonly rpc: CodingNsRpcClient
  readonly locale?: CodingNsLocale
  readonly sessions?: unknown
  readonly uiWorkspace?: unknown
  readonly slots?: SlotRegistry
  readonly onSessionDeleted?: (sessionId: string) => void
  readonly onQueueChanged?: (sessionId: string) => void
  readonly document?: Document
}): SessionDeletionControllerHandle {
  const uiRefresh = createSessionDeletionUiRefreshAdapter(options.sessions, options.uiWorkspace)
  const coordinator = createSessionDeletionCoordinator({
    rpc: options.rpc,
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    uiRefresh,
    notify: (text, success) => options.contextMenus.notify(text, success),
    ...(options.onSessionDeleted === undefined ? {} : { onSessionDeleted: options.onSessionDeleted }),
    ...(options.onQueueChanged === undefined ? {} : { onQueueChanged: options.onQueueChanged }),
  })

  const unregisterMenu = options.contextMenus.register(createSessionDeletionMenuProvider({
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    coordinator,
    iconKey: options.slots === undefined ? SESSION_DELETION_WORKSPACE_ICON_KEY : SESSION_DELETION_MENU_ICON_KEY,
  }))

  let mountRoot: Root | undefined
  let mountContainer: HTMLElement | undefined
  const doc = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const unregisterSlots = options.slots === undefined
    ? undefined
    : registerSessionDeletionSlots(options.slots, coordinator, options.locale, doc)

  const syncMount = (): void => {
    const current = coordinator.getState()
    if (doc === undefined || doc.body === null) return
    if (current === null) {
      if (mountRoot !== undefined) {
        mountRoot.unmount()
        mountRoot = undefined
      }
      mountContainer?.remove()
      mountContainer = undefined
      return
    }
    if (mountContainer === undefined) {
      mountContainer = doc.createElement('div')
      mountContainer.dataset.codingnsSessionDeletionHost = 'true'
      doc.body.appendChild(mountContainer)
      mountRoot = createRoot(mountContainer)
    }
    mountRoot?.render(createElement(SessionDeletionDialogHost, {
      coordinator,
      ...(options.locale === undefined ? {} : { locale: options.locale }),
    }))
  }

  const unsubscribe = coordinator.subscribe(syncMount)
  void coordinator.refreshActiveList()

  return {
    coordinator,
    dispose: () => {
      unsubscribe()
      unregisterMenu()
      unregisterSlots?.()
      coordinator.dispose()
      if (mountRoot !== undefined) {
        mountRoot.unmount()
        mountRoot = undefined
      }
      mountContainer?.remove()
      mountContainer = undefined
    },
  }
}

function SessionDeletionDialogHost(props: {
  readonly coordinator: SessionDeletionCoordinator
  readonly locale?: CodingNsLocale
}): ReactElement | null {
  const t = useCodingNsTranslator(props.locale ?? fallbackReactLocale)
  const [stage, setStage] = useState<SessionDeletionDialogStage | null>(() => props.coordinator.getState())

  useEffect(() => {
    setStage(props.coordinator.getState())
    return props.coordinator.subscribe(() => setStage(props.coordinator.getState()))
  }, [props.coordinator])

  useEffect(() => {
    if (stage === null || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.coordinator.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [stage !== null, props.coordinator])

  if (stage === null) return null
  return createElement(SessionDeletionDialog, { stage, coordinator: props.coordinator, t })
}

export function SessionDeletionDialog(props: {
  readonly stage: SessionDeletionDialogStage
  readonly coordinator: SessionDeletionCoordinator
  readonly t: CodingNsTranslator
}): ReactElement {
  const { stage, coordinator, t } = props
  const isRestart = stage.kind === 'ready' && stage.prepare.mode === 'restart-required'
  const isQueuedStatus = stage.kind === 'status' && stage.status.status === 'queued'
  const titleId = 'codingns-session-deletion-dialog-title'
  const headerTitle = isQueuedStatus
    ? t('sessionDeletion.dialogTitleQueued')
    : isRestart
      ? t('sessionDeletion.dialogTitleRestart')
      : t('sessionDeletion.dialogTitle')
  const busy = (stage.kind === 'ready' || stage.kind === 'status') && stage.busy

  return createElement('div', {
    role: 'presentation',
    style: overlayStyle,
    onMouseDown: () => { if (!busy) coordinator.close() },
  },
    createElement('div', {
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': titleId,
      'data-codingns-session-deletion-dialog': stage.sessionId,
      style: modalStyle,
      onMouseDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    },
      createElement('div', { style: headerRowStyle },
        createElement('h2', { id: titleId, style: titleStyle }, headerTitle),
        createElement('button', {
          type: 'button',
          'aria-label': t('sessionDeletion.close'),
          style: closeButtonStyle,
          disabled: busy,
          onClick: () => coordinator.close(),
        }, '×'),
      ),
      createElement('div', { style: identityBlockStyle },
        createElement('div', { style: metaValueStyle }, stage.displayTitle || t('sessionDeletion.untitled')),
        createElement('code', {
          style: truncatedIdStyle,
          title: stage.sessionId,
          'aria-label': `${t('sessionDeletion.sessionIdLabel')}: ${stage.sessionId}`,
          'data-session-id': stage.sessionId,
        }, stage.sessionId),
      ),
      renderStageBody(stage, coordinator, t),
    ),
  )
}

function renderStageBody(
  stage: SessionDeletionDialogStage,
  coordinator: SessionDeletionCoordinator,
  t: CodingNsTranslator,
): ReactElement {
  if (stage.kind === 'preparing') {
    return createElement('div', { style: summaryTextStyle }, t('sessionDeletion.preparing'))
  }
  if (stage.kind === 'error') {
    return createElement('div', { style: contentStackStyle },
      createElement('div', { role: 'alert', style: errorLineStyle }, stage.message),
      createElement('div', { style: footerRowStyle },
        createElement('button', { type: 'button', style: dshSettingsButtonStyle, onClick: () => coordinator.close() }, t('sessionDeletion.close')),
      ),
    )
  }
  if (stage.kind === 'status') {
    const { status, busy, errorMessage } = stage
    const label = statusHeadline(status.status, t)
    const pendingLabels = formatCleanupItems(status.pendingCleanupItems, t)
    const isQueued = status.status === 'queued'
    const isAlert = status.status === 'failed' || status.status === 'cleanup-pending'
    return createElement('div', { style: contentStackStyle },
      createElement('div', { style: isAlert ? errorLineStyle : summaryTextStyle },
        createElement('div', { style: { fontWeight: 600, color: isAlert ? dshThemeColor.error : dshThemeColor.labelPrimary } }, label),
        isQueued
          ? createElement('div', { style: { marginTop: 4 } },
            t(status.archived === true ? 'sessionDeletion.cancelQueuedGuideArchived' : 'sessionDeletion.cancelQueuedGuide'))
          : null,
        status.message === undefined ? null : createElement('div', { style: { marginTop: 4 } }, status.message),
        pendingLabels === '' ? null : createElement('div', { style: { marginTop: 4 } }, t('sessionDeletion.pendingItemsLabel', { items: pendingLabels })),
      ),
      errorMessage === undefined ? null : createElement('div', { role: 'alert', style: errorLineStyle }, errorMessage),
      createElement('div', { style: footerRowStyle },
        createElement('button', {
          type: 'button',
          style: dshSettingsButtonStyle,
          disabled: busy,
          onClick: () => coordinator.close(),
        }, isQueued ? t('sessionDeletion.done') : t('sessionDeletion.close')),
        !isQueued && !status.retryableCleanup
          ? createElement('button', { type: 'button', style: dshSettingsButtonStyle, disabled: busy, onClick: () => { void coordinator.refreshStatus() } }, t('sessionDeletion.refreshStatusAction'))
          : null,
        status.cancellable
          ? createElement('button', {
            type: 'button',
            style: dshSettingsButtonStyle,
            disabled: busy,
            'data-codingns-session-deletion-cancel-queued': 'true',
            onClick: () => { void coordinator.cancelQueued() },
          }, busy ? t('sessionDeletion.cancellingQueued') : t('sessionDeletion.cancelQueuedAction'))
          : null,
        status.retryableCleanup
          ? createElement('button', {
            type: 'button',
            style: dangerButtonStyle,
            disabled: busy,
            onClick: () => { void coordinator.retryCleanup() },
          }, busy ? t('sessionDeletion.retryingCleanup') : t('sessionDeletion.retryCleanupAction'))
          : null,
      ),
    )
  }

  const { prepare, confirmed, busy, errorMessage } = stage
  const isUnsupported = prepare.mode === 'unsupported'
  const isRestart = prepare.mode === 'restart-required'
  const reasonText = translateReason(prepare.reasonCode, prepare.reasonMessage, t)
  const activitySummary = formatActivityReasons(prepare.activeReasons, t)

  return createElement('div', { style: contentStackStyle },
    isUnsupported
      ? createElement('div', { role: 'alert', style: errorLineStyle },
        createElement('div', { style: { fontWeight: 600 } }, t('sessionDeletion.unsupportedHeading')),
        createElement('div', { style: { marginTop: 4 } }, reasonText),
      )
      : createElement('div', { style: summaryTextStyle },
        (isRestart
          ? (activitySummary === ''
            ? t('sessionDeletion.restartSummaryNoReasons')
            : t('sessionDeletion.restartSummary', { reasons: activitySummary }))
          : t('sessionDeletion.immediateSummary'))
        + (prepare.subagentCount !== undefined && prepare.subagentCount > 0
          ? t('sessionDeletion.subagentNotice', { count: String(prepare.subagentCount) })
          : ''),
      ),
    isUnsupported
      ? null
      : createElement('label', { style: checkboxLabelStyle },
        createElement('input', {
          type: 'checkbox',
          checked: confirmed,
          disabled: busy,
          onChange: (event: { currentTarget: { checked: boolean } }) => coordinator.setConfirmed(event.currentTarget.checked),
        }),
        createElement('span', null, isRestart ? t('sessionDeletion.confirmCheckRestart') : t('sessionDeletion.confirmCheckImmediate')),
      ),
    errorMessage === undefined ? null : createElement('div', { role: 'alert', style: errorLineStyle }, errorMessage),
    createElement('div', { style: footerRowStyle },
      createElement('button', { type: 'button', style: dshSettingsButtonStyle, disabled: busy, onClick: () => coordinator.close() }, t('sessionDeletion.cancel')),
      isUnsupported
        ? null
        : createElement('button', {
          type: 'button',
          style: { ...dangerButtonStyle, opacity: !confirmed || busy ? 0.5 : 1, cursor: !confirmed || busy ? 'not-allowed' : 'pointer' },
          disabled: !confirmed || busy,
          'data-codingns-session-deletion-submit': prepare.mode,
          onClick: () => { void coordinator.submitCommit() },
        }, isRestart
          ? (busy ? t('sessionDeletion.confirmRestartBusy') : t('sessionDeletion.confirmRestartAction'))
          : (busy ? t('sessionDeletion.confirmImmediateBusy') : t('sessionDeletion.confirmImmediateAction'))),
    ),
  )
}

function statusHeadline(status: SessionDeletionStatusResult['status'], t: CodingNsTranslator): string {
  switch (status) {
    case 'queued': return t('sessionDeletion.statusQueued')
    case 'deleting': return t('sessionDeletion.statusDeleting')
    case 'cleanup-pending': return t('sessionDeletion.statusCleanupPending')
    case 'failed': return t('sessionDeletion.statusFailed')
    case 'cancelled': return t('sessionDeletion.statusCancelled')
    default: return t('sessionDeletion.existingHeading')
  }
}

function formatActivityReasons(reasons: readonly string[], t: CodingNsTranslator): string {
  const translated: string[] = []
  for (const kind of reasons) {
    const key = `sessionDeletion.activity.${kind}`
    const value = t(key)
    const label = value !== key ? value : kind
    if (!translated.includes(label)) translated.push(label)
  }
  return translated.join(' · ')
}

function translateReason(code: SessionDeletionReasonCode | undefined, fallback: string | undefined, t: CodingNsTranslator): string {
  if (code !== undefined) {
    const key = `sessionDeletion.reason.${code}`
    const translated = t(key)
    if (translated !== key) return translated
  }
  return fallback ?? t('sessionDeletion.reason.SESSION_DELETION_FAILED')
}

function formatCleanupItems(items: readonly SessionDeletionCleanupItem[], t: CodingNsTranslator): string {
  return items
    .map((item) => {
      const key = `sessionDeletion.cleanupItem.${item}`
      const translated = t(key)
      return translated !== key ? translated : item
    })
    .join(' · ')
}

const fallbackTranslator = resolveCodingNsTranslator()
const fallbackReactLocale: CodingNsLocale = {
  bind: () => fallbackTranslator,
  getSnapshot: () => ({ revision: 0, active: 'zh', locales: ['zh', 'en'] } as unknown as ReturnType<CodingNsLocale['getSnapshot']>),
  subscribe: () => () => undefined,
  register: () => () => undefined,
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const overlayStyle = { position: 'fixed' as const, inset: 0, zIndex: 2147483100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: dshThemeColor.overlay }
const modalStyle = { ...dshPopupSurfaceStyle, width: 'min(440px, 100%)', maxHeight: 'min(80vh, 520px)', overflowY: 'auto' as const, boxSizing: 'border-box' as const, display: 'grid', gap: 14, padding: '18px 20px', border: `1px solid ${dshThemeColor.menuBorder}`, borderRadius: 12 }
const headerRowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }
const titleStyle = { margin: 0, fontSize: uiFontSize(16), fontWeight: 650, color: dshThemeColor.labelPrimary }
const closeButtonStyle = { ...dshSettingsButtonStyle, border: 'none', background: 'transparent', minWidth: 28, minHeight: 28, padding: '2px 6px', lineHeight: 1, color: dshThemeColor.labelSecondary }
const identityBlockStyle = { display: 'grid', gap: 2, padding: '8px 10px', borderRadius: 8, background: dshThemeColor.surfaceSubtle }
const metaValueStyle = { fontSize: uiFontSize(13.5), fontWeight: 600, color: dshThemeColor.labelPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
const truncatedIdStyle = { display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, fontFamily: dshThemeColor.codeFont, fontSize: uiFontSize(11.5), color: dshThemeColor.labelSecondary }
const contentStackStyle = { display: 'grid', gap: 12 }
const summaryTextStyle = { fontSize: uiFontSize(12.5), lineHeight: 1.55, color: dshThemeColor.labelSecondary }
const errorLineStyle = { fontSize: uiFontSize(12.5), lineHeight: 1.5, color: dshThemeColor.error }
const checkboxLabelStyle = { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: uiFontSize(12.5), lineHeight: 1.45, color: dshThemeColor.labelPrimary, cursor: 'pointer' }
const footerRowStyle = { display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap' as const, gap: 8, paddingTop: 2 }
const dangerButtonStyle = { ...dshSettingsButtonStyle, borderColor: dshThemeColor.error, background: 'rgba(220, 38, 38, 0.14)', color: dshThemeColor.error, fontWeight: 600 }

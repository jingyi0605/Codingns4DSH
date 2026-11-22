import { parseVirtualSessionId } from './peer-host.js'

export const SESSION_DELETION_RPC_ENDPOINTS = [
  'sessionDeletion/prepare',
  'sessionDeletion/commit',
  'sessionDeletion/status',
  'sessionDeletion/cancel',
  'sessionDeletion/list',
] as const

export type SessionDeletionMode = 'immediate' | 'restart-required' | 'unsupported'

export type SessionDeletionPhase =
  | 'unknown'
  | 'deleting'
  | 'queued'
  | 'deleted'
  | 'cleanup-pending'
  | 'failed'
  | 'cancelled'

export type SessionDeletionCleanupItem =
  | 'workspace'
  | 'projection-cache'
  | 'spill'
  | 'search-index'

export type SessionDeletionSubagentStatus =
  | 'none'
  | 'has-children'
  | 'is-subagent-with-parent'
  | 'orphan-subagent'
  | 'unverified'

export type SessionDeletionReasonCode =
  | 'SESSION_DELETION_FORBIDDEN'
  | 'SESSION_DELETION_LOCAL_OWNER_REQUIRED'
  | 'SESSION_DELETION_FEATURE_DISABLED'
  | 'SESSION_DELETION_UNKNOWN_ACTION'
  | 'SESSION_DELETION_INVALID_REQUEST'
  | 'SESSION_DELETION_INVALID_SESSION_ID'
  | 'SESSION_DELETION_VIRTUAL_SESSION_UNSUPPORTED'
  | 'SESSION_DELETION_NOT_FOUND'
  | 'SESSION_DELETION_UNMATERIALIZED'
  | 'SESSION_DELETION_UNSUPPORTED_BACKEND'
  | 'SESSION_DELETION_CAPABILITY_UNAVAILABLE'
  | 'SESSION_DELETION_EXCLUSION_UNAVAILABLE'
  | 'SESSION_DELETION_STAGING_UNAVAILABLE'
  | 'SESSION_DELETION_PATH_UNSAFE'
  | 'SESSION_DELETION_DUPLICATE_LOCATION'
  | 'SESSION_DELETION_HAS_SUBAGENTS'
  | 'SESSION_DELETION_SUBAGENT_WITH_PARENT'
  | 'SESSION_DELETION_ACTIVE_TURN'
  | 'SESSION_DELETION_ACTIVE_SUBAGENT'
  | 'SESSION_DELETION_ACTIVE_JOB'
  | 'SESSION_DELETION_ACTIVE_SCHEDULE'
  | 'SESSION_DELETION_ACTIVE_WRITER'
  | 'SESSION_DELETION_LIVE_SESSION_HELD'
  | 'SESSION_DELETION_ACTIVITY_UNVERIFIED'
  | 'SESSION_DELETION_TOKEN_INVALID'
  | 'SESSION_DELETION_TOKEN_EXPIRED'
  | 'SESSION_DELETION_TOKEN_MISMATCH'
  | 'SESSION_DELETION_MODE_MISMATCH'
  | 'SESSION_DELETION_ALREADY_PENDING'
  | 'SESSION_DELETION_TARGET_CHANGED'
  | 'SESSION_DELETION_BUSY'
  | 'SESSION_DELETION_NOT_CANCELLABLE'
  | 'SESSION_DELETION_CLEANUP_PENDING'
  | 'SESSION_DELETION_FAILED'

export interface SessionDeletionStorageSummary {
  readonly logDirKnown: boolean
  readonly workspaceDetachedNeeded: boolean
  readonly projectionCacheEnabled: boolean
  readonly spillEnabled: boolean
  readonly searchEnabled: boolean
}

export interface SessionDeletionPrepareRequest {
  readonly sessionId: string
}

export interface SessionDeletionPrepareResult {
  readonly sessionId: string
  readonly title: string | null
  readonly mode: SessionDeletionMode
  readonly reasonCode?: SessionDeletionReasonCode
  readonly reasonMessage?: string
  readonly subagentStatus: SessionDeletionSubagentStatus
  readonly subagentCount?: number
  readonly activeReasons: readonly string[]
  readonly operationId?: string
  readonly expiresAt?: number
  readonly existingOperation?: SessionDeletionStatusResult
  readonly storageSummary: SessionDeletionStorageSummary
}

export interface SessionDeletionCommitRequest {
  readonly operationId: string
  readonly mode: Exclude<SessionDeletionMode, 'unsupported'>
  readonly background?: boolean
}

export interface SessionDeletionCommitResult {
  readonly operationId: string
  readonly sessionId: string
  readonly status: 'deleted' | 'deleting' | 'queued' | 'busy' | 'changed' | 'unsupported' | 'cleanup-pending' | 'failed'
  readonly archived?: boolean
  readonly code?: SessionDeletionReasonCode
  readonly message?: string
  readonly pendingCleanupItems?: readonly SessionDeletionCleanupItem[]
  readonly completedCleanupItems?: readonly SessionDeletionCleanupItem[]
}

export interface SessionDeletionStatusRequest {
  readonly operationId?: string
  readonly sessionId?: string
}

export interface SessionDeletionStatusResult {
  readonly operationId?: string
  readonly sessionId?: string
  readonly status: SessionDeletionPhase
  readonly mode?: Exclude<SessionDeletionMode, 'unsupported'>
  readonly archived?: boolean
  readonly code?: SessionDeletionReasonCode
  readonly message?: string
  readonly cancellable: boolean
  readonly retryableCleanup: boolean
  readonly pendingCleanupItems: readonly SessionDeletionCleanupItem[]
  readonly completedCleanupItems: readonly SessionDeletionCleanupItem[]
  readonly updatedAt: number
}

export interface SessionDeletionCancelRequest {
  readonly operationId: string
}

export interface SessionDeletionCancelResult {
  readonly operationId: string
  readonly sessionId: string
  readonly cancelled: boolean
  readonly unarchived?: boolean
  readonly status: SessionDeletionPhase
  readonly code?: SessionDeletionReasonCode
  readonly message?: string
}

export class SessionDeletionError extends Error {
  constructor(
    readonly code: SessionDeletionReasonCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SessionDeletionError'
  }
}

export function validateLocalSessionId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SessionDeletionError('SESSION_DELETION_INVALID_SESSION_ID', 'Session ID must be a string')
  }
  const trimmed = value.trim()
  if (
    trimmed.length === 0
    || trimmed !== value
    || trimmed === '.'
    || trimmed === '..'
    || trimmed.length > 512
    || /[\u0000-\u001F\u007F/\\]/u.test(trimmed)
  ) {
    throw new SessionDeletionError('SESSION_DELETION_INVALID_SESSION_ID', 'Session ID is invalid')
  }
  if (parseVirtualSessionId(trimmed) !== null) {
    throw new SessionDeletionError(
      'SESSION_DELETION_VIRTUAL_SESSION_UNSUPPORTED',
      'Remote PeerHost virtual sessions cannot be deleted from this Host',
    )
  }
  return trimmed
}

export function isNonEmptyToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value === value.trim()
    && value.length <= 256
    && !/[\u0000-\u001F\u007F]/u.test(value)
}

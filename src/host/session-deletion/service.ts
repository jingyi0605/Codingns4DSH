import { randomUUID } from 'node:crypto'
import { lstat, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  readImmediateDeletionAdapter,
  readPersistenceLocationAdapter,
  readRestartReplayAdapter,
  readService,
  type DshWriteLeaseHandle,
} from '../../dsh-capabilities/host/session-deletion-adapter.js'
import {
  SessionDeletionError,
  isNonEmptyToken,
  validateLocalSessionId,
  type SessionDeletionCancelRequest,
  type SessionDeletionCancelResult,
  type SessionDeletionCleanupItem,
  type SessionDeletionCommitRequest,
  type SessionDeletionCommitResult,
  type SessionDeletionMode,
  type SessionDeletionPrepareRequest,
  type SessionDeletionPrepareResult,
  type SessionDeletionStatusRequest,
  type SessionDeletionStatusResult,
} from '../../shared/contracts/session-deletion.js'
import { SessionAdmissionGuard, type SessionAdmissionReservation } from './admission-guard.js'
import { inspectSessionActivityAndLineage } from './activity-inspector.js'
import { executeDerivedCleanup, inspectAvailableCleanupPlan } from './cleanup.js'
import {
  FileSessionDeletionStore,
  PrepareTokenRegistry,
  buildIdentityEvidence,
  isActivePersistedPhase,
  isSameSessionLifecycle,
  toStatusResult,
  type CascadeDeletionTarget,
  type CascadePrepareTarget,
  type PersistedDeletionRecord,
} from './store.js'
import { isEnoent, locateAndVerifyTarget, type VerifiedTargetLocation } from './target-locator.js'

const TOKEN_TTL_MS = 5 * 60 * 1000
const DEFAULT_RESERVATION_TIMEOUT_MS = 3_000

export interface SessionDeletionServiceOptions {
  readonly dshContext: unknown
  readonly stateDirectory: string
  readonly isFeatureEnabled?: () => boolean
  readonly onSessionRemoved?: (sessionId: string) => Promise<void> | void
  readonly emitNativeRemoved?: (sessionId: string) => void
  readonly reservationTimeoutMs?: number
  readonly tokenTtlMs?: number
  readonly now?: () => number
}

export class SessionDeletionService {
  readonly instanceId = Symbol('sessionDeletionService')
  readonly admissionGuard = new SessionAdmissionGuard()
  private readonly store: FileSessionDeletionStore
  private readonly tokens = new PrepareTokenRegistry()
  private readonly sessionQueues = new Map<string, Promise<unknown>>()
  private readonly activeCommits = new Set<string>()
  private readonly backgroundStates = new Map<string, { readonly callerKey: string; readonly status: SessionDeletionStatusResult }>()
  private readonly disposeAbort = new AbortController()
  private readonly now: () => number
  private readonly reservationTimeoutMs: number
  private readonly tokenTtlMs: number
  private uninstallGuard: (() => void) | undefined
  private initialized = false
  private disposed = false

  constructor(private readonly options: SessionDeletionServiceOptions) {
    this.store = new FileSessionDeletionStore(options.stateDirectory)
    this.now = options.now ?? Date.now
    this.reservationTimeoutMs = options.reservationTimeoutMs ?? DEFAULT_RESERVATION_TIMEOUT_MS
    this.tokenTtlMs = options.tokenTtlMs ?? TOKEN_TTL_MS
  }

  async initialize(options: { readonly replayOnStartup?: boolean } = {}): Promise<void> {
    if (this.initialized || this.disposed) return
    this.initialized = true
    const location = readPersistenceLocationAdapter(this.options.dshContext)
    if (location !== undefined) {
      this.uninstallGuard = this.admissionGuard.install(location.persistence)
    }
    if (options.replayOnStartup !== false) {
      await this.replayOnStartup()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeAbort.abort()
    this.uninstallGuard?.()
    this.uninstallGuard = undefined
  }

  async prepare(
    callerKey: string,
    request: SessionDeletionPrepareRequest,
    signal?: AbortSignal,
  ): Promise<SessionDeletionPrepareResult> {
    this.assertFeatureEnabled()
    const sessionId = validateLocalSessionId(request?.sessionId)

    const activeBg = this.findActiveBackgroundBySession(sessionId)
    if (activeBg !== undefined) {
      return {
        sessionId,
        title: null,
        mode: 'unsupported',
        reasonCode: 'SESSION_DELETION_ALREADY_PENDING',
        reasonMessage: 'An active or pending deletion operation already exists for this session',
        subagentStatus: 'none',
        activeReasons: [],
        existingOperation: activeBg.status,
        storageSummary: inspectAvailableCleanupPlan({ sessionId, dshContext: this.options.dshContext }).summary,
      }
    }

    const existing = await this.store.findActiveBySessionId(sessionId)
    if (existing !== undefined) {
      return {
        sessionId,
        title: null,
        mode: 'unsupported',
        reasonCode: 'SESSION_DELETION_ALREADY_PENDING',
        reasonMessage: 'An active or pending deletion operation already exists for this session',
        subagentStatus: 'none',
        activeReasons: [],
        existingOperation: toStatusResult(existing),
        storageSummary: inspectAvailableCleanupPlan({ sessionId, dshContext: this.options.dshContext }).summary,
      }
    }

    const location = readPersistenceLocationAdapter(this.options.dshContext)
    if (location === undefined) {
      throw new SessionDeletionError(
        'SESSION_DELETION_CAPABILITY_UNAVAILABLE',
        'Session persistence location capability is unavailable on this Host',
      )
    }

    const verified = await locateAndVerifyTarget({
      persistence: location.persistence,
      root: location.root,
      sessionId,
      stateDir: this.options.stateDirectory,
      ...(signal === undefined ? {} : { signal }),
    })

    const inspection = await inspectSessionActivityAndLineage({
      sessionId,
      header: verified.header,
      persistence: location.persistence,
      dshContext: this.options.dshContext,
      admissionGuard: this.admissionGuard,
      ...(signal === undefined ? {} : { signal }),
    })

    const title = await this.readSessionTitle(sessionId, verified.header)
    const cleanupPlan = inspectAvailableCleanupPlan({ sessionId, dshContext: this.options.dshContext })
    const immediateAdapter = readImmediateDeletionAdapter(this.options.dshContext)
    const restartAdapter = readRestartReplayAdapter(this.options.dshContext)

    let mode: SessionDeletionMode
    let reasonCode = inspection.blockingReasonCode
    let reasonMessage = inspection.blockingMessage

    const cascadePrepareTargets: CascadePrepareTarget[] = []
    let childVerificationCode: SessionDeletionPrepareResult['reasonCode']
    let childVerificationMessage: string | undefined
    let hasUnmaterializedChild = false

    if (inspection.subagentStatus !== 'is-subagent-with-parent') {
      for (const descendantId of inspection.descendantSubagentIds) {
        try {
          const verifiedChild = await locateAndVerifyTarget({
            persistence: location.persistence,
            root: location.root,
            sessionId: descendantId,
            stateDir: this.options.stateDirectory,
            ...(signal === undefined ? {} : { signal }),
          })
          const childCleanup = inspectAvailableCleanupPlan({ sessionId: descendantId, dshContext: this.options.dshContext })
          cascadePrepareTargets.push({
            sessionId: descendantId,
            identity: buildIdentityEvidence(verifiedChild.header),
            revision: verifiedChild.revision,
            expectedCleanupItems: [...childCleanup.items],
          })
        } catch (error) {
          if (error instanceof SessionDeletionError && (error.code === 'SESSION_DELETION_UNMATERIALIZED' || error.code === 'SESSION_DELETION_NOT_FOUND')) {
            hasUnmaterializedChild = true
          } else {
            childVerificationCode = error instanceof SessionDeletionError ? error.code : 'SESSION_DELETION_FAILED'
            childVerificationMessage = error instanceof Error ? error.message : String(error)
            break
          }
        }
      }
      if (cascadePrepareTargets.length > 0) {
        cascadePrepareTargets.push({
          sessionId,
          identity: buildIdentityEvidence(verified.header),
          revision: verified.revision,
          expectedCleanupItems: [...cleanupPlan.items],
        })
      }
    }

    if (inspection.subagentStatus === 'is-subagent-with-parent') {
      mode = 'unsupported'
    } else if (childVerificationCode !== undefined) {
      mode = 'unsupported'
      reasonCode = childVerificationCode
      reasonMessage = childVerificationMessage
    } else if (inspection.activityUnverified) {
      mode = 'unsupported'
    } else if (hasUnmaterializedChild || inspection.activeReasons.length > 0) {
      if (restartAdapter !== undefined && this.admissionGuard.isInstalled) {
        mode = 'restart-required'
        if (hasUnmaterializedChild && reasonCode === undefined) {
          reasonCode = 'SESSION_DELETION_ACTIVE_SUBAGENT'
          reasonMessage = 'Child subagent session is not yet materialized; restart-time deletion may be queued'
        }
      } else {
        mode = 'unsupported'
        reasonCode = 'SESSION_DELETION_CAPABILITY_UNAVAILABLE'
        reasonMessage = 'Session is held by runtime activity and restart-replay deletion is unavailable'
      }
    } else if (immediateAdapter !== undefined && this.admissionGuard.isInstalled) {
      mode = 'immediate'
      reasonCode = undefined
      reasonMessage = undefined
    } else if (restartAdapter !== undefined && this.admissionGuard.isInstalled) {
      mode = 'restart-required'
      reasonCode = 'SESSION_DELETION_EXCLUSION_UNAVAILABLE'
      reasonMessage = 'Immediate exclusive deletion is unavailable; restart-time deletion may be queued'
    } else {
      mode = 'unsupported'
      reasonCode = 'SESSION_DELETION_EXCLUSION_UNAVAILABLE'
      reasonMessage = 'Cannot prove safe exclusive session deletion on this Host deployment'
    }

    const subagentCount = inspection.descendantSubagentIds.length
    if (mode === 'unsupported') {
      return {
        sessionId,
        title,
        mode,
        ...(reasonCode === undefined ? {} : { reasonCode }),
        ...(reasonMessage === undefined ? {} : { reasonMessage }),
        subagentStatus: inspection.subagentStatus,
        ...(subagentCount > 0 ? { subagentCount } : {}),
        activeReasons: inspection.activeReasons,
        storageSummary: cleanupPlan.summary,
      }
    }

    const operationId = randomUUID()
    const expiresAt = this.now() + this.tokenTtlMs
    this.tokens.issue({
      operationId,
      callerKey,
      sessionId,
      mode,
      identity: buildIdentityEvidence(verified.header),
      revision: verified.revision,
      instanceId: this.instanceId,
      expiresAt,
      expectedCleanupItems: [...cleanupPlan.items],
      ...(cascadePrepareTargets.length > 0 ? { cascadeTargets: cascadePrepareTargets } : {}),
      consumed: false,
    })

    return {
      sessionId,
      title,
      mode,
      ...(reasonCode === undefined ? {} : { reasonCode }),
      ...(reasonMessage === undefined ? {} : { reasonMessage }),
      subagentStatus: inspection.subagentStatus,
      ...(subagentCount > 0 ? { subagentCount } : {}),
      activeReasons: inspection.activeReasons,
      operationId,
      expiresAt,
      storageSummary: cleanupPlan.summary,
    }
  }

  async commit(
    callerKey: string,
    request: SessionDeletionCommitRequest,
    signal?: AbortSignal,
  ): Promise<SessionDeletionCommitResult> {
    this.assertFeatureEnabled()
    if (!isNonEmptyToken(request?.operationId) || (request.mode !== 'immediate' && request.mode !== 'restart-required')) {
      throw new SessionDeletionError('SESSION_DELETION_INVALID_REQUEST', 'Invalid commit request')
    }
    const { operationId, mode } = request
    const token = this.tokens.get(operationId)
    if (token === undefined) {
      const existing = await this.store.readRecord(operationId)
      if (existing !== undefined) {
        if (existing.callerKey !== callerKey) {
          throw new SessionDeletionError('SESSION_DELETION_FORBIDDEN', 'Operation belongs to another caller')
        }
        return this.recordToCommitResult(existing)
      }
      throw new SessionDeletionError('SESSION_DELETION_TOKEN_INVALID', 'Confirmation token is unknown or expired')
    }
    if (token.callerKey !== callerKey) {
      throw new SessionDeletionError('SESSION_DELETION_FORBIDDEN', 'Confirmation token belongs to another caller')
    }
    if (token.instanceId !== this.instanceId) {
      throw new SessionDeletionError('SESSION_DELETION_TOKEN_MISMATCH', 'Confirmation token is from another service instance')
    }
    if (token.mode !== mode) {
      throw new SessionDeletionError('SESSION_DELETION_MODE_MISMATCH', 'Requested deletion mode does not match confirmation')
    }
    if (token.consumed) {
      const existing = await this.store.readRecord(operationId)
      if (existing !== undefined) return this.recordToCommitResult(existing)
      throw new SessionDeletionError('SESSION_DELETION_ALREADY_PENDING', 'Confirmation token was already used')
    }
    if (this.now() > token.expiresAt) {
      throw new SessionDeletionError('SESSION_DELETION_TOKEN_EXPIRED', 'Confirmation token has expired')
    }

    token.consumed = true

    if (mode === 'immediate' && request.background === true) {
      const activeBg = this.findActiveBackgroundBySession(token.sessionId)
      if (activeBg !== undefined) {
        return {
          operationId: activeBg.status.operationId ?? operationId,
          sessionId: token.sessionId,
          status: 'busy',
          code: 'SESSION_DELETION_ALREADY_PENDING',
          message: 'Another deletion operation is already pending for this session',
        }
      }
      const activeForSession = await this.store.findActiveBySessionId(token.sessionId)
      if (activeForSession !== undefined) {
        return {
          operationId: activeForSession.operationId,
          sessionId: token.sessionId,
          status: 'busy',
          code: 'SESSION_DELETION_ALREADY_PENDING',
          message: 'Another deletion operation is already pending for this session',
        }
      }
      const immediateAdapter = readImmediateDeletionAdapter(this.options.dshContext)
      if (immediateAdapter === undefined || !this.admissionGuard.isInstalled) {
        return {
          operationId,
          sessionId: token.sessionId,
          status: 'unsupported',
          code: 'SESSION_DELETION_EXCLUSION_UNAVAILABLE',
          message: 'Exclusive session deletion is unavailable on this Host',
        }
      }

      const initialStatus: SessionDeletionStatusResult = {
        operationId,
        sessionId: token.sessionId,
        status: 'deleting',
        mode: 'immediate',
        cancellable: false,
        retryableCleanup: false,
        pendingCleanupItems: [...token.expectedCleanupItems],
        completedCleanupItems: [],
        updatedAt: this.now(),
      }
      this.recordBackgroundState(callerKey, initialStatus)
      void this.serializeSession(token.sessionId, async () => {
        try {
          const duplicate = await this.store.findActiveBySessionId(token.sessionId)
          if (duplicate !== undefined) {
            this.recordBackgroundState(callerKey, {
              ...initialStatus,
              status: 'failed',
              code: 'SESSION_DELETION_ALREADY_PENDING',
              message: 'Another deletion operation is already pending for this session',
              updatedAt: this.now(),
            })
            return
          }
          const result = await this.executeDeletionTransaction({
            operationId,
            callerKey,
            mode: 'immediate',
            sessionId: token.sessionId,
            expectedIdentity: token.identity,
            expectedRevision: token.revision,
            cleanupItems: token.expectedCleanupItems,
            ...(token.cascadeTargets === undefined ? {} : { expectedCascade: token.cascadeTargets }),
            requestedAt: this.now(),
            signal: this.disposeAbort.signal,
          })
          this.recordBackgroundState(callerKey, this.commitResultToStatus(result))
        } catch (error) {
          this.recordBackgroundState(callerKey, {
            ...initialStatus,
            status: 'failed',
            code: error instanceof SessionDeletionError ? error.code : 'SESSION_DELETION_FAILED',
            message: error instanceof Error ? error.message : String(error),
            updatedAt: this.now(),
          })
        }
      })

      return {
        operationId,
        sessionId: token.sessionId,
        status: 'deleting',
      }
    }

    return this.serializeSession(token.sessionId, async () => {
      const activeForSession = await this.store.findActiveBySessionId(token.sessionId)
      if (activeForSession !== undefined) {
        return {
          operationId: activeForSession.operationId,
          sessionId: token.sessionId,
          status: 'busy',
          code: 'SESSION_DELETION_ALREADY_PENDING',
          message: 'Another deletion operation is already pending for this session',
        }
      }

      const location = readPersistenceLocationAdapter(this.options.dshContext)
      if (location === undefined) {
        return {
          operationId,
          sessionId: token.sessionId,
          status: 'unsupported',
          code: 'SESSION_DELETION_CAPABILITY_UNAVAILABLE',
          message: 'Session persistence location is unavailable',
        }
      }

      if (mode === 'restart-required') {
        const restartAdapter = readRestartReplayAdapter(this.options.dshContext)
        if (restartAdapter === undefined || !this.admissionGuard.isInstalled) {
          return {
            operationId,
            sessionId: token.sessionId,
            status: 'unsupported',
            code: 'SESSION_DELETION_CAPABILITY_UNAVAILABLE',
            message: 'Restart-replay deletion is not supported on this Host',
          }
        }
        const verified = await locateAndVerifyTarget({
          persistence: location.persistence,
          root: location.root,
          sessionId: token.sessionId,
          stateDir: this.options.stateDirectory,
          ...(signal === undefined ? {} : { signal }),
        })
        if (!isSameSessionLifecycle(token.identity, verified.header)) {
          return {
            operationId,
            sessionId: token.sessionId,
            status: 'changed',
            code: 'SESSION_DELETION_TARGET_CHANGED',
            message: 'Session identity changed before queuing deletion',
          }
        }
        const inspection = await inspectSessionActivityAndLineage({
          sessionId: token.sessionId,
          header: verified.header,
          persistence: location.persistence,
          dshContext: this.options.dshContext,
          admissionGuard: this.admissionGuard,
          ...(signal === undefined ? {} : { signal }),
        })
        if (inspection.subagentStatus === 'is-subagent-with-parent') {
          return {
            operationId,
            sessionId: token.sessionId,
            status: 'unsupported',
            ...(inspection.blockingReasonCode === undefined ? {} : { code: inspection.blockingReasonCode }),
            ...(inspection.blockingMessage === undefined ? {} : { message: inspection.blockingMessage }),
          }
        }
        const cascadeTargets: CascadeDeletionTarget[] = []
        if (inspection.descendantSubagentIds.length > 0) {
          for (let index = 0; index < inspection.descendantSubagentIds.length; index += 1) {
            const childId = inspection.descendantSubagentIds[index]!
            try {
              const verifiedChild = await locateAndVerifyTarget({
                persistence: location.persistence,
                root: location.root,
                sessionId: childId,
                stateDir: this.options.stateDirectory,
                ...(signal === undefined ? {} : { signal }),
              })
              const childCleanup = inspectAvailableCleanupPlan({ sessionId: childId, dshContext: this.options.dshContext })
              cascadeTargets.push({
                sessionId: childId,
                identity: buildIdentityEvidence(verifiedChild.header),
                sessionDir: verifiedChild.sessionDir,
                stagingDir: join(verified.stagingRoot, `${operationId}__${index}`),
                pendingCleanupItems: [...childCleanup.items],
                completedCleanupItems: [],
              })
            } catch (error) {
              if (!(error instanceof SessionDeletionError) || (error.code !== 'SESSION_DELETION_UNMATERIALIZED' && error.code !== 'SESSION_DELETION_NOT_FOUND')) {
                return {
                  operationId,
                  sessionId: token.sessionId,
                  status: 'unsupported',
                  code: error instanceof SessionDeletionError ? error.code : 'SESSION_DELETION_FAILED',
                  message: error instanceof Error ? error.message : String(error),
                }
              }
            }
          }
          cascadeTargets.push({
            sessionId: token.sessionId,
            identity: token.identity,
            sessionDir: verified.sessionDir,
            stagingDir: join(verified.stagingRoot, operationId),
            pendingCleanupItems: [...token.expectedCleanupItems],
            completedCleanupItems: [],
          })
        }
        const now = this.now()
        const queuedRecord: PersistedDeletionRecord = {
          operationId,
          sessionId: token.sessionId,
          callerKey,
          mode: 'restart-required',
          phase: 'queued',
          identity: token.identity,
          backend: {
            kind: 'jsonl',
            root: verified.realRoot,
            rootDev: String(verified.rootDev),
            rootIno: String(verified.rootIno),
          },
          paths: {
            sessionDir: verified.sessionDir,
            stagingDir: join(verified.stagingRoot, operationId),
          },
          requestedAt: now,
          updatedAt: now,
          pendingCleanupItems: [...token.expectedCleanupItems],
          completedCleanupItems: [],
          ...(cascadeTargets.length > 0 ? { cascadeTargets } : {}),
        }
        await this.store.writeRecord(queuedRecord)
        let archivedForDeletion = false
        const workspaceRegistry = readService(this.options.dshContext, 'workspaceRegistry') as {
          readonly archivedSessionIds?: readonly string[]
          archiveSession?(id: string, options?: { readonly stopActivity?: boolean }): Promise<void>
        } | undefined
        if (workspaceRegistry !== undefined && typeof workspaceRegistry.archiveSession === 'function') {
          const alreadyArchived = Array.isArray(workspaceRegistry.archivedSessionIds)
            && workspaceRegistry.archivedSessionIds.includes(token.sessionId)
          if (!alreadyArchived) {
            const archiveWithFallback = async (): Promise<boolean> => {
              try {
                await workspaceRegistry.archiveSession!(token.sessionId)
                return true
              } catch (error) {
                if ((error as { readonly name?: unknown })?.name === 'WorkspaceActiveSessionError') {
                  try {
                    await workspaceRegistry.archiveSession!(token.sessionId, { stopActivity: true })
                    return true
                  } catch {
                    return false
                  }
                }
                return false
              }
            }
            if (await archiveWithFallback()) {
              archivedForDeletion = true
              await this.store.writeRecord({
                ...queuedRecord,
                archivedForDeletion: true,
              })
            }
          }
        }
        return {
          operationId,
          sessionId: token.sessionId,
          status: 'queued',
          ...(archivedForDeletion ? { archived: true } : {}),
        }
      }

      // Immediate mode execution under admission reservation + cross-process write lease.
      return this.executeDeletionTransaction({
        operationId,
        callerKey,
        mode: 'immediate',
        sessionId: token.sessionId,
        expectedIdentity: token.identity,
        expectedRevision: token.revision,
        cleanupItems: token.expectedCleanupItems,
        ...(token.cascadeTargets === undefined ? {} : { expectedCascade: token.cascadeTargets }),
        requestedAt: this.now(),
        ...(signal === undefined ? {} : { signal }),
      })
    })
  }

  async status(
    callerKey: string,
    request: SessionDeletionStatusRequest & { readonly retryCleanup?: boolean },
    signal?: AbortSignal,
  ): Promise<SessionDeletionStatusResult> {
    if (isNonEmptyToken(request?.operationId)) {
      const bg = this.backgroundStates.get(request.operationId)
      if (bg !== undefined) {
        if (bg.callerKey !== callerKey) {
          throw new SessionDeletionError('SESSION_DELETION_FORBIDDEN', 'Status belongs to another caller')
        }
        if (bg.status.status === 'deleting') {
          return bg.status
        }
      }
    } else if (request?.sessionId !== undefined) {
      const validatedId = validateLocalSessionId(request.sessionId)
      const activeBg = this.findActiveBackgroundBySession(validatedId)
      if (activeBg !== undefined) {
        if (activeBg.callerKey !== callerKey) {
          throw new SessionDeletionError('SESSION_DELETION_FORBIDDEN', 'Status belongs to another caller')
        }
        return activeBg.status
      }
    }

    let record: PersistedDeletionRecord | undefined
    if (isNonEmptyToken(request?.operationId)) {
      record = await this.store.readRecord(request.operationId)
    } else if (request?.sessionId !== undefined) {
      const sessionId = validateLocalSessionId(request.sessionId)
      record = await this.store.findLatestBySessionId(sessionId)
    } else {
      throw new SessionDeletionError('SESSION_DELETION_INVALID_REQUEST', 'Either operationId or sessionId is required')
    }

    if (record === undefined) {
      if (isNonEmptyToken(request?.operationId)) {
        const bg = this.backgroundStates.get(request.operationId)
        if (bg !== undefined) {
          if (bg.callerKey !== callerKey) {
            throw new SessionDeletionError('SESSION_DELETION_FORBIDDEN', 'Status belongs to another caller')
          }
          return bg.status
        }
      }
      return {
        ...(isNonEmptyToken(request?.operationId) ? { operationId: request.operationId } : {}),
        ...(typeof request?.sessionId === 'string' ? { sessionId: request.sessionId } : {}),
        status: 'unknown',
        cancellable: false,
        retryableCleanup: false,
        pendingCleanupItems: [],
        completedCleanupItems: [],
        updatedAt: this.now(),
      }
    }

    if (record.callerKey !== callerKey) {
      throw new SessionDeletionError('SESSION_DELETION_FORBIDDEN', 'Status belongs to another caller')
    }

    if (request.retryCleanup === true && record.phase === 'cleanup-pending') {
      const retried = await this.serializeSession(record.sessionId, () => this.retryPendingCleanupRecord(record, signal))
      return toStatusResult(retried)
    }

    return toStatusResult(record)
  }

  async list(callerKey: string): Promise<readonly SessionDeletionStatusResult[]> {
    this.assertFeatureEnabled()
    const records = await this.store.listRecords()
    const byOpId = new Map<string, SessionDeletionStatusResult>()
    for (const record of records) {
      if (
        record.callerKey === callerKey
        && (record.phase === 'queued' || record.phase === 'cleanup-pending' || record.phase === 'committing' || record.phase === 'log-removed')
      ) {
        byOpId.set(record.operationId, toStatusResult(record))
      }
    }
    for (const [opId, entry] of this.backgroundStates) {
      if (entry.callerKey === callerKey && entry.status.status === 'deleting') {
        byOpId.set(opId, entry.status)
      }
    }
    return [...byOpId.values()]
  }

  async cancel(
    callerKey: string,
    request: SessionDeletionCancelRequest,
  ): Promise<SessionDeletionCancelResult> {
    if (!isNonEmptyToken(request?.operationId)) {
      throw new SessionDeletionError('SESSION_DELETION_INVALID_REQUEST', 'Invalid operationId')
    }
    const existing = await this.store.readRecord(request.operationId)
    if (existing === undefined) {
      throw new SessionDeletionError('SESSION_DELETION_TOKEN_INVALID', 'No deletion operation found for operationId')
    }
    if (existing.callerKey !== callerKey) {
      throw new SessionDeletionError('SESSION_DELETION_FORBIDDEN', 'Only the authorizing caller can cancel this operation')
    }
    return this.serializeSession(existing.sessionId, async () => {
      const latest = await this.store.readRecord(request.operationId)
      if (latest === undefined) {
        throw new SessionDeletionError('SESSION_DELETION_TOKEN_INVALID', 'Operation no longer exists')
      }
      if (latest.phase !== 'queued' || this.activeCommits.has(latest.operationId)) {
        return {
          operationId: latest.operationId,
          sessionId: latest.sessionId,
          cancelled: false,
          status: toStatusResult(latest).status,
          code: 'SESSION_DELETION_NOT_CANCELLABLE',
          message: 'Only queued operations that have not started irreversible deletion can be cancelled',
        }
      }
      const cancelledRecord: PersistedDeletionRecord = {
        ...latest,
        phase: 'cancelled',
        updatedAt: this.now(),
      }
      await this.store.writeRecord(cancelledRecord)
      let unarchived = false
      if (latest.archivedForDeletion === true) {
        const workspaceRegistry = readService(this.options.dshContext, 'workspaceRegistry') as {
          unarchiveSession?(id: string): Promise<void>
        } | undefined
        if (typeof workspaceRegistry?.unarchiveSession === 'function') {
          try {
            await workspaceRegistry.unarchiveSession(latest.sessionId)
            unarchived = true
          } catch {
            // Cancellation itself is already persisted; ignore best-effort unarchive failure.
          }
        }
      }
      return {
        operationId: cancelledRecord.operationId,
        sessionId: cancelledRecord.sessionId,
        cancelled: true,
        ...(unarchived ? { unarchived: true } : {}),
        status: 'cancelled',
      }
    })
  }

  async replayOnStartup(signal?: AbortSignal): Promise<void> {
    if (this.disposed) return
    const records = await this.store.listRecords()
    for (const record of records) {
      if (record.phase === 'completed' || record.phase === 'cancelled' || record.phase === 'failed') continue
      await this.serializeSession(record.sessionId, async () => {
        const latest = await this.store.readRecord(record.operationId)
        if (latest === undefined || !isActivePersistedPhase(latest.phase)) return
        await this.replaySingleRecord(latest, signal)
      })
    }
  }

  private async replaySingleRecord(record: PersistedDeletionRecord, signal?: AbortSignal): Promise<void> {
    const location = readPersistenceLocationAdapter(this.options.dshContext)
    if (location === undefined) return
    let rootStat
    try {
      rootStat = await lstat(location.root)
    } catch {
      return
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return
    const { realpath } = await import('node:fs/promises')
    const currentRealRoot = await realpath(location.root)
    if (
      currentRealRoot !== record.backend.root
      || String(rootStat.dev) !== record.backend.rootDev
      || String(rootStat.ino) !== record.backend.rootIno
    ) {
      await this.store.writeRecord({
        ...record,
        phase: 'failed',
        updatedAt: this.now(),
        lastErrorCode: 'SESSION_DELETION_TARGET_CHANGED',
        lastErrorMessage: 'Persistence backend root changed since deletion was recorded',
      })
      return
    }

    if (record.phase === 'cleanup-pending') {
      await this.retryPendingCleanupRecord(record, signal)
      return
    }

    if (record.phase === 'log-removed') {
      await this.finishLogRemovedRecord(record, signal)
      return
    }

    if (record.phase === 'committing') {
      const targets = record.cascadeTargets !== undefined && record.cascadeTargets.length > 0
        ? record.cascadeTargets
        : [{ sessionId: record.sessionId, sessionDir: record.paths.sessionDir, stagingDir: record.paths.stagingDir }]
      let anyOriginExists = false
      let anyStagingExists = false
      for (const target of targets) {
        if (await pathExists(target.sessionDir)) anyOriginExists = true
        if (await pathExists(target.stagingDir)) anyStagingExists = true
      }
      if (!anyOriginExists && anyStagingExists) {
        const movedRecord: PersistedDeletionRecord = {
          ...record,
          phase: 'log-removed',
          updatedAt: this.now(),
        }
        await this.store.writeRecord(movedRecord)
        await this.finishLogRemovedRecord(movedRecord, signal)
        return
      }
      if (!anyOriginExists && !anyStagingExists) {
        let anyPresent = false
        for (const target of targets) {
          const stat = await location.persistence.stat(target.sessionId, signal === undefined ? undefined : { signal })
          if (stat !== undefined) {
            anyPresent = true
            break
          }
        }
        if (!anyPresent) {
          const movedRecord: PersistedDeletionRecord = {
            ...record,
            phase: 'log-removed',
            updatedAt: this.now(),
          }
          await this.store.writeRecord(movedRecord)
          await this.finishLogRemovedRecord(movedRecord, signal)
          return
        }
        await this.store.writeRecord({
          ...record,
          phase: 'failed',
          updatedAt: this.now(),
          lastErrorCode: 'SESSION_DELETION_TARGET_CHANGED',
          lastErrorMessage: 'Target session state diverged during crash recovery',
        })
        return
      }
      // At least one origin still exists while committing: verify identity & execute remaining targets if safe.
    }

    // phase === 'queued' (or 'committing' where origin still exists before rename)
    const restartAdapter = readRestartReplayAdapter(this.options.dshContext)
    if (restartAdapter === undefined || !this.admissionGuard.isInstalled) {
      return
    }

    const expectedCascade = record.cascadeTargets?.map((target) => ({
      sessionId: target.sessionId,
      identity: target.identity,
      revision: '',
      expectedCleanupItems: target.pendingCleanupItems,
    }))
    const result = await this.executeDeletionTransaction({
      operationId: record.operationId,
      callerKey: record.callerKey,
      mode: record.mode,
      sessionId: record.sessionId,
      expectedIdentity: record.identity,
      // Queued operations explicitly allow legal appends between queueing and restart as long as identity matches.
      expectedRevision: undefined,
      cleanupItems: record.pendingCleanupItems,
      ...(expectedCascade === undefined ? {} : { expectedCascade }),
      allowPartiallyMovedOrigin: record.phase === 'committing',
      requestedAt: record.requestedAt,
      ...(signal === undefined ? {} : { signal }),
    })

    // For queued startup replay, if a writer or live session still holds it at startup, keep 'queued' rather than failing permanently.
    if (record.phase === 'queued') {
      if (result.status === 'busy') {
        await this.store.writeRecord({
          ...record,
          updatedAt: this.now(),
          ...(result.code === undefined ? {} : { lastErrorCode: result.code }),
          ...(result.message === undefined ? {} : { lastErrorMessage: result.message }),
        })
      } else if (result.status === 'changed' || result.status === 'unsupported' || result.status === 'failed') {
        await this.store.writeRecord({
          ...record,
          phase: 'failed',
          updatedAt: this.now(),
          ...(result.code === undefined ? {} : { lastErrorCode: result.code }),
          ...(result.message === undefined ? {} : { lastErrorMessage: result.message }),
        })
      }
    }
  }

  private async finishLogRemovedRecord(
    record: PersistedDeletionRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const location = readPersistenceLocationAdapter(this.options.dshContext)
    if (location === undefined) return
    const dirTargets = record.cascadeTargets !== undefined && record.cascadeTargets.length > 0
      ? record.cascadeTargets
      : [{ sessionId: record.sessionId, sessionDir: record.paths.sessionDir, stagingDir: record.paths.stagingDir }]
    try {
      for (const target of dirTargets) {
        await rm(target.stagingDir, { recursive: true, force: true })
        await assertPathAbsent(target.sessionDir)
        await assertPathAbsent(target.stagingDir)
      }
    } catch (error) {
      await this.store.writeRecord({
        ...record,
        phase: 'failed',
        updatedAt: this.now(),
        lastErrorCode: 'SESSION_DELETION_FAILED',
        lastErrorMessage: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const cleanupRecord: PersistedDeletionRecord = {
      ...record,
      phase: 'cleanup-pending',
      updatedAt: this.now(),
    }
    await this.store.writeRecord(cleanupRecord)
    await this.retryPendingCleanupRecord(cleanupRecord, signal)
  }

  private async retryPendingCleanupRecord(
    record: PersistedDeletionRecord,
    signal?: AbortSignal,
  ): Promise<PersistedDeletionRecord> {
    const location = readPersistenceLocationAdapter(this.options.dshContext)
    if (location === undefined) return record
    try {
      if (record.cascadeTargets !== undefined && record.cascadeTargets.length > 0) {
        const updatedTargets: CascadeDeletionTarget[] = []
        const allErrors: string[] = []
        const completedUnion = new Set<SessionDeletionCleanupItem>(record.completedCleanupItems)
        const pendingUnion = new Set<SessionDeletionCleanupItem>()

        for (const target of record.cascadeTargets) {
          const cleanup = target.pendingCleanupItems.length === 0
            ? { completed: [] as SessionDeletionCleanupItem[], pending: [] as SessionDeletionCleanupItem[], errors: [] as string[] }
            : await executeDerivedCleanup({
              sessionId: target.sessionId,
              items: target.pendingCleanupItems,
              persistence: location.persistence,
              dshContext: this.options.dshContext,
              onWorkspaceDetached: () => { this.options.emitNativeRemoved?.(target.sessionId) },
              ...(this.options.onSessionRemoved === undefined ? {} : { onSessionRemoved: this.options.onSessionRemoved }),
              ...(signal === undefined ? {} : { signal }),
            })
          this.options.emitNativeRemoved?.(target.sessionId)
          for (const item of cleanup.completed) completedUnion.add(item)
          for (const item of cleanup.pending) pendingUnion.add(item)
          allErrors.push(...cleanup.errors)
          updatedTargets.push({
            ...target,
            completedCleanupItems: [...new Set([...target.completedCleanupItems, ...cleanup.completed])],
            pendingCleanupItems: [...cleanup.pending],
          })
        }

        const pendingList = [...pendingUnion]
        const baseRecord: PersistedDeletionRecord = {
          operationId: record.operationId,
          sessionId: record.sessionId,
          callerKey: record.callerKey,
          mode: record.mode,
          phase: pendingList.length === 0 ? 'completed' : 'cleanup-pending',
          identity: record.identity,
          backend: record.backend,
          paths: record.paths,
          requestedAt: record.requestedAt,
          updatedAt: this.now(),
          completedCleanupItems: [...completedUnion],
          pendingCleanupItems: pendingList,
          cascadeTargets: updatedTargets,
        }
        const next: PersistedDeletionRecord = pendingList.length === 0
          ? baseRecord
          : {
            ...baseRecord,
            lastErrorCode: 'SESSION_DELETION_CLEANUP_PENDING',
            lastErrorMessage: allErrors.join('; '),
          }
        await this.store.writeRecord(next)
        return next
      }

      const cleanup = await executeDerivedCleanup({
        sessionId: record.sessionId,
        items: record.pendingCleanupItems,
        persistence: location.persistence,
        dshContext: this.options.dshContext,
        onWorkspaceDetached: () => { this.options.emitNativeRemoved?.(record.sessionId) },
        ...(this.options.onSessionRemoved === undefined ? {} : { onSessionRemoved: this.options.onSessionRemoved }),
        ...(signal === undefined ? {} : { signal }),
      })
      this.options.emitNativeRemoved?.(record.sessionId)
      const completedAll = [...new Set([...record.completedCleanupItems, ...cleanup.completed])]
      const baseRecord: PersistedDeletionRecord = {
        operationId: record.operationId,
        sessionId: record.sessionId,
        callerKey: record.callerKey,
        mode: record.mode,
        phase: cleanup.pending.length === 0 ? 'completed' : 'cleanup-pending',
        identity: record.identity,
        backend: record.backend,
        paths: record.paths,
        requestedAt: record.requestedAt,
        updatedAt: this.now(),
        completedCleanupItems: completedAll,
        pendingCleanupItems: cleanup.pending.length === 0 ? [] : [...cleanup.pending],
      }
      const next: PersistedDeletionRecord = cleanup.pending.length === 0
        ? baseRecord
        : {
          ...baseRecord,
          lastErrorCode: 'SESSION_DELETION_CLEANUP_PENDING',
          lastErrorMessage: cleanup.errors.join('; '),
        }
      await this.store.writeRecord(next)
      return next
    } catch (error) {
      const code = error instanceof SessionDeletionError ? error.code : 'SESSION_DELETION_CLEANUP_PENDING'
      const next: PersistedDeletionRecord = {
        ...record,
        phase: error instanceof SessionDeletionError && error.code === 'SESSION_DELETION_TARGET_CHANGED' ? 'failed' : 'cleanup-pending',
        updatedAt: this.now(),
        lastErrorCode: code,
        lastErrorMessage: error instanceof Error ? error.message : String(error),
      }
      await this.store.writeRecord(next)
      return next
    }
  }

  private async executeDeletionTransaction(input: {
    readonly operationId: string
    readonly callerKey: string
    readonly mode: Exclude<SessionDeletionMode, 'unsupported'>
    readonly sessionId: string
    readonly expectedIdentity: PersistedDeletionRecord['identity']
    readonly expectedRevision: string | undefined
    readonly cleanupItems: readonly SessionDeletionCleanupItem[]
    readonly expectedCascade?: readonly CascadePrepareTarget[]
    readonly allowPartiallyMovedOrigin?: boolean
    readonly requestedAt: number
    readonly signal?: AbortSignal
  }): Promise<SessionDeletionCommitResult> {
    const {
      operationId,
      callerKey,
      mode,
      sessionId,
      expectedIdentity,
      expectedRevision,
      cleanupItems,
      expectedCascade,
      allowPartiallyMovedOrigin,
      requestedAt,
      signal,
    } = input

    const adapter = readImmediateDeletionAdapter(this.options.dshContext)
    if (adapter === undefined || !this.admissionGuard.isInstalled) {
      return {
        operationId,
        sessionId,
        status: 'unsupported',
        code: 'SESSION_DELETION_EXCLUSION_UNAVAILABLE',
        message: 'Exclusive session deletion is unavailable on this Host',
      }
    }

    const reservations: SessionAdmissionReservation[] = []
    const leases: DshWriteLeaseHandle[] = []
    this.activeCommits.add(operationId)
    try {
      const initialRoot = await locateAndVerifyTarget({
        persistence: adapter.persistence,
        root: adapter.root,
        sessionId,
        stateDir: this.options.stateDirectory,
        ...(signal === undefined ? {} : { signal }),
      })
      const initialInspection = await inspectSessionActivityAndLineage({
        sessionId,
        header: initialRoot.header,
        persistence: adapter.persistence,
        dshContext: this.options.dshContext,
        admissionGuard: this.admissionGuard,
        ...(signal === undefined ? {} : { signal }),
      })
      if (initialInspection.subagentStatus === 'is-subagent-with-parent') {
        return {
          operationId,
          sessionId,
          status: 'unsupported',
          ...(initialInspection.blockingReasonCode === undefined ? {} : { code: initialInspection.blockingReasonCode }),
          ...(initialInspection.blockingMessage === undefined ? {} : { message: initialInspection.blockingMessage }),
        }
      }

      const orderedIds = [...initialInspection.descendantSubagentIds, sessionId]
      const sortedIds = [...new Set(orderedIds)].sort()
      for (const targetId of sortedIds) {
        try {
          reservations.push(await this.admissionGuard.acquireReservation(targetId, this.reservationTimeoutMs))
        } catch (error) {
          const code = error instanceof SessionDeletionError ? error.code : 'SESSION_DELETION_BUSY'
          return {
            operationId,
            sessionId,
            status: 'busy',
            code,
            message: error instanceof Error ? error.message : String(error),
          }
        }
      }

      const verifiedRoot = await locateAndVerifyTarget({
        persistence: adapter.persistence,
        root: adapter.root,
        sessionId,
        stateDir: this.options.stateDirectory,
        ...(signal === undefined ? {} : { signal }),
      })

      if (!isSameSessionLifecycle(expectedIdentity, verifiedRoot.header)) {
        return {
          operationId,
          sessionId,
          status: 'changed',
          code: 'SESSION_DELETION_TARGET_CHANGED',
          message: 'Session lifecycle identity changed before deletion commit',
        }
      }

      if (expectedRevision !== undefined && verifiedRoot.revision !== expectedRevision) {
        return {
          operationId,
          sessionId,
          status: 'changed',
          code: 'SESSION_DELETION_TARGET_CHANGED',
          message: 'Session log changed since confirmation was prepared',
        }
      }

      const inspection = await inspectSessionActivityAndLineage({
        sessionId,
        header: verifiedRoot.header,
        persistence: adapter.persistence,
        dshContext: this.options.dshContext,
        admissionGuard: this.admissionGuard,
        ...(signal === undefined ? {} : { signal }),
      })

      if (inspection.subagentStatus === 'is-subagent-with-parent') {
        return {
          operationId,
          sessionId,
          status: 'unsupported',
          ...(inspection.blockingReasonCode === undefined ? {} : { code: inspection.blockingReasonCode }),
          ...(inspection.blockingMessage === undefined ? {} : { message: inspection.blockingMessage }),
        }
      }
      if (inspection.activityUnverified) {
        return {
          operationId,
          sessionId,
          status: 'unsupported',
          code: 'SESSION_DELETION_ACTIVITY_UNVERIFIED',
          ...(inspection.blockingMessage === undefined ? {} : { message: inspection.blockingMessage }),
        }
      }
      if (inspection.activeReasons.length > 0) {
        return {
          operationId,
          sessionId,
          status: 'busy',
          ...(inspection.blockingReasonCode === undefined ? {} : { code: inspection.blockingReasonCode }),
          ...(inspection.blockingMessage === undefined ? {} : { message: inspection.blockingMessage }),
        }
      }

      // Check that no unexpected descendant appeared without a reservation.
      const finalOrderedIds = [...inspection.descendantSubagentIds, sessionId]
      for (const id of finalOrderedIds) {
        if (!sortedIds.includes(id)) {
          return {
            operationId,
            sessionId,
            status: 'changed',
            code: 'SESSION_DELETION_TARGET_CHANGED',
            message: `New child subagent "${id}" appeared during deletion verification`,
          }
        }
      }
      if (expectedRevision !== undefined && expectedCascade !== undefined) {
        const expectedSet = new Set(expectedCascade.map((item) => item.sessionId))
        if (finalOrderedIds.some((id) => !expectedSet.has(id))) {
          return {
            operationId,
            sessionId,
            status: 'changed',
            code: 'SESSION_DELETION_TARGET_CHANGED',
            message: 'Subagent tree changed since confirmation was prepared',
          }
        }
      }

      const expectedCascadeById = new Map((expectedCascade ?? []).map((item) => [item.sessionId, item]))
      const preLeaseLocations = new Map<string, VerifiedTargetLocation>([[sessionId, verifiedRoot]])
      const alreadyMovedChildTargets: CascadeDeletionTarget[] = []

      for (const childId of inspection.descendantSubagentIds) {
        try {
          const verifiedChild = await locateAndVerifyTarget({
            persistence: adapter.persistence,
            root: adapter.root,
            sessionId: childId,
            stateDir: this.options.stateDirectory,
            ...(signal === undefined ? {} : { signal }),
          })
          const expectedChild = expectedCascadeById.get(childId)
          if (expectedChild !== undefined) {
            if (!isSameSessionLifecycle(expectedChild.identity, verifiedChild.header)) {
              return {
                operationId,
                sessionId,
                status: 'changed',
                code: 'SESSION_DELETION_TARGET_CHANGED',
                message: `Child subagent "${childId}" lifecycle identity changed before deletion commit`,
              }
            }
            if (expectedRevision !== undefined && expectedChild.revision !== '' && verifiedChild.revision !== expectedChild.revision) {
              return {
                operationId,
                sessionId,
                status: 'changed',
                code: 'SESSION_DELETION_TARGET_CHANGED',
                message: `Child subagent "${childId}" changed since confirmation was prepared`,
              }
            }
          }
          preLeaseLocations.set(childId, verifiedChild)
        } catch (error) {
          if (
            allowPartiallyMovedOrigin === true
            && expectedCascadeById.has(childId)
            && error instanceof SessionDeletionError
            && (error.code === 'SESSION_DELETION_NOT_FOUND' || error.code === 'SESSION_DELETION_UNMATERIALIZED')
          ) {
            const expectedChild = expectedCascadeById.get(childId)!
            alreadyMovedChildTargets.push({
              sessionId: childId,
              identity: expectedChild.identity,
              sessionDir: '',
              stagingDir: '',
              pendingCleanupItems: [...expectedChild.expectedCleanupItems],
              completedCleanupItems: [],
            })
            continue
          }
          throw error
        }
      }

      // Acquire cross-process write leases in deterministic sorted ID order.
      for (const targetId of [...preLeaseLocations.keys()].sort()) {
        const loc = preLeaseLocations.get(targetId)!
        if (typeof adapter.persistence.acquireWriteLease === 'function') {
          try {
            leases.push(await adapter.persistence.acquireWriteLease(loc.header))
          } catch (error) {
            if (isAlreadyOwnedError(error)) {
              return {
                operationId,
                sessionId,
                status: 'busy',
                code: 'SESSION_DELETION_ACTIVE_WRITER',
                message: `Session "${targetId}" is currently held by another write lease`,
              }
            }
            throw error
          }
        } else if (!adapter.exclusiveDeploymentVerified) {
          return {
            operationId,
            sessionId,
            status: 'unsupported',
            code: 'SESSION_DELETION_EXCLUSION_UNAVAILABLE',
            message: 'Cross-process write lease cannot be verified',
          }
        }
      }

      // Re-verify all targets under both in-process reservations and cross-process write leases.
      const reverifiedLocations = new Map<string, VerifiedTargetLocation>()
      for (const targetId of finalOrderedIds) {
        if (!preLeaseLocations.has(targetId)) continue
        const reverified = await locateAndVerifyTarget({
          persistence: adapter.persistence,
          root: adapter.root,
          sessionId: targetId,
          stateDir: this.options.stateDirectory,
          ...(signal === undefined ? {} : { signal }),
        })
        const expectedTarget = targetId === sessionId
          ? { identity: expectedIdentity, revision: expectedRevision ?? '' }
          : expectedCascadeById.get(targetId)
        if (expectedTarget !== undefined && !isSameSessionLifecycle(expectedTarget.identity, reverified.header)) {
          return {
            operationId,
            sessionId,
            status: 'changed',
            code: 'SESSION_DELETION_TARGET_CHANGED',
            message: `Session "${targetId}" lifecycle identity changed while acquiring write exclusion`,
          }
        }
        if (
          expectedRevision !== undefined
          && expectedTarget !== undefined
          && expectedTarget.revision !== ''
          && reverified.revision !== expectedTarget.revision
        ) {
          return {
            operationId,
            sessionId,
            status: 'changed',
            code: 'SESSION_DELETION_TARGET_CHANGED',
            message: `Session "${targetId}" changed while acquiring write exclusion`,
          }
        }
        reverifiedLocations.set(targetId, reverified)
      }

      const reverifiedRoot = reverifiedLocations.get(sessionId)!
      const rootStagingDir = join(reverifiedRoot.stagingRoot, operationId)
      const persistedTargets: CascadeDeletionTarget[] = [...alreadyMovedChildTargets]

      for (let index = 0; index < finalOrderedIds.length; index += 1) {
        const targetId = finalOrderedIds[index]!
        const loc = reverifiedLocations.get(targetId)
        if (loc === undefined) continue
        const stagingDir = targetId === sessionId ? rootStagingDir : join(loc.stagingRoot, `${operationId}__${index}`)
        const targetCleanup = targetId === sessionId
          ? cleanupItems
          : inspectAvailableCleanupPlan({ sessionId: targetId, dshContext: this.options.dshContext }).items
        persistedTargets.push({
          sessionId: targetId,
          identity: buildIdentityEvidence(loc.header),
          sessionDir: loc.sessionDir,
          stagingDir,
          pendingCleanupItems: [...targetCleanup],
          completedCleanupItems: [],
        })
      }

      const useCascade = persistedTargets.length > 1
      const committingRecord: PersistedDeletionRecord = {
        operationId,
        sessionId,
        callerKey,
        mode,
        phase: 'committing',
        identity: expectedIdentity,
        backend: {
          kind: 'jsonl',
          root: reverifiedRoot.realRoot,
          rootDev: String(reverifiedRoot.rootDev),
          rootIno: String(reverifiedRoot.rootIno),
        },
        paths: {
          sessionDir: reverifiedRoot.sessionDir,
          stagingDir: rootStagingDir,
        },
        requestedAt,
        updatedAt: this.now(),
        pendingCleanupItems: [...cleanupItems],
        completedCleanupItems: [],
        ...(useCascade ? { cascadeTargets: persistedTargets } : {}),
      }
      await this.store.writeRecord(committingRecord)

      // Move targets atomically in post-order (deepest subagent leaves first, parent root last).
      for (const target of persistedTargets) {
        if (target.sessionDir === '' || target.stagingDir === '') continue
        try {
          await rename(target.sessionDir, target.stagingDir)
          await syncDirBestEffort(dirname(target.sessionDir))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.writeRecord({
            ...committingRecord,
            phase: 'failed',
            updatedAt: this.now(),
            lastErrorCode: 'SESSION_DELETION_FAILED',
            lastErrorMessage: `Failed to move session directory "${target.sessionId}" to staging: ${message}`,
          })
          return {
            operationId,
            sessionId,
            status: 'failed',
            code: 'SESSION_DELETION_FAILED',
            message: `Failed to move session directory "${target.sessionId}" to staging: ${message}`,
          }
        }
      }

      const logRemovedRecord: PersistedDeletionRecord = {
        ...committingRecord,
        phase: 'log-removed',
        updatedAt: this.now(),
      }
      await this.store.writeRecord(logRemovedRecord)

      for (const target of persistedTargets) {
        if (target.stagingDir !== '') {
          await rm(target.stagingDir, { recursive: true, force: true })
          await assertPathAbsent(target.stagingDir)
        }
        if (target.sessionDir !== '') {
          await assertPathAbsent(target.sessionDir)
        }
        const postStat = await adapter.persistence.stat(target.sessionId, signal === undefined ? undefined : { signal })
        if (postStat !== undefined) {
          throw new SessionDeletionError(
            'SESSION_DELETION_FAILED',
            `Session "${target.sessionId}" is still reported by persistence after directory removal`,
          )
        }
      }

      const pendingCleanupRecord: PersistedDeletionRecord = {
        ...logRemovedRecord,
        phase: 'cleanup-pending',
        updatedAt: this.now(),
      }
      await this.store.writeRecord(pendingCleanupRecord)
      const finalized = await this.retryPendingCleanupRecord(pendingCleanupRecord, signal)
      return this.recordToCommitResult(finalized)
    } catch (error) {
      if (error instanceof SessionDeletionError) {
        if (error.code === 'SESSION_DELETION_NOT_FOUND') {
          return {
            operationId,
            sessionId,
            status: 'changed',
            code: error.code,
            message: error.message,
          }
        }
        return {
          operationId,
          sessionId,
          status: error.code === 'SESSION_DELETION_PATH_UNSAFE' || error.code === 'SESSION_DELETION_DUPLICATE_LOCATION'
            ? 'unsupported'
            : 'failed',
          code: error.code,
          message: error.message,
        }
      }
      throw error
    } finally {
      this.activeCommits.delete(operationId)
      for (const lease of leases) {
        try {
          await lease.release()
        } catch {
          // Best-effort release after staging removal.
        }
      }
      for (const reservation of reservations) {
        reservation.release()
      }
    }
  }

  private recordToCommitResult(record: PersistedDeletionRecord): SessionDeletionCommitResult {
    switch (record.phase) {
      case 'completed':
        return {
          operationId: record.operationId,
          sessionId: record.sessionId,
          status: 'deleted',
          completedCleanupItems: [...record.completedCleanupItems],
          pendingCleanupItems: [],
        }
      case 'cleanup-pending':
        return {
          operationId: record.operationId,
          sessionId: record.sessionId,
          status: 'cleanup-pending',
          code: 'SESSION_DELETION_CLEANUP_PENDING',
          message: record.lastErrorMessage ?? 'History deleted, cleanup incomplete',
          completedCleanupItems: [...record.completedCleanupItems],
          pendingCleanupItems: [...record.pendingCleanupItems],
        }
      case 'queued':
        return {
          operationId: record.operationId,
          sessionId: record.sessionId,
          status: 'queued',
          ...(record.archivedForDeletion === true ? { archived: true } : {}),
        }
      case 'committing':
      case 'log-removed':
        return {
          operationId: record.operationId,
          sessionId: record.sessionId,
          status: 'busy',
          code: 'SESSION_DELETION_ALREADY_PENDING',
          message: 'Deletion is currently in progress',
        }
      case 'cancelled':
        return {
          operationId: record.operationId,
          sessionId: record.sessionId,
          status: 'changed',
          code: 'SESSION_DELETION_NOT_CANCELLABLE',
          message: 'Operation was cancelled',
        }
      case 'failed':
        return {
          operationId: record.operationId,
          sessionId: record.sessionId,
          status: 'failed',
          code: record.lastErrorCode ?? 'SESSION_DELETION_FAILED',
          message: record.lastErrorMessage ?? 'Session deletion failed',
        }
    }
  }

  private async readSessionTitle(
    sessionId: string,
    header: { readonly id: string; readonly createdAt: number; readonly cwd?: string; readonly version: number; readonly isSeeded: boolean },
  ): Promise<string | null> {
    const cache = readService(this.options.dshContext, 'sessionProjectionCache') as {
      cachedSnapshot?(h: unknown, keys?: readonly string[]): { readonly values?: Record<string, unknown> } | undefined
    } | undefined
    if (typeof cache?.cachedSnapshot === 'function') {
      try {
        const snap = cache.cachedSnapshot(header, ['title'])
        const title = snap?.values?.title
        if (typeof title === 'string' && title.trim() !== '') return title
      } catch {
        // Ignore cache read issues for display title.
      }
    }
    const sessionTitle = readService(this.options.dshContext, 'sessionTitle') as {
      get?(id: string): unknown
    } | undefined
    if (typeof sessionTitle?.get === 'function') {
      try {
        const value = sessionTitle.get(sessionId)
        if (typeof value === 'string' && value.trim() !== '') return value
        if (typeof value === 'object' && value !== null && typeof (value as { title?: unknown }).title === 'string') {
          const title = (value as { title: string }).title
          if (title.trim() !== '') return title
        }
      } catch {
        // Ignore optional title service error.
      }
    }
    return null
  }

  private findActiveBackgroundBySession(
    sessionId: string,
  ): { readonly callerKey: string; readonly status: SessionDeletionStatusResult } | undefined {
    for (const entry of this.backgroundStates.values()) {
      if (entry.status.sessionId === sessionId && entry.status.status === 'deleting') {
        return entry
      }
    }
    return undefined
  }

  private recordBackgroundState(callerKey: string, status: SessionDeletionStatusResult): void {
    const operationId = status.operationId
    if (operationId === undefined) return
    this.backgroundStates.delete(operationId)
    this.backgroundStates.set(operationId, { callerKey, status })
    if (this.backgroundStates.size <= 200) return
    for (const [key, entry] of this.backgroundStates) {
      if (this.backgroundStates.size <= 200) break
      if (entry.status.status !== 'deleting') this.backgroundStates.delete(key)
    }
  }

  private commitResultToStatus(result: SessionDeletionCommitResult): SessionDeletionStatusResult {
    const status = result.status === 'deleted'
      ? 'deleted'
      : result.status === 'cleanup-pending'
        ? 'cleanup-pending'
        : result.status === 'queued'
          ? 'queued'
          : result.status === 'deleting'
            ? 'deleting'
            : 'failed'
    return {
      operationId: result.operationId,
      sessionId: result.sessionId,
      status,
      mode: 'immediate',
      ...(result.code === undefined ? {} : { code: result.code }),
      ...(result.message === undefined ? {} : { message: result.message }),
      cancellable: false,
      retryableCleanup: status === 'cleanup-pending',
      pendingCleanupItems: result.pendingCleanupItems ?? [],
      completedCleanupItems: result.completedCleanupItems ?? [],
      updatedAt: this.now(),
    }
  }

  private assertFeatureEnabled(): void {
    if (this.options.isFeatureEnabled !== undefined && !this.options.isFeatureEnabled()) {
      throw new SessionDeletionError(
        'SESSION_DELETION_FEATURE_DISABLED',
        'Permanent session deletion is disabled in Workspace Session Enhancement settings',
      )
    }
  }

  private serializeSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.sessionQueues.get(sessionId) ?? Promise.resolve()
    const next = prior.then(operation, operation)
    const settled = next.then(() => undefined, () => undefined)
    this.sessionQueues.set(sessionId, settled)
    void settled.then(() => {
      if (this.sessionQueues.get(sessionId) === settled) {
        this.sessionQueues.delete(sessionId)
      }
    })
    return next
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath)
    return true
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
  }
}

async function assertPathAbsent(targetPath: string): Promise<void> {
  try {
    await lstat(targetPath)
  } catch (error) {
    if (isEnoent(error)) return
    throw error
  }
  throw new SessionDeletionError('SESSION_DELETION_FAILED', `Path still exists after deletion: ${targetPath}`)
}

async function syncDirBestEffort(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Ignore unsupported directory fsync.
  }
}

function isAlreadyOwnedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  const code = (error as { code?: unknown }).code
  return name === 'SessionAlreadyOwnedError' || code === 'SESSION_ALREADY_OWNED'
}

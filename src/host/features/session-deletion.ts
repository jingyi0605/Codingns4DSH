import { homedir } from 'node:os'
import { join } from 'node:path'
import { isCodingNsOwnerPeer } from '../../dsh-capabilities/host/connection-peer-adapter.js'
import { readService } from '../../dsh-capabilities/host/session-deletion-adapter.js'
import type { FeatureModule } from '../../shared/contracts/feature.js'
import {
  SessionDeletionError,
  type SessionDeletionCancelRequest,
  type SessionDeletionCommitRequest,
  type SessionDeletionPrepareRequest,
  type SessionDeletionStatusRequest,
} from '../../shared/contracts/session-deletion.js'
import { SessionDeletionService } from '../session-deletion/service.js'
import type { CodingNsHostServices } from './types.js'

export interface SessionDeletionFeatureOptions {
  readonly stateDirectory?: string
  readonly replayOnStartup?: boolean
  readonly reservationTimeoutMs?: number
  readonly tokenTtlMs?: number
  readonly now?: () => number
  readonly enforceSettingsToggle?: boolean
}

export function createSessionDeletionFeature(
  options: SessionDeletionFeatureOptions = {},
): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'sessionDeletion',
      version: '1.0.0',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
      requires: [{ capability: 'session.deletion.persistence-location', required: false, fallback: 'disable' }],
    },
    async start(context) {
      const host = context.services.dshContext
      const connection = readService(host, 'connection')
      const stateDirectory = options.stateDirectory
        ?? process.env.CODINGNS4DSH_STATE_DIR?.trim()
        ?? join(homedir(), '.config', 'codingns4dsh')

      const service = new SessionDeletionService({
        dshContext: host,
        stateDirectory,
        isFeatureEnabled: () => {
          if (options.enforceSettingsToggle === false) return true
          const settings = context.services.settings?.get()
          if (settings === undefined) return true
          return settings.workspaceSessionEnhancement.enableSessionDeletion === true
        },
        onSessionRemoved: async (sessionId) => {
          const settingsScope = context.services.settings
          if (settingsScope === undefined) return
          try {
            const current = settingsScope.get()
            const cliSessions = current.cliSessions
            if (Array.isArray(cliSessions) && cliSessions.some((item) => item.dshSessionId === sessionId)) {
              await settingsScope.update({
                cliSessions: cliSessions.filter((item) => item.dshSessionId !== sessionId),
              })
            }
          } catch {
            // Never fail deletion completion if optional adapter index update rejects.
          }
        },
        emitNativeRemoved: (sessionId) => {
          try {
            context.services.events?.emit?.('api-session/removed', sessionId)
          } catch {
            // Best-effort broadcast; client also refreshes explicitly.
          }
        },
        ...(options.reservationTimeoutMs === undefined ? {} : { reservationTimeoutMs: options.reservationTimeoutMs }),
        ...(options.tokenTtlMs === undefined ? {} : { tokenTtlMs: options.tokenTtlMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
      })

      context.resources.add(() => service.dispose())
      await service.initialize({ replayOnStartup: options.replayOnStartup !== false })

      context.resources.add(context.services.rpc.register('sessionDeletion', async (action, payload, caller) => {
        const call = fields(caller ?? {})
        const peers = connection as { browserPeer?: unknown; operator?: unknown } | undefined
        if (
          !peers
          || (peers.browserPeer === undefined && peers.operator === undefined)
          || !isCodingNsOwnerPeer(connection, call.peer)
        ) {
          throw new SessionDeletionError('SESSION_DELETION_FORBIDDEN', 'Only the authenticated Host owner may delete sessions')
        }
        if (call.localRequest !== true) {
          throw new SessionDeletionError(
            'SESSION_DELETION_LOCAL_OWNER_REQUIRED',
            'Permanent session deletion is only permitted from a trusted local request',
          )
        }
        const callerKey = deriveCallerKey(call.peer)
        const signal = call.signal instanceof AbortSignal ? call.signal : undefined
        switch (action) {
          case 'prepare':
            return service.prepare(callerKey, fields(payload) as unknown as SessionDeletionPrepareRequest, signal)
          case 'commit':
            return service.commit(callerKey, fields(payload) as unknown as SessionDeletionCommitRequest, signal)
          case 'status':
            return service.status(
              callerKey,
              fields(payload) as unknown as SessionDeletionStatusRequest & { readonly retryCleanup?: boolean },
              signal,
            )
          case 'cancel':
            return service.cancel(callerKey, fields(payload) as unknown as SessionDeletionCancelRequest)
          case 'list':
            return service.list(callerKey)
          default:
            throw new SessionDeletionError('SESSION_DELETION_UNKNOWN_ACTION', `Unknown sessionDeletion action: ${action}`)
        }
      }))
    },
  }
}

export function deriveCallerKey(peer: unknown): string {
  if (!isObject(peer)) return 'local-owner'
  const principal = isObject(peer.principal) ? peer.principal : undefined
  if (typeof principal?.id === 'string' && principal.id.trim() !== '') {
    return `principal:${principal.id.trim()}`
  }
  if (typeof principal?.kind === 'string' && principal.kind.trim() !== '') {
    return `kind:${principal.kind.trim()}`
  }
  return 'local-owner'
}

function fields(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {}
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

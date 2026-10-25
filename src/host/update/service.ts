import { randomUUID } from 'node:crypto'
import {
  CODINGNS_PACKAGE_NAME, compareSemver, isSemver, updateError, validatePluginUpdateChannel,
  type PluginUpdateCheckResult, type PluginUpdateStatusResult, type PluginUpdateApplyResult, type PluginUpdateRuntime,
} from '../../shared/contracts/plugin-update.js'
import { CODINGNS_VERSION } from '../../shared/contracts/version.js'
import type { PluginUpdateManager } from '../../dsh-capabilities/host/plugin-update-adapter.js'
import { PluginUpdateMetadata, pluginUpdateCheckState } from './metadata.js'
import { derivePluginUpdateApplication } from './application-result.js'

interface Operation {
  status: PluginUpdateStatusResult
  readonly manager: PluginUpdateManager
}

export class PluginUpdateService {
  private readonly checks = new Map<string, PluginUpdateCheckResult>()
  private readonly operations = new Map<string, Operation>()
  private active: Operation | undefined
  private starting = false
  private disposed = false

  constructor(
    private readonly metadata: PluginUpdateMetadata,
    private readonly manager: () => PluginUpdateManager | undefined,
    private readonly now = () => Date.now(),
  ) {}

  async runtime(localRequest: boolean): Promise<PluginUpdateRuntime> {
    this.assertOpen()
    const manager = this.manager()
    const installed = await manager?.installed().catch(() => ({ version: null, blockCode: 'UPDATE_MANAGER_UNAVAILABLE' }))
    this.assertOpen()
    const blockCode = !localRequest ? 'UPDATE_LOCAL_OWNER_REQUIRED'
      : manager === undefined ? 'UPDATE_CAPABILITY_UNAVAILABLE' : installed?.blockCode
    return {
      runningHostVersion: CODINGNS_VERSION, installedVersion: installed?.version ?? null,
      managerAvailable: manager !== undefined,
      ...(blockCode === undefined ? {} : { applyBlockCode: blockCode }),
    }
  }

  async check(payload: unknown, localRequest: boolean, signal?: AbortSignal): Promise<PluginUpdateCheckResult> {
    this.assertOpen()
    const input = fields(payload)
    const channel = validatePluginUpdateChannel(input.channel)
    const clientVersion = typeof input.clientVersion === 'string' && isSemver(input.clientVersion) ? input.clientVersion : null
    const runtime = await this.runtime(localRequest)
    signal?.throwIfAborted()
    let target
    try { target = await this.metadata.read(channel) }
    catch {
      signal?.throwIfAborted()
      throw updateError('UPDATE_METADATA_UNAVAILABLE')
    }
    signal?.throwIfAborted()
    this.assertOpen()
    const state = pluginUpdateCheckState(target, [CODINGNS_VERSION, clientVersion, runtime.installedVersion])
    const result: PluginUpdateCheckResult = {
      packageName: CODINGNS_PACKAGE_NAME, channel, target, state, checkedAt: new Date(this.now()).toISOString(),
      ...runtime, runningClientVersion: clientVersion,
      canApply: runtime.applyBlockCode === undefined && state === 'update-available',
    }
    this.checks.set(target.version, result)
    while (this.checks.size > 20) this.checks.delete(this.checks.keys().next().value!)
    return result
  }

  async apply(payload: unknown, signal?: AbortSignal): Promise<PluginUpdateStatusResult> {
    this.assertOpen()
    const input = fields(payload)
    if (typeof input.version !== 'string' || !isSemver(input.version) || input.confirmation !== true) throw updateError('UPDATE_CONFIRMATION_REQUIRED')
    const check = this.checks.get(input.version)
    if (!check?.canApply || input.checkedAt !== check.checkedAt || this.now() - Date.parse(check.checkedAt) > 5 * 60_000) {
      throw updateError('UPDATE_CHECK_REQUIRED')
    }
    if (this.starting || this.active) throw updateError('UPDATE_CONFLICT')
    this.starting = true
    try {
      const manager = this.manager()
      if (!manager) throw updateError('UPDATE_CAPABILITY_UNAVAILABLE')
      const installed = await manager.installed()
      if (installed.blockCode) throw updateError(installed.blockCode)
      if (installed.version !== null && compareSemver(input.version, installed.version) <= 0) throw updateError('UPDATE_NO_NEWER_VERSION')
      const target = await this.metadata.read({ kind: 'exact', version: input.version })
      if (target.compatibility.state !== 'compatible') throw updateError('UPDATE_INCOMPATIBLE_DSH')
      signal?.throwIfAborted()
      this.assertOpen()
      const operation: Operation = {
        manager,
        status: {
          operationId: randomUUID(), revision: 1, targetVersion: target.version, state: 'applying', phase: 'installing',
          cancellationAvailable: manager.cancellationAvailable,
        },
      }
      this.active = operation
      this.operations.set(operation.status.operationId, operation)
      while (this.operations.size > 10) this.operations.delete(this.operations.keys().next().value!)
      this.checks.clear()
      // The operation belongs to the Host; disconnecting a page does not imply package rollback.
      void this.run(operation)
      return operation.status
    } finally { this.starting = false }
  }

  status(payload: unknown): PluginUpdateStatusResult | null {
    this.assertOpen()
    const id = fields(payload).operationId
    if (id === undefined) return [...this.operations.values()].at(-1)?.status ?? null
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,80}$/iu.test(id)) throw updateError('UPDATE_INVALID_OPERATION')
    const operation = this.operations.get(id)
    if (!operation) throw updateError('UPDATE_OPERATION_NOT_FOUND')
    return operation.status
  }

  async cancel(payload: unknown): Promise<PluginUpdateStatusResult> {
    const status = this.status(payload)
    if (!status) throw updateError('UPDATE_OPERATION_NOT_FOUND')
    const operation = this.operations.get(status.operationId)!
    if (status.state === 'completed') return status
    if (!status.cancellationAvailable) throw updateError('UPDATE_CANCELLATION_UNSUPPORTED')
    operation.status = { ...status, revision: status.revision + 1, phase: 'cancelling', cancellationAvailable: false }
    try {
      const cancellation = await operation.manager.cancel(status.operationId)
      if (cancellation === 'not-running' && operation.status.state !== 'completed') throw updateError('UPDATE_CANCEL_NOT_RUNNING')
      if (operation.status.state !== 'completed') {
        operation.status = { ...operation.status, revision: operation.status.revision + 1, phase: cancellation === 'too-late' ? 'applying' : 'cancelling' }
      }
    } catch (error) {
      if (operation.status.state !== 'completed' && operation.status.phase === 'cancelling') {
        operation.status = { ...operation.status, revision: operation.status.revision + 1, phase: status.phase, cancellationAvailable: true }
      }
      if ((error as { code?: unknown })?.code === 'UPDATE_CANCEL_NOT_RUNNING') throw error
      throw updateError('UPDATE_CANCEL_FAILED')
    }
    return operation.status
  }

  progress(value: unknown): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    const input = fields(value)
    const operation = this.active
    if (!operation || input.requestId !== operation.status.operationId || operation.status.state !== 'applying') return
    if (input.phase === 'installing' && operation.status.phase !== 'installing') return
    if (input.phase === 'installing' || input.phase === 'applying' || input.phase === 'cancelling') {
      operation.status = {
        ...operation.status, revision: operation.status.revision + 1, phase: input.phase,
        cancellationAvailable: input.phase === 'installing' && operation.manager.cancellationAvailable,
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.metadata.dispose()
    this.checks.clear()
  }

  private async run(operation: Operation): Promise<void> {
    const { operationId, targetVersion } = operation.status
    let result: PluginUpdateApplyResult
    try {
      const outcome = await operation.manager.install(targetVersion, operationId)
      const packageState = outcome.packageAccepted ? 'installed' : outcome.restored ? 'rolled-back' : 'unknown'
      const hostActivation = {
        state: outcome.application === 'restart-required' ? 'restart-required' as const : 'unknown' as const,
        version: CODINGNS_VERSION,
      }
      const clientReload = { state: 'unsupported' as const, version: null, code: 'UPDATE_CLIENT_RELOAD_UNSUPPORTED' }
      const application = outcome.application === 'failed' ? 'failed' : outcome.application === 'cancelled' ? 'cancelled'
        : derivePluginUpdateApplication(targetVersion, packageState, hostActivation, clientReload)
      result = {
        operationId, targetVersion, packageState, hostActivation, clientReload, application, managerAvailable: true,
        nextStep: application === 'restart-required' ? 'Review the result in native DSH Plugins and restart DSH to activate the installed code.'
          : 'Review the actual package and runtime state in native DSH Plugins before retrying.',
        ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
      }
    } catch {
      result = {
        operationId, targetVersion, packageState: 'unknown',
        hostActivation: { state: 'unknown', version: CODINGNS_VERSION },
        clientReload: { state: 'unsupported', version: null },
        application: 'failed', managerAvailable: true, errorCode: 'UPDATE_MANAGER_FAILED',
        nextStep: 'Check native DSH Plugins before retrying; the package state could not be confirmed.',
      }
    }
    operation.status = { ...operation.status, revision: operation.status.revision + 1, state: 'completed', phase: 'completed', cancellationAvailable: false, result }
    if (this.active === operation) this.active = undefined
  }

  private assertOpen(): void { if (this.disposed) throw updateError('UPDATE_DISPOSED') }
}

export function fields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw updateError('UPDATE_INVALID_REQUEST')
  return value as Record<string, unknown>
}

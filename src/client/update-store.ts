import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import { CODINGNS_VERSION } from '../shared/contracts/version.js'
import { updateError, type PluginUpdateChannel, type PluginUpdateChannelKind, type PluginUpdateCheckResult, type PluginUpdateStatusResult, type PluginUpdateRuntime } from '../shared/contracts/plugin-update.js'
import type { CodingNsRpcClient } from './features/types.js'

export const DEFAULT_PLUGIN_UPDATE_CHANNEL: PluginUpdateChannelKind = CODINGNS_VERSION.includes('-') ? 'next' : 'latest'

export interface PluginUpdateSnapshot {
  readonly checking: boolean
  readonly starting: boolean
  readonly current: boolean
  readonly check: PluginUpdateCheckResult | null
  readonly operation: PluginUpdateStatusResult | null
  readonly runtime: PluginUpdateRuntime | null
  readonly error: string | null
}

export class PluginUpdateStore {
  private snapshot: PluginUpdateSnapshot = { checking: false, starting: false, current: false, check: null, operation: null, runtime: null, error: null }
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private checkRequest: { key: string; controller: AbortController; promise: Promise<void> } | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private operationGeneration = 0
  private recoveryGeneration = 0
  private runtimeGeneration = 0
  private pollPending: Promise<void> | undefined
  private visible = true

  constructor(private readonly rpc: CodingNsRpcClient) {}

  readonly getSnapshot = (): PluginUpdateSnapshot => this.snapshot
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  async loadRuntime(): Promise<void> {
    const generation = ++this.runtimeGeneration
    try {
      const runtime = await this.call<PluginUpdateRuntime>('runtime', {})
      if (generation === this.runtimeGeneration) this.publish({ runtime })
    } catch (error) {
      if (generation === this.runtimeGeneration) this.publish({ error: errorCode(error) })
    }
  }

  invalidate(): void {
    this.generation++
    this.checkRequest?.controller.abort()
    this.checkRequest = undefined
    this.publish({ current: false, checking: false })
  }

  check(channel: PluginUpdateChannel): Promise<void> {
    const key = JSON.stringify(channel)
    if (this.checkRequest?.key === key) return this.checkRequest.promise
    this.invalidate()
    const generation = this.generation
    const controller = new AbortController()
    this.publish({ checking: true, error: null })
    const promise = this.call<PluginUpdateCheckResult>('check', { channel, clientVersion: CODINGNS_VERSION }, controller.signal)
      .then(check => {
        if (generation !== this.generation) return
        this.runtimeGeneration++
        this.publish({ check, runtime: check, current: true })
      })
      .catch(error => { if (generation === this.generation && !controller.signal.aborted) this.publish({ error: errorCode(error) }) })
      .finally(() => {
        if (generation !== this.generation) return
        this.checkRequest = undefined
        this.publish({ checking: false })
      })
    this.checkRequest = { key, controller, promise }
    return promise
  }

  async apply(reviewed: PluginUpdateCheckResult): Promise<void> {
    if (this.snapshot.starting || this.snapshot.operation?.state === 'applying') return
    if (!this.snapshot.current || reviewed !== this.snapshot.check || !reviewed.canApply || reviewed.target === null) {
      this.publish({ error: 'UPDATE_CHECK_REQUIRED' })
      return
    }
    this.operationGeneration++
    this.publish({ starting: true, error: null })
    let recover = false
    try {
      const operation = await this.call<PluginUpdateStatusResult>('apply', {
        version: reviewed.target.version, confirmation: true, checkedAt: reviewed.checkedAt,
      })
      this.publish({ operation, current: false })
      this.schedule()
    } catch (error) {
      // An interrupted response may hide a Host-owned operation. Recover before permitting another apply.
      this.publish({ error: errorCode(error), current: false })
      recover = true
    } finally { this.publish({ starting: false }) }
    if (recover) await this.recover()
  }

  async recover(): Promise<void> {
    if (this.snapshot.starting) return
    const generation = this.operationGeneration
    const recovery = ++this.recoveryGeneration
    try {
      const operation = await this.call<PluginUpdateStatusResult | null>('status', {})
      if (generation !== this.operationGeneration || recovery !== this.recoveryGeneration) return
      if (this.snapshot.operation?.state === 'applying' && operation === null) {
        this.publish({ error: 'UPDATE_OPERATION_NOT_FOUND' })
      } else if (operation !== null) this.acceptOperation(operation)
      this.schedule()
    } catch (error) {
      if (generation === this.operationGeneration && recovery === this.recoveryGeneration) this.publish({ error: errorCode(error) })
    }
  }

  async cancel(): Promise<void> {
    const operation = this.snapshot.operation
    if (!operation?.cancellationAvailable || operation.state !== 'applying') return
    this.publish({ operation: { ...operation, phase: 'cancelling', cancellationAvailable: false }, error: null })
    try {
      const next = await this.call<PluginUpdateStatusResult>('cancel', { operationId: operation.operationId })
      if (this.snapshot.operation?.operationId === operation.operationId) this.acceptOperation(next)
    } catch (error) {
      if (this.snapshot.operation?.operationId === operation.operationId && this.snapshot.operation.state !== 'completed') this.publish({ error: errorCode(error) })
    }
    this.schedule()
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (visible) this.schedule()
  }

  dispose(): void {
    this.lifetime.abort()
    this.invalidate()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.listeners.clear()
  }

  private schedule(): void {
    if (this.lifetime.signal.aborted || !this.visible || this.snapshot.error !== null || this.timer !== undefined || this.snapshot.operation?.state !== 'applying') return
    this.timer = setTimeout(() => { this.timer = undefined; void this.poll() }, 1000)
  }

  private poll(): Promise<void> {
    if (this.pollPending) return this.pollPending
    const operation = this.snapshot.operation
    if (operation?.state !== 'applying') return Promise.resolve()
    this.pollPending = this.call<PluginUpdateStatusResult>('status', { operationId: operation.operationId })
      .then(next => {
        if (this.snapshot.operation?.operationId === next.operationId) this.acceptOperation(next)
      })
      .catch(error => {
        if (this.snapshot.operation?.operationId === operation.operationId && this.snapshot.operation.state !== 'completed') this.publish({ error: errorCode(error) })
      })
      .finally(() => { this.pollPending = undefined; this.schedule() })
    return this.pollPending
  }

  private async call<T>(action: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const combined = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
    combined.throwIfAborted()
    // Mutations never retry on another transport after an ambiguous failure.
    const response = await this.rpc.call(CODINGNS_RPC_CHANNEL, `update/${action}`, payload, combined)
    combined.throwIfAborted()
    if (!response.ok) throw updateError(response.error.code)
    return response.value as T
  }

  private acceptOperation(operation: PluginUpdateStatusResult): void {
    const current = this.snapshot.operation
    if (current?.operationId === operation.operationId) {
      if (operation.revision < current.revision || (current.state === 'completed' && operation.state !== 'completed')) return
      if (operation.revision === current.revision) {
        if (this.snapshot.error !== null) this.publish({ error: null })
        return
      }
    }
    this.publish({ operation, error: null })
    if (operation.state === 'completed' && (current?.operationId !== operation.operationId || current.state !== 'completed')) void this.loadRuntime()
  }

  private publish(patch: Partial<PluginUpdateSnapshot>): void {
    if (this.lifetime.signal.aborted) return
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && /^UPDATE_[A-Z_]{1,80}$/u.test(code) ? code : 'UPDATE_REQUEST_FAILED'
}

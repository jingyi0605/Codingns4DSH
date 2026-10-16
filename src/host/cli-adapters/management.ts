import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { CodingNsCliAdapterDescriptor } from '../../shared/contracts/cli-adapter.js'
import type { CliManagementAction, CliManagementOperation, CliManagementPlan } from '../../shared/contracts/cli-management.js'
import { CodingNsRpcError } from '../rpc-table.js'
import { automaticUpdateMethod, managementMethods, AGENT_MANAGEMENT_DEFINITIONS } from './management-methods.js'
import { resolveManagementInstallation } from './management-installation.js'
import { isNewerAgentVersion } from './update-check.js'
import { managementOutput, runManagementCommand, type ManagementRunner } from './management-process.js'

export interface ManagementRegistry {
  refreshCatalog(adapterId: string): Promise<readonly CodingNsCliAdapterDescriptor[]>
  beginMaintenance(adapterId: string): () => void
}

interface Operation {
  snapshot: CliManagementOperation
  readonly controller: AbortController
  completion: Promise<void>
  output: string
}

/** One Host-owned operation survives dialog closure, but never feature disposal. */
export class CliManagementService {
  private operation: Operation | undefined
  private disposed = false

  constructor(private readonly registry: ManagementRegistry, private readonly options: {
    readonly run?: ManagementRunner
    readonly platform?: NodeJS.Platform
    readonly arch?: string
    readonly timeoutMs?: number
    readonly resolveCommand?: (command: string) => Promise<string | null>
  } = {}) {}

  async plan(adapterId: string, action: CliManagementAction): Promise<CliManagementPlan> {
    return (await this.preparePlan(adapterId, action)).plan
  }

  private async preparePlan(adapterId: string, action: CliManagementAction) {
    this.assertAvailable()
    const adapter = (await this.registry.refreshCatalog(adapterId)).find((entry) => entry.id === adapterId)
    this.assertAvailable()
    if (adapter === undefined) throw failure('INVALID_AGENT', 'Unknown Agent.')
    if (adapter.detectionState !== 'ready' || adapter.detectionFailure) throw failure('DETECTION_FAILED', 'Re-detect this Agent successfully before installing or updating it.')
    if ((action === 'install') === adapter.installed) throw failure('STATE_CHANGED', 'The installation state changed. Close this dialog and re-detect the Agent.')
    const platform = this.options.platform ?? process.platform
    // ZCode's bundled .cjs is read by Node, so it need not have POSIX executable permission.
    const resolveCommand = this.options.resolveCommand ?? ((command: string) => adapter.id === 'zcode'
      ? realpath(command).catch(() => null)
      : resolveManagementInstallation(command, AGENT_MANAGEMENT_DEFINITIONS[adapter.id]?.npm))
    const resolved = action === 'update' && adapter.command
      ? await resolveCommand(adapter.command) : null
    this.assertAvailable()
    const installation = action === 'update' ? { ...adapter, command: resolved } : adapter
    const { sourceUrl, methods } = managementMethods(installation, action, platform, this.options.arch ?? process.arch)
    const automaticMethodId = action === 'update' ? automaticUpdateMethod(installation, methods, platform) : methods.find(method => method.executable)?.id
    const publicMethods = methods.map(({ invocation: _invocation, ...method }) => method)
    const fingerprint = createHash('sha256').update(JSON.stringify({ adapterId, action, platform, version: adapter.version, command: adapter.command, methods: publicMethods, automaticMethodId })).digest('hex')
    const plan: CliManagementPlan = { adapter, action, platform, sourceUrl, methods: publicMethods, fingerprint,
      ...(automaticMethodId === undefined ? {} : { automaticMethodId }) }
    return { plan, methods }
  }

  start(payload: unknown): CliManagementOperation {
    this.assertAvailable()
    const input = readInput(payload)
    const methodId = readString(input, 'methodId')
    const fingerprint = readString(input, 'fingerprint')
    if (this.operation?.snapshot.state === 'running') throw failure('BUSY', 'Another Agent installation or update is already running on this Host.')
    const release = this.registry.beginMaintenance(input.adapterId)
    const operation: Operation = {
      snapshot: { id: randomUUID(), adapterId: input.adapterId, action: input.action, state: 'running', output: '' },
      controller: new AbortController(), completion: Promise.resolve(), output: '',
    }
    this.operation = operation
    operation.completion = this.perform(operation, methodId, fingerprint).finally(release)
    return { ...operation.snapshot }
  }

  status(): CliManagementOperation | null {
    return this.operation === undefined ? null : { ...this.operation.snapshot, output: managementOutput(this.operation.output) }
  }

  cancel(id: string): CliManagementOperation | null {
    if (this.operation?.snapshot.id !== id) throw failure('STATE_CHANGED', 'This operation is no longer current.')
    if (this.operation.snapshot.state === 'running') this.operation.controller.abort(new Error('Operation cancelled. Files already installed are not rolled back.'))
    return this.status()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.operation?.controller.abort(new Error('Agent management stopped.'))
    await this.operation?.completion
  }

  async rpc(action: string, payload: unknown): Promise<unknown> {
    const input = record(payload)
    if (input.catalogHostId !== 'local') throw failure('LOCAL_ONLY', 'Agent installation and updates are available only for the local Host.')
    switch (action) {
      case 'management/plan': { const request = readInput(payload); return this.plan(request.adapterId, request.action) }
      case 'management/start': return this.start(payload)
      case 'management/status': return this.status()
      case 'management/cancel': return this.cancel(readString(input, 'operationId'))
      default: throw failure('INVALID_REQUEST', 'Unknown Agent management action.')
    }
  }

  private async perform(operation: Operation, methodId: string, fingerprint: string): Promise<void> {
    const { adapterId, action } = operation.snapshot
    const signal = operation.controller.signal
    const timer = setTimeout(() => operation.controller.abort(new Error('The operation timed out. Check the official guide before retrying.')), this.options.timeoutMs ?? 10 * 60_000)
    timer.unref?.()
    let executed = false
    let state: 'succeeded' | 'failed' | 'cancelled' = 'succeeded'
    try {
      signal.throwIfAborted()
      const { plan, methods } = await this.preparePlan(adapterId, action)
      signal.throwIfAborted()
      if (plan.fingerprint !== fingerprint) throw failure('STATE_CHANGED', 'The Agent or installation method changed. Reopen the action to review it again.')
      if (action === 'update' && methodId !== plan.automaticMethodId) throw failure('METHOD_UNAVAILABLE', 'No matching automatic updater was identified. Re-detect the installation or follow the official guide.')
      const method = methods.find((entry) => entry.id === methodId)
      if (!method?.executable || method.invocation === undefined) throw failure('MANUAL_REQUIRED', 'Use the official guide for this installation method.')
      executed = true
      const code = await (this.options.run ?? runManagementCommand)(method.invocation, signal, (chunk) => {
        operation.output = (operation.output + chunk).slice(-32_768)
      })
      signal.throwIfAborted()
      if (code !== 0) throw failure('COMMAND_FAILED', `The command exited with ${code === null ? 'no exit code' : `code ${code}`}. Review its output and the official guide.`)
      const adapter = await this.detectResult(adapterId)
      signal.throwIfAborted()
      operation.snapshot = { ...operation.snapshot, adapter }
      if (!adapter.installed || adapter.detectionState !== 'ready' || adapter.detectionFailure) {
        throw failure('VERIFY_FAILED', 'The command completed, but the Agent could not be verified. Check PATH and prerequisites, then re-detect.')
      }
      if (action === 'update' && plan.adapter.version && (!adapter.version || isNewerAgentVersion(plan.adapter.version, adapter.version, adapter.id) !== true)) {
        throw failure('VERSION_UNCHANGED', `The updater finished, but the detected version did not advance (${plan.adapter.version} → ${adapter.version ?? 'unknown'}). Its release channel, registry cache, or installation path may differ from the update check. Review the output and refresh before retrying.`)
      }
    } catch (error) {
      const message = signal.aborted ? signal.reason : error
      state = signal.aborted && !String(message).includes('timed out') ? 'cancelled' : 'failed'
      operation.snapshot = { ...operation.snapshot, error: managementOutput(message instanceof Error ? message.message : String(message)) }
      if (executed && !this.disposed && operation.snapshot.adapter === undefined) {
        try { operation.snapshot = { ...operation.snapshot, adapter: await this.detectResult(adapterId) } } catch { /* Preserve the command error if detection also fails. */ }
      }
    } finally {
      clearTimeout(timer)
      operation.snapshot = { ...operation.snapshot, state }
    }
  }

  private async detectResult(adapterId: string): Promise<CodingNsCliAdapterDescriptor> {
    const adapter = (await this.registry.refreshCatalog(adapterId)).find((entry) => entry.id === adapterId)
    if (adapter === undefined) throw failure('INVALID_AGENT', 'The Agent is no longer registered.')
    return adapter
  }

  private assertAvailable(): void {
    if (this.disposed) throw failure('UNAVAILABLE', 'Agent management is stopped.')
  }
}

function readInput(payload: unknown): Record<string, unknown> & { adapterId: string; action: CliManagementAction } {
  const input = record(payload)
  const adapterId = readString(input, 'adapterId')
  if (input.action !== 'install' && input.action !== 'update') throw failure('INVALID_REQUEST', 'Choose install or update.')
  return { ...input, adapterId, action: input.action }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw failure('INVALID_REQUEST', 'Invalid Agent management request.')
  return value as Record<string, unknown>
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw failure('INVALID_REQUEST', `Invalid ${key}.`)
  return value
}

function failure(code: string, message: string): CodingNsRpcError {
  return new CodingNsRpcError(`CODINGNS_CLI_MANAGEMENT_${code}`, message)
}

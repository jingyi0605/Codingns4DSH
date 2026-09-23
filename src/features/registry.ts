import type {
  FeatureContext,
  FeatureDescriptor,
  FeatureDisposer,
  FeatureModule,
  FeatureResourceScope,
  FeatureState,
} from '../shared/contracts/feature.js'

export type FeatureRegistryErrorCode =
  | 'FEATURE_INVALID_DESCRIPTOR'
  | 'FEATURE_ALREADY_REGISTERED'
  | 'FEATURE_NOT_FOUND'
  | 'FEATURE_DEPENDENCY_MISSING'
  | 'FEATURE_DEPENDENCY_CYCLE'
  | 'FEATURE_START_FAILED'
  | 'FEATURE_DISPOSE_FAILED'
  | 'FEATURE_STATE_INVALID'

export class FeatureRegistryError extends Error {
  readonly code: FeatureRegistryErrorCode
  readonly featureName: string | null

  constructor(code: FeatureRegistryErrorCode, message: string, featureName: string | null = null, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FeatureRegistryError'
    this.code = code
    this.featureName = featureName
  }
}

export interface FeatureSnapshot {
  name: string
  version: string
  state: FeatureState
  runtime: FeatureDescriptor['runtime']
  dependencies: readonly string[]
  reason: string | null
}

/**
 * 管理功能模块的依赖、状态和资源所有权。
 *
 * 注册表本身不创建计时器、socket 或进程；所有资源必须通过 context.resources
 * 登记，卸载时由注册表统一按逆序释放。它不感知界面：设置页需要的标题、说明和
 * 排序放在 descriptor.ui 中由宿主读取，因此新增模块不需要修改注册表。
 */
export class FeatureResourceScopeImpl implements FeatureResourceScope {
  private readonly disposers: FeatureDisposer[] = []
  private isDisposed = false

  get disposed(): boolean {
    return this.isDisposed
  }

  add(disposer: FeatureDisposer): void {
    if (typeof disposer !== 'function') {
      throw new TypeError('Feature disposer must be a function')
    }
    if (this.isDisposed) {
      throw new Error('Feature resource scope is already disposed')
    }
    this.disposers.push(disposer)
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return
    this.isDisposed = true
    const errors: unknown[] = []
    for (let index = this.disposers.length - 1; index >= 0; index -= 1) {
      try {
        await this.disposers[index]!()
      } catch (error) {
        errors.push(error)
      }
    }
    this.disposers.length = 0
    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more feature resources failed to dispose')
    }
  }
}

interface FeatureRecord<S, M extends FeatureModule<S>> {
  module: M
  state: FeatureState
  reason: string | null
  resources: FeatureResourceScopeImpl
  context: FeatureContext<S>
}

/**
 * 模块注册表：负责依赖排序、状态迁移、并发串行化和资源释放。
 *
 * @typeParam S - 注入给每个模块的宿主服务集合。
 * @typeParam M - 注册的模块类型；宿主可用它携带额外模块契约（例如设置面板）。
 */
export class FeatureRegistry<S = unknown, M extends FeatureModule<S> = FeatureModule<S>> {
  private readonly records = new Map<string, FeatureRecord<S, M>>()
  private readonly operations = new Map<string, Promise<void>>()

  /** @param services - 每个模块在 start 时通过 context.services 取用的服务集合。 */
  constructor(private readonly services: S) {}

  register(module: M): void {
    validateDescriptor(module?.descriptor)
    const name = module.descriptor.name
    if (this.records.has(name)) {
      throw new FeatureRegistryError('FEATURE_ALREADY_REGISTERED', `Feature already registered: ${name}`, name)
    }
    const resources = new FeatureResourceScopeImpl()
    this.records.set(name, {
      module,
      state: 'disabled',
      reason: null,
      resources,
      context: { descriptor: module.descriptor, resources, services: this.services },
    })
  }

  registerMany(modules: readonly M[]): void {
    for (const module of modules) this.register(module)
  }

  has(name: string): boolean {
    return this.records.has(name)
  }

  getState(name: string): FeatureState {
    return this.getRecord(name).state
  }

  getSnapshot(name: string): FeatureSnapshot {
    return snapshot(this.getRecord(name))
  }

  list(): FeatureSnapshot[] {
    return [...this.records.values()].map(snapshot)
  }

  /** 按注册顺序返回模块本体，供宿主渲染设置页或查询模块能力。 */
  modules(): readonly M[] {
    return [...this.records.values()].map((record) => record.module)
  }

  /** 返回单个模块本体；未注册时抛出 FEATURE_NOT_FOUND。 */
  getModule(name: string): M {
    return this.getRecord(name).module
  }

  /** 按注册顺序返回描述符，宿主用它计算期望启用集合。 */
  descriptors(): readonly FeatureDescriptor[] {
    return [...this.records.values()].map((record) => record.module.descriptor)
  }

  validate(): void {
    for (const record of this.records.values()) {
      for (const dependency of record.module.descriptor.dependencies) {
        if (!this.records.has(dependency)) {
          throw new FeatureRegistryError(
            'FEATURE_DEPENDENCY_MISSING',
            `Feature ${record.module.descriptor.name} depends on missing feature ${dependency}`,
            record.module.descriptor.name,
          )
        }
      }
    }
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (name: string): void => {
      if (visiting.has(name)) {
        throw new FeatureRegistryError('FEATURE_DEPENDENCY_CYCLE', `Feature dependency cycle includes ${name}`, name)
      }
      if (visited.has(name)) return
      visiting.add(name)
      for (const dependency of this.getRecord(name).module.descriptor.dependencies) visit(dependency)
      visiting.delete(name)
      visited.add(name)
    }
    for (const name of this.records.keys()) visit(name)
  }

  async start(name: string): Promise<void> {
    return this.enqueue(name, async () => {
      this.validate()
      await this.startInternal(name, new Set<string>())
    })
  }

  /**
   * 把模块状态对齐到期望启用集合。
   *
   * 期望启用的模块连同它们的依赖会被启动，其余已启用模块会被停用。依赖会被
   * 自动纳入期望集合，避免「子模块要启用、父模块却被停用」互相拆台。
   * 并发调用按模块串行队列排队，最终状态由最后一次调用决定。
   */
  async reconcile(enabledNames: readonly string[]): Promise<void> {
    this.validate()
    const desired = this.resolveDesired(enabledNames)
    for (const name of this.records.keys()) {
      if (desired.has(name)) await this.start(name)
    }
    for (const name of this.records.keys()) {
      if (!desired.has(name)) await this.disable(name)
    }
  }

  async drain(name: string): Promise<void> {
    return this.enqueue(name, async () => {
      const record = this.getRecord(name)
      if (record.state === 'disabled') return
      if (record.state === 'enabling') {
        throw new FeatureRegistryError('FEATURE_STATE_INVALID', `Cannot drain enabling feature: ${name}`, name)
      }
      if (record.state === 'draining') return
      if (record.state === 'failed') return
      record.state = 'draining'
      try {
        await record.module.drain?.(record.context)
      } catch (error) {
        record.reason = errorMessage(error)
        throw new FeatureRegistryError('FEATURE_DISPOSE_FAILED', `Failed to drain feature ${name}`, name, {
          cause: error,
        })
      }
    })
  }

  async dispose(name: string): Promise<void> {
    return this.enqueue(name, async () => {
      const record = this.getRecord(name)
      if (record.state === 'disabled') return
      const errors: unknown[] = []
      if (record.state === 'enabled') {
        record.state = 'draining'
        try {
          await record.module.drain?.(record.context)
        } catch (error) {
          errors.push(error)
        }
      }
      try {
        await record.module.dispose?.(record.context)
      } catch (error) {
        errors.push(error)
      }
      try {
        await record.resources.dispose()
      } catch (error) {
        errors.push(error)
      }
      record.state = 'disabled'
      record.reason = errors.length > 0 ? errors.map(errorMessage).join('; ') : null
      if (errors.length > 0) {
        throw new FeatureRegistryError('FEATURE_DISPOSE_FAILED', `Failed to dispose feature ${name}`, name, {
          cause: new AggregateError(errors),
        })
      }
    })
  }

  async disable(name: string): Promise<void> {
    this.validate()
    const dependents = this.activeDependents(name)
    for (const dependent of dependents) await this.disable(dependent)
    await this.dispose(name)
  }

  /** 把期望集合补齐为含依赖的闭包，避免依赖在停用阶段被误停。 */
  private resolveDesired(enabledNames: readonly string[]): Set<string> {
    const desired = new Set<string>()
    const include = (name: string): void => {
      if (desired.has(name)) return
      desired.add(name)
      for (const dependency of this.getRecord(name).module.descriptor.dependencies) include(dependency)
    }
    for (const name of enabledNames) {
      if (this.records.has(name)) include(name)
    }
    return desired
  }

  private async startInternal(name: string, starting: Set<string>): Promise<void> {
    const record = this.getRecord(name)
    if (record.state === 'enabled') return
    if (record.state === 'enabling') {
      throw new FeatureRegistryError('FEATURE_STATE_INVALID', `Feature is already enabling: ${name}`, name)
    }
    if (record.state === 'draining') {
      throw new FeatureRegistryError('FEATURE_STATE_INVALID', `Feature is draining: ${name}`, name)
    }
    if (starting.has(name)) {
      throw new FeatureRegistryError('FEATURE_DEPENDENCY_CYCLE', `Feature dependency cycle includes ${name}`, name)
    }
    starting.add(name)
    for (const dependency of record.module.descriptor.dependencies) {
      await this.enqueue(dependency, () => this.startInternal(dependency, starting))
    }
    starting.delete(name)

    if (record.resources.disposed) {
      record.resources = new FeatureResourceScopeImpl()
      record.context = { descriptor: record.module.descriptor, resources: record.resources, services: this.services }
    }
    record.state = 'enabling'
    record.reason = null
    try {
      const returned = await record.module.start(record.context)
      addReturnedDisposer(record.resources, returned)
      record.state = 'enabled'
    } catch (error) {
      try {
        await record.resources.dispose()
      } catch (disposeError) {
        error = new AggregateError([error, disposeError], 'Feature start and cleanup failed')
      }
      record.state = 'failed'
      record.reason = errorMessage(error)
      throw new FeatureRegistryError('FEATURE_START_FAILED', `Failed to start feature ${name}`, name, { cause: error })
    }
  }

  private activeDependents(name: string): string[] {
    const result: string[] = []
    for (const record of this.records.values()) {
      if (record.state !== 'enabled' && record.state !== 'draining') continue
      if (record.module.descriptor.dependencies.includes(name)) result.push(record.module.descriptor.name)
    }
    return result
  }

  private getRecord(name: string): FeatureRecord<S, M> {
    const record = this.records.get(name)
    if (!record) throw new FeatureRegistryError('FEATURE_NOT_FOUND', `Feature not found: ${name}`, name)
    return record
  }

  private enqueue(name: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.operations.get(name) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    this.operations.set(name, next)
    const cleanup = (): void => {
      if (this.operations.get(name) === next) this.operations.delete(name)
    }
    void next.then(cleanup, cleanup)
    return next
  }
}

function validateDescriptor(descriptor: FeatureDescriptor | undefined): asserts descriptor is FeatureDescriptor {
  if (!descriptor || typeof descriptor.name !== 'string' || descriptor.name.trim() === '') {
    throw new FeatureRegistryError('FEATURE_INVALID_DESCRIPTOR', 'Feature descriptor requires a non-empty name')
  }
  if (typeof descriptor.version !== 'string' || descriptor.version.trim() === '') {
    throw new FeatureRegistryError('FEATURE_INVALID_DESCRIPTOR', `Feature ${descriptor.name} requires a version`, descriptor.name)
  }
  if (typeof descriptor.enabledByDefault !== 'boolean') {
    throw new FeatureRegistryError('FEATURE_INVALID_DESCRIPTOR', `Feature ${descriptor.name} has invalid enabledByDefault`, descriptor.name)
  }
  if (descriptor.runtime !== 'host' && descriptor.runtime !== 'client' && descriptor.runtime !== 'both') {
    throw new FeatureRegistryError('FEATURE_INVALID_DESCRIPTOR', `Feature ${descriptor.name} has invalid runtime`, descriptor.name)
  }
  if (descriptor.activation !== undefined && descriptor.activation !== 'live' && descriptor.activation !== 'restart') {
    throw new FeatureRegistryError('FEATURE_INVALID_DESCRIPTOR', `Feature ${descriptor.name} has invalid activation`, descriptor.name)
  }
  if (!Array.isArray(descriptor.dependencies) || descriptor.dependencies.some((dependency) => typeof dependency !== 'string' || dependency.trim() === '')) {
    throw new FeatureRegistryError('FEATURE_INVALID_DESCRIPTOR', `Feature ${descriptor.name} has invalid dependencies`, descriptor.name)
  }
  if (new Set(descriptor.dependencies).size !== descriptor.dependencies.length) {
    throw new FeatureRegistryError('FEATURE_INVALID_DESCRIPTOR', `Feature ${descriptor.name} has duplicate dependencies`, descriptor.name)
  }
  validateUiDescriptor(descriptor)
}

function validateUiDescriptor(descriptor: FeatureDescriptor): void {
  const ui = descriptor.ui
  if (ui === undefined) return
  if (typeof ui.label !== 'string' || ui.label.trim() === '') {
    throw new FeatureRegistryError('FEATURE_INVALID_DESCRIPTOR', `Feature ${descriptor.name} has invalid ui.label`, descriptor.name)
  }
  if (typeof ui.description !== 'string' || ui.description.trim() === '') {
    throw new FeatureRegistryError('FEATURE_INVALID_DESCRIPTOR', `Feature ${descriptor.name} has invalid ui.description`, descriptor.name)
  }
  if (ui.order !== undefined && !Number.isFinite(ui.order)) {
    throw new FeatureRegistryError('FEATURE_INVALID_DESCRIPTOR', `Feature ${descriptor.name} has invalid ui.order`, descriptor.name)
  }
  if (ui.defaultOpen !== undefined && typeof ui.defaultOpen !== 'boolean') {
    throw new FeatureRegistryError('FEATURE_INVALID_DESCRIPTOR', `Feature ${descriptor.name} has invalid ui.defaultOpen`, descriptor.name)
  }
  if (ui.alwaysEnabled !== undefined && typeof ui.alwaysEnabled !== 'boolean') {
    throw new FeatureRegistryError('FEATURE_INVALID_DESCRIPTOR', `Feature ${descriptor.name} has invalid ui.alwaysEnabled`, descriptor.name)
  }
}

function addReturnedDisposer(resources: FeatureResourceScopeImpl, returned: void | FeatureDisposer): void {
  if (returned !== undefined) resources.add(returned)
}

function snapshot<S, M extends FeatureModule<S>>(record: FeatureRecord<S, M>): FeatureSnapshot {
  return {
    name: record.module.descriptor.name,
    version: record.module.descriptor.version,
    state: record.state,
    runtime: record.module.descriptor.runtime,
    dependencies: [...record.module.descriptor.dependencies],
    reason: record.reason,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

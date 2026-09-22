import {
  ResourceScopeStaleError,
  type ResourceScopeDisposer,
  type ResourceScopeInput,
  type ResourceScopeRef,
  type ResourceScopeSnapshot,
} from '../../shared/contracts/peer-host.js'

export {
  ResourceScopeStaleError,
  type ResourceScopeDisposer,
  type ResourceScopeInput,
  type ResourceScopeRef,
  type ResourceScopeSnapshot,
} from '../../shared/contracts/peer-host.js'

type RegisteredDisposer = {
  dispose: ResourceScopeDisposer
  active: boolean
}

type ActiveScope = {
  ref: ResourceScopeSnapshot
  disposers: RegisteredDisposer[]
}

/**
 * 管理当前 Host/Workspace/PeerHost 资源作用域。
 *
 * 这是纯状态协调器：它不发请求、不创建连接，也不理解具体资源类型。
 * 作用域切换会立即让旧 generation 失效，然后清理旧 disposer，最后保留新快照。
 */
export class ResourceScopeManager {
  private activeScope: ActiveScope | null = null

  private nextGeneration = 0

  private transitionTail: Promise<void> = Promise.resolve()

  constructor(initialScope?: ResourceScopeInput) {
    if (initialScope) {
      this.activeScope = {
        ref: Object.freeze({
          ...validateScopeInput(initialScope),
          scopeGeneration: 1,
        }),
        disposers: [],
      }
      this.nextGeneration = 1
    }
  }

  /** 返回当前快照；返回值不可用于修改管理器内部状态。 */
  getCurrent(): ResourceScopeSnapshot | null {
    return this.activeScope?.ref ?? null
  }

  /**
   * 切换作用域。并发切换会按调用顺序串行化，避免旧 disposer 交叉执行。
   * 相同作用域不会制造无意义的新 generation，但仍可附加 disposer。
   */
  switchTo(input: ResourceScopeInput, disposer?: ResourceScopeDisposer): Promise<ResourceScopeSnapshot> {
    const validatedInput = validateScopeInput(input)
    let result: ResourceScopeSnapshot | undefined
    const operation = this.transitionTail.then(async () => {
      const current = this.activeScope
      if (current && sameScope(current.ref, validatedInput)) {
        if (disposer) this.addDisposer(disposer)
        result = current.ref
        return
      }

      const previous = this.activeScope
      const next: ResourceScopeSnapshot = Object.freeze({
        ...validatedInput,
        scopeGeneration: ++this.nextGeneration,
      })

      // 先撤销旧快照，旧异步回调从这一刻起就会被 isCurrent 拒绝。
      // 清理完成后才提交新快照，避免新作用域与旧连接同时被观察到。
      this.activeScope = null
      let disposeError: unknown
      try {
        await disposeScope(previous)
      } catch (error) {
        disposeError = error
      }
      this.activeScope = { ref: next, disposers: [] }
      if (disposer) this.addDisposer(disposer)
      result = next
      if (disposeError) throw disposeError
    })

    this.transitionTail = operation.then(() => undefined, () => undefined)
    return operation.then(() => result as ResourceScopeSnapshot)
  }

  /**
   * 为当前作用域注册清理函数。传入旧快照会直接失败，防止资源归属错乱。
   */
  addDisposer(disposer: ResourceScopeDisposer): () => void {
    if (!this.activeScope) throw new ResourceScopeStaleError('No active resource scope')
    const entry: RegisteredDisposer = { dispose: disposer, active: true }
    this.activeScope.disposers.push(entry)
    return () => {
      entry.active = false
    }
  }

  /**
   * 按快照注册清理函数。异步初始化完成后应优先使用此方法，避免旧作用域
   * 的初始化结果把 disposer 错挂到新作用域。
   */
  registerDisposer(scope: ResourceScopeRef, disposer: ResourceScopeDisposer): () => void {
    this.assertCurrent(scope)
    return this.addDisposer(disposer)
  }

  /** 判断快照是否仍然代表当前作用域。 */
  isCurrent(scope: ResourceScopeRef | null | undefined): boolean {
    return Boolean(scope && this.activeScope && sameRef(this.activeScope.ref, scope))
  }

  /** 旧请求回写前调用；作用域不匹配时抛出稳定错误。 */
  assertCurrent(scope: ResourceScopeRef): void {
    if (!this.isCurrent(scope)) throw new ResourceScopeStaleError()
  }

  /** 只有当前作用域才能执行写入，避免旧请求污染新作用域。 */
  commitIfCurrent<T>(scope: ResourceScopeRef, write: () => T): T {
    this.assertCurrent(scope)
    return write()
  }

  /** 清理当前作用域并使其失效。后续可重新 switchTo。 */
  async clear(): Promise<void> {
    const operation = this.transitionTail.then(async () => {
      const previous = this.activeScope
      this.activeScope = null
      await disposeScope(previous)
    })
    this.transitionTail = operation.then(() => undefined, () => undefined)
    await operation
  }
}

function validateScopeInput(input: ResourceScopeInput): ResourceScopeInput {
  if (!input || !nonEmpty(input.hostId) || !nonEmpty(input.workspaceId)) {
    throw new TypeError('Resource scope hostId and workspaceId must be non-empty')
  }
  if (input.targetHostId !== null && !nonEmpty(input.targetHostId)) {
    throw new TypeError('Resource scope targetHostId must be null or non-empty')
  }
  return {
    hostId: input.hostId,
    workspaceId: input.workspaceId,
    targetHostId: input.targetHostId,
  }
}

function nonEmpty(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function sameScope(ref: ResourceScopeRef, input: ResourceScopeInput): boolean {
  return ref.hostId === input.hostId
    && ref.workspaceId === input.workspaceId
    && ref.targetHostId === input.targetHostId
}

function sameRef(left: ResourceScopeRef, right: ResourceScopeRef): boolean {
  return left.hostId === right.hostId
    && left.workspaceId === right.workspaceId
    && left.targetHostId === right.targetHostId
    && left.scopeGeneration === right.scopeGeneration
}

async function disposeScope(scope: ActiveScope | null): Promise<void> {
  if (!scope) return
  const errors: unknown[] = []
  for (const entry of [...scope.disposers].reverse()) {
    if (!entry.active) continue
    entry.active = false
    try {
      await entry.dispose()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Failed to dispose resource scope')
}

/**
 * CodingNS Host RPC 的命名空间分发表。
 *
 * 每个功能模块在启动时登记自己的命名空间，主 handler 只做一次 `namespace/action`
 * 前缀解析。新增模块只登记新命名空间，不需要修改中心分发代码。
 */
export type CodingNsRpcHandler = (action: string, payload: unknown) => unknown | Promise<unknown>

export interface CodingNsRpcTarget {
  readonly handler: CodingNsRpcHandler
  readonly action: string
}

/** 携带稳定错误码的 RPC 业务错误。 */
export class CodingNsRpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = code
  }
}

export class CodingNsRpcTable {
  private readonly handlers = new Map<string, CodingNsRpcHandler>()

  /**
   * 登记一个命名空间的处理器。
   *
   * @param namespace - 不含斜杠的命名空间，例如 `auth`。
   * @param handler - 接收动作名与载荷的处理器；抛错由主 handler 统一转成失败响应。
   * @returns 注销函数，供模块在资源作用域中登记。
   */
  register(namespace: string, handler: CodingNsRpcHandler): () => void {
    if (namespace.trim() === '' || namespace.includes('/')) {
      throw new TypeError(`RPC 命名空间非法: ${namespace}`)
    }
    if (this.handlers.has(namespace)) {
      throw new CodingNsRpcError('CODINGNS_RPC_NAMESPACE_TAKEN', `RPC 命名空间已登记: ${namespace}`)
    }
    this.handlers.set(namespace, handler)
    return () => {
      if (this.handlers.get(namespace) === handler) this.handlers.delete(namespace)
    }
  }

  /** 把 `namespace/action` 解析为处理器与动作名；命名空间未登记或格式非法时返回 null。 */
  resolve(endpoint: string): CodingNsRpcTarget | null {
    const separator = endpoint.indexOf('/')
    if (separator <= 0 || separator === endpoint.length - 1) return null
    const handler = this.handlers.get(endpoint.slice(0, separator))
    if (handler === undefined) return null
    return { handler, action: endpoint.slice(separator + 1) }
  }

  /** 当前已登记的命名空间，供诊断与测试使用。 */
  namespaces(): readonly string[] {
    return [...this.handlers.keys()]
  }
}

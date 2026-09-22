import type { CodingNsRpcTable } from '../rpc-table.js'

/**
 * Host 侧功能模块可用的服务集合。
 *
 * 模块在 start 中通过 context.services 取用；未来接入工作区、终端或进程能力时
 * 在这里增加字段，模块数量本身不改变这个契约的形状。
 */
export interface CodingNsHostServices {
  readonly rpc: CodingNsRpcTable
}

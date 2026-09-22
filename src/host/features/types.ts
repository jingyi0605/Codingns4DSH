import type { CodingNsRpcTable } from '../rpc-table.js'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { CodingNsSettings } from '../../shared/contracts/config.js'

/**
 * Host 侧功能模块可用的服务集合。
 *
 * 模块在 start 中通过 context.services 取用；未来接入工作区、终端或进程能力时
 * 在这里增加字段，模块数量本身不改变这个契约的形状。
 */
export interface CodingNsHostServices {
  readonly rpc: CodingNsRpcTable
  /** 持久化设置；测试或嵌入式调用未提供时，局域网映射仍可手动启动。 */
  readonly settings?: SettingsScope<CodingNsSettings>
  /** 当前 DSH Web 服务实际监听端口，用于自动定位本机 DSH。 */
  readonly dshWebPort?: number
}

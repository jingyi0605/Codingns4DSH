import type { CodingNsCliAdapterDescriptor } from '../shared/contracts/cli-adapter.js'
import { insertDelegationCarrier } from '../shared/delegation-carrier.js'
export { encodeDelegationCarrier, insertDelegationCarrier, parseDelegationCarriers } from '../shared/delegation-carrier.js'

/**
 * `/委派` 命令的纯逻辑层。
 *
 * 这里不导入任何 DSH Client 包，因此可以被 Node 单测直接加载；命令注册、
 * DSH 服务探测和界面文案留在 `delegate-command.ts`。
 */

/** 命令名（不带前导斜杠）；`/` 菜单里的稳定标识。 */
export const DELEGATE_COMMAND_NAME = 'delegate'

/** 一个可选的外部 Agent 适配器选项（纯数据，供 popupSelect 渲染）。 */
export interface DelegateAdapterOption {
  readonly id: string
  readonly label: string
  readonly detail?: string
}

/** 适配器选中后展示的模型选项。 */
export interface DelegateModelOption {
  readonly id: string
  readonly label: string
  readonly detail?: string
}

/**
 * 把适配器目录映射为委派选项。
 *
 * 只列出已安装且已启用的 Agent。`dsh` 由 Host 作为内置适配器提供，和外部 CLI
 * 一样允许用户明确选择；未安装或已停用的适配器即使出现在目录里也会在 Host 侧拒绝。
 */
export function delegateAdapterOptions(
  catalog: readonly CodingNsCliAdapterDescriptor[],
): readonly DelegateAdapterOption[] {
  const options: DelegateAdapterOption[] = []
  for (const adapter of catalog) {
    if (!adapter.installed || !adapter.enabled) continue
    const detail = adapter.version?.trim()
    options.push({
      id: adapter.id,
      label: adapter.name.trim() === '' ? adapter.id : adapter.name,
      ...(detail === undefined || detail === '' ? {} : { detail }),
    })
  }
  return options
}

/**
 * 从当前草稿里取出委派任务描述。
 *
 * 只认「委派」命令自己的两种拼写，且必须位于草稿开头：行内出现的 `/委派` 属于普通
 * 文本，而其它命令（如 `/model deepseek`）的草稿也不该被当成委派任务。当前 M1
 * 主链路由 carrier + Host rewrite 负责，函数仅保留给旧 Client 草稿兼容测试。
 */
export function extractDelegateTask(draft: string, adapterId?: string, adapterName?: string): string {
  const trimmed = draft.trimStart()
  const match = /^\/(delegate|委派)\s*([\s\S]*)$/u.exec(trimmed)
  if (match === null) return ''
  let rest = (match[2] ?? '').trim()
  for (const token of [adapterId, adapterName]) {
    if (token === undefined || token.trim() === '') continue
    const prefix = token.trim()
    if (rest === prefix) {
      rest = ''
      break
    }
    if (rest.startsWith(`${prefix} `)) {
      rest = rest.slice(prefix.length).trim()
      break
    }
  }
  return rest
}

/** 把选择结果追加到草稿；重复目标按 adapterId 去重。 */
export function appendDelegateCarrier(draft: string, adapterId: string, adapterName: string, modelId?: string): string {
  return insertDelegationCarrier(draft, adapterId, adapterName, modelId)
}

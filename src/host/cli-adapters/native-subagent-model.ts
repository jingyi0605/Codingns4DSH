import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'

interface NativeSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** 原生 spawn 默认继承父路由，跨 CLI 委派必须用宿主目录解析完整的原生选择。 */
export async function resolveNativeSubagentModel(sessions: CodingNsNativeSessionBridge, requested?: string): Promise<NativeSelection> {
  const controller = sessions.controller
  if (typeof controller?.modelCatalog !== 'function') throw new Error('DELEGATE_DSH_ROUTE_UNAVAILABLE: 无法读取 DSH 原生模型目录，已停止委派以避免继承外部 Agent 路由。')
  const catalog = await controller.modelCatalog() as {
    groups?: readonly { id?: unknown; models?: readonly { id?: unknown }[] }[]
    default?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  } | undefined
  const choices = (catalog?.groups ?? []).flatMap(group => typeof group.id === 'string' && group.id.trim() !== '' && !group.id.startsWith('codingns-cli-')
    ? (group.models ?? []).flatMap(model => typeof model.id === 'string' && model.id.trim() !== '' ? [{ provider: group.id as string, model: model.id }] : [])
    : [])
  const id = requested?.trim()
  if (!id || id === 'provider-default') {
    const current = catalog?.default
    const selected = choices.find(item => item.provider === current?.provider && item.model === current?.model)
    if (selected === undefined) throw new Error('DELEGATE_DSH_ROUTE_UNAVAILABLE: 当前 DSH 默认供应商与模型不可用，请在委派菜单中重新选择。')
    return { ...selected, ...(typeof current?.reasoningEffort === 'string' ? { reasoningEffort: current.reasoningEffort } : {}) }
  }
  const qualified = choices.filter(item => `${item.provider}/${item.model}` === id)
  const matching = qualified.length > 0 ? qualified : choices.filter(item => item.model === id)
  if (matching.length === 0) throw new Error(`DELEGATE_DSH_MODEL_NOT_FOUND: DSH 模型目录不包含 ${id}，请重新选择。`)
  if (matching.length > 1) throw new Error(`DELEGATE_DSH_MODEL_AMBIGUOUS: ${id} 属于多个供应商，请在委派菜单中选择具体供应商。`)
  return matching[0]!
}

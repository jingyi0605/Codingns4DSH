import { useEffect, useRef, useState } from 'react'
import { DESKTOP_ASSISTANT_CHANNEL, type DesktopAssistantPresentation, type DesktopAssistantStatus } from '../../shared/desktop-assistant.js'
import type { CodingNsRpcClient } from '../features/types.js'

/** 普通浏览器即使连接到 Desktop 的 Host，也只能使用页面内形象。 */
export function isDesktopAssistantClient(globals: { readonly dshDesktopBoot?: unknown; readonly location?: { readonly protocol: string } }): boolean {
  return globals.dshDesktopBoot !== undefined || globals.location?.protocol === 'dsh-app:'
}

export interface DesktopAssistantClientBridge { update(value: DesktopAssistantPresentation): void; dispose(): void }
/** 单条串行请求链负责状态与事件，刷新/卸载时迟到响应不再更新 React。 */
export function connectDesktopAssistant(rpc: CodingNsRpcClient, ownerId: string, onStatus: (status: DesktopAssistantStatus) => void,
  onOpen: () => void, interval = 1000): DesktopAssistantClientBridge {
  let disposed = false, sequence = 0, failures = 0, openSequence: number | undefined
  let presentation: DesktopAssistantPresentation = { visible: false, state: 'idle', caption: '', label: '' }
  let timer: ReturnType<typeof setTimeout> | undefined
  let attached = false
  let polling = false, changed = false
  const call = async (action: string, payload: unknown): Promise<DesktopAssistantStatus> => {
    const result = await rpc.call(DESKTOP_ASSISTANT_CHANNEL, action, payload, AbortSignal.timeout(25000))
    if (!result.ok) throw new Error(result.error.message)
    const status = result.value as DesktopAssistantStatus
    if (!status || typeof status.visible !== 'boolean' || typeof status.openSequence !== 'number') throw new Error('系统悬浮接口不可用')
    return status
  }
  const detach = (): void => { void call('detach', { ownerId }).catch(() => undefined) }
  const poll = async (): Promise<void> => {
    if (polling || disposed) return
    polling = true; changed = false
    let nextInterval = interval
    try {
      if (!attached) {
        const initial = await call('attach', { ownerId })
        // 断连重附着不吞掉尚未消费的点击；Host 重建后才回退事件序号。
        openSequence = Math.min(openSequence ?? initial.openSequence, initial.openSequence); attached = true
      }
      if (disposed) return
      const requested = presentation
      const status = await call('update', { ownerId, sequence: ++sequence, presentation: requested })
      if (disposed) return
      failures = 0
      // Host 重建可能发生在两次成功轮询之间；只在无人持有时重新附着，不能争抢另一页面。
      if (status.attached === false && !status.owned && status.available) { attached = false; changed = true; return }
      // 在途请求期间开关发生变化时，旧响应不能覆盖当前显示位置。
      if (requested.visible === presentation.visible) onStatus(status)
      if (openSequence !== undefined && status.openSequence > openSequence && status.owned) onOpen()
      openSequence = status.openSequence
    } catch (error) {
      attached = false
      nextInterval = ++failures < 3 ? interval : Math.max(interval, 15000)
      // RPC 短暂失败不能证明原生窗口消失；连续失败才回退，原生明确错误仍立即处理。
      if (!disposed && failures >= 3) onStatus({ available: false, owned: false, visible: false, openSequence: openSequence ?? 0,
        error: error instanceof Error ? error.message : String(error) })
    } finally {
      polling = false
      if (disposed) detach()
      else timer = setTimeout(() => { void poll() }, changed ? 0 : nextInterval)
    }
  }
  void poll()
  return {
    update(value) {
      presentation = value; changed = true
      if (!polling) { clearTimeout(timer); void poll() }
    },
    dispose() { disposed = true; clearTimeout(timer); if (!polling) detach() },
  }
}

export function useDesktopAssistant(rpc: CodingNsRpcClient, presentation: DesktopAssistantPresentation, onOpen: () => void): { native: boolean; visible: boolean; error?: string | undefined } {
  const [snapshot, setSnapshot] = useState<{ rpc: CodingNsRpcClient; enabled: boolean; status: DesktopAssistantStatus }>()
  const desktop = isDesktopAssistantClient(globalThis as typeof globalThis & { dshDesktopBoot?: unknown })
  const latest = useRef(presentation), open = useRef(onOpen)
  latest.current = presentation; open.current = onOpen
  const bridge = useRef<DesktopAssistantClientBridge>()
  useEffect(() => {
    if (!desktop) return
    const client = connectDesktopAssistant(rpc, `codingns-companion:${crypto.randomUUID()}`, (status) => setSnapshot({ rpc, enabled: latest.current.visible, status }), () => open.current())
    bridge.current = client; client.update(latest.current)
    return () => { bridge.current = undefined; client.dispose() }
  }, [rpc, desktop])
  useEffect(() => { bridge.current?.update(presentation) }, [presentation.visible, presentation.state, presentation.caption, presentation.label])
  const status = snapshot?.rpc === rpc && snapshot.enabled === presentation.visible ? snapshot.status : undefined
  // Desktop 首帧即保留原生展示位置；visible=false 只是尚未收到 shown，不能渲染第二份形象。
  // 只有明确不可用、原生错误或持续断连才切换页面回退，组件重挂载也不会先闪一下页面形象。
  return { native: desktop && (status === undefined || (status.available && !status.error)),
    visible: status?.visible ?? false, error: status?.error }
}

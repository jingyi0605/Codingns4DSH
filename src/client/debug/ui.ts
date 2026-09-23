import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CodingNsRpcClient, CodingNsRpcResult } from '../features/types.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'

export const DEBUG_KIND = 'debug'
export const DEBUG_PROVIDER_ID = 'dsh-codingns/debug'

interface DebugTabProps extends PropsRuntime<'sidebar.right.pane.tab'> {
  readonly rpc: CodingNsRpcClient
  readonly remote: unknown
  readonly sidebarRight: Context['sidebarRight']
}

interface DebugProfile {
  readonly id: string
  readonly name: string
  readonly port: number | null
  readonly proxy: { readonly enabled: boolean }
}

interface DebugConfig { readonly profiles: readonly DebugProfile[] }
interface DebugInstance { readonly id: string; readonly profileId: string; readonly state: string; readonly terminalId: string }
interface DebugPortCheck { readonly id: string; readonly listening: boolean; readonly process: { readonly pid: number; readonly command: string | null } | null }

/** 注册最小 Debug 页面；页面只负责展示和发送用户意图。 */
export function registerDebugUi(ctx: Context, rpc: CodingNsRpcClient, remote: unknown): () => void {
  const disposers: Array<() => void> = []
  disposers.push(ctx.sidebarRightTabs.register({
    id: DEBUG_PROVIDER_ID,
    kind: DEBUG_KIND,
    multiple: false,
    priority: 'extension',
    title: () => '调试',
    guide: [{ id: 'debug', order: 30, title: () => '调试', description: () => '启动工作区命令、检查端口并访问服务', icon: DebugIcon }],
  }))
  disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: DEBUG_PROVIDER_ID,
    inject: () => ({ rpc, remote, sidebarRight: ctx.sidebarRight }),
  }, DebugBody)))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

function DebugBody({ sessionId, rpc, remote, sidebarRight }: DebugTabProps): ReactElement {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [config, setConfig] = useState<DebugConfig | null>(null)
  const [instances, setInstances] = useState<readonly DebugInstance[]>([])
  const [message, setMessage] = useState('正在读取工作区…')
  const [busy, setBusy] = useState(false)

  const load = async (currentWorkspaceId: string): Promise<void> => {
    const scope = { sessionId: String(sessionId), workspaceId: currentWorkspaceId, generation: 0 }
    const next = await call<DebugConfig>(rpc, 'debug/config/get', scope)
    const running = await call<readonly DebugInstance[]>(rpc, 'debug/runtime/list', scope)
    setConfig(next)
    setInstances(running)
    setMessage(next.profiles.length === 0 ? '当前 Workspace 没有启动配置' : '')
  }

  useEffect(() => {
    let disposed = false
    const terminal = (remote as { readonly terminal?: { readonly environment?: (id: string) => Promise<unknown> } } | undefined)?.terminal
    void (async () => {
      try {
        const environment = await terminal?.environment?.(String(sessionId))
        const id = readWorkspaceId(environment)
        if (id === null) throw new Error('当前 Session 没有关联 Workspace')
        if (disposed) return
        setWorkspaceId(id)
        await load(id)
      } catch (error) {
        if (!disposed) setMessage(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => { disposed = true }
  }, [sessionId])

  if (workspaceId === null) return createElement('section', { style: panelStyle }, createElement('p', undefined, message))
  const profiles = config?.profiles ?? []
  return createElement('section', { style: panelStyle },
    createElement('header', { style: headerStyle }, createElement('strong', undefined, '工作区调试'), createElement('span', { style: mutedStyle }, workspaceId)),
    message && createElement('p', { role: 'status' }, message),
    profiles.map((profile) => createElement('article', { key: profile.id, style: itemStyle },
      createElement('div', undefined, createElement('strong', undefined, profile.name), profile.port === null ? null : createElement('span', { style: mutedStyle }, `端口 ${profile.port}`)),
      createElement('div', { style: actionsStyle },
        createElement('button', { type: 'button', disabled: busy, onClick: () => void launch(profile) }, '启动'),
        profile.port === null ? null : createElement('button', { type: 'button', disabled: busy, onClick: () => void inspect(profile) }, '检查端口'),
        instances.filter((instance) => instance.profileId === profile.id && instance.state === 'running').map((instance) => createElement('button', { key: instance.id, type: 'button', disabled: busy, onClick: () => void stop(instance) }, '停止')),
      ),
    )),
  )

  async function launch(profile: DebugProfile): Promise<void> {
    await withBusy(async () => {
      const result = await call<{ instance: DebugInstance; terminal: { readonly id: string } }>(rpc, 'debug/profile/launch', { sessionId: String(sessionId), workspaceId, generation: 0, profileId: profile.id, cols: 120, rows: 32 })
      setInstances((current) => [...current.filter((item) => item.id !== result.instance.id), result.instance])
      sidebarRight.openTabIn(String(sessionId) as Parameters<typeof sidebarRight.openTabIn>[0], 'terminal', { params: { terminalId: result.terminal.id } })
    })
  }

  async function inspect(profile: DebugProfile): Promise<void> {
    await withBusy(async () => {
      const result = await call<DebugPortCheck>(rpc, 'debug/port/check', { sessionId: String(sessionId), workspaceId, generation: 0, profileId: profile.id })
      setMessage(result.listening ? `端口正在监听${result.process?.pid === undefined ? '' : `（PID ${result.process.pid}）`}` : '端口未监听')
      if (result.listening && result.process !== null && window.confirm('确认结束当前监听进程？')) {
        await call(rpc, 'debug/port/terminate', { sessionId: String(sessionId), workspaceId, generation: 0, checkId: result.id })
        setMessage('监听进程已结束')
      }
    })
  }

  async function stop(instance: DebugInstance): Promise<void> {
    await withBusy(async () => {
      await call(rpc, 'debug/runtime/stop', { sessionId: String(sessionId), workspaceId, generation: 0, instanceId: instance.id })
      setInstances((current) => current.map((item) => item.id === instance.id ? { ...item, state: 'exited' } : item))
    })
  }

  async function withBusy(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try { await action() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
}

function call<T = unknown>(rpc: CodingNsRpcClient, endpoint: string, payload: unknown): Promise<T> {
  return rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload).then((result: CodingNsRpcResult) => {
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  })
}

function readWorkspaceId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = (value as { readonly value?: unknown }).value ?? value
  if (typeof candidate !== 'object' || candidate === null) return null
  const id = (candidate as { readonly workspaceId?: unknown }).workspaceId
  return typeof id === 'string' && id.trim() !== '' ? id : null
}

function DebugIcon({ size = 22, className }: { readonly size?: number | undefined; readonly className?: string | undefined }): ReactElement {
  return createElement('svg', { width: size, height: size, className, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true }, createElement('path', { d: 'M5 5h14v14H5zM8 9h8M8 12h5M8 15h8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
}

const panelStyle = { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, height: '100%', overflow: 'auto' } as const
const headerStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' } as const
const itemStyle = { border: '1px solid var(--dsh-color-border, #d9dce3)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 } as const
const actionsStyle = { display: 'flex', flexWrap: 'wrap', gap: 8 } as const
const mutedStyle = { color: 'var(--dsh-color-text-secondary, #6b7280)', fontSize: 12, marginLeft: 8 } as const

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap { debug: undefined }
}

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
  readonly cwdRelative: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly shell: { readonly profileId: string; readonly path: string; readonly args: readonly string[]; readonly name: string }
  readonly runtimeType: string
  readonly port: number | null
  readonly proxy: { readonly enabled: boolean }
}

interface DebugConfig { readonly profiles: readonly DebugProfile[] }
interface DebugInstance { readonly id: string; readonly profileId: string; readonly state: string; readonly terminalId: string }
interface DebugPortCheck { readonly id: string; readonly listening: boolean; readonly process: { readonly pid: number; readonly command: string | null } | null }
interface DebugProxyBinding { readonly id: string; readonly profileId: string; readonly instanceId: string; readonly url: string }
interface DebugProfileDraft {
  readonly name: string
  readonly cwdRelative: string
  readonly command: string
  readonly args: string
  readonly shellProfileId: string
  readonly shellPath: string
  readonly shellArgs: string
  readonly runtimeType: string
  readonly port: string
  readonly proxyEnabled: boolean
}

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
  const [bindings, setBindings] = useState<readonly DebugProxyBinding[]>([])
  const [draft, setDraft] = useState<DebugProfileDraft | null>(null)
  const [message, setMessage] = useState('正在读取工作区…')
  const [busy, setBusy] = useState(false)

  const load = async (currentWorkspaceId: string): Promise<void> => {
    const scope = { sessionId: String(sessionId), workspaceId: currentWorkspaceId, generation: 0 }
    const next = await call<DebugConfig>(rpc, 'debug/config/get', scope)
    const running = await call<readonly DebugInstance[]>(rpc, 'debug/runtime/list', scope)
    setConfig(next)
    setInstances(running)
    setMessage('')
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
    createElement('header', { style: headerStyle },
      createElement('strong', undefined, '工作区调试'),
      createElement('div', { style: actionsStyle },
        createElement('span', { style: mutedStyle }, workspaceId),
        createElement('button', { type: 'button', disabled: busy || draft !== null, onClick: () => setDraft(createProfileDraft()) }, '添加启动配置'),
      ),
    ),
    message && createElement('p', { role: 'status' }, message),
    draft === null ? null : createProfileForm(draft),
    profiles.length === 0 && draft === null ? createElement('p', { role: 'status' }, '当前 Workspace 没有启动配置，请先添加一个启动配置。') : null,
    profiles.map((profile) => createElement('article', { key: profile.id, style: itemStyle },
      createElement('div', undefined, createElement('strong', undefined, profile.name), profile.port === null ? null : createElement('span', { style: mutedStyle }, `端口 ${profile.port}`)),
      createElement('div', { style: actionsStyle },
        createElement('button', { type: 'button', disabled: busy, onClick: () => void launch(profile) }, '启动'),
        profile.port === null ? null : createElement('button', { type: 'button', disabled: busy, onClick: () => void inspect(profile) }, '检查端口'),
        instances.filter((instance) => instance.profileId === profile.id && instance.state === 'running').map((instance) => createElement('button', { key: instance.id, type: 'button', disabled: busy, onClick: () => void stop(instance) }, '停止')),
        instances.filter((instance) => instance.profileId === profile.id && instance.state === 'running' && profile.proxy.enabled).map((instance) => {
          const binding = bindings.find((item) => item.instanceId === instance.id)
          return binding === undefined
            ? createElement('button', { key: `proxy-${instance.id}`, type: 'button', disabled: busy, onClick: () => void enableProxy(profile, instance) }, '开启代理')
            : createElement('span', { key: `proxy-${instance.id}`, style: mutedStyle }, createElement('a', { href: binding.url, target: '_blank', rel: 'noreferrer' }, '打开代理'), createElement('button', { type: 'button', disabled: busy, onClick: () => void disableProxy(binding) }, '关闭代理'))
        }),
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

  function createProfileForm(value: DebugProfileDraft): ReactElement {
    const field = (label: string, key: keyof DebugProfileDraft, type = 'text'): ReactElement => createElement('label', { style: fieldStyle },
      createElement('span', undefined, label),
      createElement('input', {
        type,
        value: typeof value[key] === 'boolean' ? undefined : value[key],
        checked: typeof value[key] === 'boolean' ? value[key] : undefined,
        onChange: (event: { currentTarget: { value: string; checked: boolean } }) => setDraft({ ...value, [key]: type === 'checkbox' ? event.currentTarget.checked : event.currentTarget.value }),
      }),
    )
    return createElement('form', { style: formStyle, onSubmit: (event: { preventDefault: () => void }) => { event.preventDefault(); void saveProfile(value) } },
      createElement('strong', undefined, '添加启动配置'),
      field('名称', 'name'),
      field('启动命令', 'command'),
      field('命令参数（空格分隔）', 'args'),
      field('启动目录（Workspace 内相对路径）', 'cwdRelative'),
      createElement('label', { style: fieldStyle }, createElement('span', undefined, 'Shell'), createElement('select', { value: value.shellProfileId, onChange: (event: { currentTarget: { value: string } }) => setDraft({ ...value, shellProfileId: event.currentTarget.value }) },
        createElement('option', { value: 'zsh' }, 'zsh'), createElement('option', { value: 'bash' }, 'bash'), createElement('option', { value: 'powershell' }, 'PowerShell'), createElement('option', { value: 'cmd' }, 'cmd'), createElement('option', { value: 'git-bash' }, 'Git Bash'),
      )),
      field('Shell 可执行文件', 'shellPath'),
      field('Shell 参数（空格分隔）', 'shellArgs'),
      createElement('label', { style: fieldStyle }, createElement('span', undefined, '运行类型'), createElement('select', { value: value.runtimeType, onChange: (event: { currentTarget: { value: string } }) => setDraft({ ...value, runtimeType: event.currentTarget.value }) },
        createElement('option', { value: 'local-pty' }, 'local-pty'), createElement('option', { value: 'tmux' }, 'tmux'), createElement('option', { value: 'conpty-powershell' }, 'ConPTY PowerShell'), createElement('option', { value: 'conpty-cmd' }, 'ConPTY cmd'), createElement('option', { value: 'conpty-git-bash' }, 'ConPTY Git Bash'),
      )),
      field('端口（可选）', 'port', 'number'),
      createElement('label', { style: checkboxStyle }, createElement('input', { type: 'checkbox', checked: value.proxyEnabled, onChange: (event: { currentTarget: { checked: boolean } }) => setDraft({ ...value, proxyEnabled: event.currentTarget.checked }) }), '启用服务代理'),
      createElement('div', { style: actionsStyle },
        createElement('button', { type: 'submit', disabled: busy }, '保存配置'),
        createElement('button', { type: 'button', disabled: busy, onClick: () => setDraft(null) }, '取消'),
      ),
    )
  }

  async function saveProfile(value: DebugProfileDraft): Promise<void> {
    await withBusy(async () => {
      const profile = {
        id: createProfileId(),
        name: value.name.trim(),
        cwdRelative: value.cwdRelative.trim(),
        command: value.command.trim(),
        args: splitArgs(value.args),
        env: {},
        shell: { profileId: value.shellProfileId, path: value.shellPath.trim(), args: splitArgs(value.shellArgs), name: value.shellProfileId },
        runtimeType: value.runtimeType,
        port: value.port.trim() === '' ? null : Number(value.port),
        proxy: { enabled: value.proxyEnabled },
      }
      const next = await call<DebugConfig>(rpc, 'debug/config/save', { sessionId: String(sessionId), workspaceId, generation: 0, config: { version: 1, profiles: [...profiles, profile] } })
      setConfig(next)
      setDraft(null)
      setMessage('启动配置已保存')
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
      setBindings((current) => current.filter((item) => item.instanceId !== instance.id))
    })
  }

  async function enableProxy(profile: DebugProfile, instance: DebugInstance): Promise<void> {
    await withBusy(async () => {
      const binding = await call<DebugProxyBinding>(rpc, 'debug/proxy/enable', { sessionId: String(sessionId), workspaceId, generation: 0, profileId: profile.id, instanceId: instance.id })
      setBindings((current) => [...current.filter((item) => item.id !== binding.id && item.instanceId !== binding.instanceId), binding])
      setMessage(`代理已开启：${binding.url}`)
    })
  }

  async function disableProxy(binding: DebugProxyBinding): Promise<void> {
    await withBusy(async () => {
      await call(rpc, 'debug/proxy/disable', { sessionId: String(sessionId), workspaceId, generation: 0, bindingId: binding.id })
      setBindings((current) => current.filter((item) => item.id !== binding.id))
    })
  }

  async function withBusy(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try { await action() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
}

async function call<T = unknown>(rpc: CodingNsRpcClient, endpoint: string, payload: unknown): Promise<T> {
  let result: CodingNsRpcResult
  try {
    result = await rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/HTTP (?:404|405)\b/u.test(message)) throw error
    result = await rpc.call('/api', `codingns/${endpoint}`, payload)
  }
  if (!result.ok) throw new Error(result.error.message)
  return result.value as T
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
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 4 } as const
const formStyle = { ...itemStyle, background: 'var(--dsh-color-surface, #f8f9fb)' } as const
const checkboxStyle = { display: 'flex', alignItems: 'center', gap: 8 } as const

function createProfileDraft(): DebugProfileDraft {
  const windows = typeof navigator !== 'undefined' && /Windows/u.test(navigator.userAgent)
  return {
    name: '开发服务', cwdRelative: '.', command: windows ? 'npm' : 'pnpm', args: 'run dev',
    shellProfileId: windows ? 'powershell' : 'zsh', shellPath: windows ? 'powershell.exe' : '/bin/zsh', shellArgs: windows ? '-NoLogo' : '-i',
    runtimeType: windows ? 'conpty-powershell' : 'local-pty', port: '', proxyEnabled: false,
  }
}

function splitArgs(value: string): readonly string[] { return value.trim() === '' ? [] : value.trim().split(/\s+/u) }

function createProfileId(): string {
  const id = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `debug-${id.slice(0, 12)}`
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap { debug: undefined }
}

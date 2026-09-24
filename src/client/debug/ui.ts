import { createElement, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CodingNsRpcClient, CodingNsRpcResult } from '../features/types.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import { dshButtonStyle, dshFieldStyle, dshFormRootStyle, dshThemeColor } from '../theme.js'

export const DEBUG_KIND = 'debug'
export const DEBUG_PROVIDER_ID = 'dsh-codingns/debug'
const PORT_CHECK_INTERVAL_MS = 5_000

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
interface HostTerminalStatus {
  readonly platform: 'darwin' | 'linux' | 'win32' | 'unsupported'
  readonly profiles: readonly { readonly profileId: 'zsh' | 'bash' | 'powershell' | 'cmd' | 'git-bash'; readonly name: string; readonly path: string }[]
  readonly resolvedProfileId: 'zsh' | 'bash' | 'powershell' | 'cmd' | 'git-bash' | null
}
interface DebugProfileDraft {
  readonly id: string | null
  readonly name: string
  readonly cwdRelative: string
  readonly commandLine: string
  readonly shellProfileId: 'system' | 'zsh' | 'bash' | 'powershell' | 'cmd' | 'git-bash'
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
  const [portChecks, setPortChecks] = useState<Readonly<Record<string, DebugPortCheck>>>({})
  const [terminalStatus, setTerminalStatus] = useState<HostTerminalStatus | null>(null)
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
    setPortChecks({})
    const terminal = (remote as { readonly terminal?: { readonly environment?: (id: string) => Promise<unknown> } } | undefined)?.terminal
    void call<HostTerminalStatus>(rpc, 'terminal/status', {}).then((status) => {
      if (!disposed) setTerminalStatus(status)
    }).catch(() => { /* 调试页仍可使用系统默认 Shell；Host 状态只是可用项过滤依据。 */ })
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

  useEffect(() => {
    if (workspaceId === null || config === null) return
    if (!config.profiles.some((profile) => profile.port !== null)) return
    let disposed = false
    let checking = false
    const checkPorts = async (): Promise<void> => {
      if (checking) return
      checking = true
      try {
        const portProfiles = config.profiles.filter((profile) => profile.port !== null)
        const results = await Promise.all(portProfiles.map(async (profile) => {
          try {
            return { profileId: profile.id, result: await requestPortCheck(profile) }
          } catch {
            return null
          }
        }))
        if (disposed) return
        setPortChecks((current) => {
          const next: Record<string, DebugPortCheck> = {}
          for (const profile of portProfiles) {
            const result = results.find((item) => item?.profileId === profile.id)?.result
            if (result !== undefined) next[profile.id] = result
            else {
              const previous = current[profile.id]
              if (previous !== undefined) next[profile.id] = previous
            }
          }
          return next
        })
      } finally {
        checking = false
      }
    }
    void checkPorts()
    const timer = setInterval(() => { void checkPorts() }, PORT_CHECK_INTERVAL_MS)
    return () => { disposed = true; clearInterval(timer) }
  }, [workspaceId, config, sessionId])

  if (workspaceId === null) return createElement('section', { style: panelStyle }, createElement('div', { style: loadingStyle }, createElement('span', { style: loadingDotStyle }), message))
  const profiles = config?.profiles ?? []
  return createElement('section', { style: panelStyle },
    createElement('header', { style: headerStyle },
      createElement('div', { style: titleBlockStyle },
        createElement('div', { style: eyebrowStyle }, '工作区工具'),
        createElement('h2', { style: titleStyle }, '工作区调试'),
        createElement('div', { style: workspaceStyle, title: workspaceId }, createElement('span', { style: workspaceDotStyle }), workspaceId),
      ),
      createElement('div', { style: headerActionsStyle },
        createElement('span', { style: countStyle }, `${profiles.length} 个配置`),
      createElement('button', { type: 'button', 'aria-label': '添加启动配置', disabled: busy || draft !== null, onClick: () => setDraft(createProfileDraft()), style: primaryButtonStyle }, createElement('span', { 'aria-hidden': true }, '+'), ' 添加配置'),
      ),
    ),
    message && createElement('div', { role: 'status', 'aria-live': 'polite', style: statusStyle(statusTone(message)) }, createElement('span', { style: statusIconStyle }, statusTone(message) === 'success' ? '✓' : statusTone(message) === 'error' ? '!' : 'i'), message),
    draft === null ? null : createProfileForm(draft),
    profiles.length === 0 && draft === null ? createElement('div', { style: emptyStyle },
      createElement('div', { style: emptyIconStyle }, createElement(DebugIcon, { size: 22 })),
      createElement('strong', { style: emptyTitleStyle }, '还没有启动配置'),
      createElement('p', { style: emptyTextStyle }, '为当前 Workspace 添加一个命令，即可从这里启动终端、检查端口和访问服务。'),
      createElement('button', { type: 'button', 'aria-label': '添加启动配置', disabled: busy, onClick: () => setDraft(createProfileDraft()), style: secondaryButtonStyle }, '+ 添加第一个配置'),
    ) : null,
    profiles.map((profile) => {
      const running = runningInstances(profile, instances)
      const portCheck = portChecks[profile.id]
      return createElement('article', { key: profile.id, style: itemStyle },
      createElement('div', { style: itemHeaderStyle },
        createElement('div', { style: itemTitleBlockStyle },
          createElement('strong', { style: itemTitleStyle }, profile.name),
          createElement('span', { style: itemCommandStyle }, formatCommand(profile)),
        ),
        createElement('span', { style: running > 0 ? runningBadgeStyle : stoppedBadgeStyle }, running > 0 ? `${running} 个运行中` : '未运行'),
      ),
      createElement('div', { style: metaStyle },
        createElement('span', { style: metaItemStyle }, createElement('span', { style: metaKeyStyle }, '目录'), profile.cwdRelative || '.'),
        profile.port === null ? null : createElement('span', { style: metaItemStyle }, createElement('span', { style: metaKeyStyle }, '端口'), String(profile.port)),
        createElement('span', { style: metaItemStyle }, createElement('span', { style: metaKeyStyle }, '运行方式'), profile.runtimeType),
        profile.proxy.enabled ? createElement('span', { style: proxyBadgeStyle }, '代理已启用') : null,
      ),
      profile.port === null ? null : createElement('div', { style: portStatusStyle }, portCheck === undefined
        ? createElement('span', { style: portUnknownStyle }, '端口状态尚未检查')
        : portCheck.listening
          ? createElement('span', { style: portListeningStyle }, `端口 ${profile.port} 正在监听${portCheck.process?.pid === undefined ? '' : ` · PID ${portCheck.process.pid}`}`)
          : createElement('span', { style: portStoppedStyle }, `端口 ${profile.port} 未监听`)),
      createElement('div', { style: actionsStyle },
        createElement('button', { type: 'button', disabled: busy, onClick: () => void launch(profile), style: primaryButtonStyle }, '启动'),
        profile.port === null ? null : createElement('button', { type: 'button', disabled: busy, onClick: () => void inspect(profile), style: secondaryButtonStyle }, '检查端口'),
        portCheck?.listening === true && portCheck.process !== null ? createElement('button', { type: 'button', title: '只结束端口监听进程，保留终端窗口', disabled: busy, onClick: () => void terminatePort(profile, portCheck), style: dangerButtonStyle }, '结束进程') : null,
        instances.filter((instance) => instance.profileId === profile.id && instance.state === 'running').map((instance) => createElement('button', { key: instance.id, type: 'button', title: '停止并关闭终端窗口', disabled: busy, onClick: () => void stop(instance), style: dangerButtonStyle }, '停止')),
        createElement('span', { style: actionDividerStyle }),
        createElement('button', { type: 'button', disabled: busy, onClick: () => setDraft(createProfileDraft(profile)), style: quietButtonStyle }, '编辑'),
        createElement('button', { type: 'button', disabled: busy, onClick: () => void deleteProfile(profile), style: dangerQuietButtonStyle }, '删除'),
        instances.filter((instance) => instance.profileId === profile.id && instance.state === 'running' && profile.proxy.enabled).map((instance) => {
          const binding = bindings.find((item) => item.instanceId === instance.id)
          return binding === undefined
            ? createElement('button', { key: `proxy-${instance.id}`, type: 'button', disabled: busy, onClick: () => void enableProxy(profile, instance), style: secondaryButtonStyle }, '开启代理')
            : createElement('span', { key: `proxy-${instance.id}`, style: proxyActionsStyle }, createElement('a', { href: binding.url, target: '_blank', rel: 'noreferrer', style: linkStyle }, '打开代理'), createElement('button', { type: 'button', disabled: busy, onClick: () => void disableProxy(binding), style: quietButtonStyle }, '关闭'))
        }),
      ),
    )
    }),
  )

  async function launch(profile: DebugProfile): Promise<void> {
    await withBusy(async () => {
      const result = await call<{ instance: DebugInstance; terminal: { readonly id: string } }>(rpc, 'debug/profile/launch', { sessionId: String(sessionId), workspaceId, generation: 0, profileId: profile.id, cols: 120, rows: 32 })
      setInstances((current) => [...current.filter((item) => item.id !== result.instance.id), result.instance])
      sidebarRight.openTabIn(String(sessionId) as Parameters<typeof sidebarRight.openTabIn>[0], 'terminal', { params: { terminalId: result.terminal.id } })
    })
  }

  function createProfileForm(value: DebugProfileDraft): ReactElement {
    const field = (label: string, key: 'name' | 'cwdRelative' | 'commandLine' | 'port', type = 'text', placeholder?: string, layout?: CSSProperties): ReactElement => createElement('label', { style: { ...fieldStyle, ...layout } },
      createElement('span', { style: fieldLabelStyle }, label),
      createElement('input', {
        type,
        value: typeof value[key] === 'boolean' ? undefined : value[key],
        placeholder,
        required: key === 'name' || key === 'commandLine',
        min: key === 'port' ? 1 : undefined,
        max: key === 'port' ? 65535 : undefined,
        step: key === 'port' ? 1 : undefined,
        autoComplete: 'off',
        onChange: (event: { currentTarget: { value: string } }) => setDraft({ ...value, [key]: event.currentTarget.value }),
        style: inputStyle,
      }),
    )
    const selectField = (label: string, key: 'shellProfileId', options: readonly { value: DebugProfileDraft['shellProfileId']; label: string }[]): ReactElement => createElement('label', { style: selectFieldStyle },
      createElement('span', { style: fieldLabelStyle }, label),
      createElement('select', { value: value[key], onChange: (event: { currentTarget: { value: string } }) => setDraft({ ...value, [key]: event.currentTarget.value as DebugProfileDraft['shellProfileId'] }), style: inputStyle }, ...options.map((option) => createElement('option', { key: option.value, value: option.value }, option.label))),
    )
    return createElement('div', { role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'debug-shortcut-title', style: formOverlayStyle },
      createElement('form', { style: formStyle, onSubmit: (event: { preventDefault: () => void }) => { event.preventDefault(); void saveProfile(value) } },
        createElement('div', { style: formHeaderStyle }, createElement('div', undefined, createElement('h3', { id: 'debug-shortcut-title', style: formTitleStyle }, value.id === null ? '添加快捷启动项' : '编辑快捷启动项'), createElement('p', { style: formHintStyle }, '保存一组可重复使用的启动参数，之后可以一键打开终端。')), createElement('button', { type: 'button', disabled: busy, onClick: () => setDraft(null), style: closeButtonStyle, 'aria-label': '关闭快捷启动项' }, '×')),
        createElement('section', { style: formSectionStyle },
          createElement('div', { style: formSectionHeaderStyle }, createElement('strong', { style: formSectionTitleStyle }, '启动入口'), createElement('span', { style: formSectionHintStyle }, '直接输入完整命令，例如 pnpm run dev --host 0.0.0.0。')),
          createElement('div', { style: formGridStyle },
            field('名称', 'name', 'text', '例如：前端开发'),
            field('启动目录（Workspace 内相对路径）', 'cwdRelative', 'text', '留空使用根目录'),
            field('完整启动命令', 'commandLine', 'text', '例如：pnpm run dev --host 0.0.0.0', { gridColumn: '1 / -1' }),
          ),
        ),
        createElement('section', { style: formSectionStyle },
          createElement('div', { style: formSectionHeaderStyle }, createElement('strong', { style: formSectionTitleStyle }, '执行环境（可选）'), createElement('span', { style: formSectionHintStyle }, '只显示 Host 实际检测到的 Shell。')),
          createElement('div', { style: formGridStyle },
            selectField('终端 Shell', 'shellProfileId', shellOptions(terminalStatus)),
          ),
          createElement('p', { style: runtimeHintStyle }, `运行方式由 Host 平台自动选择：${terminalRuntimeLabel(terminalStatus?.platform)}。`),
        ),
        createElement('section', { style: formSectionStyle },
          createElement('div', { style: formSectionHeaderStyle }, createElement('strong', { style: formSectionTitleStyle }, '服务检查'), createElement('span', { style: formSectionHintStyle }, '端口每 5 秒自动检查，也可手动刷新。')),
          createElement('div', { style: formGridStyle },
            field('监听端口（可选）', 'port', 'number', '1 - 65535'),
            createElement('label', { style: proxyFieldStyle }, createElement('span', { style: fieldLabelStyle }, '反向代理'), createElement('span', { style: proxyToggleStyle }, createElement('span', undefined, '允许访问已确认的服务'), createElement('input', { type: 'checkbox', 'aria-label': '启用服务代理', checked: value.proxyEnabled, onChange: (event: { currentTarget: { checked: boolean } }) => setDraft({ ...value, proxyEnabled: event.currentTarget.checked }), style: { accentColor: dshThemeColor.accent } }))),
          ),
        ),
        createElement('div', { style: formActionsStyle },
          createElement('button', { type: 'button', disabled: busy, onClick: () => setDraft(null), style: secondaryButtonStyle }, '关闭'),
          createElement('button', { type: 'submit', 'aria-label': value.id === null ? '保存配置并创建快捷启动项' : '保存快捷启动项修改', disabled: busy || value.commandLine.trim() === '', style: primaryButtonStyle }, busy ? '保存中…' : value.id === null ? '保存为快捷启动' : '保存修改'),
        ),
      ),
    )
  }

  async function saveProfile(value: DebugProfileDraft): Promise<void> {
    await withBusy(async () => {
      const name = value.name.trim()
      const commandParts = splitCommandLine(value.commandLine)
      const portText = value.port.trim()
      if (name === '' || commandParts.length === 0) throw new Error('名称和完整启动命令不能为空')
      const port = portText === '' ? null : Number(portText)
      if (port !== null && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) throw new Error('监听端口必须是 1 到 65535 的整数')
      const shell = resolveShell(value.shellProfileId, terminalStatus)
      const profile = {
        id: value.id ?? createProfileId(),
        name,
        cwdRelative: value.cwdRelative.trim() || '.',
        command: commandParts[0] as string,
        args: commandParts.slice(1),
        env: {},
        shell,
        runtimeType: runtimeTypeFor(terminalStatus?.platform, shell.profileId),
        port,
        proxy: { enabled: value.proxyEnabled },
      }
      const endpoint = value.id === null ? 'debug/config/save' : 'debug/config/update'
      const payload = value.id === null
        ? { sessionId: String(sessionId), workspaceId, generation: 0, config: { version: 1, profiles: [...profiles, profile] } }
        : { sessionId: String(sessionId), workspaceId, generation: 0, profileId: value.id, profile }
      const next = await call<DebugConfig>(rpc, endpoint, payload)
      setConfig(next)
      setDraft(null)
      setMessage(value.id === null ? '启动配置已保存' : '启动配置已更新')
    })
  }

  async function deleteProfile(profile: DebugProfile): Promise<void> {
    if (!window.confirm(`确认删除“${profile.name}”启动配置？`)) return
    await withBusy(async () => {
      const next = await call<DebugConfig>(rpc, 'debug/config/delete', { sessionId: String(sessionId), workspaceId, generation: 0, profileId: profile.id })
      setConfig(next)
      setPortChecks((current) => { const { [profile.id]: _removed, ...rest } = current; return rest })
      setBindings((current) => current.filter((item) => item.profileId !== profile.id))
      setMessage('启动配置已删除')
    })
  }

  async function inspect(profile: DebugProfile): Promise<void> {
    await withBusy(async () => {
      const result = await requestPortCheck(profile)
      setPortChecks((current) => ({ ...current, [profile.id]: result }))
      setMessage(result.listening ? `端口 ${profile.port ?? ''} 正在监听` : `端口 ${profile.port ?? ''} 未监听`)
    })
  }

  async function requestPortCheck(profile: DebugProfile): Promise<DebugPortCheck> {
    return call<DebugPortCheck>(rpc, 'debug/port/check', { sessionId: String(sessionId), workspaceId, generation: 0, profileId: profile.id })
  }

  async function terminatePort(profile: DebugProfile, check: DebugPortCheck): Promise<void> {
    if (!check.listening || check.process === null || !window.confirm(`确认结束端口 ${profile.port ?? ''} 的监听进程？`)) return
    await withBusy(async () => {
      await call(rpc, 'debug/port/kill', { sessionId: String(sessionId), workspaceId, generation: 0, checkId: check.id })
      setPortChecks((current) => ({ ...current, [profile.id]: { ...check, listening: false, process: null } }))
      setMessage('监听进程已结束')
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

const panelStyle: CSSProperties = { ...dshFormRootStyle, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px 28px', minHeight: '100%', overflow: 'auto', background: dshThemeColor.pageBackground }
const headerStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', paddingBottom: 16, borderBottom: `1px solid ${dshThemeColor.border}` }
const titleBlockStyle: CSSProperties = { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }
const eyebrowStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontSize: 10, fontWeight: 600 }
const titleStyle: CSSProperties = { margin: 0, color: dshThemeColor.labelPrimary, fontSize: 22, lineHeight: 1.25, fontWeight: 650 }
const workspaceStyle: CSSProperties = { display: 'flex', alignItems: 'center', minWidth: 0, maxWidth: 260, overflow: 'hidden', color: dshThemeColor.labelTertiary, fontSize: 11, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const workspaceDotStyle: CSSProperties = { width: 6, height: 6, flex: '0 0 auto', marginRight: 6, borderRadius: '50%', background: dshThemeColor.accent }
const headerActionsStyle: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }
const countStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontSize: 11, whiteSpace: 'nowrap' }
const itemStyle: CSSProperties = { border: `1px solid ${dshThemeColor.border}`, borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, background: dshThemeColor.menuBackground, boxShadow: dshThemeColor.subtleShadow }
const itemHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }
const itemTitleBlockStyle: CSSProperties = { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }
const itemTitleStyle: CSSProperties = { color: dshThemeColor.labelPrimary, fontSize: 15, fontWeight: 600 }
const itemCommandStyle: CSSProperties = { overflow: 'hidden', color: dshThemeColor.labelSecondary, fontFamily: 'var(--dsw-font-family-mono, ui-monospace, monospace)', fontSize: 12, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const runningBadgeStyle: CSSProperties = { flex: '0 0 auto', padding: '3px 7px', borderRadius: 10, color: dshThemeColor.success, background: 'color-mix(in srgb, currentColor 10%, transparent)', fontSize: 11, whiteSpace: 'nowrap' }
const stoppedBadgeStyle: CSSProperties = { flex: '0 0 auto', padding: '3px 7px', borderRadius: 10, color: dshThemeColor.labelTertiary, background: `${dshThemeColor.border}`, fontSize: 11, whiteSpace: 'nowrap' }
const metaStyle: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '5px 10px', color: dshThemeColor.labelSecondary, fontSize: 11 }
const metaItemStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const metaKeyStyle: CSSProperties = { color: dshThemeColor.labelCaption, fontSize: 10 }
const proxyBadgeStyle: CSSProperties = { padding: '2px 6px', borderRadius: 4, color: dshThemeColor.accent, background: 'color-mix(in srgb, currentColor 10%, transparent)', fontSize: 10 }
const portStatusStyle: CSSProperties = { display: 'flex', alignItems: 'center', minHeight: 24, padding: '4px 8px', borderRadius: 5, background: dshThemeColor.menuBackground, fontSize: 11 }
const portUnknownStyle: CSSProperties = { color: dshThemeColor.labelTertiary }
const portListeningStyle: CSSProperties = { color: dshThemeColor.success }
const portStoppedStyle: CSSProperties = { color: dshThemeColor.labelTertiary }
const actionsStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 7, paddingTop: 4 }
const actionDividerStyle: CSSProperties = { width: 1, height: 18, margin: '0 2px', background: dshThemeColor.border }
const proxyActionsStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }
const linkStyle: CSSProperties = { color: dshThemeColor.accent, fontSize: 12, textDecoration: 'none' }
const buttonBaseStyle: CSSProperties = { ...dshButtonStyle, minHeight: 30, padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, lineHeight: '18px' }
const primaryButtonStyle: CSSProperties = { ...buttonBaseStyle, color: '#fff', borderColor: dshThemeColor.accent, background: dshThemeColor.accent, fontWeight: 600 }
const secondaryButtonStyle: CSSProperties = { ...buttonBaseStyle, color: dshThemeColor.labelSecondary }
const quietButtonStyle: CSSProperties = { ...buttonBaseStyle, minHeight: 26, padding: '3px 7px', color: dshThemeColor.labelTertiary, border: 0, background: 'transparent' }
const dangerButtonStyle: CSSProperties = { ...buttonBaseStyle, color: dshThemeColor.error, borderColor: dshThemeColor.error, background: 'transparent' }
const dangerQuietButtonStyle: CSSProperties = { ...quietButtonStyle, color: dshThemeColor.error }
const statusIconStyle: CSSProperties = { display: 'inline-flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', borderRadius: '50%', fontSize: 10, fontWeight: 700 }
const emptyStyle: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '28px 20px', border: `1px dashed ${dshThemeColor.border}`, borderRadius: 8, textAlign: 'center' }
const emptyIconStyle: CSSProperties = { display: 'flex', width: 42, height: 42, alignItems: 'center', justifyContent: 'center', marginBottom: 2, borderRadius: 12, color: dshThemeColor.accent, background: 'color-mix(in srgb, currentColor 10%, transparent)' }
const emptyTitleStyle: CSSProperties = { color: dshThemeColor.labelPrimary, fontSize: 14 }
const emptyTextStyle: CSSProperties = { maxWidth: 300, margin: 0, color: dshThemeColor.labelTertiary, fontSize: 12, lineHeight: 1.55 }
const loadingStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: 12, color: dshThemeColor.labelTertiary, fontSize: 13 }
const loadingDotStyle: CSSProperties = { width: 7, height: 7, borderRadius: '50%', background: dshThemeColor.accent }
const formOverlayStyle: CSSProperties = { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18, overflow: 'auto', background: dshThemeColor.overlay }
const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, width: 'min(100%, 720px)', maxHeight: 'calc(100vh - 36px)', boxSizing: 'border-box', overflow: 'auto', padding: 20, border: `1px solid ${dshThemeColor.border}`, borderRadius: 10, background: dshThemeColor.menuBackground, boxShadow: dshThemeColor.prominentShadow }
const formHeaderStyle: CSSProperties = { gridColumn: '1 / -1', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingBottom: 10, borderBottom: `1px solid ${dshThemeColor.border}` }
const formSectionStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 9, paddingTop: 2 }
const formSectionHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }
const formSectionTitleStyle: CSSProperties = { color: dshThemeColor.labelPrimary, fontSize: 13, fontWeight: 650 }
const formSectionHintStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontSize: 11, textAlign: 'right' }
const formTitleStyle: CSSProperties = { margin: 0, color: dshThemeColor.labelPrimary, fontSize: 20, lineHeight: 1.3, fontWeight: 650 }
const formHintStyle: CSSProperties = { margin: '4px 0 0', color: dshThemeColor.labelTertiary, fontSize: 11 }
const closeButtonStyle: CSSProperties = { ...quietButtonStyle, minHeight: 24, padding: '0 5px', fontSize: 20, lineHeight: 1 }
const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }
const selectFieldStyle: CSSProperties = { ...fieldStyle }
const fieldLabelStyle: CSSProperties = { color: dshThemeColor.labelSecondary, fontSize: 12, fontWeight: 500 }
const inputStyle: CSSProperties = { ...dshFieldStyle, width: '100%', boxSizing: 'border-box', minHeight: 32, padding: '6px 8px', borderRadius: 6, fontSize: 12 }
const runtimeHintStyle: CSSProperties = { margin: '-5px 0 0', color: dshThemeColor.labelTertiary, fontSize: 11 }
const formGridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }
const proxyFieldStyle: CSSProperties = { ...fieldStyle }
const proxyToggleStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 32, boxSizing: 'border-box', padding: '0 2px', border: 0, borderRadius: 0, color: dshThemeColor.labelSecondary, background: 'transparent', fontSize: 12, lineHeight: '18px' }
const formActionsStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 6, paddingTop: 4 }

type StatusTone = 'success' | 'error' | 'info'
function statusTone(message: string): StatusTone { return /失败|错误|不能为空|无效/u.test(message) ? 'error' : /已保存|已更新|已删除|已开启|已结束/u.test(message) ? 'success' : 'info' }
function statusStyle(tone: StatusTone): CSSProperties { const color = tone === 'success' ? dshThemeColor.success : tone === 'error' ? dshThemeColor.error : dshThemeColor.labelSecondary; return { display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px', border: `1px solid ${color}`, borderRadius: 6, color, background: 'color-mix(in srgb, currentColor 7%, transparent)', fontSize: 12 } }
function runningInstances(profile: DebugProfile, instances: readonly DebugInstance[]): number { return instances.filter((instance) => instance.profileId === profile.id && instance.state === 'running').length }
function formatCommand(profile: DebugProfile): string { return [profile.command, ...profile.args].join(' ') }

function createProfileDraft(profile?: DebugProfile): DebugProfileDraft {
  return {
    id: profile?.id ?? null,
    name: profile?.name ?? '',
    cwdRelative: profile?.cwdRelative === '.' ? '' : profile?.cwdRelative ?? '',
    commandLine: profile === undefined ? '' : formatCommand(profile),
    shellProfileId: profile === undefined ? 'system' : profile.shell.profileId as DebugProfileDraft['shellProfileId'],
    port: profile?.port === null || profile?.port === undefined ? '' : String(profile.port),
    proxyEnabled: profile?.proxy.enabled ?? false,
  }
}

function shellOptions(status: HostTerminalStatus | null): readonly { readonly value: DebugProfileDraft['shellProfileId']; readonly label: string }[] {
  const detected = status?.profiles ?? []
  return [
    { value: 'system', label: status === null ? '系统默认' : '系统默认（自动选择）' },
    ...detected.map((profile): { readonly value: DebugProfileDraft['shellProfileId']; readonly label: string } => ({ value: profile.profileId, label: profile.name })),
  ]
}

function resolveShell(profileId: DebugProfileDraft['shellProfileId'], status: HostTerminalStatus | null): DebugProfile['shell'] {
  const resolvedId = profileId === 'system' ? status?.resolvedProfileId ?? defaultShellForPlatform(status?.platform) : profileId
  const detected = status?.profiles.find((profile) => profile.profileId === resolvedId)
  if (status !== null && detected === undefined) throw new Error('所选终端 Shell 当前不可用，请重新选择')
  return {
    profileId: resolvedId,
    path: detected?.path ?? shellPathFor(resolvedId),
    args: shellArgsFor(resolvedId),
    name: detected?.name ?? resolvedId,
  }
}

function shellPathFor(profileId: DebugProfile['shell']['profileId']): string {
  if (profileId === 'powershell') return 'powershell.exe'
  if (profileId === 'cmd') return 'cmd.exe'
  if (profileId === 'bash') return '/bin/bash'
  if (profileId === 'git-bash') return 'bash.exe'
  return '/bin/zsh'
}

function shellArgsFor(profileId: DebugProfile['shell']['profileId']): readonly string[] {
  return profileId === 'powershell' ? ['-NoLogo'] : profileId === 'cmd' ? [] : ['-i']
}

function defaultShellForPlatform(platform: HostTerminalStatus['platform'] | undefined): DebugProfile['shell']['profileId'] {
  return platform === 'win32' ? 'powershell' : 'zsh'
}

function runtimeTypeFor(platform: HostTerminalStatus['platform'] | undefined, shellProfileId: DebugProfile['shell']['profileId']): DebugProfile['runtimeType'] {
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') throw new Error('Host 平台不支持自动选择终端运行方式')
  if (platform !== 'win32') return 'tmux'
  if (shellProfileId === 'cmd') return 'conpty-cmd'
  if (shellProfileId === 'git-bash') return 'conpty-git-bash'
  return 'conpty-powershell'
}

function terminalRuntimeLabel(platform: HostTerminalStatus['platform'] | undefined): string {
  if (platform === 'win32') return 'Windows 使用 ConPTY'
  if (platform === 'darwin' || platform === 'linux') return `${platform === 'darwin' ? 'macOS' : 'Linux'} 使用 tmux`
  return '等待 Host 平台状态'
}

function splitCommandLine(value: string): readonly string[] {
  const parts: string[] = []
  let current = ''
  let quote: 'single' | 'double' | null = null
  let escaping = false
  for (const character of value.trim()) {
    if (escaping) { current += character; escaping = false; continue }
    if (character === '\\' && quote !== 'single') { escaping = true; continue }
    if (quote === null && (character === '"' || character === "'")) { quote = character === '"' ? 'double' : 'single'; continue }
    if ((quote === 'double' && character === '"') || (quote === 'single' && character === "'")) { quote = null; continue }
    if (quote === null && /\s/u.test(character)) {
      if (current !== '') { parts.push(current); current = '' }
      continue
    }
    current += character
  }
  if (escaping) current += '\\'
  if (current !== '') parts.push(current)
  if (quote !== null) throw new Error('完整启动命令包含未闭合的引号')
  return parts
}

function createProfileId(): string {
  const id = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `debug-${id.slice(0, 12)}`
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap { debug: undefined }
}

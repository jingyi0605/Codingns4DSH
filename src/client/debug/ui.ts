import { createElement, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { CodingNsRpcClient, CodingNsRpcResult } from '../features/types.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import { debugWarn } from '../../shared/debug.js'
import { dshButtonStyle, dshFieldStyle, dshFormRootStyle, dshThemeColor } from '../theme.js'
import { backdropPointerDownHandler } from '../popup-dismiss.js'
import { codingNsTranslator, useCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from '../locale.js'

export const DEBUG_KIND = 'debug'
export const DEBUG_PROVIDER_ID = 'codingns4dsh/debug'
const PORT_CHECK_INTERVAL_MS = 5_000

interface DebugTabProps {
  readonly sessionId: string
  readonly useTabInfo: UseSidebarRightTabInfo
  readonly rpc: CodingNsRpcClient
  readonly remote: unknown
  readonly terminalRemote: (() => unknown) | undefined
  readonly sidebarRight: Context['sidebarRight']
  readonly locale: CodingNsLocale
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
  readonly effectiveEnabled: boolean
  readonly runtimeTypes?: readonly ('local-pty' | 'tmux' | 'conpty-powershell' | 'conpty-cmd' | 'conpty-git-bash')[]
  readonly runtimeWarning?: string
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
export function registerDebugUi(ctx: Context, rpc: CodingNsRpcClient, remote: unknown, terminalRemote?: () => unknown, locale: CodingNsLocale = ctx.locale): () => void {
  const disposers: Array<() => void> = []
  const t = codingNsTranslator(locale)
  try {
    disposers.push(ctx.sidebarRightTabs.register({
      id: DEBUG_PROVIDER_ID,
      kind: DEBUG_KIND,
      multiple: false,
      priority: 'extension',
      title: () => t('debug.title'),
      guide: [{ id: 'debug', order: 30, title: () => t('debug.title'), description: () => t('debug.guideDescription'), icon: DebugIcon }],
    }))
    disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: DEBUG_PROVIDER_ID,
      inject: () => ({ rpc, remote, terminalRemote, sidebarRight: ctx.sidebarRight, locale }),
    }, DebugBody)))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    if (isDuplicateDebugRegistration(error)) {
      debugWarn(`codingns4dsh: 调试 Sidebar 已注册，跳过重复注册: ${DEBUG_PROVIDER_ID}`)
      return () => {}
    }
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

function isDuplicateDebugRegistration(error: unknown): boolean {
  return error instanceof Error && /sidebarRight: (?:tab type id|tab kind) .* already registered/u.test(error.message)
}

function DebugBody({ sessionId, rpc, remote, terminalRemote, sidebarRight, locale }: DebugTabProps): ReactElement {
  const t = useCodingNsTranslator(locale)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [config, setConfig] = useState<DebugConfig | null>(null)
  const [instances, setInstances] = useState<readonly DebugInstance[]>([])
  const [bindings, setBindings] = useState<readonly DebugProxyBinding[]>([])
  const [portChecks, setPortChecks] = useState<Readonly<Record<string, DebugPortCheck>>>({})
  const [terminalStatus, setTerminalStatus] = useState<HostTerminalStatus | null>(null)
  const [draft, setDraft] = useState<DebugProfileDraft | null>(null)
  const [message, setMessage] = useState<StatusMessage>({ text: t('debug.readingWorkspace'), tone: 'info' })
  const [busy, setBusy] = useState(false)

  const load = async (currentWorkspaceId: string, isCurrent?: () => boolean): Promise<void> => {
    const scope = { sessionId: String(sessionId), workspaceId: currentWorkspaceId, generation: 0 }
    const next = await call<DebugConfig>(rpc, 'debug/config/get', scope)
    const running = await call<readonly DebugInstance[]>(rpc, 'debug/runtime/list', scope)
    // Session 切换后，旧请求的结果不能覆盖新 Session 的面板状态。
    if (isCurrent?.() === false) return
    setConfig(next)
    setInstances(running)
    setMessage({ text: '', tone: 'info' })
  }

  useEffect(() => {
    let disposed = false
    setPortChecks({})
    const terminal = (terminalRemote?.() as { readonly environment?: (id: string) => Promise<unknown> } | undefined)
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
        await load(id, () => !disposed)
      } catch (error) {
        if (!disposed) setMessage({ text: error instanceof Error ? error.message : String(error), tone: 'error' })
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

  if (workspaceId === null) return createElement('section', { style: panelStyle }, createElement('div', { style: loadingStyle }, createElement('span', { style: loadingDotStyle }), message.text))
  const profiles = config?.profiles ?? []
  return createElement('section', { style: panelStyle },
    createElement('header', { style: headerStyle },
      createElement('div', { style: titleBlockStyle },
        createElement('div', { style: eyebrowStyle }, t('debug.eyebrow')),
        createElement('h2', { style: titleStyle }, t('debug.heading')),
        createElement('div', { style: workspaceStyle, title: workspaceId }, createElement('span', { style: workspaceDotStyle }), workspaceId),
      ),
      createElement('div', { style: headerActionsStyle },
        createElement('span', { style: countStyle }, t('debug.profileCount', { count: profiles.length })),
      createElement('button', { type: 'button', 'aria-label': t('debug.addProfileAria'), disabled: busy || draft !== null, onClick: () => setDraft(createProfileDraft()), style: primaryButtonStyle }, createElement('span', { 'aria-hidden': true }, '+'), ' ', t('debug.addProfile')),
      ),
    ),
    message.text && createElement('div', { role: 'status', 'aria-live': 'polite', style: statusStyle(message.tone) }, createElement('span', { style: statusIconStyle }, message.tone === 'success' ? '✓' : message.tone === 'error' ? '!' : 'i'), message.text),
    terminalStatus?.runtimeWarning === undefined ? null : createElement('div', { role: 'alert', style: warningStatusStyle }, createElement('span', { style: statusIconStyle }, '!'), terminalStatus.runtimeWarning),
    draft === null ? null : createProfileForm(draft),
    profiles.length === 0 && draft === null ? createElement('div', { style: emptyStyle },
      createElement('div', { style: emptyIconStyle }, createElement(DebugIcon, { size: 22 })),
      createElement('strong', { style: emptyTitleStyle }, t('debug.emptyTitle')),
      createElement('p', { style: emptyTextStyle }, t('debug.emptyText')),
      createElement('button', { type: 'button', 'aria-label': t('debug.addProfileAria'), disabled: busy, onClick: () => setDraft(createProfileDraft()), style: secondaryButtonStyle }, '+ ', t('debug.addFirstProfile')),
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
        createElement('span', { style: running > 0 ? runningBadgeStyle : stoppedBadgeStyle }, running > 0 ? t('debug.runningCount', { count: running }) : t('debug.notRunning')),
      ),
      createElement('div', { style: metaStyle },
        createElement('span', { style: metaItemStyle }, createElement('span', { style: metaKeyStyle }, t('debug.metaCwd')), profile.cwdRelative || '.'),
        profile.port === null ? null : createElement('span', { style: metaItemStyle }, createElement('span', { style: metaKeyStyle }, t('debug.metaPort')), String(profile.port)),
        createElement('span', { style: metaItemStyle }, createElement('span', { style: metaKeyStyle }, t('debug.metaRuntime')), profile.runtimeType),
        profile.proxy.enabled ? createElement('span', { style: proxyBadgeStyle }, t('debug.proxyEnabled')) : null,
      ),
      profile.port === null ? null : createElement('div', { style: portStatusStyle }, portCheck === undefined
        ? createElement('span', { style: portUnknownStyle }, t('debug.portUnknown'))
        : portCheck.listening
          ? createElement('span', { style: portListeningStyle }, portCheck.process?.pid === undefined
            ? t('debug.portListening', { port: profile.port })
            : t('debug.portListeningPid', { port: profile.port, pid: portCheck.process.pid }))
          : createElement('span', { style: portStoppedStyle }, t('debug.portStopped', { port: profile.port }))),
      createElement('div', { style: actionsStyle },
        createElement('button', { type: 'button', disabled: busy, onClick: () => void launch(profile), style: primaryButtonStyle }, t('debug.launch')),
        profile.port === null ? null : createElement('button', { type: 'button', disabled: busy, onClick: () => void inspect(profile), style: secondaryButtonStyle }, t('debug.checkPort')),
        portCheck?.listening === true && portCheck.process !== null ? createElement('button', { type: 'button', title: t('debug.killPortHint'), disabled: busy, onClick: () => void terminatePort(profile, portCheck), style: dangerButtonStyle }, t('debug.killProcess')) : null,
        instances.filter((instance) => instance.profileId === profile.id && instance.state === 'running').map((instance) => createElement('button', { key: instance.id, type: 'button', title: t('debug.stopHint'), disabled: busy, onClick: () => void stop(instance), style: dangerButtonStyle }, t('debug.stop'))),
        createElement('span', { style: actionDividerStyle }),
        createElement('button', { type: 'button', disabled: busy, onClick: () => setDraft(createProfileDraft(profile)), style: quietButtonStyle }, t('debug.edit')),
        createElement('button', { type: 'button', disabled: busy, onClick: () => void deleteProfile(profile), style: dangerQuietButtonStyle }, t('debug.delete')),
        instances.filter((instance) => instance.profileId === profile.id && instance.state === 'running' && profile.proxy.enabled).map((instance) => {
          const binding = bindings.find((item) => item.instanceId === instance.id)
          return binding === undefined
            ? createElement('button', { key: `proxy-${instance.id}`, type: 'button', disabled: busy, onClick: () => void enableProxy(profile, instance), style: secondaryButtonStyle }, t('debug.enableProxy'))
            : createElement('span', { key: `proxy-${instance.id}`, style: proxyActionsStyle }, createElement('a', { href: binding.url, target: '_blank', rel: 'noreferrer', style: linkStyle }, t('debug.openProxy')), createElement('button', { type: 'button', disabled: busy, onClick: () => void disableProxy(binding), style: quietButtonStyle }, t('debug.proxyTurnOff')))
        }),
      ),
    )
    }),
  )

  async function launch(profile: DebugProfile): Promise<void> {
    await withBusy(async () => {
      const result = await call<{ instance: DebugInstance; terminal: { readonly id: string } }>(rpc, 'debug/profile/launch', { sessionId: String(sessionId), workspaceId, generation: 0, profileId: profile.id, cols: 120, rows: 32 })
      setInstances((current) => [...current.filter((item) => item.id !== result.instance.id), result.instance])
      // 终端页签是工作区聚合入口，具体 terminalId 由页内库存列表管理。
      sidebarRight.openTabIn(String(sessionId) as Parameters<typeof sidebarRight.openTabIn>[0], 'terminal')
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
    return createElement('div', { role: 'presentation', onPointerDown: backdropPointerDownHandler(() => setDraft(null)), style: formOverlayStyle },
      createElement('form', { role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'debug-shortcut-title', style: formStyle, onSubmit: (event: { preventDefault: () => void }) => { event.preventDefault(); void saveProfile(value) } },
        createElement('div', { style: formHeaderStyle }, createElement('div', undefined, createElement('h3', { id: 'debug-shortcut-title', style: formTitleStyle }, value.id === null ? t('debug.formAddTitle') : t('debug.formEditTitle')), createElement('p', { style: formHintStyle }, t('debug.formHint'))), createElement('button', { type: 'button', disabled: busy, onClick: () => setDraft(null), style: closeButtonStyle, 'aria-label': t('debug.closeFormAria') }, '×')),
        createElement('section', { style: formSectionStyle },
          createElement('div', { style: formSectionHeaderStyle }, createElement('strong', { style: formSectionTitleStyle }, t('debug.sectionLaunch')), createElement('span', { style: formSectionHintStyle }, t('debug.sectionLaunchHint'))),
          createElement('div', { style: formGridStyle },
            field(t('debug.fieldName'), 'name', 'text', t('debug.fieldNamePlaceholder')),
            field(t('debug.fieldCwd'), 'cwdRelative', 'text', t('debug.fieldCwdPlaceholder')),
            field(t('debug.fieldCommand'), 'commandLine', 'text', t('debug.fieldCommandPlaceholder'), { gridColumn: '1 / -1' }),
          ),
        ),
        createElement('section', { style: formSectionStyle },
          createElement('div', { style: formSectionHeaderStyle }, createElement('strong', { style: formSectionTitleStyle }, t('debug.sectionRuntime')), createElement('span', { style: formSectionHintStyle }, t('debug.sectionRuntimeHint'))),
          createElement('div', { style: formGridStyle },
            selectField(t('debug.fieldShell'), 'shellProfileId', shellOptions(terminalStatus, t)),
          ),
          createElement('p', { style: runtimeHintStyle }, t('debug.runtimeHint', { runtime: terminalRuntimeLabel(terminalStatus, t) })),
          terminalStatus?.runtimeWarning === undefined ? null : createElement('p', { style: warningHintStyle }, terminalStatus.runtimeWarning),
        ),
        createElement('section', { style: formSectionStyle },
          createElement('div', { style: formSectionHeaderStyle }, createElement('strong', { style: formSectionTitleStyle }, t('debug.sectionPort')), createElement('span', { style: formSectionHintStyle }, t('debug.sectionPortHint'))),
          createElement('div', { style: formGridStyle },
            field(t('debug.fieldPort'), 'port', 'number', '1 - 65535'),
            createElement('label', { style: proxyFieldStyle }, createElement('span', { style: fieldLabelStyle }, t('debug.fieldProxy')), createElement('span', { style: proxyToggleStyle }, createElement('span', undefined, t('debug.proxyToggleLabel')), createElement('input', { type: 'checkbox', 'aria-label': t('debug.proxyToggleAria'), checked: value.proxyEnabled, onChange: (event: { currentTarget: { checked: boolean } }) => setDraft({ ...value, proxyEnabled: event.currentTarget.checked }), style: { accentColor: dshThemeColor.accent } }))),
          ),
        ),
        createElement('div', { style: formActionsStyle },
          createElement('button', { type: 'button', disabled: busy, onClick: () => setDraft(null), style: secondaryButtonStyle }, t('debug.close')),
          createElement('button', { type: 'submit', 'aria-label': value.id === null ? t('debug.saveAriaCreate') : t('debug.saveAriaUpdate'), disabled: busy || value.commandLine.trim() === '', style: primaryButtonStyle }, busy ? t('debug.saving') : value.id === null ? t('debug.saveAsQuickLaunch') : t('debug.saveChanges')),
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
        runtimeType: runtimeTypeFor(terminalStatus, shell.profileId),
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
      setMessage(value.id === null ? { text: t('debug.saved'), tone: 'success' } : { text: t('debug.updated'), tone: 'success' })
    })
  }

  async function deleteProfile(profile: DebugProfile): Promise<void> {
    if (!window.confirm(t('debug.confirmDelete', { name: profile.name }))) return
    await withBusy(async () => {
      const next = await call<DebugConfig>(rpc, 'debug/config/delete', { sessionId: String(sessionId), workspaceId, generation: 0, profileId: profile.id })
      setConfig(next)
      setPortChecks((current) => { const { [profile.id]: _removed, ...rest } = current; return rest })
      setBindings((current) => current.filter((item) => item.profileId !== profile.id))
      setMessage({ text: t('debug.deleted'), tone: 'success' })
    })
  }

  async function inspect(profile: DebugProfile): Promise<void> {
    await withBusy(async () => {
      const result = await requestPortCheck(profile)
      setPortChecks((current) => ({ ...current, [profile.id]: result }))
      setMessage(result.listening
        ? { text: t('debug.portListening', { port: profile.port ?? '' }), tone: 'info' }
        : { text: t('debug.portStopped', { port: profile.port ?? '' }), tone: 'info' })
    })
  }

  async function requestPortCheck(profile: DebugProfile): Promise<DebugPortCheck> {
    return call<DebugPortCheck>(rpc, 'debug/port/check', { sessionId: String(sessionId), workspaceId, generation: 0, profileId: profile.id })
  }

  async function terminatePort(profile: DebugProfile, check: DebugPortCheck): Promise<void> {
    if (!check.listening || check.process === null || !window.confirm(t('debug.confirmKillPort', { port: profile.port ?? '' }))) return
    await withBusy(async () => {
      await call(rpc, 'debug/port/kill', { sessionId: String(sessionId), workspaceId, generation: 0, checkId: check.id })
      setPortChecks((current) => ({ ...current, [profile.id]: { ...check, listening: false, process: null } }))
      setMessage({ text: t('debug.portKilled'), tone: 'success' })
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
      setMessage({ text: t('debug.proxyEnabledMessage', { url: binding.url }), tone: 'success' })
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
    try { await action() } catch (error) { setMessage({ text: error instanceof Error ? error.message : String(error), tone: 'error' }) } finally { setBusy(false) }
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
const warningHintStyle: CSSProperties = { margin: '-5px 0 0', color: dshThemeColor.error, fontSize: 11 }
const warningStatusStyle: CSSProperties = { ...statusStyle('error'), marginBottom: 0 }
const formGridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }
const proxyFieldStyle: CSSProperties = { ...fieldStyle }
const proxyToggleStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 32, boxSizing: 'border-box', padding: '0 2px', border: 0, borderRadius: 0, color: dshThemeColor.labelSecondary, background: 'transparent', fontSize: 12, lineHeight: '18px' }
const formActionsStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 6, paddingTop: 4 }

type StatusTone = 'success' | 'error' | 'info'
/** 状态条文案自带色调，避免依赖中文文案内容推断成功/失败。 */
interface StatusMessage { readonly text: string; readonly tone: StatusTone }
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

function shellOptions(status: HostTerminalStatus | null, t: CodingNsTranslator): readonly { readonly value: DebugProfileDraft['shellProfileId']; readonly label: string }[] {
  const detected = status?.profiles ?? []
  return [
    { value: 'system', label: status === null ? t('debug.shellSystemDefault') : t('debug.shellSystemDefaultAuto') },
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

function runtimeTypeFor(status: HostTerminalStatus | null, shellProfileId: DebugProfile['shell']['profileId']): DebugProfile['runtimeType'] {
  if (status === null || status === undefined) throw new Error('尚未获取 Host 终端能力')
  const runtimeTypes = status.runtimeTypes ?? (status.effectiveEnabled ? ['tmux'] : ['local-pty'])
  if (runtimeTypes.includes('tmux')) return 'tmux'
  if (status.platform !== 'win32') return 'local-pty'
  if (shellProfileId === 'cmd' && runtimeTypes.includes('conpty-cmd')) return 'conpty-cmd'
  if (shellProfileId === 'git-bash' && runtimeTypes.includes('conpty-git-bash')) return 'conpty-git-bash'
  if (runtimeTypes.includes('conpty-powershell')) return 'conpty-powershell'
  if (runtimeTypes.includes('local-pty')) return 'local-pty'
  throw new Error('Host 没有可用的终端 backend')
}

function terminalRuntimeLabel(status: HostTerminalStatus | null, t: CodingNsTranslator): string {
  const runtimeTypes = status?.runtimeTypes ?? (status?.effectiveEnabled ? ['tmux'] : ['local-pty'])
  if (runtimeTypes.includes('tmux')) return status?.platform === 'darwin' ? t('debug.runtimeMacosTmux') : t('debug.runtimeLinuxTmux')
  if (runtimeTypes.includes('conpty-powershell') || runtimeTypes.includes('conpty-cmd') || runtimeTypes.includes('conpty-git-bash')) return t('debug.runtimeWindowsConpty')
  if (runtimeTypes.includes('local-pty')) return t('debug.runtimeLocalPty')
  return t('debug.runtimeWaiting')
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

export interface ProviderVisual {
  readonly adapterId: string | null
  readonly displayName: string
  readonly iconUrl: string | undefined
}

interface ProviderDefinition {
  readonly adapterId: string
  readonly displayName: string
}

/** 外部 Agent 标识与显示名称的唯一映射。浏览器入口另行安装内联资产。 */
const PROVIDER_DEFINITIONS: Readonly<Record<string, ProviderDefinition>> = {
  dsh: { adapterId: 'dsh', displayName: 'DeepSeek Harness' },
  'command-code': { adapterId: 'command-code', displayName: 'Command Code' },
  'claude-code': { adapterId: 'claude-code', displayName: 'Claude Code' },
  kimi: { adapterId: 'kimi', displayName: 'Kimi' },
  gemini: { adapterId: 'gemini', displayName: 'Gemini CLI' },
  pi: { adapterId: 'pi', displayName: 'Pi' },
  codex: { adapterId: 'codex', displayName: 'Codex' },
  opencode: { adapterId: 'opencode', displayName: 'OpenCode' },
  grok: { adapterId: 'grok', displayName: 'Grok' },
}

const PROVIDER_ICONS: Record<string, string> = {}

/** 只由浏览器入口调用，使普通 Node 测试不需要加载 png/svg。 */
export function installProviderIcons(icons: Readonly<Record<string, string>>): void {
  for (const adapterId of Object.keys(PROVIDER_ICONS)) delete PROVIDER_ICONS[adapterId]
  for (const adapterId of Object.keys(PROVIDER_DEFINITIONS)) {
    const iconUrl = icons[adapterId]
    if (iconUrl !== undefined) PROVIDER_ICONS[adapterId] = iconUrl
  }
}

export function providerIconUrl(adapterId: string): string | undefined {
  return PROVIDER_ICONS[adapterId]
}

/** 未绑定和未知值都返回中性占位，绝不冒充任一已知品牌。 */
export function providerVisual(adapterId: string | undefined): ProviderVisual {
  if (adapterId === undefined || adapterId.trim() === '') {
    return { adapterId: null, displayName: '未绑定 Agent', iconUrl: undefined }
  }
  const definition = PROVIDER_DEFINITIONS[adapterId]
  if (definition === undefined) {
    return { adapterId, displayName: `未知 Agent（${adapterId}）`, iconUrl: undefined }
  }
  return { ...definition, iconUrl: PROVIDER_ICONS[adapterId] }
}

export { PROVIDER_DEFINITIONS, PROVIDER_ICONS }

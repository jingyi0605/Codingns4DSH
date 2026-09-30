export interface ProviderVisual {
  readonly adapterId: string | null
  readonly displayName: string
  readonly iconUrl: string | undefined
  readonly color: string
}

interface ProviderDefinition {
  readonly adapterId: string
  readonly displayName: string
  readonly color: string
}

/** 未绑定和未知 Agent 使用中性灰，绝不冒充任一已知品牌色。 */
export const PROVIDER_NEUTRAL_COLOR = '#71717a'

/**
 * 外部 Agent 标识、显示名称与标签颜色的唯一映射。浏览器入口另行安装内联资产。
 *
 * 标签颜色用于会话行/归档列表的彩色标识：优先贴近本地图标或品牌色，
 * 并保持在浅色与深色主题下都可读的中等明度区间。
 */
const PROVIDER_DEFINITIONS: Readonly<Record<string, ProviderDefinition>> = {
  dsh: { adapterId: 'dsh', displayName: 'DeepSeek Harness', color: '#2563eb' },
  'command-code': { adapterId: 'command-code', displayName: 'Command Code', color: '#8b5cf6' },
  'claude-code': { adapterId: 'claude-code', displayName: 'Claude Code', color: '#d97757' },
  kimi: { adapterId: 'kimi', displayName: 'Kimi', color: '#0ea5e9' },
  gemini: { adapterId: 'gemini', displayName: 'Gemini CLI', color: '#4285f4' },
  pi: { adapterId: 'pi', displayName: 'Pi', color: '#f59e0b' },
  codex: { adapterId: 'codex', displayName: 'Codex', color: '#10a37f' },
  opencode: { adapterId: 'opencode', displayName: 'OpenCode', color: '#14b8a6' },
  grok: { adapterId: 'grok', displayName: 'Grok', color: '#71717a' },
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
    return { adapterId: null, displayName: '未绑定 Agent', iconUrl: undefined, color: PROVIDER_NEUTRAL_COLOR }
  }
  const definition = PROVIDER_DEFINITIONS[adapterId]
  if (definition === undefined) {
    return { adapterId, displayName: `未知 Agent（${adapterId}）`, iconUrl: undefined, color: PROVIDER_NEUTRAL_COLOR }
  }
  return { ...definition, iconUrl: PROVIDER_ICONS[adapterId] }
}

export { PROVIDER_DEFINITIONS, PROVIDER_ICONS }

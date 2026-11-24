/** 菜单与原生子代理 Provider 注册共用的目标集合，避免出现可选却无法执行的 Agent。 */
export const DELEGATION_TARGET_IDS = [
  'dsh', 'mcode', 'zcode', 'claude-code', 'codex', 'kimi', 'gemini', 'pi', 'opencode', 'grok', 'command-code', 'antigravity',
] as const

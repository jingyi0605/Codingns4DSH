/** Client 与 Host 共用固定资源目录；避开 Desktop 将 /assets 固定映射到应用安装目录的路径。 */
export const PROVIDER_ICON_PATH = '/api/codingns/provider-icons/'

export const PROVIDER_ICON_FILES: Readonly<Record<string, string>> = {
  dsh: 'deepseek-harness.svg',
  'command-code': 'command-code.svg',
  'claude-code': 'claude-code.png',
  kimi: 'kimi.png',
  gemini: 'gemini.png',
  pi: 'pi.svg',
  codex: 'codex.png',
  opencode: 'opencode.png',
  grok: 'grok.png',
  mcode: 'minimax-code.svg',
  zcode: 'zcode.svg',
  r4: 'r4.svg',
  codebuddy: 'codebuddy.svg',
  workbuddy: 'workbuddy.svg',
  'cursor-cli': 'cursor-cli.svg',
  'kiro-cli': 'kiro-cli.svg',
  qoder: 'qoder.svg',
  'qoder-cn': 'qoder-cn.svg',
  antigravity: 'antigravity.svg',
  doubao: 'doubao.png',
}

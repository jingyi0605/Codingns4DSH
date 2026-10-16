import type { CodingNsCliAdapterDescriptor } from '../../shared/contracts/cli-adapter.js'
import type { CliManagementAction, CliManagementMethod } from '../../shared/contracts/cli-management.js'
import { codexStandaloneDirectory } from './management-installation.js'

export interface ManagementCommand {
  readonly file: string
  readonly args: readonly string[]
}

export interface ManagementMethod extends CliManagementMethod {
  readonly invocation?: ManagementCommand
}

interface Definition {
  readonly sourceUrl: string
  readonly npm?: string
  readonly npmArgs?: readonly string[]
  readonly script?: string
  readonly powershell?: string
  readonly scriptShell?: 'bash' | 'sh'
  readonly update?: readonly string[]
  readonly brew?: readonly string[]
  readonly note?: string
  readonly manual?: boolean
  readonly windowsManual?: boolean
}

// Official evidence: docs/调查报告/20261016-外部Agent官方安装与更新方式.md.
export const AGENT_MANAGEMENT_DEFINITIONS: Readonly<Record<string, Definition>> = {
  'command-code': { sourceUrl: 'https://commandcode.ai/docs/quickstart', npm: 'command-code', update: ['update'], note: 'Requires Node.js 22 or newer.' },
  'claude-code': { sourceUrl: 'https://code.claude.com/docs/en/setup', npm: '@anthropic-ai/claude-code', script: 'https://claude.ai/install.sh', powershell: 'https://claude.ai/install.ps1', update: ['update'], brew: ['--cask', 'claude-code'] },
  kimi: { sourceUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html', npm: '@moonshot-ai/kimi-code', note: 'Requires Node.js 22.19+. The Python kimi-cli distribution is archived. Review the official migration guide before replacing it; sessions and sign-in are not migrated by this action. Native installations use the interactive kimi upgrade command in a terminal.' },
  gemini: { sourceUrl: 'https://geminicli.com/docs/get-started/installation/', npm: '@google/gemini-cli', brew: ['gemini-cli'], note: 'Requires Node.js 20 or newer. Use the package manager that owns the current installation.' },
  pi: { sourceUrl: 'https://pi.dev/docs/latest/quickstart', npm: '@earendil-works/pi-coding-agent', npmArgs: ['--ignore-scripts'], update: ['update'], note: 'Requires Node.js 22.19+. npm updates retain the installed package, including official 0.x releases. The built-in updater is for native installations.' },
  codex: { sourceUrl: 'https://developers.openai.com/codex/cli/', npm: '@openai/codex', script: 'https://chatgpt.com/codex/install.sh', scriptShell: 'sh', brew: ['--cask', 'codex'], note: 'Updates preserve the detected package manager and installation location. The standalone installer also updates standalone installations.' },
  opencode: { sourceUrl: 'https://dev.opencode.ai/v2/docs', script: 'https://opencode.ai/v2/install', npm: '@opencode/cli', update: ['upgrade'], windowsManual: true, note: 'New installations use OpenCode v2. Existing installations use their built-in updater. The v2 guide does not support Windows package-manager installation.' },
  grok: { sourceUrl: 'https://docs.x.ai/build/overview', script: 'https://x.ai/cli/install.sh', update: ['update'], windowsManual: true, note: 'Use the official Windows guide for Windows installation. WinGet installations must be updated through WinGet.' },
  mcode: { sourceUrl: 'https://github.com/MiniMax-AI/minimax-code', script: 'https://filecdn.minimax.chat/public/install.sh', powershell: 'https://filecdn.minimax.chat/public/install.ps1', npm: '@minimax-ai/code', npmArgs: ['--registry=https://registry.npmjs.org/', '--ignore-scripts=false', '--include=optional', '--allow-scripts=@minimax-ai/code,better-sqlite3'], note: 'npm requires Node.js 22.19+ (22.x), 24.2+ (24.x), 25, or 26. Use the same npm prefix as the original installation. The native installer does not support Alpine/musl.' },
  zcode: { sourceUrl: 'https://zcode.z.ai/en/docs/install', manual: true, note: 'Download the official ZCode application for your platform. Update through ZCode or the current official installer; its bundled runtime is managed by the application.' },
  codebuddy: { sourceUrl: 'https://www.codebuddy.ai/docs/cli/troubleshooting', npm: '@tencent-ai/codebuddy-code', npmArgs: ['--registry=https://registry.npmjs.org/'], update: ['update'], note: 'Requires Node.js 18.20+. npm updates use the same official registry as release checks, avoiding stale mirrors and silent failures in the built-in updater.' },
  workbuddy: { sourceUrl: 'https://www.workbuddy.ai/', manual: true, note: 'Install the official WorkBuddy application. To update, open Personal center → Check for updates. WorkBuddy manages its bundled Agent runtime.' },
  'cursor-cli': { sourceUrl: 'https://cursor.com/docs/cli/installation', script: 'https://cursor.com/install', powershell: 'https://cursor.com/install?win32=true', update: ['update'] },
  'kiro-cli': { sourceUrl: 'https://kiro.dev/docs/getting-started/installation/', script: 'https://cli.kiro.dev/install', update: ['update', '--non-interactive'], windowsManual: true },
  qoder: { sourceUrl: 'https://docs.qoder.com/cli/installation', script: 'https://qoder.com/install', powershell: 'https://qoder.com/install.ps1', update: ['update'] },
  'qoder-cn': { sourceUrl: 'https://docs.qoder.cn/en/cli/installation', script: 'https://static.qoder.com.cn/qoder-cli-cn/install.sh', powershell: 'https://static.qoder.com.cn/qoder-cli-cn/install.ps1', update: ['update'] },
  antigravity: { sourceUrl: 'https://www.antigravity.google/docs/cli/install/', script: 'https://antigravity.google/cli/install.sh', powershell: 'https://antigravity.google/cli/install.ps1', update: ['update'] },
  doubao: { sourceUrl: 'https://www.doubao.com/download/desktop', manual: true, note: 'Download the official Doubao desktop application. Use its update flow or the current official installer, then re-detect it here.' },
}

export function managementNpmPackage(adapter: CodingNsCliAdapterDescriptor): string | undefined {
  return adapter.id === 'pi' && /@mariozechner[\\/]/u.test(adapter.command ?? '')
    ? '@mariozechner/pi-coding-agent' : AGENT_MANAGEMENT_DEFINITIONS[adapter.id]?.npm
}

export function managementMethods(adapter: CodingNsCliAdapterDescriptor, action: CliManagementAction, platform: NodeJS.Platform, arch: string): { sourceUrl: string; methods: ManagementMethod[] } {
  const definition = AGENT_MANAGEMENT_DEFINITIONS[adapter.id]
  if (definition === undefined) throw new Error('This Agent has no verified installation method.')
  const methods: ManagementMethod[] = []
  const note = definition.note ?? 'Follow the official prerequisites. Updating does not sign you in or change your Agent settings.'
  const manual = (instructions = note): ManagementMethod => ({ id: 'manual', label: 'Official guide', command: null, instructions, executable: false })
  const bundled = /\.app[\\/]Contents[\\/]|[\\/]resources[\\/]app(?:\.asar)?[\\/]/iu.test(adapter.command ?? '')
  const unsupported = !['darwin', 'linux', 'win32'].includes(platform)
    || (platform === 'win32' && arch === 'arm64' && ['qoder', 'qoder-cn'].includes(adapter.id))
  if (definition.manual || unsupported || bundled) {
    const instructions = bundled ? 'This runtime is bundled with an application. Update the owning application using its official instructions.'
      : unsupported ? `No automated method is supported for ${platform}/${arch}. Check the official platform requirements. ${note}` : note
    return { sourceUrl: definition.sourceUrl, methods: [manual(instructions)] }
  }
  const command = (id: string, label: string, file: string, args: readonly string[], instructions = note): void => {
    methods.push({ id, label, command: [file, ...args].map(displayArgument).join(' '), instructions, executable: true, invocation: { file, args } })
  }
  if (action === 'update' && definition.update && adapter.command) {
    command('native', 'Built-in updater', adapter.command, definition.update)
  }
  if (action === 'install' || (action === 'update' && adapter.id === 'codex')) {
    if (platform === 'win32' && definition.powershell) {
      const script = `$ErrorActionPreference = 'Stop'; irm '${definition.powershell}' | iex`
      command('installer', 'Official PowerShell installer', 'powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script])
      methods[methods.length - 1] = { ...methods.at(-1)!, command: `irm '${definition.powershell}' | iex` }
    } else if (platform !== 'win32' && definition.script) {
      const script = `curl -fsSL '${definition.script}' | ${definition.scriptShell ?? 'bash'}`
      command('installer', 'Official installer', 'bash', ['-o', 'pipefail', '-c', script])
      methods[methods.length - 1] = { ...methods.at(-1)!, command: script }
    }
  }
  const npmPackage = managementNpmPackage(adapter)
  if (npmPackage && !(platform === 'win32' && definition.windowsManual)) {
    command('npm', 'npm (global)', 'npm', ['install', '-g', `${npmPackage}@latest`, ...(definition.npmArgs ?? [])])
  }
  if (definition.brew && platform !== 'win32' && (!definition.brew.includes('--cask') || platform === 'darwin')) {
    command('brew', 'Homebrew', 'brew', [action === 'install' ? 'install' : 'upgrade', ...definition.brew])
  }
  methods.push(manual(methods.length === 0 ? `No unattended command has been verified for ${platform}. Follow the official guide. ${note}` : note))
  return { sourceUrl: definition.sourceUrl, methods }
}

function displayArgument(value: string): string {
  return /^[\w@./:=,+-]+$/u.test(value) ? value : JSON.stringify(value)
}

/** Select only a matching package owner or an official self-updater. */
export function automaticUpdateMethod(adapter: CodingNsCliAdapterDescriptor, methods: ManagementMethod[], platform: NodeJS.Platform): string | undefined {
  const definition = AGENT_MANAGEMENT_DEFINITIONS[adapter.id]
  const path = (adapter.command ?? '').replaceAll('\\', '/')
  const absolute = platform === 'win32' ? /^(?:[A-Za-z]:\/|\/\/)/u.test(path) : path.startsWith('/')
  const has = (id: string): boolean => methods.some(method => method.id === id && method.executable)
  if (!definition || !adapter.installed) return undefined
  if (adapter.id === 'claude-code' && path === 'claude' && has('native')) return 'native'
  if (!absolute) return undefined
  if (adapter.id === 'kimi' && Number(adapter.version?.match(/^v?(\d+)\./u)?.[1] ?? 0) < 2) return undefined

  const brew = path.match(/^(.*)\/(?:Cellar|Caskroom)\/([^/]+)\//u)
  const brewPackage = brew?.[2]
  if (brew && has('brew') && (definition.brew?.at(-1) === brewPackage || (adapter.id === 'claude-code' && brewPackage === 'claude-code@latest'))) {
    const method = methods.find(method => method.id === 'brew')!
    const file = `${brew[1]}/bin/brew`
    const args = [...method.invocation!.args.slice(0, -1), brewPackage!]
    methods[methods.indexOf(method)] = { ...method, command: [file, ...args].map(displayArgument).join(' '), invocation: { file, args } }
    return 'brew'
  }
  if (/\/(?:scoop|WinGet|nix\/store)\//iu.test(path)) return undefined
  if (['command-code', 'claude-code', 'opencode'].includes(adapter.id) && has('native') && !brew) return 'native'
  if (/\/(?:\.bun|\.pnpm)\//iu.test(path)) return undefined
  const npmPackage = managementNpmPackage(adapter)
  if (npmPackage && has('npm')) {
    const marker = `${platform === 'win32' ? '' : '/lib'}/node_modules/${npmPackage}/`
    const index = path.indexOf(marker)
    if (index > 0 && (!brew || /^node(?:@\d+)?$/u.test(brewPackage!))) {
      const method = methods.find(method => method.id === 'npm')!
      const args = [...method.invocation!.args, '--prefix', path.slice(0, index)]
      methods[methods.indexOf(method)] = { ...method, command: ['npm', ...args].map(displayArgument).join(' '), invocation: { file: 'npm', args } }
      return 'npm'
    }
  }
  // These distributions require their package manager, not a guessed self-update.
  if (brew || /\/node_modules\//iu.test(path)) return undefined
  if (adapter.id === 'codex' && has('installer')) {
    const directory = codexStandaloneDirectory(path, platform)
    if (!directory || path !== `${directory.replace(/\/$/u, '')}/codex`) return undefined
    const method = methods.find(method => method.id === 'installer')!
    // Pass the directory as an argument: spaces and shell syntax must never become shell code.
    const script = `curl -fsSL '${definition.script}' | CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DAEMON_ONLY=0 CODEX_INSTALL_DEFER_SELECTION=0 CODEX_INSTALL_DIR="$1" sh -s -- --release latest`
    const args = ['-o', 'pipefail', '-c', script, 'codingns-codex-update', directory]
    methods[methods.indexOf(method)] = { ...method,
      command: `curl -fsSL '${definition.script}' | CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DIR=${displayArgument(directory)} sh -s -- --release latest`,
      invocation: { file: 'bash', args } }
    return 'installer'
  }
  if (platform === 'win32' && adapter.id === 'grok') return undefined
  if (adapter.id === 'pi' && !/\/\.local\//u.test(path)) return undefined
  return has('native') ? 'native' : undefined
}

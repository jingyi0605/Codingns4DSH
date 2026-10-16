import { open, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveCommandPath } from './process-utils.js'

/** Recognize the official standalone layout without treating arbitrary binaries as owned installs. */
export function codexStandaloneDirectory(command: string, platform: NodeJS.Platform, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (platform !== 'darwin' && platform !== 'linux') return undefined
  const directory = environment.CODEX_INSTALL_DIR || join(homedir(), '.local', 'bin')
  const home = environment.CODEX_HOME || join(homedir(), '.codex')
  if (!isAbsolute(directory) || !isAbsolute(home)) return undefined
  if (command === join(directory, 'codex')) return directory
  const release = relative(join(home, 'packages', 'standalone', 'releases'), command)
  // Current packages use <version>-<target>/bin/codex; older releases contain codex directly.
  if (/^(?:rust-v)?\d+\.\d+\.\d+(?:-[\w.-]+)?\/(?:bin\/)?codex$/u.test(release)) return directory
  return undefined
}

/** Retain the npm owner when its launcher resolves into a separate binary package. */
export async function resolveManagementInstallation(command: string, packageName?: string, environment: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return resolveInstallation(command, packageName, environment, new Set())
}

async function resolveInstallation(command: string, packageName: string | undefined, environment: NodeJS.ProcessEnv, visited: Set<string>): Promise<string | null> {
  const launcher = await resolveCommandPath(command)
  if (launcher === null) return null
  const target = await realpath(launcher).catch(() => launcher)
  if (visited.has(target) || visited.size >= 8) return null
  visited.add(target)
  if (!packageName) return target
  const normalizedTarget = target.replaceAll('\\', '/')
  const brewPackage = normalizedTarget.match(/\/(?:Cellar|Caskroom)\/([^/]+)\//u)?.[1]
  if ((brewPackage && !/^node(?:@\d+)?$/u.test(brewPackage)) || /\.app\/Contents\/|\/resources\/app(?:\.asar)?\//iu.test(normalizedTarget)) return target
  const roots = new Set<string>()
  for (const path of [launcher, target]) {
    const normalized = path.replaceAll('\\', '/')
    if (/\/(?:\.bun|\.pnpm|scoop|WinGet)\//iu.test(normalized)) return target
    const marker = process.platform === 'win32' ? '/node_modules/' : '/lib/node_modules/'
    const index = normalized.indexOf(marker)
    if (index > 0) roots.add(join(normalized.slice(0, index), marker.slice(1), packageName))
  }
  // npm's global launchers live in <prefix>/bin on POSIX and <prefix> on Windows.
  roots.add(process.platform === 'win32'
    ? join(dirname(launcher), 'node_modules', packageName)
    : join(dirname(launcher), '..', 'lib', 'node_modules', packageName))
  for (const root of roots) {
    try {
      const metadata = JSON.parse(await readSmallFile(join(root, 'package.json')))
      if (metadata.name !== packageName) continue
      const bins = typeof metadata.bin === 'string' ? { [packageName.split('/').at(-1)!]: metadata.bin } : metadata.bin
      if (!bins || typeof bins !== 'object' || Array.isArray(bins)) continue
      for (const [name, value] of Object.entries(bins)) {
        if (typeof value !== 'string' || isAbsolute(value)) continue
        const entry = resolve(root, value)
        const within = relative(root, entry)
        if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) continue
        const binary = await realpath(entry).catch(() => null)
        if (binary === null) continue
        if (binary === target) return entry
        if (process.platform === 'win32' && /\.(?:cmd|ps1)$/iu.test(launcher) && basename(launcher).replace(/\.(?:cmd|ps1)$/iu, '') === name) {
          const shim = (await readSmallFile(launcher)).replaceAll('\\', '/')
          const suffix = `/node_modules/${packageName}/${value.replaceAll('\\', '/').replace(/^\.\//u, '')}`
          if (['%dp0%', '$basedir'].some(base => shim.includes(`${base}${suffix}`))) return entry
        }
      }
    } catch { /* Missing or unrelated metadata is not evidence of package ownership. */ }
  }
  if (packageName === '@openai/codex' && process.platform !== 'win32') {
    try {
      const script = await readExecutableScript(target)
      if (script !== undefined) {
        const wrapped = codexWrapperTarget(script)
        return wrapped ? resolveInstallation(wrapped, packageName, environment, visited) : null
      }
    } catch { return null }
    const directory = codexStandaloneDirectory(target, process.platform, environment)
    const entry = directory && join(directory, 'codex')
    // Keep the active launcher only if it points to this release. Never redirect a custom installation.
    if (entry && await realpath(entry).catch(() => null) === target) return entry
  }
  // A wrapper needs verified ownership; an arbitrary exec target must not select an updater.
  return visited.size === 1 ? target : null
}

/** Inspect a literal terminal exec without evaluating the wrapper or sourcing its environment files. */
function codexWrapperTarget(script: string): string | undefined {
  if (!/^#![ \t]*(?:\/bin\/(?:ba|da|k|z)?sh|\/usr\/bin\/env[ \t]+(?:ba|da|k|z)?sh)[ \t]*\r?\n/u.test(script)) return undefined
  const lines = script.split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  if (lines.filter(line => /^exec[ \t]/u.test(line)).length !== 1) return undefined
  const match = lines.at(-1)?.match(/^exec[ \t]+(?:'([^']+)'|"([^"$`\\]+)"|([/\w@+=,:.-]+))(?:[ \t]+--[\w-]+(?:=[\w.-]+)?)*[ \t]+"\$@"$/u)
  const target = match?.[1] ?? match?.[2] ?? match?.[3]
  return target && isAbsolute(target) && /^(?:codex|codex\.js)$/u.test(basename(target)) ? target : undefined
}

async function readExecutableScript(path: string): Promise<string | undefined> {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(2)
    await file.read(header, 0, header.length, 0)
    return header.toString() === '#!' ? await readSmallFile(path) : undefined
  } finally { await file.close() }
}

async function readSmallFile(path: string): Promise<string> {
  const info = await stat(path)
  if (!info.isFile() || info.size > 65_536) throw new Error('Installation metadata is not a small regular file.')
  return readFile(path, 'utf8')
}

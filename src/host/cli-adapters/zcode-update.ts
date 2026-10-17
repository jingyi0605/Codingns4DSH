import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { parse } from 'yaml'
import type { ManagementCommand } from './management-methods.js'
import type { ManagementRunner } from './management-process.js'

export function zcodeManifestUrl(platform: NodeJS.Platform, arch: string): string | undefined {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) return undefined
  return `https://zcode.z.ai/api/v1/releases/electron/manifest?platform=${platform === 'win32' ? 'windows' : platform}-${arch === 'arm64' ? 'aarch64' : 'x86_64'}&channel=1`
}

/** Only the desktop layouts detected by the ZCode driver have an in-place updater. */
export function zcodeUpdateRoot(entry: string, platform: NodeJS.Platform, arch: string): string | undefined {
  if (!zcodeManifestUrl(platform, arch)) return undefined
  const path = entry.replaceAll('\\', '/')
  if (/\/(?:scoop|WinGet|Cellar|Caskroom|nix\/store)\//iu.test(path)) return undefined
  if (platform === 'win32' && /^(?:[A-Za-z]:\/|\/\/).+\/resources\/glm\/zcode\.cjs$/iu.test(path)) {
    return win32.normalize(win32.dirname(win32.dirname(win32.dirname(entry))))
  }
  if (platform === 'darwin' && /^\/.+\.app\/Contents\/resources\/glm\/zcode\.cjs$/iu.test(path)) return posix.dirname(posix.dirname(posix.dirname(posix.dirname(entry))))
  return undefined
}

async function readResponse(response: Response, limit: number, signal: AbortSignal, consume: (chunk: Uint8Array) => Promise<void>): Promise<number> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`ZCode download failed (HTTP ${response.status}).`) }
  const reader = response.body.getReader()
  let bytes = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) return bytes
      bytes += value.byteLength
      if (bytes > limit) throw new Error('ZCode download exceeds the published size limit.')
      await consume(value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
}

/** Consume the publisher's package, never a browser-provided URL or command. */
export async function runZcodeUpdate(command: ManagementCommand, signal: AbortSignal, output: (text: string) => void,
  run: ManagementRunner, fetch: typeof globalThis.fetch = globalThis.fetch): Promise<number | null> {
  const options = command.zcodeUpdate!
  const root = zcodeUpdateRoot(command.file, options.platform, options.arch)
  if (!root) throw new Error('This ZCode installation has no supported desktop updater.')
  signal.throwIfAborted()
  if (options.platform === 'darwin') {
    let processes = ''
    const code = await run({ file: '/bin/ps', args: ['-axo', 'command='] }, signal, text => { processes += text })
    if (code !== 0) throw new Error('Could not check whether ZCode is running. Close it and retry.')
    if (processes.includes(`${root}/Contents/MacOS/`)) throw new Error('Close ZCode before updating its application bundle.')
  }
  const chunks: Buffer[] = []
  await readResponse(await fetch(zcodeManifestUrl(options.platform, options.arch)!, { signal, credentials: 'omit' }), 512 * 1024, signal,
    async chunk => { chunks.push(Buffer.from(chunk)) })
  const manifest = parse(Buffer.concat(chunks).toString('utf8'))
  const extension = options.platform === 'win32' ? '.exe' : '.zip'
  const release = Array.isArray(manifest?.files) ? manifest.files.find((file: { url?: unknown }) => typeof file?.url === 'string' && file.url.endsWith(extension)) : undefined
  const url = new URL(release?.url ?? 'https://invalid/')
  if (typeof manifest?.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(manifest.version)
    || url.origin !== 'https://cdn-zcode.z.ai' || !url.pathname.startsWith('/zcode/electron/releases/') || url.username || url.password
    || typeof release?.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(release.sha512)
    || !Number.isSafeInteger(release.size) || release.size <= 0 || release.size > 1024 ** 3) throw new Error('Invalid ZCode release package metadata.')
  const directory = await mkdtemp(join(tmpdir(), 'codingns-zcode-update-'))
  try {
    // Windows cleanup terminates ZCode.exe; the installer must have a different process name.
    const archive = join(directory, options.platform === 'win32' ? 'ZCode-setup.exe' : `ZCode${extension}`)
    const file = await open(archive, 'wx')
    const hash = createHash('sha512')
    let lastProgress = -1
    let received = 0
    output(`Downloading ZCode ${manifest.version}…\n`)
    let size: number
    try {
      size = await readResponse(await fetch(url, { signal, credentials: 'omit' }), release.size, signal, async chunk => {
        hash.update(chunk)
        await file.writeFile(chunk)
        received += chunk.byteLength
        const progress = Math.floor(received / release.size * 10) * 10
        if (progress !== lastProgress) { output(`${progress}%\n`); lastProgress = progress }
      })
    } finally { await file.close() }
    if (size !== release.size || hash.digest('base64') !== release.sha512) throw new Error('ZCode package checksum or size verification failed.')
    signal.throwIfAborted()
    output(`Installing ZCode ${manifest.version} at ${root}…\n`)
    if (options.platform === 'win32') {
      // The runner appends /D last and preserves its unquoted path, including spaces.
      return await run({ file: archive, args: ['/S'], nsisInstallDirectory: root }, signal, output)
    }
    const extracted = join(directory, 'extracted')
    await mkdir(extracted)
    const code = await run({ file: '/usr/bin/ditto', args: ['-x', '-k', archive, extracted] }, signal, output)
    if (code !== 0) return code
    const apps = (await readdir(extracted)).filter(name => /^zcode\.app$/iu.test(name))
    if (apps.length !== 1) throw new Error('The ZCode archive does not contain the expected application.')
    const staged = await mkdtemp(join(posix.dirname(root), '.codingns-zcode-update-'))
    const backup = join(staged, 'previous.app')
    let backupExists = false
    try {
      const replacement = join(staged, 'ZCode.app')
      const copied = await run({ file: '/usr/bin/ditto', args: [join(extracted, apps[0]!), replacement] }, signal, output)
      if (copied !== 0) return copied
      await access(join(replacement, 'Contents', 'resources', 'glm', 'zcode.cjs'))
      signal.throwIfAborted()
      await rename(root, backup)
      backupExists = true
      try { await rename(replacement, root) } catch (error) { await rename(backup, root); backupExists = false; throw error }
      await rm(backup, { recursive: true })
      backupExists = false
    } finally { if (!backupExists) await rm(staged, { recursive: true, force: true }) }
    return 0
  } finally { await rm(directory, { recursive: true, force: true }) }
}

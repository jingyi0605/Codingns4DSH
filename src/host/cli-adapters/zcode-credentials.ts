import { createDecipheriv, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { resolveZCodeDesktopRuntime } from './desktop-app-runtime.js'

const hash = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest()
interface CredentialReadOptions {
  readonly credentialPath?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Read-only native key-store seam. No create, set, migration or export operation. */
  readonly readOsKey?: (path: string) => Promise<string | null>
}

async function readOsKey(credentialPath: string): Promise<string | null> {
  const root = resolveZCodeDesktopRuntime()?.installRoot
  if (!root || process.platform !== 'win32' || process.arch !== 'x64') return null
  // Use ZCode's own shipped N-API provider and exact service/account derivation.
  // This is a read only lookup: an absent key must never be replaced or generated.
  const binary = join(root, 'resources', 'app.asar.unpacked', 'node_modules', '@napi-rs', 'keyring-win32-x64-msvc', 'keyring.win32-x64-msvc.node')
  const native = createRequire(import.meta.url)(binary) as { AsyncEntry: new (service: string, account: string) => { getPassword(): Promise<string | null> } }
  const entry = new native.AsyncEntry('ZCode Credential Encryption', hash(resolve(credentialPath)).toString('hex'))
  return entry.getPassword()
}

function open(payload: string, key: Buffer): string | null {
  const parts = payload.split('.')
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]*$/u.test(p))) return null
  const [iv, tag, encrypted] = parts.map(p => Buffer.from(p, 'base64url'))
  if (!iv || iv.length !== 12 || !tag || tag.length !== 16 || !encrypted) return null
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8').trim() || null
}

/** Matches the installed ZCode cipher protocol; never treats unknown ciphertext as an API key. */
export async function decryptZcodeCredential(value: string, options: CredentialReadOptions = {}): Promise<string | null> {
  const path = options.credentialPath ?? join(homedir(), '.zcode', 'v2', 'credentials.json')
  const env = options.env ?? process.env
  try {
    if (!value.startsWith('enc:')) return value.trim() || null
    if (value.startsWith('enc:v2:')) {
      const match = /^enc:v2:(os|env):([a-f0-9]{24}):(.+)$/u.exec(value)
      if (!match) return null
      let key: Buffer
      if (match[1] === 'os') {
        const secret = await (options.readOsKey ?? readOsKey)(path)
        if (!secret || !/^[A-Za-z0-9_-]{43}$/u.test(secret)) return null
        key = Buffer.from(secret, 'base64url')
      } else {
        if (env.ZCODE_CREDENTIAL_SECRET && env.ZCODE_CREDENTIAL_SECRET_FILE) return null
        const secret = env.ZCODE_CREDENTIAL_SECRET ?? await readFile(env.ZCODE_CREDENTIAL_SECRET_FILE ?? join(dirname(path), 'credential-secret'), 'utf8')
        if (Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 4096) return null
        key = hash(secret)
      }
      if (key.length !== 32 || hash(key).toString('hex').slice(0, 24) !== match[2]) return null
      return open(match[3]!, key)
    }
    if (!value.startsWith('enc:v1:')) return null
    let username = 'unknown'
    try { username = userInfo().username } catch { /* Match the provider fallback. */ }
    const fallback = `zcode-credential-fallback:${process.platform}:${homedir()}:${username}`
    for (const secret of new Set([env.ZCODE_CREDENTIAL_SECRET, env.ZCODE_CREDENTIAL_SECRET?.trim(), fallback])) {
      if (!secret) continue
      try { const result = open(value.slice('enc:v1:'.length), hash(secret)); if (result) return result } catch { /* Try the next legacy key. */ }
    }
    return null
  } catch { return null }
}

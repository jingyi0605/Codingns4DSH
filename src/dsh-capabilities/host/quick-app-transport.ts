import { isAbsolute } from 'node:path'
import { quickAppTransportErrorCode, type QuickAppRuntimeReason } from '../../shared/contracts/quick-apps.js'
import type { QuickAppLanTransport, QuickAppOriginProvider } from './quick-app-origin-adapter.js'
import { boundedFile, configuredQuickAppHttpsProvider } from './quick-app-https-provider.js'
import { parseQuickAppLanPortsConfig, QuickAppLanPortsProvider } from './quick-app-lan-ports.js'

export interface ConfiguredQuickAppTransport {
  readonly origins: QuickAppOriginProvider
  readonly lan?: QuickAppLanTransport
  readonly configurationError?: boolean
  dispose(): Promise<void>
}

/** Host-only configuration; never inferred from forwarded headers or browser settings. */
export async function configuredQuickAppTransport(configPath = process.env.CODINGNS_QUICK_APPS_HTTPS_CONFIG): Promise<ConfiguredQuickAppTransport> {
  if (!configPath) return disabled('not-configured')
  try {
    if (!isAbsolute(configPath)) throw new Error('Expected an absolute configuration path.')
    const config: unknown = JSON.parse(await boundedFile(configPath, 32 * 1024))
    if ((config as { transport?: unknown } | null)?.transport === 'lan-ports') {
      const parsed = parseQuickAppLanPortsConfig(config)
      const [cert, key] = await Promise.all([boundedFile(parsed.certFile, 128 * 1024), boundedFile(parsed.keyFile, 64 * 1024)])
      const provider = new QuickAppLanPortsProvider(parsed, { cert, key })
      await provider.initialize()
      return { origins: provider, lan: provider, dispose: () => provider.dispose() }
    }
    const provider = (await configuredQuickAppHttpsProvider(configPath))!
    return { origins: provider, dispose: () => provider.dispose() }
  } catch { return { ...disabled('config-invalid'), configurationError: true } }
}

function disabled(reason: QuickAppRuntimeReason): ConfiguredQuickAppTransport {
  return { origins: {
    available: () => false, diagnostic: () => reason,
    open: async () => { throw Object.assign(new Error(`Quick Apps transport unavailable: ${reason}.`), { code: quickAppTransportErrorCode(reason) }) },
  }, dispose: async () => undefined }
}

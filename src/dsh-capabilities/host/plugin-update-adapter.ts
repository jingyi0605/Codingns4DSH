import { CODINGNS_NPM_REGISTRY, CODINGNS_PACKAGE_NAME, isSemver, updateError } from '../../shared/contracts/plugin-update.js'

interface PluginManager {
  listBundles(): Promise<readonly {
    name: string; version?: string; installed: boolean; enabled: boolean; availability: string
  }[]>
  installBundle(spec: string, options: { enabled: boolean; saveExact: boolean; registry: string; requestId: string }): Promise<unknown>
  cancelInstall?(requestId: string): Promise<{ status: 'cancelled' | 'too-late' | 'not-running' }>
}

export interface PluginManagerOutcome {
  readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled' | 'unknown'
  readonly installedVersion: string | null
  readonly packageAccepted: boolean
  readonly restored: boolean
  readonly errorCode?: string
}

export interface PluginUpdateManager {
  installed(): Promise<{ version: string | null; blockCode?: string }>
  install(version: string, requestId: string): Promise<PluginManagerOutcome>
  readonly cancellationAvailable: boolean
  cancel(requestId: string): Promise<'cancelled' | 'too-late' | 'not-running'>
}

export function readUpdateService(context: unknown, name: string): unknown {
  if (typeof context !== 'object' || context === null) return undefined
  try {
    const getter = Reflect.get(context, 'get')
    return typeof getter === 'function' ? getter.call(context, name) : Reflect.get(context, name)
  } catch { return undefined }
}

export function supportsPluginUpdateManager(context: unknown): boolean {
  const manager = readUpdateService(context, 'pluginManager') as Partial<PluginManager> | undefined
  return typeof manager?.listBundles === 'function' && typeof manager.installBundle === 'function'
}

/** Published 0.2.1-rc.2 contract. There is no updateBundle or self-uninstall fallback. */
export function createPluginUpdateManager(context: unknown): PluginUpdateManager {
  const manager = readUpdateService(context, 'pluginManager') as PluginManager
  const policy = (): string | undefined => {
    const profile = readUpdateService(context, 'profileContext') as { name?: unknown; packageManager?: unknown } | undefined
    if (!profile || typeof profile.name !== 'string') return 'UPDATE_PROFILE_UNKNOWN'
    if (profile.name === 'desktop' || profile.packageManager !== undefined || process.versions.electron !== undefined) return 'UPDATE_DESKTOP_UNSUPPORTED'
    if (readUpdateService(context, 'hmr') !== undefined) return 'UPDATE_NATIVE_MANAGER_REQUIRED'
    return undefined
  }
  return {
    async installed() {
      const bundle = (await manager.listBundles()).find(item => item.name === CODINGNS_PACKAGE_NAME)
      const version = typeof bundle?.version === 'string' && isSemver(bundle.version) ? bundle.version : null
      const blockCode = policy() ?? (bundle?.installed !== true || bundle.availability !== 'profile' ? 'UPDATE_PROFILE_UNKNOWN'
        : version === null ? 'UPDATE_INSTALLED_VERSION_UNKNOWN' : undefined)
      return {
        version,
        ...(blockCode === undefined ? {} : { blockCode }),
      }
    },
    async install(version, requestId) {
      if (!isSemver(version)) throw updateError('UPDATE_INVALID_VERSION')
      const { blockCode } = await this.installed()
      if (blockCode !== undefined) throw updateError(blockCode)
      const raw = await manager.installBundle(`${CODINGNS_PACKAGE_NAME}@${version}`, {
        enabled: true, saveExact: true, registry: CODINGNS_NPM_REGISTRY, requestId,
      })
      return normalizePluginManagerOutcome(raw, version)
    },
    cancellationAvailable: typeof manager.cancelInstall === 'function',
    async cancel(requestId) { return manager.cancelInstall ? (await manager.cancelInstall(requestId)).status : 'not-running' },
  }
}

export function normalizePluginManagerOutcome(value: unknown, version: string): PluginManagerOutcome {
  const result = value as Record<string, unknown> | null
  const application = ['applied', 'restart-required', 'overridden', 'failed', 'cancelled'].includes(String(result?.application))
    ? result!.application as PluginManagerOutcome['application'] : 'unknown'
  const accepted = result?.bundle === CODINGNS_PACKAGE_NAME && result.version === version
  const error = result?.error as { code?: unknown } | undefined
  const code = typeof error?.code === 'string' && /^[a-z-]{1,64}$/u.test(error.code) ? `UPDATE_MANAGER_${error.code.toUpperCase().replaceAll('-', '_')}` : undefined
  return {
    application, installedVersion: accepted ? version : null, packageAccepted: accepted,
    // Generic operation-error can also mean restoration failed. Do not infer rollback from changed=false alone.
    restored: result?.stage === 'install' && result.changed === false && result.packageResult !== undefined
      && (application === 'cancelled' || (application === 'failed' && error?.code === 'incompatible-version')),
    ...(code === undefined ? {} : { errorCode: code }),
  }
}

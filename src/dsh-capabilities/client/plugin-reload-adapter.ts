import type { PluginActivationState } from '../../shared/contracts/plugin-update.js'
import { CODINGNS_VERSION } from '../../shared/contracts/version.js'

/** Supported DSH Desktop releases expose no authoritative Client replacement contract. */
export function pluginClientReloadStatus(): PluginActivationState {
  return { state: 'unsupported', version: CODINGNS_VERSION, code: 'UPDATE_CLIENT_RELOAD_UNSUPPORTED' }
}

import { assertSupportedDshVersion, isDshVersionCompatible, SUPPORTED_DSH_VERSION } from '../shared/index.js'
import type { CodingNsTransportHooks } from '../shared/contracts/transport.js'

/** 页面级 PeerHost preboot shim 的全局名称。 */
export const DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL = '__CODINGNS4DSH_PREBOOT_SHIM__' as const

export type DshPeerHostPrebootShimState = 'not-installed' | 'installed' | 'active' | 'requires-reload' | 'external' | 'disposed'

export interface DshPeerHostPrebootShimApi {
  readonly version: string
  readonly getState: () => DshPeerHostPrebootShimState
  readonly activate: (transport?: CodingNsTransportHooks) => DshPeerHostPrebootShimState
  readonly deactivate: () => DshPeerHostPrebootShimState
  readonly dispose: () => void
}

type ShimGlobal = typeof globalThis & {
  __DSH_TRANSPORT__?: Record<string, unknown>
  [DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]?: DshPeerHostPrebootShimApi
}

/**
 * 在当前 JavaScript Realm 安装 shim。生产页面通过启动页脚本安装，测试和
 * H5 宿主可以直接调用这个函数。版本不在插件兼容范围内时不写入任何全局状态。
 */
export function installDshPeerHostPrebootShim(options: { readonly dshVersion: string }): DshPeerHostPrebootShimApi {
  assertSupportedDshVersion(options.dshVersion)
  const globals = globalThis as ShimGlobal
  const existing = globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
  if (existing !== undefined) return existing
  const original = globals.__DSH_TRANSPORT__
  if ((globals as ShimGlobal & { dshDesktopBoot?: unknown }).dshDesktopBoot !== undefined || (original !== undefined && !isRecord(original))) {
    const external: DshPeerHostPrebootShimApi = {
      version: options.dshVersion,
      getState: () => 'external',
      activate: () => 'external',
      deactivate: () => 'external',
      dispose: () => undefined,
    }
    globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] = external
    return external
  }

  let state: DshPeerHostPrebootShimState = 'installed'
  let active: CodingNsTransportHooks | undefined
  const baseline = original ?? {}
  const baselineHooks = baseline as Partial<CodingNsTransportHooks>
  const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined
  const facade: Record<string, unknown> = {
    // 启动页 shim 只用于 Web Host；Desktop Transport 在上面的 external 分支保留原样。
    get ownsHost() { return true },
    rpc: {
      call: (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
        if (typeof active?.rpc === 'function') return active.rpc({ method: endpoint, payload: { channel, payload }, ...(signal === undefined ? {} : { signal }) })
        return fallbackRpc(channel, endpoint, payload, signal, nativeFetch ?? baseline.fetch)
      },
      get open() {
        if (typeof active?.openStream === 'function') {
          return (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal, uplink?: AsyncIterable<unknown>) => {
            try { return active!.openStream!({ method: endpoint, payload: { channel, payload, uplink }, ...(signal === undefined ? {} : { signal }) }) }
            catch (error) {
              if (!(error instanceof Error) || error.message !== 'CODINGNS_BASELINE_STREAM') throw error
            }
            const baselineOpener = isRecord(baseline.rpc) ? baseline.rpc.open : undefined
            if (typeof baselineOpener === 'function') return (baselineOpener as (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal, uplink?: AsyncIterable<unknown>) => AsyncIterable<unknown>)(channel, endpoint, payload, signal, uplink)
            throw new Error('当前页面没有可用 DSH Remote stream')
          }
        }
        const baselineOpener = isRecord(baseline.rpc) ? baseline.rpc.open : undefined
        return typeof baselineOpener === 'function' ? baselineOpener : undefined
      },
    },
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof active?.fetch === 'function') return active.fetch(input, init)
      if (typeof baseline.fetch === 'function') return baseline.fetch(input, init)
      if (nativeFetch === undefined) return Promise.reject(new Error('当前页面没有 fetch'))
      return nativeFetch(input, init)
    },
    reconnect: (signal?: AbortSignal) => active?.reconnect?.(signal) ?? baselineHooks.reconnect?.(signal) ?? Promise.resolve(),
    close: () => active?.close?.() ?? baselineHooks.close?.() ?? Promise.resolve(),
  }
  Object.defineProperties(facade, {
    generation: { enumerable: false, get: () => active?.generation?.() ?? baselineHooks.generation?.() },
    onGenerationChange: { enumerable: false, get: () => active?.onGenerationChange ?? baselineHooks.onGenerationChange },
  })
  Object.defineProperty(facade, 'openStream', {
    enumerable: true,
    configurable: false,
    get: () => active?.openStream,
  })
  Object.defineProperty(facade, 'loadBundle', {
    enumerable: true,
    configurable: false,
    get: () => active?.loadBundle ?? baseline.loadBundle,
  })
  globals.__DSH_TRANSPORT__ = facade

  const api: DshPeerHostPrebootShimApi = {
    version: options.dshVersion,
    getState: () => state,
    activate(transport) {
      if (transport === undefined) {
        state = 'requires-reload'
        return state
      }
      active = transport
      state = 'active'
      return state
    },
    deactivate() {
      active = undefined
      state = 'installed'
      return state
    },
    dispose() {
      active = undefined
      state = 'disposed'
      if (globals.__DSH_TRANSPORT__ === facade) {
        if (original === undefined) delete globals.__DSH_TRANSPORT__
        else globals.__DSH_TRANSPORT__ = original
      }
      if (globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] === api) delete globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
    },
  }
  globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] = api
  return api
}

/** 生成启动页 head script；脚本只依赖浏览器原生 API，不引用插件模块。 */
export function createDshPeerHostPrebootShimScript(dshVersion: string = SUPPORTED_DSH_VERSION): string {
  const serialized = JSON.stringify(dshVersion)
  // 兼容范围只声明下界时，启动页脚本无法做 semver 比较：生成期就把范围判定
  // 烘焙成常量，不支持的版本继续生成空操作脚本。
  const supported = isDshVersionCompatible(dshVersion)
  return `(function(){var g=globalThis;if(g.${DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL})return;var v=${serialized};if(${!supported})return;var old=g.__DSH_TRANSPORT__;if(g.dshDesktopBoot!==void 0||(old!==void 0&&old!==null&&typeof old!=="object")){g.${DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL}={version:v,getState:function(){return"external"},activate:function(){return"external"},deactivate:function(){return"external"},dispose:function(){}};return}var active;var state="installed";var nativeFetch=typeof g.fetch==="function"?g.fetch.bind(g):void 0;var base=old&&typeof old==="object"?old:{};function call(channel,endpoint,payload,signal){if(active&&typeof active.rpc==="function")return active.rpc({method:endpoint,payload:{channel:channel,payload:payload},signal:signal});var fetcher=typeof base.fetch==="function"?base.fetch:nativeFetch;if(!fetcher)return Promise.reject(new Error("当前页面没有 fetch"));var id=(g.crypto&&typeof g.crypto.randomUUID==="function"?g.crypto.randomUUID():String(Date.now())+String(Math.random()));var url=channel+"/"+String(endpoint);var body=JSON.stringify({type:"client-request",rpcId:id,method:endpoint,payload:payload});return fetcher(url,{method:"POST",headers:{"content-type":"application/json"},body:body,signal:signal}).then(function(r){if(!r.ok)throw new Error("transport failure: HTTP "+r.status);return r.json()}).then(function(x){return x.result})}function open(channel,endpoint,payload,signal,uplink){if(active&&typeof active.openStream==="function"){try{return active.openStream({method:endpoint,payload:{channel:channel,payload:payload,uplink:uplink},signal:signal})}catch(error){if(!(error instanceof Error)||error.message!=="CODINGNS_BASELINE_STREAM")throw error}}var opener=base.rpc&&typeof base.rpc.open==="function"?base.rpc.open:void 0;if(typeof opener==="function")return opener(channel,endpoint,payload,signal,uplink);throw new Error("当前页面没有可用 DSH Remote stream")}var facade={get ownsHost(){return true},rpc:{call:call,get open(){var hasActive=active&&typeof active.openStream==="function";var hasBaseline=base.rpc&&typeof base.rpc.open==="function";return hasActive||hasBaseline?open:void 0}},fetch:function(i,o){if(active&&typeof active.fetch==="function")return active.fetch(i,o);if(typeof base.fetch==="function")return base.fetch(i,o);if(!nativeFetch)return Promise.reject(new Error("当前页面没有 fetch"));return nativeFetch(i,o)},reconnect:function(s){return active&&active.reconnect?active.reconnect(s):base.reconnect?base.reconnect(s):Promise.resolve()},close:function(){return active&&active.close?active.close():base.close?base.close():Promise.resolve()}};Object.defineProperties(facade,{generation:{enumerable:false,get:function(){return active&&active.generation?active.generation():typeof base.generation==="function"?base.generation():void 0}},onGenerationChange:{enumerable:false,get:function(){return active&&active.onGenerationChange||base.onGenerationChange}}});Object.defineProperty(facade,"openStream",{enumerable:true,get:function(){return active&&active.openStream}});Object.defineProperty(facade,"loadBundle",{enumerable:true,get:function(){return active&&active.loadBundle||base.loadBundle}});g.__DSH_TRANSPORT__=facade;var api={version:v,getState:function(){return state},activate:function(t){if(!t){state="requires-reload";return state}active=t;state="active";return state},deactivate:function(){active=void 0;state="installed";return state},dispose:function(){active=void 0;state="disposed";if(g.__DSH_TRANSPORT__===facade){if(old===void 0)delete g.__DSH_TRANSPORT__;else g.__DSH_TRANSPORT__=old}delete g.${DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL}}};g.${DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL}=api})()`
}

async function fallbackRpc(channel: string, endpoint: string, payload: unknown, signal: AbortSignal | undefined, fetcher: unknown): Promise<unknown> {
  if (typeof fetcher !== 'function') throw new Error('当前页面没有可用 Transport fetch')
  const rpcId = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`
  const response = await (fetcher as typeof fetch)(`${channel}/${endpoint}`.replace(/^\//u, ''), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`transport failure: HTTP ${response.status}`)
  const envelope = await response.json() as { result?: unknown }
  return envelope.result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

import { assertSupportedDshVersion, isDshVersionCompatible, SUPPORTED_DSH_VERSION } from '../shared/index.js'
import type { CodingNsTransportHooks } from '../shared/contracts/transport.js'

/** 页面级 PeerHost preboot shim 的全局名称。 */
export const DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL = '__CODINGNS4DSH_PREBOOT_SHIM__' as const

export type DshPeerHostPrebootShimState = 'not-installed' | 'installed' | 'active' | 'requires-reload' | 'external' | 'disposed'

/**
 * shim 接管页面 Transport 的方式。
 *
 * - `web`：普通 Web Host。shim 自己提供 `rpc`/`openStream`，激活后由 facade 直接分流。
 * - `desktop`：Desktop 壳（存在 `dshDesktopBoot` 或协议为 `dsh-app:`）。Desktop 的
 *   Transport 由前端 Bundle 在运行时**直接赋值**为 `{ ownsHost, streamBaseUrl }`，
 *   因此 shim 用带 setter 的访问器接管这次赋值，并且**只提供 `fetch` 等外壳字段**：
 *   `rpc`/`openStream` 故意留空，让 DSH 继续创建原生 `createWebConnectionRpc`
 *   （完整保留 rpcId 校验、multipart 解析与 Remote mux 启动条件）。聚合分流由
 *   业务侧在 Connection 就绪后补 `connection.rpc.open` 完成。
 * - `external`：Transport 形状未知（非对象，例如字符串标记），无法包装，保持原样。
 */
export type DshPeerHostPrebootShimMode = 'web' | 'desktop' | 'external'

export interface DshPeerHostPrebootShimApi {
  readonly version: string
  readonly getState: () => DshPeerHostPrebootShimState
  readonly getMode: () => DshPeerHostPrebootShimMode
  readonly activate: (transport?: CodingNsTransportHooks) => DshPeerHostPrebootShimState
  readonly deactivate: () => DshPeerHostPrebootShimState
  readonly dispose: () => void
}

type ShimGlobal = typeof globalThis & {
  __DSH_TRANSPORT__?: Record<string, unknown>
  dshDesktopBoot?: unknown
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
  // 只有非对象形状才真正无法包装；Desktop 的 Transport 是普通对象，必须接管。
  if (original !== undefined && !isRecord(original)) {
    const external: DshPeerHostPrebootShimApi = {
      version: options.dshVersion,
      getState: () => 'external',
      getMode: () => 'external',
      activate: () => 'external',
      deactivate: () => 'external',
      dispose: () => undefined,
    }
    globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] = external
    return external
  }

  const mode: DshPeerHostPrebootShimMode = isDesktopTopology(globals) ? 'desktop' : 'web'
  let state: DshPeerHostPrebootShimState = 'installed'
  let active: CodingNsTransportHooks | undefined
  // Desktop 会在 shim 之后赋值 Transport（先赋值则这里直接拿到），因此 baseline
  // 必须可变：访问器 setter 捕获后续赋值，facade 始终透传最新一份。
  let baseline: Record<string, unknown> = original ?? {}
  const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined
  const baselineRpc = (): Record<string, unknown> | undefined => (isRecord(baseline.rpc) ? baseline.rpc : undefined)
  const resolveFetch = (): unknown => active?.fetch ?? baseline.fetch ?? nativeFetch
  const baselineHooks = (): Partial<CodingNsTransportHooks> => baseline as Partial<CodingNsTransportHooks>
  const baselineOpen = (): unknown => {
    const open = baselineRpc()?.open
    return typeof open === 'function' ? open : undefined
  }

  const facade: Record<string, unknown> = {
    get ownsHost() { return true },
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const fetcher = resolveFetch()
      if (typeof fetcher !== 'function') return Promise.reject(new Error('当前页面没有 fetch'))
      return (fetcher as typeof fetch)(input, init)
    },
    reconnect: (signal?: AbortSignal) => active?.reconnect?.(signal) ?? baselineHooks().reconnect?.(signal) ?? Promise.resolve(),
    close: () => active?.close?.() ?? baselineHooks().close?.() ?? Promise.resolve(),
  }
  Object.defineProperties(facade, {
    generation: { enumerable: false, get: () => active?.generation?.() ?? baselineHooks().generation?.() },
    onGenerationChange: { enumerable: false, get: () => active?.onGenerationChange ?? baselineHooks().onGenerationChange },
    // 聚合流基址必须来自被包装的 baseline，否则 `openDshGatewayStream` 与 DSH 自己的
    // `/api/remote.mux` 会退回 `document.baseURI`，在 Desktop（`dsh-app:`）下拼出
    // 不可用的 WebSocket 地址。
    streamBaseUrl: { enumerable: true, get: () => baseline.streamBaseUrl },
  })
  if (mode === 'web') {
    // Web 路径保持既有实现：shim 自己提供 rpc/openStream，激活即分流。
    Object.defineProperty(facade, 'rpc', {
      enumerable: true,
      configurable: false,
      value: {
        call: (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
          if (typeof active?.rpc === 'function') return active.rpc({ method: endpoint, payload: { channel, payload }, ...(signal === undefined ? {} : { signal }) })
          // 未激活时优先复用页面原本的 rpc（中继桥可能自带），没有原生实现才退回内置信封。
          const baselineCall = baselineRpc()?.call
          if (typeof baselineCall === 'function') {
            return (baselineCall as (this: unknown, channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>).call(baseline.rpc, channel, endpoint, payload, signal)
          }
          return fallbackRpc(channel, endpoint, payload, signal, resolveFetch())
        },
        get open() {
          if (typeof active?.openStream === 'function') {
            return (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal, uplink?: AsyncIterable<unknown>) => {
              try { return active!.openStream!({ method: endpoint, payload: { channel, payload, uplink }, ...(signal === undefined ? {} : { signal }) }) }
              catch (error) {
                if (!(error instanceof Error) || error.message !== 'CODINGNS_BASELINE_STREAM') throw error
              }
              const baselineOpener = baselineOpen()
              if (typeof baselineOpener === 'function') return (baselineOpener as (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal, uplink?: AsyncIterable<unknown>) => AsyncIterable<unknown>)(channel, endpoint, payload, signal, uplink)
              throw new Error('当前页面没有可用 DSH Remote stream')
            }
          }
          return baselineOpen()
        },
      },
    })
    Object.defineProperty(facade, 'openStream', {
      enumerable: true,
      configurable: false,
      get: () => active?.openStream,
    })
  }
  Object.defineProperty(facade, 'loadBundle', {
    enumerable: true,
    configurable: false,
    get: () => active?.loadBundle ?? baseline.loadBundle,
  })

  let desktopRestoreDescriptor: PropertyDescriptor | undefined
  if (mode === 'desktop') {
    desktopRestoreDescriptor = Object.getOwnPropertyDescriptor(globals, '__DSH_TRANSPORT__')
    try {
      Object.defineProperty(globals, '__DSH_TRANSPORT__', {
        configurable: true,
        enumerable: true,
        get: () => facade,
        set: (next: unknown) => {
          // Desktop 只下发 `{ ownsHost, streamBaseUrl }`；整份对象保留为 baseline，
          // 之后读取 `fetch`/`loadBundle`/`streamBaseUrl` 都透传到最新值。
          if (isRecord(next)) baseline = next
        },
      })
    } catch {
      // 同名属性不可配置时退化为一次直接赋值；Desktop 之后仍可能覆盖它，
      // 此时至少保证当前这次 DSH 读取拿到 facade。
      globals.__DSH_TRANSPORT__ = facade
    }
  } else {
    globals.__DSH_TRANSPORT__ = facade
  }

  const api: DshPeerHostPrebootShimApi = {
    version: options.dshVersion,
    getState: () => state,
    getMode: () => mode,
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
      if (mode === 'desktop') {
        if (desktopRestoreDescriptor === undefined) delete globals.__DSH_TRANSPORT__
        else Object.defineProperty(globals, '__DSH_TRANSPORT__', desktopRestoreDescriptor)
      } else if (globals.__DSH_TRANSPORT__ === facade) {
        if (original === undefined) delete globals.__DSH_TRANSPORT__
        else globals.__DSH_TRANSPORT__ = original
      }
      if (globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] === api) delete globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
    },
  }
  globals[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] = api
  return api
}

/** Desktop 壳的两个稳定特征：preload 暴露的 `dshDesktopBoot` 或 `dsh-app:` 协议。 */
function isDesktopTopology(globals: ShimGlobal): boolean {
  if (globals.dshDesktopBoot !== undefined) return true
  try {
    return globalThis.location?.protocol?.toLowerCase() === 'dsh-app:'
  } catch {
    return false
  }
}

/**
 * 读取当前页面 shim 的状态；没有安装过 shim 时返回 `not-installed`。
 *
 * 供设置面板与账户入口判断"结构性不支持"（`external`）与"尚未注入"
 * （`not-installed`）两种情况，避免把结构问题误报成"刷新即可"。
 */
export function readDshPeerHostPrebootShimState(): DshPeerHostPrebootShimState {
  try {
    return (globalThis as ShimGlobal)[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]?.getState() ?? 'not-installed'
  } catch {
    return 'not-installed'
  }
}

/** 读取当前页面 shim 的接管方式；没有安装过 shim 时返回 `undefined`。 */
export function readDshPeerHostPrebootShimMode(): DshPeerHostPrebootShimMode | undefined {
  try {
    return (globalThis as ShimGlobal)[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]?.getMode()
  } catch {
    return undefined
  }
}

/**
 * 生成启动页 head script；脚本只依赖浏览器原生 API，不引用插件模块。
 *
 * 脚本与 `installDshPeerHostPrebootShim` 覆盖不同注入路径（脚本走 `<head>`，
 * 函数供测试与 H5 宿主直接调用），两者必须保持同一组行为；
 * `tests/dsh-peer-host-preboot-shim.spec.ts` 对同一批场景分别断言两条路径。
 */
export function createDshPeerHostPrebootShimScript(dshVersion: string = SUPPORTED_DSH_VERSION): string {
  const serialized = JSON.stringify(dshVersion)
  // 兼容范围只声明下界时，启动页脚本无法做 semver 比较：生成期就把范围判定
  // 烘焙成常量，不支持的版本继续生成空操作脚本。
  const supported = isDshVersionCompatible(dshVersion)
  return `(function(){var g=globalThis;if(g.${DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL})return;var v=${serialized};if(${!supported})return;var old=g.__DSH_TRANSPORT__;if(old!==void 0&&old!==null&&typeof old!=="object"){g.${DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL}={version:v,getState:function(){return"external"},getMode:function(){return"external"},activate:function(){return"external"},deactivate:function(){return"external"},dispose:function(){}};return}var desktop=false;if(g.dshDesktopBoot!==void 0)desktop=true;else try{desktop=!!(g.location&&g.location.protocol&&g.location.protocol.toLowerCase()==="dsh-app:")}catch(e){desktop=false}var active;var state="installed";var baseline=old&&typeof old==="object"?old:{};var nativeFetch=typeof g.fetch==="function"?g.fetch.bind(g):void 0;function baselineRpc(){var r=baseline.rpc;return r&&typeof r==="object"?r:void 0}function resolveFetch(){if(active&&typeof active.fetch==="function")return active.fetch;if(typeof baseline.fetch==="function")return baseline.fetch;return nativeFetch}function baselineOpen(){var r=baselineRpc();return r&&typeof r.open==="function"?r.open:void 0}function fallbackCall(channel,endpoint,payload,signal){var f=resolveFetch();if(typeof f!=="function")return Promise.reject(new Error("当前页面没有 fetch"));var id=(g.crypto&&typeof g.crypto.randomUUID==="function"?g.crypto.randomUUID():String(Date.now())+String(Math.random()));var body=JSON.stringify({type:"client-request",rpcId:id,method:endpoint,payload:payload});return f(String(channel)+"/"+String(endpoint),{method:"POST",headers:{"content-type":"application/json"},body:body,signal:signal}).then(function(r){if(!r.ok)throw new Error("transport failure: HTTP "+r.status);return r.json()}).then(function(x){return x.result})}function call(channel,endpoint,payload,signal){if(active&&typeof active.rpc==="function")return active.rpc({method:endpoint,payload:{channel:channel,payload:payload},signal:signal});var r=baselineRpc();if(r&&typeof r.call==="function")return r.call(channel,endpoint,payload,signal);return fallbackCall(channel,endpoint,payload,signal)}var facade={get ownsHost(){return true},fetch:function(input,init){var f=resolveFetch();if(typeof f!=="function")return Promise.reject(new Error("当前页面没有 fetch"));return f(input,init)},reconnect:function(s){if(active&&typeof active.reconnect==="function")return active.reconnect(s);if(typeof baseline.reconnect==="function")return baseline.reconnect(s);return Promise.resolve()},close:function(){if(active&&typeof active.close==="function")return active.close();if(typeof baseline.close==="function")return baseline.close();return Promise.resolve()}};Object.defineProperties(facade,{generation:{enumerable:false,get:function(){if(active&&typeof active.generation==="function")return active.generation();if(typeof baseline.generation==="function")return baseline.generation()}},onGenerationChange:{enumerable:false,get:function(){return active&&active.onGenerationChange?active.onGenerationChange:baseline.onGenerationChange}},streamBaseUrl:{enumerable:true,get:function(){return baseline.streamBaseUrl}}});if(!desktop){Object.defineProperty(facade,"rpc",{enumerable:true,configurable:false,value:{call:call,get open(){if(active&&typeof active.openStream==="function")return function(channel,endpoint,payload,signal,uplink){try{return active.openStream({method:endpoint,payload:{channel:channel,payload:payload,uplink:uplink},signal:signal})}catch(error){if(!(error instanceof Error)||error.message!=="CODINGNS_BASELINE_STREAM")throw error}var opener=baselineOpen();if(typeof opener==="function")return opener(channel,endpoint,payload,signal,uplink);throw new Error("当前页面没有可用 DSH Remote stream")};return baselineOpen()}}});Object.defineProperty(facade,"openStream",{enumerable:true,configurable:false,get:function(){return active&&active.openStream}})}Object.defineProperty(facade,"loadBundle",{enumerable:true,configurable:false,get:function(){return active&&active.loadBundle?active.loadBundle:baseline.loadBundle}});var restore;if(desktop){restore=Object.getOwnPropertyDescriptor(g,"__DSH_TRANSPORT__");try{Object.defineProperty(g,"__DSH_TRANSPORT__",{configurable:true,enumerable:true,get:function(){return facade},set:function(next){if(next&&typeof next==="object")baseline=next}})}catch(e){g.__DSH_TRANSPORT__=facade}}else{g.__DSH_TRANSPORT__=facade}g.${DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL}={version:v,getState:function(){return state},getMode:function(){return desktop?"desktop":"web"},activate:function(t){if(t===void 0){state="requires-reload";return state}active=t;state="active";return state},deactivate:function(){active=void 0;state="installed";return state},dispose:function(){active=void 0;state="disposed";if(desktop){if(restore===void 0)delete g.__DSH_TRANSPORT__;else Object.defineProperty(g,"__DSH_TRANSPORT__",restore)}else if(g.__DSH_TRANSPORT__===facade){if(old===void 0)delete g.__DSH_TRANSPORT__;else g.__DSH_TRANSPORT__=old}if(g.${DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL})delete g.${DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL}}};})()`
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

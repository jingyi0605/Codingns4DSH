/**
 * 注入启动页的内联脚本。
 *
 * 只做三件事，刻意保持 2KB 以内：
 * 1. 暴露安装引导状态（`beforeinstallprompt` 必须在页面早期捕获）；
 * 2. 在安全上下文里、且确认 manifest 来自本插件时注册 `/sw.js`；
 * 3. 暴露注销入口，让“关闭 Service Worker”不会留下无法清理的驻留状态。
 *
 * 回环地址（桌面本机入口）直接短路：本机既不需要 PWA，也不应该因为捕获安装事件
 * 而影响浏览器自身的安装入口。脚本不读 Cookie、不写凭据，注册失败只记录状态。
 */
import { PWA_MANIFEST_PATH, PWA_MANIFEST_MARKER, PWA_SERVICE_WORKER_PATH } from './pwa-assets.js'

export interface PwaClientScriptOptions {
  /** 生成注册代码（设置开启时）。 */
  readonly serviceWorker: boolean
  /** 生成安装引导捕获与提示入口（设置开启时）。 */
  readonly installPrompt: boolean
}

export function createPwaClientScript(options: PwaClientScriptOptions): string {
  const parts: string[] = [
    '(function(){',
    'var s={loopback:false,marker:false,sw:"idle",installed:false,installPromptAvailable:false,promptEvent:null};',
    'globalThis.__CODINGNS_PWA__=s;',
    'var h=globalThis.location?globalThis.location.hostname:"";',
    's.loopback=h==="127.0.0.1"||h==="localhost"||h==="::1"||h==="[::1]";',
    // 注销入口在所有入口都可用：它只影响“当前源”上的注册，不会触碰别处。
    'globalThis.__CODINGNS_PWA_UNREGISTER__=function(){try{if(!globalThis.navigator||!navigator.serviceWorker)return Promise.resolve(false);return navigator.serviceWorker.getRegistrations().then(function(list){return Promise.all(list.map(function(r){try{if(r.active)r.active.postMessage({type:"codingns-sw-unregister"})}catch(e){}return r.unregister()})).then(function(){s.sw="unregistered";return true})}).catch(function(){return false})}catch(e){return Promise.resolve(false)}};',
    'if(s.loopback){s.sw="loopback";return}',
    'try{s.installed=typeof globalThis.matchMedia==="function"&&globalThis.matchMedia("(display-mode: standalone)").matches===true}catch(e){}',
  ]
  if (options.installPrompt) {
    parts.push(
      'globalThis.__CODINGNS_PWA_PROMPT__=function(){var e=s.promptEvent;if(!e||typeof e.prompt!=="function")return Promise.resolve("unavailable");s.promptEvent=null;s.installPromptAvailable=false;return e.prompt().then(function(){return e.userChoice}).then(function(c){return c&&c.outcome?c.outcome:"dismissed"}).catch(function(){return "failed"})};',
      'globalThis.addEventListener("beforeinstallprompt",function(e){try{e.preventDefault()}catch(error){}s.installPromptAvailable=true;s.promptEvent=e;try{globalThis.dispatchEvent(new CustomEvent("codingns-pwa-install-available"))}catch(error){}});',
      'globalThis.addEventListener("appinstalled",function(){s.installPromptAvailable=false;s.promptEvent=null;s.installed=true;try{globalThis.dispatchEvent(new CustomEvent("codingns-pwa-installed"))}catch(error){}});',
    )
  }
  if (options.serviceWorker) {
    parts.push(
      'if(!globalThis.isSecureContext||!globalThis.navigator||!navigator.serviceWorker){s.sw="unsupported";return}',
      `fetch(${JSON.stringify(PWA_MANIFEST_PATH)},{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(m){var flag=m&&m.codingns4dsh&&m.codingns4dsh.pwa===1;s.marker=flag===true;if(!flag){s.sw="external";return}return navigator.serviceWorker.register(${JSON.stringify(PWA_SERVICE_WORKER_PATH)},{scope:"/"}).then(function(){s.sw="active"},function(){s.sw="failed"})}).catch(function(){s.sw="failed"});`,
    )
  }
  parts.push('})();')
  return parts.join('')
}

/** 供测试与调试确认 manifest 标记没有被改动。 */
export function pwaManifestMarker(): string {
  return PWA_MANIFEST_MARKER
}

/**
 * 局域网入口的 PWA 资产清单。
 *
 * 代理只在“请求侧”工作：这里生成的字节由 `LanAccessDshProxy.authorize()` 直接
 * 合成响应，不经过上游 DSH，也不改写上游响应。清单是唯一来源：
 * manifest、Service Worker、图标都在这里定义，供代理与 RPC 状态查询共用。
 */
import { CODINGNS_VERSION } from '../../../shared/contracts/version.js'
import type { LanAccessDshPwaSettings } from '../../../shared/contracts/config.js'
import { createPwaIconPng } from './pwa-icons.js'

export const PWA_MANIFEST_PATH = '/manifest.webmanifest'
export const PWA_SERVICE_WORKER_PATH = '/sw.js'
export const PWA_ASSET_PREFIX = '/__codingns/pwa/'
export const PWA_MANIFEST_MARKER = 'codingns4dsh-pwa'
export const PWA_THEME_COLOR = '#0a0f1d'
export const PWA_BACKGROUND_COLOR = '#0a0f1d'
export const PWA_NOTIFICATION_ICON_PATH = `${PWA_ASSET_PREFIX}icon-192.png`
/** SW 注册脚本用来确认“这是插件自己提供的 manifest”。 */
export const PWA_MANIFEST_MARKER_FIELD = 'codingns4dsh'

export interface LanAccessDshPwaAsset {
  /** 对外路径（含前导斜杠）。 */
  readonly path: string
  readonly contentType: string
  readonly cacheControl: string
  readonly body: Uint8Array
}

export interface LanAccessDshPwaBundle {
  readonly manifest: Uint8Array
  /** 未启用 Service Worker 时为 null；代理据此决定是否拦截 `/sw.js`。 */
  readonly serviceWorker: Uint8Array | null
  readonly assets: ReadonlyMap<string, LanAccessDshPwaAsset>
  /** 客户端探测用的标记值。 */
  readonly marker: string
}

export interface LanAccessDshPwaProvider {
  /** 返回当前应提供的资产；未启用时返回 null（代理保持原行为）。 */
  snapshot(): LanAccessDshPwaBundle | null
}

export interface LanAccessDshPwaProviderOptions {
  readonly readSettings: () => LanAccessDshPwaSettings
}

/** 按设置生成资产；设置未变化时复用上一次的字节。 */
export function createLanAccessDshPwaProvider(options: LanAccessDshPwaProviderOptions): LanAccessDshPwaProvider {
  let cachedKey: string | null = null
  let cached: LanAccessDshPwaBundle | null = null
  return {
    snapshot() {
      const settings = options.readSettings()
      const key = `${settings.enabled ? '1' : '0'}:${settings.serviceWorker ? '1' : '0'}`
      if (key === cachedKey) return cached
      cachedKey = key
      cached = settings.enabled
        ? createLanAccessDshPwaBundle({ serviceWorker: settings.serviceWorker })
        : null
      return cached
    },
  }
}

export function createLanAccessDshPwaBundle(options: { readonly serviceWorker: boolean }): LanAccessDshPwaBundle {
  return {
    manifest: encodeManifest(),
    serviceWorker: options.serviceWorker ? encodeServiceWorker() : null,
    assets: createIconAssets(),
    marker: PWA_MANIFEST_MARKER,
  }
}

function createIconAssets(): ReadonlyMap<string, LanAccessDshPwaAsset> {
  const assets = new Map<string, LanAccessDshPwaAsset>()
  const entries: readonly { readonly file: string; readonly size: number; readonly maskable?: boolean }[] = [
    { file: 'icon-192.png', size: 192 },
    { file: 'icon-512.png', size: 512 },
    { file: 'icon-maskable-512.png', size: 512, maskable: true },
    { file: 'apple-touch-icon.png', size: 180 },
  ]
  for (const entry of entries) {
    assets.set(`${PWA_ASSET_PREFIX}${entry.file}`, {
      path: `${PWA_ASSET_PREFIX}${entry.file}`,
      contentType: 'image/png',
      // 文件名稳定、内容随插件版本变化；用短缓存避免升级后长期看到旧图标。
      cacheControl: 'public, max-age=86400',
      body: createPwaIconPng(entry.maskable === true ? { size: entry.size, maskable: true } : { size: entry.size }),
    })
  }
  return assets
}

/** 覆盖上游 manifest：保留名称与 start_url/scope，覆盖显示模式并补齐 PNG 图标。 */
export function createPwaManifest(): Record<string, unknown> {
  return {
    name: 'DeepSeek Harness',
    short_name: 'DSH',
    description: 'DeepSeek Harness Web 应用（Codingns4DSH 局域网入口）',
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'any',
    theme_color: PWA_THEME_COLOR,
    background_color: PWA_BACKGROUND_COLOR,
    icons: [
      { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: `${PWA_ASSET_PREFIX}icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${PWA_ASSET_PREFIX}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${PWA_ASSET_PREFIX}icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    [PWA_MANIFEST_MARKER_FIELD]: {
      pwa: 1,
      marker: PWA_MANIFEST_MARKER,
      version: CODINGNS_VERSION,
    },
  }
}

function encodeManifest(): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(createPwaManifest(), null, 2)}\n`)
}

/**
 * Service Worker 脚本。
 *
 * 刻意不做任何资源缓存：DSH 页面是长连接应用，缓存导航请求只会带来“登录页被
 * 缓存”一类事故。这里只保留一个空的 fetch 监听（供旧版 Chrome 的安装判定），
 * 以及 push / notificationclick / message 三类消息处理。
 */
export function createPwaServiceWorkerScript(): string {
  return `/* Codingns4DSH PWA Service Worker v${CODINGNS_VERSION} */
const VERSION = ${JSON.stringify(CODINGNS_VERSION)};
const CACHE_PREFIX = 'codingns4dsh-pwa-';
const DEFAULT_TITLE = 'DeepSeek Harness';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_PREFIX + VERSION).map((name) => caches.delete(name)));
    } catch (error) {}
    await self.clients.claim();
  })());
});

// 不拦截任何请求：DSH 的页面与 API 全部直连网络。
self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    payload = {};
  }
  const title = typeof payload.title === 'string' && payload.title !== '' ? payload.title : DEFAULT_TITLE;
  const body = typeof payload.body === 'string' ? payload.body : '';
  const url = typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/';
  const tag = typeof payload.tag === 'string' && payload.tag !== '' ? payload.tag : 'codingns4dsh';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    data: { url },
    icon: ${JSON.stringify(PWA_NOTIFICATION_ICON_PATH)},
    badge: ${JSON.stringify(PWA_NOTIFICATION_ICON_PATH)},
    // Android PWA 支持的通知振动模式；不支持的平台会忽略该字段。
    vibrate: [80, 40, 80],
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      // 已有页面也要跳到通知携带的会话地址，否则点击通知只会把旧页面置前。
      if (typeof client.navigate === 'function') {
        try { await client.navigate(target); } catch (error) {}
      }
      if (typeof client.focus === 'function') {
        await client.focus();
        return;
      }
    }
    if (typeof self.clients.openWindow === 'function') await self.clients.openWindow(target);
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'codingns-sw-unregister') return;
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)));
    } catch (error) {}
    if (typeof self.registration.unregister === 'function') await self.registration.unregister();
  })());
});
`
}

function encodeServiceWorker(): Uint8Array {
  return new TextEncoder().encode(createPwaServiceWorkerScript())
}

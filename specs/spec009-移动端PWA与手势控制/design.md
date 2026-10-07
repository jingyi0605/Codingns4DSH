# 设计文档 - 移动端 PWA 与手势控制

状态：规划完成，待实施。

## 1. 概述

### 1.1 目标

- 让手机通过局域网代理（后续经 NGINX HTTPS）访问 DSH Web 时获得可安装的 PWA 基础：正确的 manifest、图标、apple 元数据与独立窗口。
- 在安全上下文下提供 Service Worker、安装引导与通知（本地 → VAPID 推送）。
- 用横滑手势开合左侧会话列表与右边栏，全部通过 DSH 官方客户端服务完成。
- 所有增强限定在插件自己的两个边界内：代理的请求侧合成，以及启动页的注入表/`tapIndex`；不改写上游响应、不改 DSH 源文件。
- 新增能力按 `AGENTS.md` 走能力矩阵与三版本 fixture，缺失时安全降级。

### 1.2 覆盖需求

- `requirements.md` 需求 1 至需求 9，以及三条非功能需求。

### 1.3 技术约束

- Host：TypeScript、Cordis Feature、`CodingNsHostServices` 注入；代理沿用 `LanAccessDshProxy`/`LanAccessDshAuthTransform` 的请求侧解析路径。
- 注入：只使用 `webserver/index-inject` 事件（`html`/`script`/`script-src` 行）与 `webServer.tapIndex`；响应侧保持“原样 pipe”。
- Client：沿用 `src/client/*-dom.ts` 的控制器模式与 `CLIENT_FEATURES` 注册表；手势只调用 `ctx.layout` 与 `ctx.sidebarRight`。
- 存储：Host 私有状态文件沿用 `~/.config/codingns4dsh/`（0600）。图标不落包内二进制，由 `src/host/modules/pwa/pwa-icons.ts` 程序化生成（偏离与理由见 `docs/开发记录/20260929-PWA与移动端手势实现记录.md`）。
- 网络：HTTPS 由 NGINX 反代提供；插件不做 TLS 终结、不做公网方案。
- 平台前提：Service Worker / Push / Android 安装判定需要安全上下文；iOS 通知需要“已添加到主屏幕”（16.4+）；iOS 无 `navigator.vibrate`。
- 禁止事项：改写上游 HTML 响应；把凭据注入页面；把登录保护放行扩大到非静态路径；用版本 `if` 代替能力探测。

## 2. 架构

### 2.1 系统结构

```text
手机浏览器 / 已安装 PWA
  │ https://<域名>（NGINX 终结 TLS；建议挂根路径）
  ▼
LanAccessDshProxy（0.0.0.0:13080）
  ├── LanAccessDshAuthTransform（请求侧）
  │     ├── /manifest.webmanifest  → 合成插件 manifest（启用时）
  │     ├── /sw.js                 → 合成 Service Worker
  │     ├── /__codingns/pwa/*.png  → 合成包内图标
  │     ├── /__codingns/session... → 现有登录接口（不改）
  │     └── 其他                    → 登录校验后透传
  └── dshSocket.pipe(localSocket)（响应侧原样，不改写）
  ▼
DSH WebServer（127.0.0.1:<dshPort>）
  ├── webserver/index-inject → 追加 html 行（theme-color / apple-* / apple-touch-icon）
  │                           追加 script 行（SW 注册脚本）
  ├── webServer.tapIndex     → 改写 <meta name="viewport"> 补 viewport-fit=cover
  └── 静态兜底 → 上游 index.html 与 manifest（保持可用）
  ▼
DSH Web 前端（React）

浏览器内（客户端插件）
  ├── MobileSidebarGestureController（横滑 → 服务调用）
  ├── PwaInstallPrompt（beforeinstallprompt / iOS 指引）
  └── PwaNotificationClient（权限、showNotification、订阅管理）
```

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `LanAccessDshProxy`（扩展） | 在现有 `authorize()` 分支内合成 PWA 资产；放行静态路径 | HTTP 请求头、PWA 设置快照 | `Uint8Array` 响应或 `'pass'` |
| `LanResponseSynthesizer`（新增） | 生成“原字节 + 自定义 Content-Type”的完整 HTTP 响应；替代 `loginResponse` 对非 HTML/JSON 的转义 | 状态、类型、字节、头 | 完整响应字节 |
| `PwaAssetRegistry`（新增） | 包内资产路径 → 内容类型/缓存策略/文件名（内容哈希） | 启用开关 | 资产清单 |
| `injectDshWebPwaMetadata`（`index-injection.ts` 扩展） | 构造并追加注入行（head 元数据 + 注册脚本） | WebServer 事件表、设置 | 修改后的注入表 |
| `applyViewportFitTap`（新增，`tapIndex` 消费者） | 把 `viewport-fit=cover` 合并进已有 viewport meta | 原始 HTML | 变换后的 HTML |
| `MobileSidebarGestureController`（新增，client） | 监听触摸、判定手势、调用侧栏服务 | 触摸样本、设置、能力 | 服务调用与诊断 |
| `detectSidebarGesture`（纯函数） | 手势判定的全部逻辑，便于单测 | 样本与配置 | 动作或忽略 |
| `PwaInstallPrompt`（新增，client） | 安装引导与状态记忆 | `beforeinstallprompt`、display-mode | 引导条 UI |
| `PwaNotificationClient` + `Host` 推送发送器（新增） | 本地通知、VAPID 订阅与发送 | 权限、订阅、事件 | 通知与订阅记录 |
| `LanAccessPanel` / `WorkspaceSessionEnhancementPanel`（扩展） | 设置与状态展示（含回环旁路提示） | 设置快照 | 用户配置 |

### 2.3 关键流程

#### 2.3.1 手机访问与“添加到主屏幕”

1. 手机访问 `https://<域名>/`（未登录）→ 代理返回登录页；登录成功后浏览器重新加载首页。
2. 首页 HTML 已由 WebServer 渲染：注入行追加了 theme-color 与 apple 元数据；`tapIndex` 已把 viewport 改为含 `viewport-fit=cover`。
3. 浏览器按 `<link rel="manifest">` 请求 `/manifest.webmanifest` → 代理返回插件 manifest（含 PNG 图标与标记字段）。
4. iOS：用户“分享 → 添加到主屏幕”，主屏图标取 `apple-touch-icon`，启动后进入独立窗口；Android：满足安装判定后浏览器可提示安装，插件同时展示自定义引导条。
5. 已处于 `display-mode: standalone` 时，引导条不再出现。

#### 2.3.2 Service Worker 注册与生命周期

1. 注入脚本在启动页执行：仅当 `window.isSecureContext === true` 且 `'serviceWorker' in navigator` 且设置启用时继续。
2. 探测 `/manifest.webmanifest` 是否带插件标记（避免在桌面/中继入口误注册）；无标记则直接退出。
3. `navigator.serviceWorker.register('/sw.js', { scope: '/' })`；失败只记录诊断码，不影响页面。
4. `/sw.js` 由代理合成，内容是带版本常量的脚本：不做导航缓存，只处理 `push`、`notificationclick` 与 `message`（注销/清缓存）。
5. 用户关闭 SW 设置：客户端 `getRegistrations()` → `unregister()`，并向活动 SW `postMessage({ type: 'codingns-sw-unregister' })` 让其清理缓存。
6. 插件升级：SW 脚本内容随版本变化（版本常量出现在字节里），浏览器按 `no-cache` 重新校验并安装新版本。

#### 2.3.3 通知与推送

1. 用户在设置里选择档位：`off`（默认）→ `local` → `push`。
2. `local`：权限请求只在用户手势内发起；授权后由页面或 SW 调 `showNotification`；非安全上下文或 iOS 未安装到主屏时显示不可用原因。
3. `push`：Host 生成并保存 VAPID 密钥；客户端 `pushManager.subscribe` 后把订阅 POST 到 Host 存储；Host 在事件触发时加密载荷并发送到订阅 endpoint。
4. 载荷只包含标题、摘要与会话标识；iOS 不允许静默推送，载荷必须展示通知。
5. 关闭档位：客户端退订 + Host 删除订阅记录。

#### 2.3.4 手势开合侧栏

1. 控制器在 `touchstart` 记录单指起点；多指、可编辑目标、消息中的可横向滚动组件或起点落在边缘热区（默认 12px）时直接放弃，分别交给缩放、输入控件、表格/代码块内容或系统返回手势。
2. `touchmove` 累积样本，采用「距离 OR 甩动」双通道：水平位移达到 `视口宽度 × 距离比例`（设置项，默认 25%）即触发；位移不足时，若达到甩动下限（48px）且整段平均速度达到 0.5px/ms（约 500px/s），按快速甩动触发。水平/垂直位移比需达到 1.5。距离通道不再做速度二次否决——人手松手前必然减速，用末端速度否决会系统性误杀正常滑动。方向锁定失败则立即释放；只有成功判定才 `preventDefault`，滚动不受影响。
3. 判定通过：按方向映射取动作——右滑 → 左栏 `ctx.layout.toggleSidebar()`；左滑 → 右栏 `ctx.sidebarRight.toggleExpanded()`（`swap` 模式互换），同一触摸只触发一次。
4. 调用前读取状态：右栏若将进入全屏（窄屏 `autoFullscreen`），压入一条 history 记录；`popstate` 时若右栏展开则关闭右栏并阻止默认后退。
5. 控制器只调服务；关闭/禁用时移除全部监听，无定时器残留。

#### 2.3.5 NGINX 拓扑与安全边界

1. NGINX 把 `https://<域名>` 反代到代理监听口；Host/Origin 由代理改写为 `127.0.0.1:<dshPort>`，NGINX 不需要还原 Host。
2. 普通 HTTP 请求由代理强制 `Connection: close`，NGINX 不要给上游配 keepalive（无收益且会削弱“每连接首请求拦截”的语义）。
3. WebSocket 升级请求保留 `Upgrade` 透传；SSE 端点需 `proxy_buffering off`。
4. 同机 NGINX 反代到 `127.0.0.1:13080` 时，代理视其为回环流量并放行，**登录保护对该链路失效**：必须在 NGINX 侧鉴权，或接受“仅内网/隧道可达”。设置面板与文档给出提示。
5. PWA 资产只放行静态路径；`/sw.js` 与图标同样不携带凭据，放行不影响安全模型。

#### 2.3.6 输入焦点与虚拟键盘

1. `startTouchInputFocusGuard` 独立于侧栏和会话手势：iPad UA 或 `Macintosh` 且 `maxTouchPoints > 1` 时不受宽度限制；其他设备沿用不超过 1024px 的触摸视口判定。
2. 捕获可信的 `pointerdown/mousedown/touchstart/click`，将可编辑子文本归一到输入根节点，仅向直接被点按的组件授予 700ms 聚焦许可。关联标签和终端文字面板分别映射到对应文本框；非输入按钮不得授权。
3. 包装当前窗口的 `HTMLElement.prototype.focus`，调用原生方法前拒绝无许可的输入聚焦；通过 `focusin` 兜底处理原生自动聚焦和缓存原生方法的调用。普通按钮焦点保持可用。
4. 超过 12px 的移动、触摸取消、输入失焦、非输入区点按及进入后台撤销许可；保留 Composer 工具按钮的点击链路。销毁或离开受保护视口时恢复原生方法并移除监听，宽屏 iPad 持续保护。

## 3. 组件和接口

### 3.1 核心组件

覆盖需求：1、2、3、4、5、6、7、8、9。

- `LanResponseSynthesizer`：唯一的代理合成出口，保证 Content-Length、Content-Type、缓存头正确。
- `PwaAssetRegistry`：唯一的资产清单来源（manifest 模板、图标文件、SW 脚本生成器）。
- `injectDshWebPwaMetadata`：唯一的启动页元数据注入点。
- `applyViewportFitTap`：唯一的 viewport 改写实现，注册进 `webServer.tapIndex`。
- `MobileSidebarGestureController` + `detectSidebarGesture`：唯一的手势入口与判定逻辑。
- `PwaInstallPrompt`、`PwaNotificationClient`、`PwaPushSender`（Host）：安装引导与通知链路。
- 能力适配（`src/dsh-capabilities/`）：`web.index-inject`、`web.index-tap`、`layout.columns`、`sidebar.right.expand`。

### 3.2 数据结构

覆盖需求：1、2、4、5、7。

#### 3.2.1 `LanAccessDshPwaSettings`（设置契约扩展）

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `enabled` | `boolean` | 是 | 是否由代理提供 PWA 资产与元数据 | 默认 `true`，阶段 1 后生效 |
| `serviceWorker` | `boolean` | 是 | 是否合成 `/sw.js` 并注入注册脚本 | 默认 `false`，仅安全上下文生效 |
| `installPrompt` | `boolean` | 是 | 是否注入安装引导 | 默认 `true` |
| `notifications` | `'off' \| 'local' \| 'push'` | 是 | 通知档位 | 默认 `off`；`push` 需要 VAPID 就绪 |

`LanAccessDshSettings` 增加 `pwa` 字段；旧配置缺省时由 normalizer 回填默认值，读取路径与 `lanAccessDsh/settings/*` RPC 复用。

#### 3.2.2 `SidebarGestureSettings`（挂 `MobileAccessSettings`）

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `sidebarGestures` | `boolean` | 是 | 手势总开关 | 默认 `true` |
| `sidebarGestureMapping` | `'swipe-inward' \| 'swap'` | 是 | 方向映射 | 默认 `swipe-inward`（右滑=左栏，左滑=右栏） |
| `sidebarGestureEdge` | `'avoid' \| 'edge'` | 是 | 起手是否允许贴边 | 默认 `avoid`（避开 12px 系统热区） |
| `sidebarGestureDistancePercent` | `number` | 是 | 触发手势所需的水平位移占视口宽度的百分比；用比例而非像素，保证同一设置在各类视口表达同一灵敏度 | 15–80，默认 25，越界收敛 |

#### 3.2.3 `LanAccessDshPwaAsset`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | `string` | 对外路径，如 `/__codingns/pwa/icon-192.png` |
| `contentType` | `string` | `image/png` 等 |
| `file` | `string` | 规划中的包内相对路径；实现改为程序化生成字节（`pwa-icons.ts`），该字段未使用 |
| `cacheControl` | `string` | 文件名含内容哈希时用长缓存 |

#### 3.2.4 `PwaPushSubscription`（Host-only）

| 字段 | 类型 | 说明 | 约束 |
| --- | --- | --- | --- |
| `endpoint` | `string` | 推送服务地址 | 去重键 |
| `keys.p256dh` / `keys.auth` | `string` | 浏览器公钥与认证密钥 | 不落日志 |
| `createdAt` | `string` | 订阅时间 | ISO 8601 |
| `label` | `string` | 设备摘要（UA 截断） | 脱敏 |

### 3.3 接口契约

覆盖需求：1、2、3、4、5、8、9。

#### 3.3.1 代理合成响应助手（内部接口）

- 标识：`synthLanResponse({ status, contentType, body, headers?, cacheControl? })`。
- 行为：`Content-Length` 由字节数计算；`X-Content-Type-Options: nosniff`；`Connection: close`；不经过 `escapeHtml`；`Cache-Control` 由调用方指定（manifest 默认 `public, max-age=300`，SW 固定 `no-cache`，图标可由内容哈希决定长缓存）。
- 校验：`body` 必须是 `Uint8Array` 或 UTF-8 字符串；`contentType` 必填；status 限定在 `200/204/301/302/303/401/404/410/405`。
- 错误：非法入参在开发期抛 `LAN_ACCESS_DSH_INVALID`；生产路径不得因此中断其他请求（沿用 try/catch + 诊断日志）。

#### 3.3.2 代理拦截与放行规则表

| 路径 | 方法 | 启用时行为 | 禁用/缺失时 | 登录放行 | 缓存 |
| --- | --- | --- | --- | --- | --- |
| `/manifest.webmanifest` | GET | 合成插件 manifest | `'pass'`（上游） | 是 | `max-age=300` |
| `/sw.js` | GET | 合成 SW 脚本 | `'pass'`（上游 404） | 是 | `no-cache` |
| `/__codingns/pwa/<file>` | GET | 合成包内资产 | `404` | 是 | 内容哈希 → 长缓存 |
| `/__codingns/session*`、`/__codingns/login`、`/__codingns/logout` | 现有 | 不变 | 不变 | 现有语义 | `no-store` |
| 其他 | 任意 | 不变（登录校验后透传） | 不变 | 否 | 上游 |

约束：以上路径不允许出现 `POST/PUT/PATCH/DELETE`，一律 `405`；合成响应不进入上游转发路径。

#### 3.3.3 注入行契约

- `html` 行（`placement: 'head'`，按表顺序追加）：
  - `<meta name="theme-color" content="…">`（与 DSH 主题色一致，深/浅各一条时用 `media`）
  - `<meta name="mobile-web-app-capable" content="yes">`
  - `<meta name="apple-mobile-web-app-capable" content="yes">`
  - `<meta name="apple-mobile-web-app-status-bar-style" content="default">`：主页面与登录页统一由 iOS/iPadOS 保留状态栏空间，避免安全区值为零时覆盖顶部按钮；不依赖移动端宽度判定。
  - `<meta name="apple-mobile-web-app-title" content="DSH">`
  - `<link rel="apple-touch-icon" sizes="180x180" href="/__codingns/pwa/apple-touch-icon.png">`
- `script` 行（`placement: 'head'`，内联、体积 ≤ 2KB）：SW 注册脚本，逻辑见 §2.3.2；未启用/非安全上下文时自身短路。
- 顺序：元数据行在前，注册脚本在后；与现有 Transport/版本注入行共存，异常互不影响（现有 try/catch 语义保持）。
- 版本兼容：`html` 行在 0.2.0-rc.1 确认存在；更早版本是否支持由 `web.index-inject` 探测与 fixture 决定，不支持则整块跳过并出诊断。

#### 3.3.4 viewport 改写（`tapIndex`）

- 输入：完整 HTML 文本；输出：把已有 `<meta name="viewport" content="width=device-width, initial-scale=1">` 的内容替换为追加 `, viewport-fit=cover`；没有 viewport meta 时不做任何事（不新增第二个）。
- 幂等：已经包含 `viewport-fit` 时不重复追加。
- 失败：解析失败时原样返回，并记诊断；能力缺失（`web.index-tap` 不可用）时整块跳过。

#### 3.3.5 能力 route 契约（新增）

| 能力 ID | 运行时 | 检测 | 缺失时降级 |
| --- | --- | --- | --- |
| `web.index-inject` | host | 宿主 Context 提供 `webserver/index-inject` 事件与 WebServer | 跳过全部启动页注入（含现有 Transport 注入保持现状） |
| `web.index-tap` | host | `webServer.tapIndex` 为函数 | 跳过 viewport 改写 |
| `layout.columns` | client | `ctx.layout.toggleSidebar` 为函数 | 手势整体关闭（左栏部分） |
| `sidebar.right.expand` | client | `ctx.sidebarRight` 提供 `isExpanded`/`toggleExpanded` | 手势整体关闭（右栏部分） |
- 每条 route 覆盖 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-rc.2 / 0.2.0-rc.1 四套 fixture，返回值必须是 `ready/degraded/unavailable` 三态之一，并带诊断码。
- 业务代码只读 `capabilityProfile`，不写版本比较。

#### 3.3.6 手势控制器接口（client）

```ts
interface SidebarGesturePorts {
  readonly layout?: { toggleSidebar(): void }
  readonly sidebarRight?: { isExpanded(): boolean; toggleExpanded(): void }
}

interface SidebarGestureOptions {
  readonly ports: SidebarGesturePorts
  readonly settings: () => SidebarGestureSettings
  readonly readLeftCollapsed?: () => boolean | undefined
  readonly onHistoryIntegrate?: () => void
  readonly onDiagnostic?: (code: string) => void
}

startMobileSidebarGestures(options: SidebarGestureOptions): { dispose(): void }
detectSidebarGesture(samples: readonly TouchSample[], config: GestureConfig): GestureDecision
```

- 端口缺失：对应方向的动作被禁用，`onDiagnostic('CODINGNS_GESTURE_CAPABILITY_MISSING')`。
- 判定纯函数：不读 DOM、不调服务，输入样本（`x/y/t` 与起手区信息）与配置，输出 `{ action: 'left' | 'right' | 'ignore', reason }`。
- 编辑目标（输入框、终端、CodeMirror）内的触摸不参与手势。

#### 3.3.7 Host RPC 扩展

- `lanAccessDsh/settings/get|set`：负载增加 `pwa` 字段（沿用现有解析与持久化路径）。
- `lanAccessDsh/pwa/push/subscribe`：`{ subscription }` → 保存订阅（脱敏返回）。
- `lanAccessDsh/pwa/push/unsubscribe`：`{ endpoint }` → 删除订阅。
- `lanAccessDsh/pwa/push/test`：发送一条测试通知（用于验收，不含正文）。
- `lanAccessDsh/pwa/status`：返回 SW/通知/推送与资产的就绪状态与诊断码。

## 4. 数据与状态模型

### 4.1 数据关系

`代理入口 1—1 局域网映射`；`入口 1—1 PWA 资产集`（由设置开关决定是否提供）；`入口 1—N 推送订阅`（同一 Host 不同设备）；`客户端页面 1—1 手势控制器`（生命周期跟随功能模块启停）。

### 4.2 状态流转

Service Worker：

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `disabled` | 未启用或不满足条件 | 设置关闭 / 非安全上下文 / 无资产标记 | 用户启用且满足条件 |
| `registering` | 正在注册 | 调用 `register()` | 注册成功或失败 |
| `active` | 已接管 | 注册成功 | 用户关闭 / SW 被浏览器淘汰 |
| `update_pending` | 有更新待激活 | 脚本字节变化 | 新版本激活 |
| `unregistered` | 已注销并清缓存 | 用户关闭或注销 RPC | 再次启用 |

手势：

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `idle` | 未跟踪 | 初始 / 手势结束 | `touchstart` |
| `tracking` | 已记录单指起点 | 起点不在热区且在可手势区域 | 方向判定失败 / 多指 / `touchend` |
| `claimed` | 距离或甩动任一通道通过，且方向锁定通过 | 水平位移至少为 `视口宽度 × 距离比例`（默认 25%），或达到 48px 且平均速度 ≥ 0.5px/ms | 触发服务调用 |
| `rejected` | 放弃本次手势 | 起点在热区 / 方向不满足 / 目标不可用 | 回到 `idle` |

## 5. 错误处理

### 5.1 错误类型

- `LAN_ACCESS_DSH_PWA_ASSET_MISSING`：包内资产缺失或不可读；返回 404 并保持上游可用。
- `CODINGNS_PWA_INSECURE_CONTEXT`：非安全上下文，跳过 SW/推送。
- `CODINGNS_PWA_SW_UNSUPPORTED` / `CODINGNS_PWA_SW_REGISTER_FAILED`：浏览器不支持或注册失败。
- `CODINGNS_PWA_NOTIFICATION_DENIED`：通知权限被拒。
- `CODINGNS_PWA_PUSH_UNAVAILABLE` / `CODINGNS_PWA_PUSH_SUBSCRIBE_FAILED`：推送不可用或订阅失败。
- `CODINGNS_GESTURE_CAPABILITY_MISSING`：`layout`/`sidebarRight` 端口缺失。
- `CODINGNS_CAPABILITY_WEB_INDEX_TAP_MISSING`：无 `tapIndex`，viewport 改写跳过。

### 5.2 错误响应格式

沿用现有约定：RPC 用 `CodingNsRpcError(code, message)`；代理合成响应用 HTTP 状态 + 纯文本或 JSON（不暴露内部细节），状态与诊断码写入调试日志（脱敏）。

### 5.3 处理策略

1. 输入验证错误：设置解析在写入前拒绝，不落库。
2. 能力缺失：跳过对应增强，记录诊断，不影响其他模块与启动页。
3. 浏览器能力错误：静默降级到低档位（push → local → off），设置页展示原因。
4. 资产/注入异常：try/catch 回退到“不增强”，启动页与登录流程优先可用。
5. 取消与清理：卸载时注销 SW、移除监听、清空缓存；不遗留会拦截页面的状态。

## 6. 正确性属性

### 6.1 属性 1：零副作用

*对于任何* 未启用（或能力缺失）的场景，系统都应该满足：不注册 Service Worker、不注入元数据、不挂手势监听、不产生额外请求。

**验证需求：** 需求 2、5、7。

### 6.2 属性 2：登录边界不被削弱

*对于任何* 请求，系统都应该满足：只有白名单静态路径被放行或合成；其余路径仍走登录校验；合成内容不含 Cookie、Token、绝对路径。

**验证需求：** 需求 1、2、8。

### 6.3 属性 3：代理转发不变式

*对于任何* 被放行的请求，系统都应该满足：请求头改写、`Connection: close`、WebSocket 升级与响应侧原样回传的行为与增强前一致。

**验证需求：** 需求 8。

### 6.4 属性 4：SW 缓存安全

*对于任何* SW 生命周期状态，系统都应该满足：不缓存登录页、`/__codingns/*` 与 `/api/*`；注销后不再拦截任何请求。

**验证需求：** 需求 2、8。

### 6.5 属性 5：手势只经服务

*对于任何* 手势触发，系统都应该满足：侧栏状态变化全部来自 `toggleSidebar()`/`toggleExpanded()`，不由插件直接改 DOM class 或 store。

**验证需求：** 需求 5、6。

## 7. 测试策略

### 7.1 单元测试

- `synthLanResponse`：状态行、Content-Length、Content-Type、不转义、二进制字节保真。
- manifest 生成：`display: standalone`、图标集合、标记字段、`start_url/scope` 保持 `./`。
- SW 脚本：版本常量、无导航缓存、白名单、注销消息处理。
- 注入行构造：`html` 行内容与顺序、短路径开关（禁用时不出现在表中）、异常隔离。
- `applyViewportFitTap`：改写、幂等、无 meta 时不动、异常回退。
- `detectSidebarGesture`：四方向、距离比例边界（15%/25%/80%）、甩动通道（距离下限与平均速度）、方向锁、边缘热区（12px）、编辑目标、配置非法值和多指排除。
- 设置 normalizer：缺省回填、越界收敛、旧像素门槛一次性换算为比例、新字段优先于旧字段。

### 7.2 集成测试

- 扩展 `tests/lan-access-dsh.spec.ts` 的 `FakeRuntime`/`FakeStream`：合成 manifest/SW/图标命中且不连接上游；非 GET 返回 405；登录启用时资产仍可取；其他路径保持原有语义。
- WebServer 注入集成（fake WebServer 提供 `on('webserver/index-inject')` 与 `tapIndex`）：断言注入行出现在表中、viewport 被改写、异常不影响启动页渲染。
- 能力矩阵：四个能力在 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-rc.2 / 0.2.0-rc.1 夹具下的三态结果与诊断码。
- 手势控制器：fake DOM + fake 端口，验证只调用服务、不触碰 DOM class、卸载后无监听。

### 7.3 端到端测试（人工，真机）

- iOS Safari：A2HS 后独立窗口、图标与名称、刘海/Home 指示条适配、引导文案、手势与系统边缘手势的边界。
- Android Chrome：安装判定、安装后引导隐藏、通知、手势、系统返回手势。
- HTTPS 经 NGINX：SW 注册成功、更新与注销、登录页不被缓存、SSE/WebSocket 正常。
- 失败路径：HTTP 直连（不注册 SW）、能力缺失（手势关闭）、资产缺失（回退上游 manifest）。

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| 需求 1 | §2.3.1、§3.3.1、§3.3.3 | 代理合成单测 + 注入行单测 + 真机图标检查 |
| 需求 2 | §2.3.2、§4.2、§5.3 | SW 脚本单测 + 集成测试 + 真机更新/注销 |
| 需求 3 | §2.3.1、§3.1 | 引导条组件测试 + 真机截图 |
| 需求 4 | §2.3.3、§3.3.7 | 订阅/退订 RPC 测试 + 真机通知 |
| 需求 5 | §2.3.4、§3.3.6 | 纯函数单测 + 控制器集成测试 |
| 需求 6 | §2.3.4、§2.3.5、§2.3.6 | 手势与输入焦点单测 + 真机返回键及键盘回放 |
| 需求 7 | §3.2.1、§3.2.2 | 设置 normalizer 与面板测试 |
| 需求 8 | §2.3.5、§6.2、§6.3 | 放行白名单集成测试 + 配置走查 |
| 需求 9 | §3.3.5、§7.2 | 四版本能力 fixture 测试 + `capability:check` |

## 8. 风险与待确认项

### 8.1 风险

- **SW 驻留**：一旦注册会长期留在手机上；必须有版本化更新、注销入口与“不缓存登录页”的硬约束，否则会出现“升级后仍是旧页面”或“登录页被缓存”的事故。
- **iOS 系统手势不可取消**：边缘避让只是缓解；`edge` 模式在 iOS 上大概率被系统接管，需要在设置说明中写清楚。
- **`display` 覆盖**：上游是 `fullscreen`，覆盖为 `standalone` 只作用于代理入口；若上游将来为桌面壳调整 manifest，本覆盖需重新评估。
- **旧版本注入行/tapIndex 存在性未验证**：0.1.x 是否支持 `html` 行与 `tapIndex` 需要 fixture 与真实环境验证，不支持时整块跳过。
- **同机 NGINX 回环旁路**：登录保护在该链路整体失效，是既有设计语义；只能靠 NGINX 鉴权与文档提示。
- **推送实现选型**：自实现 VAPID + `aes128gcm` 加密与成熟依赖（如 `web-push`）之间需要决策；新增依赖要走发布确认流程。
- **代理拦截语义**：拦截只作用于每条连接的首个请求；当前依赖“每请求一条连接”的既有性质，若上游引入 keep-alive/多路复用会退化。

手势设置已归入“移动端访问增强”面板，与移动端视口和侧栏行为共用一份设置；旧版本写在
`workspaceSessionEnhancement` 的字段只做兼容读取。

### 8.2 待确认项
- PWA 资产开关的默认值：阶段 1 是否直接默认开启，还是先默认关闭、由用户在面板勾选。
- `display` 取值最终定为 `standalone` 还是保留上游 `fullscreen`。
- 推送的事件源（任务完成、等待输入等）与首个触发点；是否先只提供“测试通知”。
- 安装引导的展示时机与频率（首次访问？登录后？standalone 检测之外是否还有设备判定）。
- 是否需要把同一套能力同时提供给中继/H5 入口，还是严格限定局域网代理入口。
- iOS 主屏 web app 与 Safari 共享 Cookie 的行为在跨版本上的稳定性（影响 SW 与登录态交互）。

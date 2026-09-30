# spec009：移动端 PWA 与手势控制

状态：阶段 1–5 已实现并完成代码级验证，落地过程与验证结果见 `docs/开发记录/20260929-PWA与移动端手势实现记录.md`；真机验收项待按部署清单在设备上执行。实现与规划的一处偏离：PNG 图标改为在 `src/host/modules/pwa/pwa-icons.ts` 程序化生成，不再落包内 `assets/pwa/` 二进制。

## 这份 Spec 解决什么问题

用户用手机通过局域网（后续经 NGINX 反代 HTTPS）访问 DSH Web 时，体验停留在“浏览器里的桌面版页面”：

1. 不能“添加到主屏幕”成为一个独立应用（iOS 没有独立窗口与全屏；Android 图标与安装判定不满足）。
2. 没有通知能力，任务跑完只能自己回来看。
3. 左右两个侧栏（会话列表、右边栏）在小屏上只能点按钮开合，没有手势。

而 DSH 上游已经把这些能力的“接口”准备好了：前端 dist 自带 `manifest.webmanifest` 并在 `index.html` 中引用；启动页支持结构化注入表（`webserver/index-inject`）与原始 HTML 改写（`tapIndex`）；左侧栏有 `ctx.layout.toggleSidebar()`、右侧栏有 `ctx.sidebarRight.toggleExpanded()`（插件客户端已经在注入 `sidebarRight`）。缺的是**插件侧的资产与手势层**，以及一个硬前置条件：**HTTPS 安全上下文**（Service Worker、Push、安装判定都要求它）。

本 Spec 规定：由插件的局域网代理模块承担 PWA 组件的注入与合成，由客户端注入手势层驱动左右侧栏；HTTPS 由 NGINX 反代提供（部署侧，不在插件代码内）。

## 核心判断

- 上游直接提供移动端 PWA 与手势：不可行。经调查（见 `docs/调查报告/20260929-DSH移动端PWA与布局手势能力调查.md`），上游 manifest 是 `display: fullscreen` + 单一 SVG 图标，无 apple 元数据、无 Service Worker、无手势；但它已经把 manifest 引用、注入表和侧栏服务全部备好。
- 插件实现 PWA 资产与手势：可行性约 `8/10`。代理模块已有“解析请求头 + 合成 HTTP 响应”的成熟路径（登录页、会话 JSON），manifest 已在白名单里；`html`/`script-src` 注入行和 `tapIndex` 是官方扩展点；侧栏开合有服务 API。主要工作量在 Service Worker 生命周期、通知链路与手势手感打磨。
- 不依赖插件的替代方案：PWA 基础体验（独立窗口、图标）在 iOS 上依赖 A2HS + apple 元数据，Android 依赖 HTTPS + 合格 manifest；这些都必须由插件提供资产，上游不会补。
- 振动：不可行（iOS 至今没有 `navigator.vibrate`；Android 有但需要先前用户激活）。本 Spec 不承诺跨平台振动，只记录结论。

## 阅读顺序

1. `requirements.md`：用户故事、范围和可验收行为。
2. `design.md`：分层设计、代理合成契约、注入行契约、能力登记、手势控制器与设置。
3. `docs/调查报告/20260929-DSH移动端PWA与布局手势能力调查.md`：上游 manifest/注入表/侧栏服务的原文证据与复现命令。
4. `tasks.md`：按阶段执行的任务清单；每完成一个任务必须立即回写状态和验证证据。

## 当前范围

本 Spec 覆盖：

- 局域网代理合成/覆盖 PWA 静态资产：`/manifest.webmanifest`、PNG 图标（192/512/maskable）、`apple-touch-icon`（180×180）。
- 启动页注入：`theme-color`、`apple-mobile-web-app-capable` 等 head 元数据；`tapIndex` 补 `viewport-fit=cover`。
- Service Worker：合成 `/sw.js`、只在安全上下文注册、版本化更新、注销逃生口、禁止缓存登录页与 `/__codingns/*`。
- 安装引导：Android `beforeinstallprompt` 引导条；iOS “分享 → 添加到主屏幕”指引；已安装（standalone）时不再展示。
- 通知：本地通知 → VAPID 远程推送（订阅、存储、发送、iOS 限制说明）。
- 手势：移动端横滑开合左（`toggleSidebar`）右（`toggleExpanded`）侧栏，方向锁定、边缘避让、阈值可配、与系统返回手势共存。
- 设置与面板：PWA 开关挂在“局域网访问 DSH”面板；手势开关、方向、边缘模式与灵敏度统一挂在“移动端访问增强”面板。
- 能力登记：`web.index-inject`、`web.index-tap`、`layout.columns`、`sidebar.right.expand` 四条新能力与三版本 fixture。
- 安全边界：登录放行白名单、回环旁路提示、合成响应不进入上游转发路径、NGINX 部署注意事项。

明确不在本 Spec 内：

- 修改 DSH Host、前端 bundle 或上游 manifest 源文件。
- 在插件里实现 TLS 终结；HTTPS 由 NGINX（或等价反代）提供。
- “自动安装”：浏览器不允许，本 Spec 只做引导。
- iOS 振动：平台没有该 API，不做兼容层。
- 公网暴露方案（域名、证书申请、防火墙），只在任务里给出部署检查清单。
- 离线可用性与激进缓存策略（SW 只做最小必要能力，避免缓存污染）。

## 与现有 Spec 的关系

- 依赖 `spec005-DSH能力注册与版本路由机制`：新增能力必须走矩阵、route、诊断与 fixture。
- 与 `spec008-会话级受控访问地址` 并列：两者都复用 `lan-access-dsh` 代理骨架，但用途不同（会话级只读分享 vs 入口体验增强）。若两者都要在代理层加前缀处理，需要共用一套“请求拦截表”扩展点。
- 复用 `spec007` 建立的客户端功能模块规范（注册表、设置卡片、资源登记）。
- 不改变现有局域网访问、登录保护、中继、PeerHost 的行为。

## 阶段总览

| 阶段 | 内容 | 前置条件 | 手机侧收益 |
| --- | --- | --- | --- |
| 阶段 1 | 代理覆盖 manifest + 补 PNG 图标 + 注入 apple meta/theme-color/apple-touch-icon + `tapIndex` 补 `viewport-fit=cover` | 无 | iOS 可“添加到主屏幕”获得独立窗口与全屏；安卓图标正确 |
| 阶段 2 | 合成 `/sw.js`（仅安全上下文注册）+ safe-area 适配 + 安装引导条 | NGINX HTTPS | 安卓安装判定达标；可安装、可更新、可注销 |
| 阶段 3 | 手势开合左右侧栏（服务调用 + 纯函数判定 + 设置） | 无（与阶段 1/2 并行） | 横滑开合会话列表与右边栏 |
| 阶段 4 | 通知：本地 → VAPID 真推送 | 阶段 2 | 任务完成可收通知（iOS 需已安装到主屏） |
| 阶段 5 | 安全、兼容与验收（放行白名单、回环旁路、三版本 fixture、文档回写） | 阶段 1–4 | 可长期放心使用 |

## 关键设计结论

```text
手机浏览器 / 已安装 PWA (https://<域名>)
  │  HTTPS（NGINX 终结 TLS；建议挂在域名根路径）
  ▼
插件局域网代理：LanAccessDshProxy（0.0.0.0:13080）
  ├── 请求侧：解析首个请求头，按白名单决定 放行 / 合成响应
  │     ├── GET /manifest.webmanifest  → 合成插件版 manifest（覆盖上游）
  │     ├── GET /sw.js                 → 合成 Service Worker（版本化）
  │     ├── GET /__codingns/pwa/*.png  → 合成 PNG 图标（包内资产）
  │     └── 其他请求 → 登录校验后透传
  └── 响应侧：原样回传，不解析（不改写上游 HTML）
  ▼
DSH WebServer
  ├── webserver/index-inject：追加 html 行（theme-color / apple-* / apple-touch-icon）
  └── webServer.tapIndex：改写 <meta name="viewport"> 补 viewport-fit=cover
  ▼
DSH Web 前端（manifest 已引用；无 SW、无手势）

客户端（浏览器内）
  ├── 手势控制器：横滑 → ctx.layout.toggleSidebar() / ctx.sidebarRight.toggleExpanded()
  ├── 安装引导条：beforeinstallprompt（Android）/ 手动指引（iOS）
  └── 通知层：Notification / Service Worker showNotification / Web Push
```

约束一句话：**代理只负责“发文件”，注入表只负责“加标签”，手势只负责“调服务”；三者都不改写上游响应、不改 DOM 状态、不绕开登录保护。**

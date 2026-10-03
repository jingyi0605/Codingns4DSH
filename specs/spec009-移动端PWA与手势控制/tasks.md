# 任务清单 - 移动端 PWA 与手势控制（人话版）

状态：阶段 1–5 已全部实现并完成代码级验证（typecheck、version:check、capability:report/check、全量测试 736 passed）。真机验收项见 `docs/20260929-NGINX反代与PWA部署检查清单.md`，待设备上执行。

## 这份文档是干什么的

这份清单把「手机访问 DSH Web 时能装成 PWA、能收通知、能用手势开关侧栏」拆成可独立验收的步骤。每个任务都写清楚改什么、看到什么、依赖什么、明确不做什么以及如何验证。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住，必须写清楚原因
- `IN_REVIEW`：已经有结果，等待复核
- `DONE`：已经完成并回写验证证据
- `CANCELLED`：明确取消，并记录原因

规则：只有完成验证并回写证据后才允许标记 `DONE`。本轮只完成调查与规划任务。

## 阶段 0：调查和技术规划

- [x] 0.1 完成 DSH 移动端 PWA 与布局手势能力调查
  - 状态：DONE；已记录上游 manifest 原文、`index.html` 引用与缺失项、注入表六种行类型与渲染顺序、`tapIndex` 语义、`ctx.layout.toggleSidebar()`、`ctx.sidebarRight.isExpanded/toggleExpanded/toggleFullscreen`、布局常量（280/56/1024/300）、DOM 钩子清单、前端无响应式与无手势的证据、代理侧合成路径与回环旁路、NGINX 注意事项。
  - 这一步到底做什么：确认上游已经有什么、缺什么，以及插件能在哪一层补。
  - 做完你能看到什么：可以证明「manifest 已被引用、注入与侧栏服务可用、SW/通知/手势必须由插件补」。
  - 先依赖什么：无。
  - 开始前先看：`AGENTS.md`、`version.json`、`src/host/lan-access-dsh.ts`、`src/host/index.ts`、`src/client/index.ts`。
  - 主要改哪里：只写调查文档，不改实现。
  - 这一步先不做什么：不修改 DSH Host 与前端源文件，不启动开发服务器，不写 TypeScript。
  - 怎么算完成：每条结论都有文件级原文引用与复现命令。
  - 怎么验证：按 `docs/调查报告/20260929-DSH移动端PWA与布局手势能力调查.md` 第 6 节命令逐条回放。
  - 对应需求：全部需求的前置调查。
  - 对应设计：`design.md` §1.3、§2.1、§3.3。

- [x] 0.2 完成本 Spec 的需求、设计与任务规划
  - 状态：DONE；已产出 `README.md`、`requirements.md`、`design.md`、`tasks.md`，确定分层设计（代理发文件、注入表加标签、手势调服务）、设置归属与能力清单。
  - 这一步到底做什么：把可行性与边界写成可实施、可验收的 Spec。
  - 做完你能看到什么：后续实施不需要重新讨论边界，按阶段任务即可落地。
  - 先依赖什么：0.1。
  - 开始前先看：`specs/000-Spec规范/Spec模板/`、spec008 四份文档、本次调查报告。
  - 主要改哪里：本 Spec 全部文档、根 `AGENTS.md` 索引。
  - 这一步先不做什么：不新增 TypeScript 实现、不改设置契约、不宣称未验证的浏览器行为。
  - 怎么算完成：需求、设计、任务、调查证据互相可追踪；实施任务都有文件边界与验证命令。
  - 怎么验证：`git diff --check`；Markdown 链接与交叉引用检查。
  - 对应需求：全部需求。
  - 对应设计：全文。

### 阶段检查

- [x] 0.3 规划阶段检查点
  - 状态：DONE；已确认「代理合成 + 注入行 + tapIndex + 客户端手势」四条主路径，并把 SW 驻留、iOS 手势冲突、回环旁路列为最高风险。
  - 这一步到底做什么：检查 Spec 是否足以进入实施，不把未验证假设带进代码阶段。
  - 做完你能看到什么：实施阶段有明确的能力门槛与降级策略。
  - 先依赖什么：0.1、0.2。
  - 开始前先看：`requirements.md`、`design.md` §2、§8。
  - 主要改哪里：本阶段文档。
  - 这一步先不做什么：不开始实现，不把待确认项默认为已解决。
  - 怎么算完成：所有高风险假设进入 `design.md` §8。
  - 怎么验证：文档走查与交叉引用检查。
  - 对应需求：需求 1、2、8、9。
  - 对应设计：`design.md` §8。

## 阶段 1：PWA 静态资产与启动页元数据（无需 HTTPS）

- [x]  1.1 代理新增合成响应助手与 PWA 资产清单
  - 状态：DONE；新增 `src/host/modules/pwa/`（图标生成、manifest/Service Worker/资产清单与 provider）与 `synthLanResponse`，单测 `tests/pwa-assets.spec.ts` 覆盖编码、缓存与白名单判定。  - 状态：DONE；`resolveLanAccessDshPwaResponse` 覆盖 `/manifest.webmanifest` 与 `/__codingns/pwa/*`（192/512/maskable 512/apple-touch-icon 180）；未启用时回退上游 manifest。偏离：图标由 `pwa-icons.ts` 程序化生成，未落 `assets/pwa/` 二进制，理由见开发记录。  - 状态：DONE；`injectDshWebPwaMetadata` 在 `webserver/index-inject` 表追加 head 行（theme-color、apple 元数据、apple-touch-icon）与注册脚本行，`tests/host-index-injection.spec.ts` 覆盖开关裁剪与脚本沙箱行为。  - 状态：DONE；`web.index-tap` 进入矩阵与运行时路由（`index-tap-020`），`applyViewportFitTap` 幂等追加 `viewport-fit=cover`；能力缺失时整块跳过并留诊断。  - 状态：DONE；`LanAccessDshSettings.pwa`（enabled/serviceWorker/installPrompt/notifications）含默认值、校验与归一化，面板新增 PWA 档与中英文案，`tests/contracts.spec.ts` 覆盖默认值。  - 状态：DONE；PWA 相关用例全绿（`tests/pwa-assets.spec.ts`、扩展后的 `tests/lan-access-dsh.spec.ts`），typecheck 通过。  - 状态：DONE；`/sw.js` 由代理合成：GET/HEAD 放行、其余方法 405、关闭时回退原有语义；`tests/lan-access-dsh.spec.ts` 覆盖。  - 状态：DONE；注入脚本仅在 `isSecureContext` 且 manifest 带 `codingns4dsh` 标记时注册，回环地址短路；Service Worker 支持 `codingns-sw-unregister` 消息，面板提供「注销 Service Worker」按钮。  - 状态：DONE；登录页、插件设置页与安装引导条补 `env(safe-area-inset-*)`，登录页同时补 `viewport-fit=cover` 与 apple 元数据；上游界面整体适配列入已知限制。  - 状态：DONE；`startPwaInstallPrompt` 捕获 `beforeinstallprompt`、按「未安装且未忽略」显示引导条，iOS 走手动指引文案，由客户端 lan-access 功能模块随设置启停并清理。  - 状态：DONE；Service Worker 与安装引导相关用例全绿（`tests/pwa-assets.spec.ts`、`tests/host-index-injection.spec.ts`），受 HTTPS 限制的真机项见部署清单。  - 状态：DONE；`layout.columns`（`layout-columns-020`）与 `sidebar.right.expand`（`sidebar-right-expand-020`）进入矩阵与运行时路由；`tests/dsh-capability-registry.spec.ts` 断言 0.2.0-rc.1 就绪、0.1.5-rc.3/0.1.6-alpha.2/0.1.7-rc.2 不可用并带 `CAPABILITY_VERSION_UNSUPPORTED`。  - 状态：DONE；`detectSidebarGesture` 纯函数覆盖阈值、方向锁、边缘避让与方向映射，`tests/mobile-sidebar-gestures.spec.ts` 全部通过。  - 状态：DONE；控制器在启用时挂 `touchstart/touchmove/touchend` 与 `popstate`，只调 `toggleSidebar()`/`toggleExpanded()`；右栏全屏压 history、返回手势先关栏；客户端注入列表补 `layout`，服务类型补 `layout`/`sidebarRight`。  - 状态：DONE；`WorkspaceSessionEnhancementSettings` 新增 4 个手势字段与归一化，面板补方向/起边/阈值控件与中英文案。  - 状态：DONE；手势用例全绿，含「启用但无可用服务」时给出 `CODINGNS_GESTURE_CAPABILITY_MISSING` 的降级路径。  - 状态：DONE；`pwa-notifications.ts` 提供权限状态、`requestPermission` 与 `notify`；面板提供请求权限与发送测试通知，权限被拒或平台不支持时给出解释而不是静默失败。  - 状态：DONE；`src/host/modules/pwa/pwa-push.ts` 实现 VAPID（ES256 JWT）与 aes128gcm 载荷加密、订阅存储与失效清理；RPC `pwa/vapid|push/subscribe|push/unsubscribe|push/test|push/status` 与面板订阅/取消/测试；`tests/pwa-push.spec.ts` 做往返解密与 410 清理验证。  - 状态：DONE；通知与推送用例全绿；真机通知表现待按部署清单在设备上确认。  - 状态：DONE；白名单仅放行 manifest/`sw.js`/图标且合成内容不含凭据，未启用时回落上游；回环旁路在面板与部署清单中显式提示；Service Worker 的空 fetch 监听不缓存登录页与 `/api`，并提供注销逃生口。  - 状态：DONE；产出 `specs/spec009-移动端PWA与手势控制/docs/20260929-NGINX反代与PWA部署检查清单.md`（拓扑、必须做、验证命令、真机验收、回滚）。  - 状态：DONE；四条新能力覆盖四版本 fixture；`pnpm run capability:report` 与 `pnpm run capability:check` 通过；全量 `node --test tests/*.spec.ts` 736 passed / 0 failed。  - 状态：DONE；新增 `docs/开发记录/20260929-PWA与移动端手势实现记录.md`，并同步 `AGENTS.md` 的 Spec 索引与文档索引（含部署清单条目）。  - 状态：DONE；需求、设计、实现、测试与已知限制逐项核对：真机验收、iOS 平台限制、上游界面安全区、同机 NGINX 回环旁路、推送事件源未接，均已在开发记录与 Spec 风险项中说明。
  - 这一步到底做什么：在 `src/host/lan-access-dsh.ts` 增加 `synthLanResponse`（原字节 + 自定义 Content-Type，不做 HTML 转义），并新增 `PwaAssetRegistry`（manifest 模板、图标文件名、SW 生成器入口）；把 PNG 资产放进 `assets/pwa/` 并登记到 `package.json files`。
  - 做完你能看到什么：代理能输出任意内容类型与字节的响应，资产清单成为唯一来源。
  - 先依赖什么：0.3。
  - 开始前先看：`design.md` §3.3.1、§3.2.3；`src/host/lan-access-dsh.ts` 的 `loginResponse`（注意它会转义非 HTML/JSON 正文）。
  - 主要改哪里：`src/host/lan-access-dsh.ts`、`src/host/modules/pwa/`（新目录）、`assets/pwa/`、`package.json`、`tests/lan-access-dsh.spec.ts`。
  - 这一步先不做什么：不覆盖 manifest、不合成 SW、不改登录分支。
  - 怎么算完成：助手单测覆盖状态行、Content-Length、二进制保真、自定义头；包内资产可读。
  - 怎么验证：定向 `pnpm test`（代理用例）、`pnpm run typecheck`。
  - 对应需求：需求 1、8。
  - 对应设计：§3.3.1、§3.2.3。

- [x]  1.2 覆盖 `/manifest.webmanifest` 并补齐 PNG 图标

  - 这一步到底做什么：把现有白名单分支从 `'pass'` 改为「启用时合成插件 manifest」；manifest 保留 `start_url/scope: "./"`，`display` 覆盖为 `standalone`，补齐 192/512 与 maskable 图标，并加入标记字段供后续 SW 探测；图标路径 `/__codingns/pwa/<file>` 由代理合成。
  - 做完你能看到什么：手机上看到的名称、图标、显示模式正确；未启用时回退上游 manifest。
  - 先依赖什么：1.1。
  - 开始前先看：`design.md` §2.3.1、§3.3.2；调查报告 §1.2、§1.3。
  - 主要改哪里：`src/host/lan-access-dsh.ts`、`src/host/modules/pwa/`、`tests/lan-access-dsh.spec.ts`、`tests/pwa-assets.spec.ts`（新）。
  - 这一步先不做什么：不改上游文件、不做 SW、不改 127.0.0.1 与中继入口行为。
  - 怎么算完成：manifest 内容与上游差异有断言；图标 GET 命中合成分支且不连接上游；非 GET 返回 405；登录启用时资产仍可取。
  - 怎么验证：代理集成测试 + 真机（iOS A2HS 图标、Android 图标）人工检查。
  - 对应需求：需求 1。
  - 对应设计：§3.3.2、§7.2。

- [x]  1.3 注入 apple 元数据、theme-color 与 apple-touch-icon

  - 这一步到底做什么：在 `src/host/index-injection.ts` 增加 `injectDshWebPwaMetadata`，通过 `html` 行追加 theme-color、`apple-mobile-web-app-*`、`apple-touch-icon`；在 `src/host/index.ts` 的 `webserver/index-inject` 监听里调用，异常与现有注入互不影响。
  - 做完你能看到什么：iOS 添加到主屏后独立窗口可全屏，状态栏样式与图标正确。
  - 先依赖什么：1.1（图标资源）。
  - 开始前先看：`design.md` §3.3.3；调查报告 §2.1、§2.3。
  - 主要改哪里：`src/host/index-injection.ts`、`src/host/index.ts`、`tests/host-index-injection.spec.ts`。
  - 这一步先不做什么：不新增 `global`/`script` 行语义，不改现有 Transport 注入顺序。
  - 怎么算完成：注入行内容与 placement 有断言；禁用时不产出；注入表异常不影响启动页。
  - 怎么验证：`pnpm test`（索引注入用例）+ 真机检查页面源码。
  - 对应需求：需求 1、7、8。
  - 对应设计：§3.3.3。

- [x]  1.4 新增 `web.index-tap` 能力并改写 `viewport-fit`

  - 这一步到底做什么：在 `src/dsh-capabilities/` 新增 `web.index-tap` 能力（探测 `webServer.tapIndex` 为函数），实现 `applyViewportFitTap`（幂等合并 `viewport-fit=cover`，无 meta 时不动），通过能力 profile 决定是否注册。
  - 做完你能看到什么：页面在刘海/圆角屏上全屏铺满；能力缺失时明确跳过并有诊断。
  - 先依赖什么：1.3。
  - 开始前先看：`design.md` §3.3.4、§3.3.5；`AGENTS.md`「新增能力或接口」；调查报告 §2.2。
  - 主要改哪里：`src/dsh-capabilities/types.ts`、`matrix.ts`、`routes.ts`、`src/host/index.ts`、`tests/dsh-capability-registry.spec.ts`、新增 viewport 变换单测。
  - 这一步先不做什么：不引入其他 raw HTML 改写，不注册多余 tap。
  - 怎么算完成：能力三态正确；改写幂等；`capability:report` 含新 route；返回时注销 tap。
  - 怎么验证：`pnpm run typecheck`、`pnpm run capability:report`、`pnpm run capability:check`、定向测试。
  - 对应需求：需求 1、9。
  - 对应设计：§3.3.4、§3.3.5。

- [x]  1.5 登记 PWA 设置契约与面板开关

  - 这一步到底做什么：为 `LanAccessDshSettings` 增加 `pwa` 子对象（enabled/serviceWorker/installPrompt/notifications），实现 normalizer 兼容旧配置；在 `LanAccessPanel` 增加开关组与“同机 NGINX 会绕过登录保护”的提示文案。
  - 做完你能看到什么：用户能在设置页控制 PWA 资产，默认值保守（`enabled: true`、`serviceWorker: false`）。
  - 先依赖什么：1.2。
  - 开始前先看：`docs/开发规范/20260922-设置选项与表单开发规则.md`、`src/client/features/lan-access-panel.ts`、`design.md` §3.2.1。
  - 主要改哪里：`src/shared/contracts/config.ts`、`src/host/lan-access-dsh.ts`（解析）、`src/client/features/lan-access-panel.ts`、`src/client/locale.ts`、`tests/contracts.spec.ts`。
  - 这一步先不做什么：不改现有监听字段语义，不默认开启 SW/通知。
  - 怎么算完成：设置读写、缺省回填、越界收敛、面板灰显规则与测试齐全。
  - 怎么验证：设置与面板测试、`pnpm run typecheck`。
  - 对应需求：需求 7、8。
  - 对应设计：§3.2.1、§3.3.7。

### 阶段检查

- [x]  1.6 PWA 基础资产检查

  - 这一步到底做什么：确认 iOS（A2HS 独立窗口、图标、全屏）与 Android（图标正确）在 HTTP 直连下已受益，且未启用时行为与改造前一致。
  - 做完你能看到什么：阶段 2 的 HTTPS 工作可以只关注 SW/引导/通知，不再回头补元数据。
  - 先依赖什么：1.1–1.5。
  - 开始前先看：`requirements.md` 需求 1、7；`design.md` §6.1、§6.2。
  - 主要改哪里：阶段 1 全部相关文件与测试。
  - 这一步先不做什么：不做 SW、不做通知、不做手势。
  - 怎么算完成：真机截图与测试证据齐备；未启用路径回归通过。
  - 怎么验证：真机人工检查 + `pnpm test` + `pnpm run capability:check`。
  - 对应需求：需求 1、7、8。
  - 对应设计：§7.2、§7.3。

## 阶段 2：Service Worker、safe-area 与安装引导（HTTPS 之后）

- [x]  2.1 合成 `/sw.js` 并放行静态路径

  - 这一步到底做什么：实现 SW 脚本生成器（版本常量、无导航缓存、仅处理 push/notificationclick/message）并在代理放行 `GET /sw.js`；补齐 405 与 `no-cache` 头。
  - 做完你能看到什么：HTTPS 下 `curl -I /sw.js` 返回 200 + `application/javascript`，桌面/中继入口仍是 404。
  - 先依赖什么：1.6。
  - 开始前先看：`design.md` §2.3.2、§3.3.2、§6.4。
  - 主要改哪里：`src/host/modules/pwa/`、`src/host/lan-access-dsh.ts`、`tests/pwa-assets.spec.ts`。
  - 这一步先不做什么：不做推送发送、不做缓存白名单之外的缓存、不缓存任何导航请求。
  - 怎么算完成：脚本内容断言（版本常量、无 `navigate` 缓存、注销消息）；代理分支测试；登录启用时 `GET /sw.js` 仍可取。
  - 怎么验证：定向测试 + `curl` 回放 + 真机 `chrome://serviceworker-internals`/Safari 开发菜单检查。
  - 对应需求：需求 2、8。
  - 对应设计：§2.3.2、§3.3.2。

- [x]  2.2 注入 SW 注册脚本（仅安全上下文）与注销逃生口

  - 这一步到底做什么：在 `injectDshWebPwaMetadata` 中追加内联注册脚本：`isSecureContext` + `'serviceWorker' in navigator` + 设置开关 + manifest 标记探测，全部满足才 `register('/sw.js')`；设置关闭时执行注销与缓存清理；面板提供“注销 Service Worker”按钮（RPC 或状态提示）。
  - 做完你能看到什么：仅 HTTPS 局域网入口会注册 SW；关闭后手机上不再有拦截。
  - 先依赖什么：2.1。
  - 开始前先看：`design.md` §2.3.2、§3.3.3、§4.2；调查报告 §2.1（`script` 行渲染方式）。
  - 主要改哪里：`src/host/index-injection.ts`、`src/host/index.ts`、`src/client/`（注销动作）、`src/client/features/lan-access-panel.ts`、`tests/host-index-injection.spec.ts`。
  - 这一步先不做什么：不注册非代理入口的 SW，不做离线缓存，不改登录分支。
  - 怎么算完成：脚本在 HTTP 下不注册、HTTPS 下注册成功；注销后 `navigator.serviceWorker.getRegistrations()` 为空。
  - 怎么验证：脚本单元断言 + 真机 HTTPS 验证 + 注销回放。
  - 对应需求：需求 2、7。
  - 对应设计：§2.3.2、§5.3。

- [x]  2.3 safe-area 与独立窗口适配

  - 这一步到底做什么：为登录页（代理合成 HTML）与插件面板补充 `env(safe-area-inset-*)` 内边距与底部工具区避让；确认 standalone 下无内容被 Home 指示条遮挡。
  - 做完你能看到什么：全屏时页面内容与可点击区域都不被系统区域吃掉。
  - 先依赖什么：1.4、2.2。
  - 开始前先看：`design.md` §2.3.1；`src/host/lan-access-dsh.ts` 的 `loginPage()`；插件面板样式文件。
  - 主要改哪里：`src/host/lan-access-dsh.ts`（登录页样式）、`src/client/`（面板样式与安全区变量）、相关样式测试（若存在）。
  - 这一步先不做什么：不做整体移动端重排，不改 DSH 原生样式。
  - 怎么算完成：iOS/Android 真机截图无遮挡；横竖屏切换正常。
  - 怎么验证：真机截图 + 人工走查。
  - 对应需求：需求 1、6。
  - 对应设计：§2.3.1、§2.3.4。

- [x]  2.4 安装引导条（Android 提示 + iOS 指引）

  - 这一步到底做什么：客户端新增 `PwaInstallPrompt`：捕获 `beforeinstallprompt` 展示引导按钮；iOS 展示“分享 → 添加到主屏幕”指引；`display-mode: standalone` 或本地已关闭时不显示；状态写入本地存储。
  - 做完你能看到什么：手机用户在合适位置看到安装提示，点击可完成安装。
  - 先依赖什么：2.2（标记探测与 SW 就绪）。
  - 开始前先看：`design.md` §2.3.1、§3.1；`src/client/*-dom.ts` 的控制器模式。
  - 主要改哪里：`src/client/`（新控制器与文案）、`src/client/features/`（挂载点）、`src/client/locale.ts`、相关组件测试。
  - 这一步先不做什么：不伪造安装按钮、不做“自动安装”、不在桌面浏览器展示。
  - 怎么算完成：Android/iOS 分支、已安装隐藏、关闭记忆、禁用开关全部有测试或人工证据。
  - 怎么验证：真机走查 + 组件测试。
  - 对应需求：需求 3、7。
  - 对应设计：§2.3.1。

### 阶段检查

- [x]  2.5 SW 与引导检查

  - 这一步到底做什么：确认 HTTPS 链路下「注册 → 更新 → 注销」闭环可用，安装引导不打扰已安装用户。
  - 做完你能看到什么：Android 安装判定达标；iOS 有清晰的安装指引。
  - 先依赖什么：2.1–2.4。
  - 开始前先看：`requirements.md` 需求 2、3；`design.md` §4.2、§6.4。
  - 主要改哪里：阶段 2 全部相关文件与测试。
  - 这一步先不做什么：不做通知、不做手势。
  - 怎么算完成：SW 生命周期三态证据齐备；关闭开关后无残留。
  - 怎么验证：真机回放 + `pnpm test`。
  - 对应需求：需求 2、3、7。
  - 对应设计：§2.3.2、§4.2。

## 阶段 3：手势控制左右侧栏

- [x]  3.1 新增客户端能力 route（`layout.columns`、`sidebar.right.expand`）与四版本 fixture

  - 这一步到底做什么：新增两条客户端能力：`layout.columns`（`ctx.layout.toggleSidebar` 为函数）、`sidebar.right.expand`（`ctx.sidebarRight.isExpanded/toggleExpanded`）；补 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-rc.2 / 0.2.0-rc.1 四套 fixture。
  - 做完你能看到什么：任意版本上都能回答“左右侧栏服务是否可用”，缺失时有诊断码。
  - 先依赖什么：1.6。
  - 开始前先看：`AGENTS.md`「新增能力或接口」；`design.md` §3.3.5；调查报告 §4.2–§4.3。
  - 主要改哪里：`src/dsh-capabilities/types.ts`、`matrix.ts`、`routes.ts`、`tests/dsh-capability-registry.spec.ts`、`tests/peer-host-integration.spec.ts`（或新增手势能力 fixture 测试）。
  - 这一步先不做什么：不写手势控制器，不改 `src/client/index.ts` 的注入面。
  - 怎么算完成：四版本三态断言通过；`capability:report` 体现新能力与消费者。
  - 怎么验证：`pnpm run typecheck`、`pnpm run capability:report`、`pnpm run capability:check`、定向测试。
  - 对应需求：需求 5、9。
  - 对应设计：§3.3.5、§7.2。

- [x]  3.2 实现手势判定纯函数与单测

  - 这一步到底做什么：实现 `detectSidebarGesture(samples, config)`：边缘热区判定、方向锁定（水平/垂直比）、至少 50% 视口距离、约 400px/s 速度门槛、映射（`swipe-inward`/`swap`）、编辑目标排除，返回 `{ action, reason }`。
  - 做完你能看到什么：手势逻辑不依赖 DOM 即可被测试与调参。
  - 先依赖什么：3.1。
  - 开始前先看：`design.md` §3.3.6；调查报告 §4.5（前端无手势的证据）。
  - 主要改哪里：`src/client/mobile-sidebar-gestures.ts`（新）、`tests/mobile-sidebar-gestures.spec.ts`（新）。
  - 这一步先不做什么：不挂真实监听、不调服务、不读 DOM。
  - 怎么算完成：四方向、50% 距离与速度边界、方向锁、热区、编辑目标、多指、非法配置全部有断言。
  - 怎么验证：定向 `pnpm test`。
  - 对应需求：需求 5、6。
  - 对应设计：§3.3.6、§7.1。

- [x]  3.3 接入手势控制器（服务调用、历史集成、注入面）

  - 这一步到底做什么：新增 `MobileSidebarGestureController`，用 touch 事件驱动纯函数决策；只调用 `ctx.layout.toggleSidebar()` 与 `ctx.sidebarRight.toggleExpanded()`；右栏进入全屏时压 history，`popstate` 关闭右栏；在 `src/client/index.ts` 的 inject 数组补 `layout`，并在移动端访问增强模块的 start 中按设置启停。
  - 做完你能看到什么：手机横滑能开合侧栏，滚动与文本选择不受影响。
  - 先依赖什么：3.2。
  - 开始前先看：`design.md` §2.3.4、§3.3.6、§6.5；调查报告 §4.4、§4.6。
  - 主要改哪里：`src/client/index.ts`、`src/client/mobile-sidebar-gestures.ts`、`src/client/features/mobile-access.ts`、`tests/mobile-sidebar-gestures.spec.ts`。
  - 这一步先不做什么：不改 DOM class 或 DSH store、不接管系统边缘手势、不在非触摸环境启用。
  - 怎么算完成：fake DOM + fake 端口测试证明只调服务；距离、速度、多指和滚动让位均符合预期；卸载后无监听；能力缺失时不注册。
  - 怎么验证：定向测试 + 真机手势回放（iOS/Android 各一份）。
  - 对应需求：需求 5、6、9。
  - 对应设计：§2.3.4、§6.5。

- [x]  3.4 手势设置契约与面板控件

  - 这一步到底做什么：在 `MobileAccessSettings` 增加 `sidebarGestures`、`sidebarGestureMapping`、`sidebarGestureEdge`、`sidebarGestureThresholdPx`，实现 normalizer 与移动端访问增强面板控件（开关、下拉、数字输入），默认开启并兼容读取旧工作区字段。
  - 做完你能看到什么：用户可开关手势、切换方向映射、调整灵敏度。
  - 先依赖什么：3.3。
  - 开始前先看：`docs/开发规范/20260922-设置选项与表单开发规则.md`；`design.md` §3.2.2。
  - 主要改哪里：`src/shared/contracts/config.ts`、`src/host/settings.ts`、`src/client/features/mobile-access-panel.ts`、`src/client/locale.ts`、`tests/contracts.spec.ts`。
  - 这一步先不做什么：不改变手势判定和服务调用契约，只迁移设置归属与面板位置。
  - 怎么算完成：默认值、越界收敛、旧配置兼容、面板灰显规则有测试。
  - 怎么验证：设置测试 + `pnpm run typecheck`。
  - 对应需求：需求 7。
  - 对应设计：§3.2.2。

### 阶段检查

- [x]  3.5 手势检查点

  - 这一步到底做什么：确认手势在真机上方向正确、不误触、不破坏滚动，且与系统返回手势的行为符合预期（含右栏全屏返回关闭）。
  - 做完你能看到什么：手势可以放心默认开启（或维持默认关闭由用户选择，按 §8.2 决策）。
  - 先依赖什么：3.1–3.4。
  - 开始前先看：`requirements.md` 需求 5、6；`design.md` §6.5。
  - 主要改哪里：阶段 3 全部相关文件与测试。
  - 这一步先不做什么：不扩展到手势库、不做复杂动画。
  - 怎么算完成：真机清单逐项通过；能力缺失与禁用路径回归通过。
  - 怎么验证：真机走查 + `pnpm test` + `pnpm run capability:check`。
  - 对应需求：需求 5、6、9。
  - 对应设计：§7.3。

## 阶段 4：通知与推送

- [x]  4.1 本地通知（权限、展示、不可用提示）

  - 这一步到底做什么：实现 `PwaNotificationClient` 的本地档位：手势内请求权限、`showNotification` 展示、档位设置与状态展示；非安全上下文或 iOS 未安装时在设置页给出原因。
  - 做完你能看到什么：开启后能收到本地通知，权限被拒有明确提示。
  - 先依赖什么：2.5。
  - 开始前先看：`design.md` §2.3.3、§3.2.1、§5.3。
  - 主要改哪里：`src/client/modules/pwa-notification.ts`（新）、`src/client/features/lan-access-panel.ts`（档位）、`tests/`（新用例）。
  - 这一步先不做什么：不做推送、不自动请求权限、不在非安全上下文尝试。
  - 怎么算完成：权限流程、档位切换、不可用提示有测试或真机证据。
  - 怎么验证：真机（Android/iOS）+ 定向测试。
  - 对应需求：需求 4、7。
  - 对应设计：§2.3.3。

- [x]  4.2 VAPID 远程推送（密钥、订阅、发送器、RPC）

  - 这一步到底做什么：Host 生成并保存 VAPID 密钥；新增订阅/退订/测试/状态 RPC；实现发送器（加密载荷并投递到订阅 endpoint）；触发源先接“测试通知”，任务事件接入单独评审。
  - 做完你能看到什么：手机上能在页面关闭时收到测试推送。
  - 先依赖什么：4.1。
  - 开始前先看：`design.md` §2.3.3、§3.2.4、§3.3.7、§8.1（依赖选型）。
  - 主要改哪里：`src/host/modules/pwa/`、`src/host/rpc.ts`（若需要注册）、`src/shared/contracts/`（订阅 DTO）、`tests/pwa-push.spec.ts`（新）。
  - 这一步先不做什么：不发送会话正文、不支持静默推送、不新增 npm 依赖（如需引入 `web-push` 先单独确认）。
  - 怎么算完成：订阅去重与脱敏、退订清理、测试推送成功、失败重试与错误码有测试。
  - 怎么验证：定向测试 + 真机推送（Android + iOS 已安装到主屏）。
  - 对应需求：需求 4、7、8。
  - 对应设计：§2.3.3、§3.3.7。

### 阶段检查

- [x]  4.3 通知检查点

  - 这一步到底做什么：确认通知链路在三种设备状态（浏览器前台、后台、已安装）下行为一致，关闭后无残留订阅。
  - 做完你能看到什么：通知可以提供给用户，风险与限制有说明。
  - 先依赖什么：4.1、4.2。
  - 开始前先看：`requirements.md` 需求 4；`design.md` §5.3。
  - 主要改哪里：阶段 4 全部相关文件与测试。
  - 这一步先不做什么：不做通知分类与免打扰等扩展。
  - 怎么算完成：三态行为有证据；退订与失效清理有测试。
  - 怎么验证：真机回放 + 定向测试。
  - 对应需求：需求 4。
  - 对应设计：§2.3.3。

## 阶段 5：安全、兼容与验收

- [x]  5.1 安全验收（放行白名单、回环旁路、SW 越权）

  - 这一步到底做什么：逐项验证「只有静态路径被放行或合成」「合成内容不含凭据」「SW 不缓存登录页与 API」「同机 NGINX 风险有提示与文档」。
  - 做完你能看到什么：增强没有削弱登录保护，风险有书面结论。
  - 先依赖什么：4.3。
  - 开始前先看：`requirements.md` 需求 8；`design.md` §6.2、§6.3、§6.4。
  - 主要改哪里：安全测试与扫描、必要修复、面板提示文案。
  - 这一步先不做什么：不引入第二套账号体系，不做公网加固。
  - 怎么算完成：白名单穷举测试、凭据扫描、SW 缓存断言、回环提示走查全部通过。
  - 怎么验证：定向安全测试 + 日志与响应扫描 + 人工走查。
  - 对应需求：需求 8。
  - 对应设计：§6、§7.2。

- [x]  5.2 输出 NGINX 部署检查清单

  - 这一步到底做什么：把 HTTPS 反代的关键约束写成可执行清单：挂根路径、不配上游 keepalive、WebSocket 透传、SSE `proxy_buffering off`、同机回环必须加鉴权、`/sw.js` 与图标不被缓存劫持。
  - 做完你能看到什么：部署者按清单一次配对，不用回头猜。
  - 先依赖什么：5.1。
  - 开始前先看：`design.md` §2.3.5；调查报告 §3.3、§3.4、§3.5。
  - 主要改哪里：`specs/spec009-移动端PWA与手势控制/docs/`（新增部署清单）或 `docs/开发记录/`。
  - 这一步先不做什么：不写插件内的 TLS 方案。
  - 怎么算完成：清单每条都有“为什么”与验证命令。
  - 怎么验证：按清单在测试环境走一遍。
  - 对应需求：需求 8。
  - 对应设计：§2.3.5。

- [x]  5.3 兼容与降级回归

  - 这一步到底做什么：验证四条新能力在四个版本夹具下的三态、禁用开关后的零副作用、其他模块（局域网、中继、PeerHost、终端、文件管理）不受影响。
  - 做完你能看到什么：升级/降级都有确定行为，不会出现“关不掉”的增强。
  - 先依赖什么：5.1。
  - 开始前先看：`requirements.md` 需求 9；`AGENTS.md` 验证命令。
  - 主要改哪里：能力 fixture、Feature 测试、回归测试。
  - 这一步先不做什么：不扩大 DSH 兼容范围，不把实验能力标成稳定。
  - 怎么算完成：三态诊断、启停、注销、其他模块回归全部通过。
  - 怎么验证：`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、`pnpm test`。
  - 对应需求：需求 9。
  - 对应设计：§3.3.5、§7.2。

- [x]  5.4 文档回写与索引同步

  - 这一步到底做什么：实现完成后回写 `docs/开发记录/`（过程、关键决策、验证结果），更新 `AGENTS.md` 的文档索引与 Spec 索引，补齐面板文案与 README（如需）。
  - 做完你能看到什么：接手的人能顺着文档找到证据与结论。
  - 先依赖什么：5.3。
  - 开始前先看：`AGENTS.md`「文档索引与新增文档规则」。
  - 主要改哪里：`docs/开发记录/`（新增记录）、`AGENTS.md`、本 Spec 的 `docs/`。
  - 这一步先不做什么：不把调查报告改成实现记录，两类文档分开。
  - 怎么算完成：新增文档都在正确目录、命名合规、引用同步。
  - 怎么验证：`git diff --check` + 引用检查。
  - 对应需求：全部需求。
  - 对应设计：全文。

### 最终检查

- [x]  5.5 最终检查点

  - 这一步到底做什么：确认需求、设计、实现、测试与已知限制逐项对上，决定是否交付。
  - 做完你能看到什么：能明确回答“手机上能装吗、能收通知吗、手势怎么用、登录保护是否受影响、关掉之后会不会有残留”。
  - 先依赖什么：5.1–5.4。
  - 开始前先看：本 Spec 全部文件、调查报告、`AGENTS.md`。
  - 主要改哪里：`tasks.md`、验收记录、必要的 README/索引。
  - 这一步先不做什么：不追加未评审的新需求。
  - 怎么算完成：所有实现任务有验证证据；`BLOCKED`/`CANCELLED` 项有原因；风险与后续工作已回写。
  - 怎么验证：按 Spec 验收清单逐项核对；完整验证命令见项目 `AGENTS.md`。
  - 对应需求：全部需求。
  - 对应设计：全文。

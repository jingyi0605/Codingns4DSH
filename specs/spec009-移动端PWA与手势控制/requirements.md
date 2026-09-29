# 需求文档 - 移动端 PWA 与手势控制

状态：规划完成，待实施。

## 简介

用户希望手机访问 DSH Web 时像一个正常移动应用：能“添加到主屏幕”并以独立窗口全屏使用、能收通知、能用横滑手势开合左右侧栏。当前插件只提供“把 DSH Web 映射到局域网”这一层能力，页面仍是浏览器里的桌面版：iOS 没有独立窗口元数据，Android 没有达标图标与 Service Worker，没有通知，也没有任何手势。

本需求定义三件事，由插件在现有 `lan-access-dsh` 代理与客户端注入层内完成：

1. **PWA 资产层**：在局域网代理上合成/覆盖 manifest、图标与 Service Worker，并在启动页注入 apple 元数据与视口参数。
2. **通知层**：先做本地通知，再做 VAPID 远程推送（Host 侧保存订阅并发送）。
3. **手势层**：移动端横滑开合左侧会话列表与右边栏，全部通过 DSH 官方客户端服务完成。

硬前置条件：Service Worker、Push、Android 安装判定都要求**安全上下文**，即通过 NGINX（或等价反代）以 HTTPS 访问；HTTP 局域网直连时这些能力自动关闭，其余能力（iOS A2HS 所需元数据、图标、手势）仍然可用。

## 术语表

- **System**：本插件（Codingns4DSH）在 DSH Host 与浏览器中注入运行的功能集合。
- **局域网代理**：`src/host/lan-access-dsh.ts` 中的 TCP 转发与登录保护层，把手机请求转发到 DSH Web。
- **安全上下文（Secure Context）**：浏览器认定的可信来源，HTTPS 或 localhost；Service Worker / Push / Android 安装判定的前提。
- **PWA 资产**：`/manifest.webmanifest`、PNG 图标、`apple-touch-icon`、`/sw.js` 等由插件合成的静态响应。
- **注入行（Index Injection Row）**：通过 `webserver/index-inject` 事件追加到启动页的行，支持 `global/script/script-src/script-preload/style/html` 六种。
- **tapIndex**：WebServer 提供的原始 HTML 变换逃生口，在结构化注入行渲染之后执行。
- **左栏**：DSH 三栏布局中的会话列表列（`ctx.layout.toggleSidebar()`）。
- **右边栏**：会话右侧面板列（`ctx.sidebarRight.toggleExpanded()` / `toggleFullscreen()`）。
- **手势控制器**：插件新增的客户端模块，把触摸横滑翻译为侧栏开关服务调用。
- **安装引导**：提示用户完成“添加到主屏幕”的界面元素；浏览器不允许自动安装。
- **standalone / 独立窗口**：从主屏图标启动、无浏览器地址栏的显示模式。

## 范围说明

### In Scope

- 代理合成 PWA 资产：manifest 覆盖、PNG 图标（192/512/maskable）、`apple-touch-icon`、Service Worker。
- 启动页注入：`theme-color`、apple 移动端元数据、SW 注册脚本；`tapIndex` 改写 viewport。
- Service Worker 生命周期：版本化、更新、注销逃生口、缓存安全边界。
- 安装引导（Android 提示 + iOS 手动指引）。
- 通知：本地通知与 VAPID 远程推送（含订阅存储与发送器）。
- 手势：横滑开合左右侧栏，含方向、边缘避让、阈值与降级。
- 设置与面板、能力登记与三版本 fixture、测试与文档。

### Out of Scope

- 修改 DSH Host、DSH 前端 bundle、上游 manifest 源文件。
- 在插件内做 TLS 终结或证书管理（由 NGINX 承担）。
- “自动安装”与绕过浏览器权限提示的能力。
- iOS 振动（平台无 API）。
- 离线缓存与离线可用性（SW 只保留通知与最小运行时能力）。
- 公网域名/证书/防火墙方案本身，只提供部署检查清单。

## 需求

### 需求 1：PWA 静态资产与安装元数据

**用户故事：** 作为手机用户，我希望把 DSH Web 添加到主屏幕后拥有正确的名称、图标与独立窗口，以便像应用一样使用。

#### 验收标准

1. WHEN 手机通过局域网代理请求 `GET /manifest.webmanifest` THEN System SHALL 返回插件合成的 manifest：保留上游 `start_url: "./"`、`scope: "./"`，将 `display` 覆盖为 `standalone`，补齐 `name`、`short_name`、`theme_color`、`background_color` 与 PNG 图标（至少 192×192 与 512×512，含 `purpose: maskable`）。
2. WHEN manifest 引用图标 THEN System SHALL 从包内静态资产（`assets/pwa/`）提供它们，且这些请求不因登录保护返回 401。
3. WHEN 启动页被渲染 THEN System SHALL 注入 `theme-color`、`apple-mobile-web-app-capable`、`apple-mobile-web-app-status-bar-style` 与 `apple-touch-icon`（180×180 PNG）。
4. WHEN 启动页被渲染 THEN System SHALL 把 `<meta name="viewport">` 改写为包含 `viewport-fit=cover`，且不重复插入第二个 viewport meta。
5. WHEN 用户从本机 127.0.0.1 或中继入口访问 THEN System SHALL 不改变这些入口的 manifest 与页面元数据行为（资产只作用于代理入口）。

### 需求 2：Service Worker 与安全上下文

**用户故事：** 作为手机用户，我希望在 HTTPS 下安装的 DSH Web 能注册 Service Worker 以支撑通知与安装判定，同时在 HTTP 下不产生报错。

#### 验收标准

1. WHEN 页面处于安全上下文且设置启用 SW THEN System SHALL 从同源根路径 `/sw.js` 注册 Service Worker，且该请求不因登录保护返回登录页。
2. WHEN 页面不是安全上下文 THEN System SHALL 不注册 SW 且控制台无未捕获异常。
3. WHEN SW 脚本更新 THEN System SHALL 通过版本化脚本内容使浏览器更新（`no-cache`/内容变化），并提供显式注销入口（面板按钮或 RPC）。
4. WHEN SW 处理 fetch THEN System SHALL 不缓存登录页、`/__codingns/*` 路径与 `/api/*` 响应；只允许缓存显式白名单的静态资产。
5. WHEN 用户在设置中关闭 SW THEN System SHALL 停止注册并注销已注册的 SW，且清空插件创建的缓存。

### 需求 3：安装引导

**用户故事：** 作为手机用户，我希望在合适的时机被提示“添加到主屏幕”，但不要被反复打扰。

#### 验收标准

1. WHEN 页面在 Android Chrome 触发 `beforeinstallprompt` THEN System SHALL 捕获事件并展示自定义安装引导条，点击后调用浏览器安装提示。
2. WHEN 页面在 iOS（无安装 API）THEN System SHALL 展示“分享 → 添加到主屏幕”的图文指引，不伪造安装按钮。
3. WHEN 页面已处于 `display-mode: standalone` THEN System SHALL 不展示任何安装引导。
4. WHEN 用户关闭引导 THEN System SHALL 在本地记住关闭状态，不再对同一设备重复展示（除非用户手动清除）。

### 需求 4：通知与远程推送

**用户故事：** 作为插件用户，我希望任务结束或需要我处理时能在手机上收到通知，以便不用盯着页面。

#### 验收标准

1. WHEN 用户开启本地通知且浏览器已授权 THEN System SHALL 通过 `Notification` 或 SW `showNotification` 展示通知，且权限请求只在用户手势中发起。
2. WHEN 通知能力不可用（非安全上下文 / 未安装到主屏的 iOS / 无权限）THEN System SHALL 在设置里显示不可用原因，不静默失败。
3. WHEN 用户开启远程推送 THEN System SHALL 生成/保存 Host 侧 VAPID 密钥、存储浏览器订阅，并在事件触发时向推送服务发送载荷。
4. WHEN 推送载荷到达 iOS THEN System SHALL 以必须展示的通知形式发出（iOS 不支持静默推送）；载荷不得包含会话正文、凭据或绝对路径。
5. WHEN 用户关闭推送 THEN System SHALL 删除 Host 侧订阅并在浏览器端退订。

### 需求 5：手势开合左右侧栏

**用户故事：** 作为手机用户，我希望用横滑手势开关左侧会话列表和右边栏，而不是去找小小的按钮。

#### 验收标准

1. WHEN 用户在允许区域内水平滑动超过阈值 THEN System SHALL 调用 `ctx.layout.toggleSidebar()`（左栏）或 `ctx.sidebarRight.toggleExpanded()`（右边栏）。
2. WHEN 手势控制器判定动作 THEN System SHALL 只通过上述服务改变布局，不直接修改 DOM class 或其他插件的状态。
3. WHEN 手势需要感知当前状态（例如“收起时才展开”） THEN System SHALL 通过能力层封装的读取方式（左栏读 `data-sidebar-collapsed`，右栏用 `isExpanded()`）获取，读取失败时退化为无条件切换或禁用。
4. WHEN 判定逻辑被执行 THEN System SHALL 是纯函数（输入触点样本与配置，输出动作或忽略），可被单元测试直接覆盖。
5. WHEN `ctx.layout` 或 `ctx.sidebarRight` 能力缺失 THEN System SHALL 不注册手势监听，并在能力诊断中给出原因；其他功能不受影响。

### 需求 6：与系统手势共存

**用户故事：** 作为用户，我希望自定义手势不与手机系统的返回手势打架，也不会让页面滚动失灵。

#### 验收标准

1. WHEN 触点起始位置落在系统边缘热区 THEN System SHALL（默认配置下）不接管该手势，交给系统处理。
2. WHEN 手势进行中 THEN System SHALL 依据方向锁定（水平位移显著大于垂直位移）才接管，并避免破坏列表滚动与文本选择。
3. WHEN 右边栏以全屏方式打开 THEN System SHALL 让系统返回手势表现为“关闭右栏”而不是离开会话（历史记录集成；不可行时如实降级并提示）。
4. WHEN 手势被取消或未达阈值 THEN System SHALL 恢复默认行为，不留下残余状态。

### 需求 7：设置与界面

**用户故事：** 作为插件用户，我希望所有新行为都能在设置页开关与调节，默认值保守。

#### 验收标准

1. WHEN 用户在设置页查看“局域网访问 DSH”卡片 THEN System SHALL 提供 PWA 资产开关、Service Worker 开关、安装引导开关与通知档位，未启用时灰显且不可操作。
2. WHEN 用户在“工作区会话增强”卡片 THEN System SHALL 提供手势开关、方向映射、边缘模式与阈值（带范围校验与默认值）。
3. WHEN 设置字段缺失或越界 THEN System SHALL 按默认值回填并收敛到允许范围（沿用现有 normalizer 模式）。
4. WHEN 设置变更 THEN System SHALL 立即生效（无需重启），且不因反复读写产生设置循环。
5. WHEN 功能未启用 THEN System SHALL 保证零副作用：不注册 SW、不注入引导、不挂手势监听。

### 需求 8：代理与注入的安全边界

**用户故事：** 作为部署者，我希望这些增强不会削弱登录保护，也不会把凭据带到页面里。

#### 验收标准

1. WHEN 代理放行或合成 PWA 资产 THEN System SHALL 只放行静态、无凭据的路径（manifest、SW 脚本、图标），其余请求仍走登录校验。
2. WHEN 合成响应 THEN System SHALL 不包含 Cookie、Token、环境变量或绝对路径。
3. WHEN NGINX 与本机同址反代到回环地址 THEN System SHALL 在设置面板与文档中提示“登录保护对该链路失效”，建议在 NGINX 侧鉴权。
4. WHEN 注入内容进入启动页 THEN System SHALL 只注入静态文本与同源脚本引用，不注入任何凭据。
5. WHEN 代理运行 THEN System SHALL 保持“响应侧不解析、原样回传”的不变式；任何新响应都来自请求侧合成。

### 需求 9：能力注册与降级兼容

**用户故事：** 作为现有插件用户，我希望在 DSH 版本或服务缺失时这些增强安全关闭，两个入口（本机/中继）行为不受影响。

#### 验收标准

1. WHEN 新增的宿主能力（`web.index-inject`、`web.index-tap`）或客户端能力（`layout.columns`、`sidebar.right.expand`）可用 THEN System SHALL 通过能力矩阵返回 `ready` 并启用对应增强。
2. WHEN 能力缺失或版本不支持 THEN System SHALL 返回 `unavailable`/`degraded` 与诊断码，并按“注入跳过 / 手势关闭 / 通知关闭”降级，不影响其他模块。
3. WHEN 版本升级 THEN System SHALL 只改能力矩阵 route 与 fixture，不在业务模块写版本 `if`。
4. WHEN 运行 `pnpm run capability:report` THEN System SHALL 在报告中包含新增能力与消费者清单。

## 非功能需求

### 非功能需求 1：性能

1. WHEN 合成 PWA 资产 THEN System SHALL 只返回静态字节（图标单文件不超过 64KB），不产生额外上游请求。
2. WHEN 手势监听 THEN System SHALL 只在首次触摸时启动判定，空闲时无定时器、无高频事件处理。
3. WHEN 注入脚本 THEN System SHALL 体积受控（注册脚本不超过 2KB），不阻塞首屏渲染。

### 非功能需求 2：可靠性

1. WHEN 注入表异常或资产缺失 THEN System SHALL 记录诊断并跳过该注入，启动页与登录流程保持可用。
2. WHEN SW 注册失败 THEN System SHALL 静默降级（不影响页面功能），并在设置中可见原因。
3. WHEN 用户注销 SW 或卸载插件 THEN System SHALL 不遗留会导致页面无法加载的缓存或拦截规则。

### 非功能需求 3：可维护性

1. WHEN 新增一个 PWA 资产或注入行 THEN System SHALL 只改资产表/注入表一处，不扩散到设置页与代理主流程。
2. WHEN 排查问题 THEN System SHALL 能用稳定诊断码区分“能力缺失”“非安全上下文”“未登录”“资产缺失”四类原因。
3. WHEN 新增设置项 THEN System SHALL 按 `docs/开发规范/20260922-设置选项与表单开发规则.md` 登记契约、面板与测试。

## 成功定义

- iOS：通过 HTTPS（或 HTTP 局域网）添加主屏后，以独立窗口全屏打开，图标与名称正确，内容避开刘海与 Home 指示条。
- Android：HTTPS 下满足安装判定，可安装为 PWA；已安装后不再显示安装引导。
- 通知：开启后能收到本地通知；配置 VAPID 后能收到任务完成推送（iOS 已安装到主屏）。
- 手势：手机横滑能开合会话列表与右边栏，纵向滚动与文本选择不受影响，系统返回手势行为可预期。
- 安全：PWA 相关请求之外仍强制登录；合成内容与注入内容不含凭据；同机 NGINX 的风险有明确提示与文档。
- 工程：`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、`pnpm test` 全部通过；新增能力覆盖 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-rc.2 / 0.2.0-rc.1 夹具；不改 DSH Host 与前端源文件。

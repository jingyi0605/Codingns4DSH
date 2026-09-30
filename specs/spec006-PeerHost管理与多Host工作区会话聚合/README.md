# spec006：PeerHost 管理与多 Host 工作区会话聚合

状态：阶段 1 至阶段 5 已完成；PeerHost 管理入口已集成到统一用户账户菜单，新增/登录支持本地保护账号或中转账号自动识别；原阶段 6 的 DOM/适配器实现保留为验证与降级路径；阶段 6A.0、6A.1、6A.2、6A.3（原生列表投影子集）、6A.6 已完成，本轮已装配 Host 摘要 source、AggregatedHostTransport、虚拟顺序 RPC、单插件 preboot shim 和原生列表 Store facade；6A.4、6A.5、6A.7 仍受 DSH 原生 Session binding/Conversation Remote 协议缺口限制，阶段 6B 仅保留协议验证和降级实现；阶段 7.1 仍阻塞，阶段 7.2 进行中，阶段 8 等待原生会话聚合验收。

## 这份 Spec 解决什么问题

当前 `codingns4dsh` 已经具备局域网访问和中转访问能力，但这两种能力只解决“访问当前 DSH Host”。用户无法在一个 DSH 工作区里管理其他已经安装本插件的 DSH Host，也无法把不同 Host 的工作区、会话、消息记录、聊天输入和右侧工具结果放在同一个工作流中使用。

本 Spec 增加一个独立的“管理其他 DSH Host”模块。最终目标不是把远端资源伪装成当前 Host 的 DOM，而是让本地 DSH Web 和本地 CodingNS 插件继续作为唯一 UI/Bundle 来源，由 Aggregated Host 将本地与多个 PeerHost 的资源路由到统一的 DSH 原生 Client Store。模块启用后：

- 用户账户菜单中出现“管理 PeerHost”入口，按需打开连接管理面板。
- 用户可以添加局域网地址或中转入口对应的 PeerHost。
- 当前 Host 负责保存目标 Host 配置、检查兼容性、代管目标登录态和执行受控代理。
- DSH Web 只连接一个 Aggregated Host；原生 Workspace、Session、Conversation、终端和右侧栏仍由本地 DSH Client 渲染。
- Aggregated Host 合并当前 Host 和 PeerHost 的工作区、会话、消息及工具数据，并为资源生成带 Host 命名空间的虚拟 ID。
- 本地 CodingNS 插件状态决定 UI、适配器入口和右侧标签页；远端 Host 只提供执行能力和能力状态，不合并远端插件 Bundle。
- 打开远端会话后，中栏消息、聊天输入、实时事件和右侧栏请求通过虚拟 ID 路由到对应 DSH Host。

## 设计原则

1. PeerHost 是 Aggregated Host 的远端执行后端，不把远端 Workspace 复制成本地 Workspace。
2. Client 只提交 `targetHostId`，不保存目标 Host 的 access token 或 refresh token。
3. 所有跨 Host 资源都必须使用 `hostId + workspaceId + sessionId` 作用域。
4. 代理只允许明确登记的 DSH API、WebSocket 消息和目标 Host，禁止任意 URL 转发。
5. 局域网直连先落地；中转 Host 连接单独验证，不能假设浏览器侧中转 Transport 可以直接复用到 Node Host。
6. DOM 注入和 Remote Web Context 只能作为验证或降级路径；最终验收必须通过 Aggregated Host 让 DSH 原生 Store 直接消费统一数据面。
7. 所有 Client Bundle、插件状态和 UI Slot 以当前 Host 为准；远端独有插件不进入聚合范围。

## 阅读顺序

1. `requirements.md`：用户可见行为、边界和验收标准。
2. `design.md`：Host/Client 架构、数据结构、代理、作用域和 UI 路由。
3. `docs/20260927-父仓库PeerHost实现对照与本项目边界.md`：父仓库实现可复用的逻辑及本项目差异。
4. `tasks.md`：按阶段执行的任务清单。每个任务完成后必须立即回写状态和验证证据。

## 与现有 Spec 的关系

- 依赖 `spec005-DSH能力注册与版本路由机制` 提供的能力矩阵和 Feature 能力声明。
- 复用 `spec001`、`spec002` 已定义的 Transport、HostScope、generation 和远程 Web 运行时边界。
- 不把父仓库 CodingNS 作为源码依赖；父仓库只作为行为和安全边界参考。
- 不改变当前单 Host 登录、局域网访问和中转访问的既有行为。

## 当前实现边界（2026-09-29）

### 架构决策（2026-09-29）

- “当前 Host UI + 多个 PeerHost 数据源”确定为目标架构；不再把 DOM 注入的导航或会话节点视为原生集成。
- 原生聚合采用单插件自包含路线：CodingNS 内置 DSH `0.2.0-rc.1` preboot shim，并在原生服务已经创建后包装其公开列表 Store；不要求用户安装额外补丁包，也不把等待上游契约作为实现前置条件。
- CodingNS 是用户唯一需要安装的聚合插件；本 Spec 不引入独立 Patch Engine、PeerHost Runtime 或 Store 插件，也不通过安装脚本修改 DSH 安装目录。
- 本 Spec 不扩展通用模块替换 Patch Engine，不替换 DSH 原生 Workspace/Session Controller；`dsh.bundle.patch` 只用于现有配置 entry 调整和 CodingNS entry 注册。
- 新增 Aggregated Host 边界：它负责虚拟 Workspace/Session Registry、Host 命名空间、请求/事件路由、混合排序持久化和能力聚合。
- 本地 DSH Client 和 CodingNS Client Bundle 是唯一 UI 来源；远端 PeerHost 只提供工作区、会话、对话、适配器、文件、Git、终端和右侧工具的 Host 能力。
- 本地插件可以渲染远端会话和工具，但每个目标 Host 的实际适配器能力仍必须通过握手/能力摘要确认；不支持的能力返回结构化 `unsupported`。
- 自绘 DOM 适配器（`peer-host-native-session-ui.ts`、`host-navigation.ts`）与列表 Store facade（`peer-host-native-store-adapter.ts`）已删除：虚拟工作区就地投影进原生 `workspaces.list`（`peer-host-native-store-projection.ts`），虚拟会话由页面 Transport 并入 `session/list` 并触发原生 `sessions.refresh()` 进入 SessionManager，两者都由原生侧栏与会话组件渲染；受控代理继续保留。

- 已实现 PeerHost 管理面板、Host 侧加密凭据存储、固定握手、HTTP/WS 正向白名单和局域网 Host-to-Host `/ws` connector。
- PeerHost 管理已复用统一用户账户菜单；添加/登录表单自动识别本地保护账号或中转账号，仅预填用户名，密码不读取、不持久化；中转路由后端未就绪时保持明确不可用。
- 已实现 `HostScope` 作用域校验、`scopeGeneration` 清理、聊天/停止/权限/问题回答命令、实时消息写入、文件/Git/终端/右侧工具的受控适配器，以及有限指数退避和重连后的 generation 重建。
- 当前聚合层只接受显式注入的稳定 workspace/session source。未注入时返回 `unsupported` 和中文诊断，不把空列表伪装成成功；远端摘要已由页面 Transport 投影进原生工作区 Store 与 `session/list` 通道。
- DSH 0.2.0-rc.1 已由 CodingNS 单插件内置并验证 preboot Transport shim；当前版本把聚合结果投影进原生 `workspaces.list`（就地改写 `getSnapshot`/`subscribe`）与 `session/list`（虚拟会话摘要与 cached 标题投影），并调用原生 `sessions.refresh()` 让虚拟会话进入 SessionManager，`sessions.retain()` 与远端 `session/follow` 已能串联；Host 侧 `peerHost/native`、`peerHost/nativeStream` 负责双向虚拟 ID 改写。页面 Transport 启动晚于 DSH UI 插件建立原生流，因此不能再依赖拦截 `workspace/follow`/`$events` 注入帧。目标侧原生调用已改走 DSH 自己的 `typertGateway`（按 descriptor 解包 `{args}` 并解析 lookup），会话流不再“开场游标前结束”；右侧 `workspaceFiles/*` 已纳入转发与 `workspaceFileScopeId` 身份改写，终端/Git 等其余命名空间仍在 6A.5/6A.7 验收中。
- 远端资源只经原生 Remote 帧进入原生 Store；页面流结构不符时跳过注入并保持本机数据可用，不再以 DOM 节点或列表 facade 冒充原生集成。
- Relay route 仅代表能力矩阵中的受控扩展点。Host-to-Host 工作台 JSON/WS Transport 尚未验证，所有中转 PeerHost 必须保持 `relay_unavailable/degraded`。
- 诊断只返回 PeerHost ID、路由类型、状态、稳定错误码、检查时间和脱敏 fingerprint；不向 Client 或日志写入 token、密码、relay ticket、完整 URL、文件内容、命令和模型正文。

详细证据见：[PeerHost 能力与中转边界调查](../../docs/调查报告/20260928-PeerHost能力与中转边界调查.md)、[PeerHost 聚合与断线重连实现记录](../../docs/开发记录/20260928-PeerHost聚合与断线重连实现记录.md)、[PeerHost 聚合 Host 与本地插件基线架构决策记录](../../docs/开发记录/20260929-PeerHost聚合Host与本地插件基线架构决策记录.md) 与 [DSH 原生 Remote 协议白名单与虚拟 ID 改写记录](../../docs/开发记录/20260929-DSH原生Remote协议白名单与虚拟ID改写记录.md)。

## 当前范围

本 Spec 覆盖：

- PeerHost 管理模块及设置页。
- 局域网和中转 PeerHost 地址模型。
- Host 握手、版本/API 兼容、插件存在性和 fingerprint 检查。
- 目标 Host 登录态的 Host 侧加密存储和刷新。
- 受控 HTTP/WS 代理。
- Host 作用域、聚合工作区/会话导航和 Host 标签。
- 远端会话中栏、聊天输入、实时流和右侧工具路由。
- 断线、版本变化、目标登录过期和作用域切换清理。
- Aggregated Host 的统一 Transport、虚拟 Workspace/Session Registry、本地插件能力路由和混合排序持久化。

明确不在本 Spec 内：

- 跨 Host 数据同步、复制、迁移和全局搜索。
- 任意 URL、任意 WebSocket 或任意第三方 Host 代理。
- PeerHost 的递归代理和代理链路发现。
- 把目标 Host 的插件 Bundle 安装到当前 DSH Profile。
- 合并或加载远端独有插件、远端 Plugin Manifest 和远端 UI Slot；所有 UI/插件状态以当前 Host 为准。
- 破坏当前 Host 切换、局域网访问和中转访问的现有语义。

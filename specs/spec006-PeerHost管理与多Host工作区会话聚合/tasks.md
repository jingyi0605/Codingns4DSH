# 任务清单 - PeerHost 管理与多 Host 工作区会话聚合

状态：阶段 1 至阶段 5 已完成；原阶段 6 的 HTTP/WS/DOM 适配保留为验证和降级实现；阶段 5.1、5.2 已完成账户菜单集成和自动凭据识别；阶段 6A.0、6A.1、6A.2、6A.3、6A.6 已完成，6A.4 已完成首个原生 Remote connector 子集，6A.5、6A.7 进行中；本轮已把普通 Remote、session/follow 流、虚拟 ID 路由和目标 Host DSH Controller 接通。阶段 7.1 阻塞、7.2 进行中，仍需真实 DSH Web 回放覆盖 Conversation 全生命周期。

## 2026-09-29 架构决策与下一步总览

### 2026-09-29 本轮装配结果

- `CodingNsHostServices.dshContext` 已向 PeerHost Feature 暴露当前 DSH Context；新增 `dsh-native-summary-source.ts`，通过结构探测读取 `workspaceRegistry` 和 `nativeSessions.listRemote()`，生成本地工作区/会话摘要。缺少稳定服务时返回 `unsupported`，不伪造空成功。
- `createPeerHostFeature()` 默认创建 `AggregatedHostTransportService`，聚合当前 Host 和已登录 PeerHost 的 `/api/workspaces`、`/api/sessions` 摘要；远端摘要仍受 HostScope、HTTP 白名单和 token 隔离保护。
- 新增 `peerHost/native` 固定 RPC 入口，只接受 `DSH_NATIVE_REMOTE_METHODS`，执行虚拟 ID 改写；目标 Host 没有原生 Remote connector 时明确返回 `unsupported`，不把旧 HTTP API 冒充成原生协议。
- Client PeerHost Feature 已将单插件 preboot shim 绑定到页面 fetch/RPC bridge，启用 PeerHost 后不再无条件停留在 `requires-reload`；页面 reload 仍是让 DSH 原生 Connection 在 boot 前首次读取 facade 的必要条件。
  - 2026-09-30 更正：Desktop 拓扑不再需要 reload。shim 用访问器在页面 Transport 赋值时就地接管，连接层分流挂在已建立的 Connection 上；Web 路径同样在启用后即时生效，"开→关→开"不需要刷新页面。只有"插件刚安装、当前页面 head 还没跑过 shim 脚本"才需要一次刷新，此时面板显示的是"未安装 preboot shim"而不是 `requires-reload`。
- 新增 `tests/dsh-native-summary-source.spec.ts`；定向 PeerHost/boot/shim/Registry 测试 20 项全部通过。完整测试唯一失败仍为受限环境不能绑定 `0.0.0.0` 的既有 Host relay 测试（`bind EPERM 0.0.0.0`）。
- 本轮新增页面端 `peerHost/native` 与 `peerHost/nativeStream` connector：虚拟 Workspace/Session ID 会解析为 HostScope，普通 Remote 通过目标 Host 的 DSH Controller 执行，`session/follow` 等流通过受控句柄轮询转发；已覆盖目标 Host 无 Controller、作用域不匹配、流结束和关闭路径。
- 当前仍未完成真实 DSH Web 三栏回放、`session/control` 投影与消息发送/权限回复的端到端浏览器证据；因此 6A.7 不能标记为完成，右侧栏完整能力仍以本地 CodingNS 插件为基线。

本 Spec 的最终目标调整为：本地 DSH Client 和本地 CodingNS Client Bundle 作为唯一 UI/插件基线，连接一个 Aggregated Host；Aggregated Host 将当前 Host 和多个 PeerHost 的 Workspace、Session、Conversation、适配器、文件、Git、终端和右侧工具能力映射到统一的虚拟数据面。远端独有插件 Bundle、Manifest、UI Slot 和设置不进入聚合范围。

剩余验收必须按以下顺序执行（6A.0、6A.1、6A.2、6A.6 已完成）：

1. **6A.3 原生列表接入**：已完成；由 CodingNS 单插件内置 shim 和 Store facade，让 DSH 原生 Workspace/Session 列表消费 Aggregated Host 数据。
2. **6A.4 原生 UI connector**：已完成 connector 子集；继续补齐 Conversation 的发送、停止、权限回复、历史分页和 `session/control` 投影的真实回放。
3. **6A.5 本地插件适配器路由**：以当前 Host 的 CodingNS UI/设置为准，将适配器、文件、Git、终端和工具请求按虚拟 ID 路由到目标 Host。
4. **6A.7 集成验收**：在当前 DSH 0.2.0-rc.1 fixture 和真实 DSH Web 回放中验证原生列表、消息流、工具链路和单 Host 兼容性。

旧阶段 6 的 DOM 导航和会话节点只用于能力探测、协议验证和降级展示；它们不能关闭 6A 任务，也不能作为发布验收证据。

## 2026-09-30 用户体验改造：显式添加远端工作区、彩色标签与一次性凭据

- 状态：`DONE`
- 目标：远端工作区默认不显示，改由原生"添加工作区"对话框新增的"远程 HOST"标签页显式登记；
  Host 归属改用可配色标签；凭据在编辑里一次性保存并自动连接，管理面板按钮精简为四项。
- 改动文件：
  - 契约：`src/shared/contracts/peer-host.ts`、`src/shared/index.ts`
  - Host：`src/host/modules/peer-host/peer-host-store.ts`、
    `src/host/modules/peer-host/peer-host-session.ts`、
    `src/host/modules/peer-host/peer-host-aggregate-service.ts`、
    `src/host/modules/peer-host/peer-host-remote-summary-source.ts`、
    `src/host/features/peer-host.ts`
  - Client：`src/client/peer-host-color.ts`（新增）、
    `src/client/peer-host-workspace-tag.ts`（新增）、
    `src/client/peer-host-workspace-tab.ts`（新增）、
    `src/client/peer-host-management-api.ts`、
    `src/client/peer-host-management-panel.ts`、
    `src/client/peer-host-native-projection.ts`、
    `src/client/features/peer-host.ts`
  - 测试：`tests/peer-host-workspace-tab.spec.ts`（新增 7 项）、
    `tests/peer-host-workspace-tag.spec.ts`（新增 7 项）、
    `tests/peer-host-edit-connect.spec.ts`（新增 7 项），
    并扩展 `peer-host-store`、`peer-host-session`、`peer-host-remote-summary-source`、
    `peer-host-management`、`peer-host-native-projection` 用例
- 关键决策：
  1. **不抢占 `sidebar.workspaces.directoryFlow` 插槽**。它是 `single` 插槽且 DSH 自带 browse 组件
     不可复用（包只导出 `apply`/`inject`），抢占等于自绘整个目录浏览器并替换原生入口。
     用户要求"原生主体不变，只加标签页"，因此改为在原生对话框 DOM 上追加标签页。
  2. **远端分支不调用 `onPicked`**。原生 flow 的 `onPicked` 会交给本地 `createWorkspace({path})`，
     走这条路径会在本机按远端路径创建不存在的工作区。
  3. **配色只接受 `#rrggbb`**。颜色会写进本机侧栏内联样式，开放任意字符串等于交出 CSS 注入面。
  4. **旧记录缺失 `visibleWorkspaceIds` 归一化为空数组**。当成"显示全部"会让升级用户突然看到
     所有远端工作区，与"默认不显示"语义相反。
- 验证证据：
  - `pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check` 通过。
  - `node --test tests/*.spec.ts`：826 项中 825 项通过；唯一失败为 `contracts.spec.ts` 的
    `mobileAccess` 用例，属于同一工作区中另一写入者并行进行的移动端改造（其 `config.ts`
    改动本轮期间落盘、测试未同步），与本任务无关。
  - 测试实际捕获并修复两个实现缺陷：标签注入后当轮被清理循环误删；
    远端读取失败被伪装成"没有已连接的 Host"。
- 明确不做什么：不新增远端目录浏览、不新增 `directoryPicker/*` 白名单、不修改 DSH 原生组件源码。
- 风险：标签页依赖原生对话框的 CSS module 类名（`_editorScope`/`_header`/`_content`/`_footerBar`），
  已确认在 0.2.0-rc.1 与 rc.2 上一致，但 DSH 升级时需回归 `peer-host-workspace-tab.spec.ts`。

## 使用规则

- `TODO`：未开始。
- `IN_PROGRESS`：正在实现。
- `IN_REVIEW`：代码与验证完成，等待复核。
- `DONE`：已回写验证证据。
- `BLOCKED`：外部能力或决策阻塞，必须写明原因。
- 每个任务完成后立即回写状态、改动文件和验证命令，不允许最后一次性补记录。
- 任务只修改本任务列出的边界；发现跨边界需求时先在“风险与待确认项”中记录，再拆新任务。

## 阶段 6A.0：DSH Web Client pre-boot Transport 接入

- 状态：`DONE`（Web 与 Desktop 两条路径均已接入）；官方 Provider 契约仍为后续可选演进项
- 已完成（2026-09-29）：CodingNS 单插件在启动页 head 注入版本锁定的 `0.2.0-rc.1` preboot facade。facade 默认透传页面 fetch，支持幂等安装、激活/停用、dispose、版本拒绝；PeerHost 设置启用时显示安装状态和刷新提示。
- 已完成（2026-09-30，Desktop 适配）：把原先"Desktop 外部 Transport 保护"这个**刻意边界重新分类为已修复缺口**。Desktop 的 `__DSH_TRANSPORT__` 由前端 Bundle 运行时直接赋值（`{ ownsHost, streamBaseUrl }`，无 rpc/fetch/openStream），旧实现因此直接返回只读 `external`，加上 `index-injection` 的 `index < 0` 守卫会跳过 shim 脚本行，形成 `not-installed` / `external` 两个死路分支。本次改为：
  1. shim 用带 setter 的 `Object.defineProperty` 访问器接管 Desktop 的运行时赋值，`External` 只在 Transport 形状未知（非对象）时保留；facade 新增 `streamBaseUrl` 透传，且**刻意不提供 `rpc`/`openStream`**，让 DSH 继续走原生 `createWebConnectionRpc`（保住 rpcId 校验与 multipart 附件解析，并让 `connection.rpc.open === void 0` 成立以启动原生 Remote mux）。
  2. `index-injection` 的注入守卫改为"表里没有 shim 行就注入"。
  3. Feature 在 Desktop 拓扑下就地补连接层分流：`connection.rpc.call` 与 `remote.openRemoteStream` 只在命中聚合作用域时转交页面 Transport，本机请求原样落回 DSH 自身实现（含 uplink 与 mux 重连语义）。
  4. 能力路由 `peer-host.client-preboot-transport` 范围改为 `>=0.2.0-rc.1`，探测改为读页面 shim 状态；Feature 该能力回退策略改为 `disable`（结构不支持时只停用 PeerHost，不再提示"请刷新"）；设置面板文案区分"结构不支持"与"需要刷新"，`account-bar` 入口可见性与能力状态一致。
- 改动文件：`src/bootstrap/dsh-peer-host-preboot-shim.ts`、`src/bootstrap/index.ts`、`src/host/index-injection.ts`、`src/dsh-capabilities/matrix.ts`、`src/dsh-capabilities/routes.ts`、`src/client/features/peer-host.ts`、`src/client/features/index.ts`、`src/client/account-bar.ts`、`src/host/cli-adapters/feature.ts`（顺带修复阻塞构建的 `readSandboxMode` 返回类型）
- 测试：`tests/dsh-peer-host-preboot-shim.spec.ts`、`tests/host-index-injection.spec.ts`、`tests/peer-host-desktop-transport.spec.ts`（新增）、`tests/dsh-capability-registry.spec.ts`、`tests/peer-host-account-menu.spec.ts`
- 验证证据（2026-09-30）：`pnpm run typecheck`；`pnpm run version:check`；`pnpm run capability:check`；`pnpm run capability:report`（已重新生成 `docs/生成报告/20260925-能力路由报告.md`）；`pnpm test`（876 项全部通过）。
- 证据文档：`docs/调查报告/20260930-Desktop页面Transport下发方式调查.md`、`docs/开发记录/20260930-Desktop下PeerHost聚合适配记录.md`
- 真实边界：shim 只解决页面 Transport 的 preboot 生命周期，不伪造 `ctx.workspaces`、`ctx.sessions`；原生 Store 接入仍由 6A.3/6A.4 负责。Desktop 侧结论来自 `app.asar` 反编译证据与等价沙箱测试，真实 Desktop 窗口的首次人工验证仍需在用户侧完成。
- 明确不做什么：不引入独立补丁包、Patch Engine、第二插件或远端 UI Bundle；不在运行中的页面重建 DSH Connection；不替换 `createWebConnectionRpc`。

## 阶段 1：建立 Spec 边界、能力矩阵和内部契约

### 1.1 注册 PeerHost 能力 ID 与 Feature descriptor

- 状态：`DONE`
- 改动文件：`src/dsh-capabilities/types.ts`、`src/dsh-capabilities/matrix.ts`、`src/dsh-capabilities/routes.ts`、`src/client/features/peer-host.ts`、`src/client/features/index.ts`、`src/host/features/peer-host.ts`、`src/host/features/index.ts`、`tests/dsh-capability-registry.spec.ts`、`tests/feature-wiring.spec.ts`
- 验证命令：`pnpm run typecheck`；`pnpm run build && node --test tests/dsh-capability-registry.spec.ts tests/feature-wiring.spec.ts`（28 项通过）
- 已知限制：PeerHost 适配器尚未装配，当前仅提供显式结构探测和默认关闭的 Feature；真实配置、握手、代理和聚合留在后续任务。中转能力未宣称可用。
- 对应需求和设计章节：需求 1、12；设计 §1、§2、§3
- 做什么：在能力注册表中增加 PeerHost store、握手、HTTP/WS 代理、聚合、Relay 和导航降级能力，注册独立 `peer-host` Feature。
- 做完看到什么：能力画像能解释 PeerHost 是否可用，模块启停不影响现有 Feature。
- 依赖什么：spec005 能力注册与 FeatureRegistry；无业务代码依赖。
- 先看哪些文档：`requirements.md` 需求 1、12；`design.md` §3。
- 主要改哪些文件：`src/dsh-capabilities/types.ts`、`src/dsh-capabilities/matrix.ts`、`src/client/features/index.ts`、`src/host/features/index.ts`、对应测试。
- 明确不做什么：不连接真实目标 Host，不添加管理面板，不扩大 DSH manifest 范围。
- 怎么验证：能力矩阵单测、Feature 缺失能力禁用测试、`pnpm run typecheck`。

### 1.2 定义 PeerHost、HostScope 和聚合 DTO

- 状态：`DONE`
- 改动文件：`src/shared/contracts/peer-host.ts`、`src/shared/contracts/errors.ts`、`src/shared/index.ts`、`tests/peer-host-contracts.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-contracts.spec.ts tests/resource-scope.spec.ts`（9 项通过）
- 已知限制：契约已定义但尚未接入持久化、握手、代理和聚合运行时；`ResourceScopeManager` 保留旧输入形状，完整 `sessionId` 生命周期由阶段 4 接入。
- 对应需求和设计章节：需求 2、5、6、7、8、12；设计 §4、§6、§7、§11
- 做什么：新增 `PeerHostRecord`、`PeerHostRoute`、`PeerHostStatus`、`HostScope`、工作区/会话摘要和结构化错误码。
- 做完看到什么：Host、Client、代理和导航共享同一套内部契约，不再用裸 workspace/session ID。
- 依赖什么：1.1；现有 `src/shared/contracts/peer-host.ts` 和 `src/features/resource-scope/index.ts`。
- 先看哪些文档：`requirements.md` 需求 2、7、8；`design.md` §4、§11。
- 主要改哪些文件：`src/shared/contracts/peer-host.ts`、`src/shared/contracts/resource-scope.ts`（如需要）、`src/shared/errors/`、契约测试。
- 明确不做什么：不决定数据库实现，不把 DSH 私有类型暴露给业务模块。
- 怎么验证：类型检查、序列化/反序列化测试、错误码稳定性测试。

### 1.3 建立版本和能力 fixture

- 状态：`DONE`
- 改动文件：`src/dsh-capabilities/matrix.ts`、`src/dsh-capabilities/routes.ts`、`tests/dsh-capability-registry.spec.ts`、`docs/生成报告/20260925-能力路由报告.md`（脚本生成）
- 验证命令：`pnpm run typecheck`；`pnpm run build && node --test tests/dsh-capability-registry.spec.ts`（8 项通过）；`pnpm run version:check`；`pnpm run capability:check`；`pnpm run capability:report`
- 已知限制：0.1.5-rc.3/0.1.6-alpha.2 仅在显式注入时使用 Remote Web Context；0.1.7 原生导航仍需真实 adapter。Relay 三版本均保持 unavailable，尚未验证 Host-to-Host 中转。
- 对应需求和设计章节：需求 1、4、12；设计 §3、§5、§9、§14、§15
- 做什么：为 DSH 0.1.5-rc.3、0.1.6-alpha.2、0.1.7-rc.2 建立 PeerHost 能力 fixture，记录原生导航、WS 和 Remote Web Context 能力差异。
- 做完看到什么：每个版本都有明确的 ready/degraded/unavailable 结果。
- 依赖什么：1.1、1.2；现有 spec005 版本矩阵。
- 先看哪些文档：`docs/20260927-父仓库PeerHost实现对照与本项目边界.md`、现有 DSH 调查报告。
- 主要改哪些文件：`src/dsh-capabilities/matrix.ts`、`tests/fixtures/`、`tests/dsh-capability-registry.spec.ts`、对应调查文档。
- 明确不做什么：不通过字符串版本判断绕过能力探测，不宣称未验证的中转能力可用。
- 怎么验证：`pnpm run version:check`、能力报告和三版本 fixture 测试。

## 阶段 2：Host PeerHost 注册、握手和目标登录态

### 2.1 实现 PeerHost 持久化和敏感会话存储

- 状态：`DONE`
- 改动文件：`src/host/modules/peer-host/peer-host-store.ts`、`tests/peer-host-store.spec.ts`
- 验证命令：`pnpm run typecheck`；`pnpm run build && node --test tests/peer-host-store.spec.ts`（3 项通过）
- 已知限制：服务尚未接入 Host Feature/RPC；加密文件密钥由 Host 启动边界注入，密钥生命周期和系统密钥链集成留在 Host 装配任务。
- 对应需求和设计章节：需求 2、4、5、12；设计 §4、§5、§11
- 做什么：实现 PeerHostRecord 的增删改查、路由规范化、重复检查、加密目标登录态和删除清理。
- 做完看到什么：配置和 token 只存当前 Host，Client 只能看到脱敏 DTO。
- 依赖什么：1.2；现有 Host settings store、认证服务和敏感存储边界。
- 先看哪些文档：`requirements.md` 需求 2、5；`design.md` §4、§5。
- 主要改哪些文件：`src/host/modules/peer-host/`、`src/host/settings.ts` 或对应 store、Host 单测。
- 明确不做什么：不让浏览器直接持有目标 token，不保存短期 relay ticket。
- 怎么验证：存储 round-trip、权限隔离、删除清理和日志脱敏测试。

### 2.2 实现目标 Host 握手和状态机

- 状态：`DONE`
- 已完成增量（2026-10-08）：插件版本从严格相等改为客户端版本不低于 PeerHost，复用语义版本比较并修正版本提示。7 个相关测试文件通过源码加载器免构建回归，类型、版本同步、能力退休及国际化检查通过。详见 `docs/开发记录/20261008-PeerHost插件版本向下兼容实现记录.md`。
- 改动文件：`src/host/modules/peer-host/peer-host-store.ts`、`src/host/modules/peer-host/peer-host-handshake.ts`、`tests/peer-host-handshake.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-handshake.spec.ts`（4 项通过）
- 已知限制：当前只实现固定 LAN 握手路径；Relay 明确返回 `PEER_HOST_RELAY_UNAVAILABLE`。握手服务尚未接入 Feature/RPC，目标 Host 真实握手端点装配留在后续任务。
- 对应需求和设计章节：需求 3、4、5、11、12；设计 §5、§11、§15
- 做什么：实现产品标识、插件版本、DSH 版本、API 兼容标识和 fingerprint 检查，落地状态转换和诊断码。
- 做完看到什么：未安装插件、版本不兼容、身份变化和网络失败都能显示真实状态并阻止代理。
- 依赖什么：2.1、1.3；能力矩阵和版本解析工具。
- 先看哪些文档：`requirements.md` 需求 3、4；`design.md` §5、§11。
- 主要改哪些文件：`src/host/modules/peer-host/peer-host-service.ts`、握手 adapter、`tests/peer-host-handshake.spec.ts`。
- 明确不做什么：不在握手阶段加载会话全文，不自动信任 fingerprint 变化。
- 怎么验证：成功、插件缺失、版本不兼容、fingerprint 变化、超时和重试测试。

### 2.3 接入目标 Host 登录、刷新和退出

- 状态：`DONE`
- 改动文件：`src/host/modules/peer-host/peer-host-store.ts`、`src/host/modules/peer-host/peer-host-session.ts`、`tests/peer-host-session.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-session.spec.ts`（3 项通过）
- 已知限制：登录服务已完成 Host 侧 token 隔离和自动刷新，但尚未接入生产 Host Feature/RPC；RPC 装配与代理生命周期在阶段 3 统一完成。Relay 登录仍不可用。
- 对应需求和设计章节：需求 5、6、11、12；设计 §5.2、§6、§11
- 做什么：提供 Host 侧登录、refresh、logout 和 `session_required` 处理，确保当前 Host 登录态不受影响。
- 做完看到什么：用户可在管理面板登录 PeerHost，代理前由 Host 自动刷新目标 token。
- 依赖什么：2.1、2.2；现有认证服务和目标 DSH 登录接口。
- 先看哪些文档：`requirements.md` 需求 5；`design.md` §5.2。
- 主要改哪些文件：`src/host/modules/peer-host/peer-host-service.ts`、Host RPC/API、认证测试。
- 明确不做什么：不把密码、token 或 refresh 结果返回 Client，不复用当前 Host token。
- 怎么验证：token 刷新成功/失败、目标退出、目标删除和当前 Host 会话隔离测试。
- 本次修复（2026-09-30）：目标 LAN 边界新增 `POST /api/auth/login|refresh|logout`，用登录保护的
  口令哈希与签名材料签发短期票据；PeerHost 白名单路由改为校验票据签名，不再接受任意 Bearer。
  当前 Host 侧 `errorResponse()` 直传 `PeerHostSessionError` 稳定错误码（缺少凭据返回
  `401 PEER_HOST_SESSION_REQUIRED`），`login()` / `refresh()` 允许从 `session_required` 直接恢复并写回
  `ready`。修复前目标返回 404，日志里只看到被掩码的 `PEER_HOST_PROXY_UNREACHABLE`。
- 本次修复验证：`pnpm run typecheck`、`pnpm run build`、`pnpm run version:check`、
  `pnpm run capability:check` 通过；`pnpm test` 750 项通过；真实 socket 探针（LAN 边界 11/11、
  端到端登录与状态代理 9/9）通过。详见 `docs/开发记录/20260930-PeerHost目标登录端点与Bearer票据校验记录.md`。
- 本次修复边界：目标 LAN 上游的 `/api/workspaces`、`/api/sessions` 在 DSH 0.2.0-rc.2 不存在（404），
  远端工作区摘要仍需 spec006 阶段 6A 的原生 source 方案，未在本轮修改。

## 阶段 3：HTTP/WS 受控代理

### 3.1 实现 HTTP 代理入口和白名单

- 状态：`DONE`
- 改动文件：`src/host/modules/peer-host/host-api-proxy-service.ts`、`tests/peer-host-http-proxy.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-http-proxy.spec.ts`（3 项通过）
- 已知限制：代理服务尚未注册到生产 WebServer/RPC；当前白名单覆盖工作区、会话、文件树、文件、Git、终端和右侧工具的固定 API 前缀，具体 DSH 版本路径适配仍需能力矩阵扩展。
- 对应需求和设计章节：需求 5、6、7、10、12；设计 §6、§11
- 做什么：按固定 PeerHost ID 和资源类别代理工作区、会话、文件、Git、终端和右侧工具 API。
- 做完看到什么：合法请求可到达目标 Host，任意 URL、认证和未登记 API 被拒绝。
- 依赖什么：2.2、2.3；现有 Host HTTP 路由和 `host-api-proxy-service.ts` 参考实现。
- 先看哪些文档：`requirements.md` 需求 6、10；`design.md` §6。
- 主要改哪些文件：`src/host/modules/peer-host/host-api-proxy-service.ts`、路由注册、白名单契约、测试。
- 明确不做什么：不接受客户端 baseUrl，不开放任意 `/api`、插件安装或认证代理。
- 怎么验证：路径、方法、体积、作用域、认证、响应头和错误码测试。

### 3.2 实现 WebSocket 代理和消息过滤

- 状态：`DONE`
- 改动文件：`src/host/modules/peer-host/host-ws-proxy-service.ts`、`src/host/modules/peer-host/peer-host-ws-gateway.ts`、`src/host/features/peer-host.ts`、`src/host/rpc.ts`、`tests/peer-host-ws-proxy.spec.ts`、`tests/peer-host-ws-gateway.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-ws-proxy.spec.ts tests/peer-host-ws-gateway.spec.ts`（代理 3 项通过；网关集成测试在禁止监听端口的环境跳过）
- 已知限制：服务已完成双端过滤、有界队列、插件自有固定路径 upgrade 网关和默认 LAN `/ws` Host-to-Host connector；不修改 DSH WebServer。目标 WS 断线重连留在后续阶段 7，relay connector 在能力验证前保持明确不可用。
- 对应需求和设计章节：需求 6、7、9、10、11、12；设计 §7、§8、§11
- 做什么：建立当前 Host 到目标 Host 的双端 WS 连接，过滤客户端/远端消息类型并绑定 HostScope。
- 做完看到什么：会话、终端、文件树和 Git 实时事件能路由到正确 Host，未知消息不会透传。
- 依赖什么：3.1、2.3；现有 WS auth guard 和 DSH 工作台消息协议。
- 先看哪些文档：`requirements.md` 需求 6、9、10；`design.md` §7。
- 主要改哪些文件：`src/host/modules/peer-host/host-ws-proxy-service.ts`、WS 路由、消息白名单和测试。
- 明确不做什么：不支持二进制透传、任意 WebSocket 路径或 PeerHost 递归代理。
- 怎么验证：双端连接、消息白名单、scope mismatch、上游关闭、背压和清理测试。

### 3.3 增加代理安全和诊断测试

- 状态：`DONE`
- 改动文件：`tests/peer-host-security.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-http-proxy.spec.ts tests/peer-host-ws-proxy.spec.ts tests/peer-host-security.spec.ts`（8 项通过）
- 已知限制：安全测试覆盖当前代理实现和错误脱敏；生产日志扫描、实际 WebServer/upgrade 注册以及新增 DSH API 的持续白名单门禁仍需后续任务。
- 对应需求和设计章节：需求 6、12；设计 §6、§7、§11、§12
- 做什么：把代理路径、消息类型、日志字段和凭据脱敏规则固化为安全契约测试。
- 做完看到什么：新增代理接口如果漏注册白名单或日志包含敏感字段，测试会失败。
- 依赖什么：3.1、3.2。
- 先看哪些文档：`requirements.md` 需求 6、12；`design.md` §11、§12。
- 主要改哪些文件：`tests/peer-host-proxy.spec.ts`、`tests/peer-host-security.spec.ts`、日志工具。
- 明确不做什么：不把安全测试变成对具体第三方网络环境的依赖。
- 怎么验证：`pnpm test` 中的代理/安全测试、敏感字段扫描和失败路径覆盖。

## 阶段 4：HostScope、HostRouter 和聚合摘要

### 4.1 实现 HostRouter 和 generation 清理

- 状态：`DONE`
- 改动文件：`src/features/host-router.ts`、`src/client/host-router.ts`、`src/host/host-router.ts`、`tests/host-router.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/host-router.spec.ts`（3 项通过）
- 已知限制：路由器已提供作用域、generation、清理和稳定 key，但尚未替换现有会话/工具模块的请求入口；接入在阶段 6 完成。
- 对应需求和设计章节：需求 7、9、10、11；设计 §8、§10、§11
- 做什么：统一解析当前 Host/PeerHost、校验作用域、递增 generation、取消旧请求和清理旧订阅。
- 做完看到什么：切换 Host、工作区或会话后，旧请求和旧 WS 结果不能污染新页面。
- 依赖什么：1.2、3.2；现有 resource-scope 和 remote-web-runtime 生命周期。
- 先看哪些文档：`requirements.md` 需求 7、11；`design.md` §8。
- 主要改哪些文件：`src/features/resource-scope/index.ts`、`src/client/host-router.ts`、`src/host/host-router.ts`、测试。
- 明确不做什么：不通过全局锁阻塞所有 Host，不删除现有单 Host 作用域行为。
- 怎么验证：旧 generation 丢弃、取消、WS 关闭、清理失败后新作用域仍能建立的测试。

### 4.2 实现多 Host 工作区/会话摘要聚合

- 状态：`DONE`
- 改动文件：`src/shared/contracts/peer-host.ts`、`src/shared/index.ts`、`src/host/modules/peer-host/peer-host-aggregate-service.ts`、`tests/peer-host-aggregate.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-aggregate.spec.ts`（3 项通过）
- 已知限制：聚合服务只加载摘要，尚未连接真实 workspace/session API 或 Client 导航 store；错误节点暂以 `AggregateHostResult` 状态承载。
- 对应需求和设计章节：需求 7、8、11；设计 §4.5、§8、§9、§11
- 做什么：并发获取当前 Host 和 PeerHost 摘要，合并稳定 key，保留不可用 Host 节点和状态。
- 做完看到什么：导航一次显示所有 Host 的工作区和会话，同名资源不会覆盖。
- 依赖什么：4.1、2.2；工作区/会话摘要 API。
- 先看哪些文档：`requirements.md` 需求 8；`design.md` §4.5、§9。
- 主要改哪些文件：`src/host/modules/peer-host/peer-host-aggregate-service.ts`、Client 聚合 store、DTO 测试。
- 明确不做什么：不预加载会话全文、文件内容或跨 Host 搜索。
- 怎么验证：并发、超时、单 Host 失败、同名 workspace/session、远端删除和刷新测试。

### 4.3 接入 Host 标签和导航数据适配器

- 状态：`DONE`
- 改动文件：`src/client/host-navigation.ts`、`tests/host-navigation.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/host-navigation.spec.ts`（2 项通过）
- 已知限制：当前提供纯数据适配器，尚未挂接 DSH 原生导航 DOM/React Slot；Remote Web Context 降级提示和真实导航装配留在阶段 5/6。
- 对应需求和设计章节：需求 8、11、12；设计 §9.2、§9.3、§14
- 做什么：为当前 Host 和 PeerHost 生成稳定标签、DOM/React key 和导航树模型。
- 做完看到什么：工作区名称后显示 Host 标签，切换和刷新不会跳到错误资源。
- 依赖什么：4.2；现有 workspace/session 导航和 host alias 逻辑。
- 先看哪些文档：`requirements.md` 需求 8；`design.md` §9.2。
- 主要改哪些文件：`src/client/workspace-session-logo-dom.ts`、导航组件/adapter、相关测试。
- 明确不做什么：不把标签写入 workspaceId，不改变当前 Host 默认显示语义。
- 怎么验证：多 Host 同名资源、稳定 key、标签更新和不可用节点保留测试。

## 阶段 5：连接管理入口和设置面板

### 5.1 集成账户菜单连接管理入口

- 状态：`DONE`
- 改动文件：`src/client/account-bar.ts`、`src/client/peer-host-connection-button.ts`、`src/client/features/peer-host.ts`、`src/client/features/index.ts`、`tests/peer-host-connection-button.spec.ts`、`tests/peer-host-account-menu.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-connection-button.spec.ts tests/peer-host-account-menu.spec.ts`（2 项通过）
- 已完成（2026-09-29）：管理入口已从独立 Host 按钮迁移到账户菜单，继续复用既有打开事件；Feature 停用时不再额外注入重复入口。旧按钮工厂保留用于兼容既有调用方和测试，不再是默认装配路径。
- 对应需求和设计章节：需求 1、2、12；设计 §2.1、§9.3
- 做什么：在统一用户管理窗口中提供 PeerHost 管理入口，停用时移除管理面板事件监听和 DOM。
- 做完看到什么：用户从账户菜单进入 PeerHost 管理，不需要在页面上寻找第二个 Host 按钮。
- 依赖什么：1.1、4.1；现有 account bar/右下角 UI 注册方式。
- 先看哪些文档：`requirements.md` 需求 1、2；`design.md` §9.3。
- 主要改哪些文件：`src/client/account-bar.ts`、PeerHost UI 组件、Feature wiring 和组件测试。
- 明确不做什么：不复用 HostSwitcher 的 active Host 切换语义，不在停用后保留 DOM 节点，不改变当前 Host 登录菜单语义。
- 怎么验证：Feature 启停、按钮显示、面板打开、资源释放和移动视口测试。

### 5.2 实现 PeerHost 管理面板

- 状态：`DONE`
- 改动文件：`src/client/account-bar.ts`、`src/client/peer-host-management-api.ts`、`src/client/peer-host-management-panel.ts`、`src/host/features/peer-host.ts`、`src/host/features/types.ts`、`src/host/index.ts`、`src/host/rpc.ts`、`src/shared/contracts/peer-host.ts`、`src/shared/index.ts`、`tests/peer-host-management.spec.ts`、`tests/peer-host-account-menu.spec.ts`
- 验证命令：`node --test tests/peer-host-management.spec.ts tests/peer-host-account-menu.spec.ts tests/peer-host-connection-button.spec.ts tests/client-entry.spec.ts tests/popup-dismiss.spec.ts`（44 项通过）；`pnpm run typecheck`；`pnpm run build`；`git diff --check`
- 已完成（2026-09-29）：新增/登录改为面板内表单，移除 `window.prompt()`；客户端自动识别局部保护登录或中转账号并预填用户名，密码不读取、不持久化，只在一次 `peerHost/login` RPC 中提交。Relay 仍在提交前明确提示不可用，不创建假成功连接。LAN 地址和中转路由详情继续由 Host 侧保存或按隐私边界要求重新输入。
- 对应需求和设计章节：需求 2、3、4、5、12；设计 §2.1、§5、§9.3、§11
- 做什么：提供添加、编辑、检查、重连、登录、退出和删除 PeerHost 的表单与状态视图，并按父仓库 CodingNS 的 Host Switcher 方式把凭据入口集中到用户管理流程。
- 做完看到什么：用户能看到名称、路由、版本、fingerprint 脱敏摘要、最近检查和错误原因；添加或登录时能看到当前账号来源的自动识别结果。
- 依赖什么：2.1、2.2、2.3、5.1；现有设置表单规范。
- 先看哪些文档：`requirements.md` 需求 2、3、4、5；`docs/开发规范/20260922-设置选项与表单开发规则.md`。
- 主要改哪些文件：`src/client/features/peer-host-management.ts`、管理面板 DOM/React、locale 和测试。
- 明确不做什么：不显示或读取 token、密码、完整 relay ticket 或任意目标 URL 查询串；不把中转后端未实现伪装成可用能力。
- 怎么验证：表单校验、重复目标、删除确认、登录失败、版本错误和中转不可用状态测试。

### 5.3 接入设置项和模块启停

- 状态：`DONE`
- 改动文件：`src/host/rpc.ts`、`src/client/features/peer-host.ts`、`src/host/features/peer-host.ts`、`tests/peer-host-management.spec.ts`
- 验证命令：`node --test tests/peer-host-management.spec.ts`（5 项通过）；`pnpm run typecheck`；`pnpm run build`；`git diff --check`
- 已知限制：设置使用现有 `modules` 字典，不新增独立顶层字段；停用时不会删除持久 PeerHost 配置和 Host 加密凭据。完整 DSH 设置页视觉回放留在阶段 8。
- 对应需求和设计章节：需求 1、12；设计 §2.1、§11
- 做什么：新增独立设置项、FeatureRegistry 启停回调和已有配置保留策略。
- 做完看到什么：关闭模块后按钮、轮询、聚合和连接消失，重新开启可恢复配置。
- 依赖什么：1.1、5.1、5.2；现有 settings store。
- 先看哪些文档：`requirements.md` 需求 1、12；功能模块开发规则。
- 主要改哪些文件：`src/shared/contracts/feature.ts`、`src/client/settings-section.ts`、`src/host/settings.ts`、Feature 测试。
- 明确不做什么：不删除用户保存的 PeerHost，不影响当前 Host 的既有开关。
- 怎么验证：重复启停、持久配置保留、定时器/WS/iframe 清理和能力缺失降级测试。

## 阶段 6A：Aggregated Host 原生聚合主线

### 6A.1 固定 Aggregated Host Transport 与能力契约

- 状态：`DONE`
- 已完成（2026-09-29）：新增 Host 侧 `AggregatedHostTransportService`，统一 RPC、fetch、stream、WebSocket、generation/reconnect 作用域；RPC/path 使用正向白名单，目标 token 仍由 Host 代理持有；Manifest/Bundle 仅允许本地插件基线，远端能力仅返回脱敏摘要。
- 改动文件：`src/shared/contracts/peer-host.ts`、`src/shared/index.ts`、`src/dsh-capabilities/types.ts`、`src/dsh-capabilities/matrix.ts`、`src/dsh-capabilities/routes.ts`、`src/host/modules/peer-host/aggregated-host-transport.ts`、`src/host/modules/peer-host/host-api-proxy-service.ts`、`src/host/index.ts`、`tests/peer-host-aggregated-transport.spec.ts`
- 验证命令：`pnpm run typecheck`；`pnpm run build`；`node --test tests/peer-host-aggregated-transport.spec.ts`（3 项通过）
- 已知限制：真实 DSH Client boot 接入、虚拟 Registry 消费和目标 Host stream adapter 留在 6A.2 至 6A.4；本任务不加载远端 Bundle/Manifest，也不替换普通插件 `ctx.connection`。
- 做什么：定义 DSH Client 所需的统一 RPC、fetch、stream、WebSocket、generation、reconnect、manifest/bundle 读取边界，以及本地插件基线和目标 Host 能力摘要。
- 做完看到什么：本地 DSH Client 只连接一个 Aggregated Host；远端插件 Bundle、Manifest 和 UI Slot 不进入协议。
- 依赖什么：阶段 1 至阶段 5；DSH 0.2.0-rc.1 Client boot 调查。
- 主要改哪些文件：`src/shared/contracts/peer-host.ts`、`src/dsh-capabilities/types.ts`、`src/dsh-capabilities/matrix.ts`、`src/host/modules/peer-host/`、对应契约测试。
- 明确不做什么：不在本任务中加载远端 Client Bundle，不开放任意 URL、任意 RPC 或任意插件接口。
- 怎么验证：Transport hook、能力摘要、版本门禁、`unsupported` 错误和敏感字段测试。

### 6A.2 实现虚拟 Workspace/Session Registry

- 状态：`DONE`
- 已完成（2026-09-29）：新增版本化虚拟 Workspace/Session ID、可逆解析函数、Host 命名空间路由表和混合 Workspace 顺序 Registry；新增 DSH 原生 Workspace/Session Remote 方法白名单、请求 ID 解码和响应/事件 ID 编码，未知资源、重复 ID、同 ID move 和离线快照均有明确处理。
- 改动文件：`src/shared/contracts/peer-host.ts`、`src/shared/index.ts`、`src/host/modules/peer-host/peer-host-virtual-registry.ts`、`src/host/modules/peer-host/peer-host-native-protocol.ts`、`src/host/index.ts`、`tests/peer-host-virtual-registry.spec.ts`、`tests/peer-host-native-protocol.spec.ts`
- 验证证据：`pnpm run typecheck`；`pnpm run build`；`node --test tests/peer-host-native-protocol.spec.ts tests/peer-host-virtual-registry.spec.ts tests/peer-host-aggregated-transport.spec.ts`（14 项通过）。
- 剩余边界：原生事件流仍须由远端 DSH Remote connector 装配；本任务只提供可复用的 ID 改写和路由契约，不在 0.2.0-rc.1 上伪造 Session binding。
- 做什么：为当前 Host 和 PeerHost 生成 Host 命名空间虚拟 ID，建立 Workspace/Session 路由表、稳定 key、事件 ID 改写和混合顺序数据结构。
- 做完看到什么：原生 Store 可以区分 `local-host:workspace-1`、`peer-a:workspace-1` 等相同远端 ID；删除、离线和重连不会破坏顺序记账。
- 依赖什么：6A.1、阶段 4 的 HostScope 和聚合 DTO。
- 主要改哪些文件：`src/shared/contracts/peer-host.ts`、`src/host/modules/peer-host/peer-host-aggregate-service.ts`、新增虚拟 Registry、`tests/peer-host-aggregate.spec.ts`。
- 明确不做什么：不把远端 Workspace/Session 写入当前 Host 原生持久 Registry，不使用裸 ID 作为跨 Host 主键。
- 怎么验证：同名资源、虚拟 ID、路由往返、事件改写、混合排序和单 Host 失败测试。

### 6A.3 验证 DSH 0.2.0-rc.1 Client boot 与原生列表接入

- 状态：`DONE`
- 做什么：在 CodingNS 单插件内安装 `0.2.0-rc.1` shim，并包装现有 `ctx.get('workspaces').list`、`ctx.get('sessions').list` 快照，让原生 Workspace/Session UI 读取聚合数据。
- 做完看到什么：真实 DSH Web 页面不依赖 DOM 选择器即可显示带 Host 标签的虚拟 Workspace/Session，并把远端 Workspace 拖拽排序路由回 Host。
- 依赖什么：6A.1、6A.2；`src/bootstrap/dsh-connection-adapter.ts` 和 DSH Web boot graph 调查。
- 主要改哪些文件：`src/bootstrap/`、`src/client/dsh-h5-bootstrap.ts`、`tests/fixtures/`、新增 DSH Web boot 回放测试。
- 明确不做什么：不以 DOM 注入成功作为原生 Store 接入证据，不覆盖 `ctx.connection`，不伪造远端 Session binding。
- 怎么验证：`node --test tests/dsh-client-boot-020.spec.ts`（1 项通过）；`pnpm run typecheck`；`pnpm run build` 均已通过。完整 `pnpm test` 的唯一失败是受限环境无法绑定 `0.0.0.0` 的既有 Host relay 测试，与本任务无关。
- 已完成证据：`tests/fixtures/dsh-020-aggregated-transport.mjs` 通过 `globalThis.__DSH_TRANSPORT__` 安装最小聚合 RPC；测试真实加载 0.2.0-rc.1 `@deepseek-ai/dsh-client-connection/client`，在 Client apply 前登记 Transport，随后通过公开 `registerGenerationSource/start` 建立 generation，并读取 workspace/session fixture 快照。
- 当前边界：0.2.0-rc.1 没有公开的 pre-boot `workspaces/sessions` 替换点，但其列表快照对象可被安全包装。CodingNS 已在单插件内完成列表投影；`dsh-client-ui-workspace`/`ui-session` 后续打开远端会话仍需要真实 `workspace.follow`、Session control stream 和 Conversation history/stream。
- 不需要的事情：不需要用户等待或安装 DSH 官方契约，不需要通用模块替换 Patch Engine，也不需要修改 DSH Host 业务逻辑。

### 6A.4 接入本地原生 Workspace/Session/Conversation

- 状态：`IN_PROGRESS`
- 已完成（2026-09-29）：页面端根据聚合摘要建立虚拟 ID 到 HostScope 的映射；`/api` 原生 Remote 普通调用路由到 `peerHost/native`，流调用路由到 `peerHost/nativeStream`；Host 侧使用目标 DSH Context 的 `workspaceController`/`sessionController`，`session/follow` 保留请求参数，流句柄支持轮询、结束、关闭、过期和作用域校验。
- 当前缺口：真实 DSH Web 的 `sessions.retain()` 全链路、`session/control` 投影、历史分页与发送/停止/权限回复尚未在浏览器 fixture 中闭环验证。
- 做什么：让本地 DSH 原生 Workspace、Session、Conversation 组件消费虚拟 Store，并将打开、历史、实时消息、发送、停止、权限回复和问题回答路由到目标 Host。
- 做完看到什么：本地和多个 PeerHost 工作区出现在同一个原生列表，远端会话使用原生消息和会话生命周期，不再插入插件消息 DOM。
- 依赖什么：6A.2、6A.3、阶段 6B.1/6B.2 的 HostScope 请求适配器。
- 主要改哪些文件：Aggregated Host adapter、`src/client/peer-host-session-controller.ts`、DSH boot/connection fixture、原生 UI 集成测试。
- 明确不做什么：不加载远端 UI Bundle，不把远端消息复制成本地持久会话。
- 怎么验证：多 Host 同名会话、历史、增量、切换、旧 generation 丢弃和本地会话回归测试。

### 6A.5 接入本地插件的适配器与工具路由

- 状态：`IN_PROGRESS`
- 阻塞原因：原生 Conversation connector 已可路由，但右侧工具、终端和文件/Git 操作仍需按同一虚拟 Session 作用域逐项接入并完成真实页面验证；不将 DOM 降级节点宣称为原生右侧栏。
- 做什么：以当前 Host CodingNS Client Bundle、Feature、Slot 和设置为准，将多适配器对话、文件、Git、终端和右侧工具请求按虚拟 Workspace/Session 路由到目标 Host。
- 做完看到什么：本地 UI 可以操作多个 PeerHost；目标 Host 缺少能力时只返回稳定 `unsupported`，不静默切换到当前 Host。
- 依赖什么：6A.1、6A.2、6A.4、阶段 6B.3 的工具白名单。
- 主要改哪些文件：`src/client/features/`、`src/client/peer-host-scoped-client.ts`、`src/host/modules/peer-host/`、能力摘要和工具测试。
- 明确不做什么：不聚合远端插件标签页、远端设置或远端 Plugin Manifest。
- 怎么验证：适配器能力差异、文件/Git/终端/右侧工具作用域隔离和错误回退测试。

### 6A.6 实现混合 Workspace 顺序和持久化

- 状态：`DONE`
- 已完成（2026-09-29）：Host 侧新增 `FileAggregateWorkspaceOrderStore` 和 `peerHost/workspaceOrder` RPC，混合顺序仅保存虚拟 Workspace ID；支持读取顺序、移动到指定项之前或末尾，离线资源保留顺序墓碑，重连后恢复原位置。Client 管理 API 已提供对应读写封装。
- 改动文件：`src/host/modules/peer-host/peer-host-virtual-registry.ts`、`src/host/features/peer-host.ts`、`src/host/rpc.ts`、`src/client/peer-host-management-api.ts`、`tests/peer-host-virtual-registry.spec.ts`
- 验证证据：`pnpm run typecheck`；`pnpm run build`；虚拟 Registry 定向测试 5 项通过；`git diff --check`。
- 已知限制：远端 Workspace 拖拽已通过 Store facade 路由到顺序 RPC；远端 Session 归档、重命名和会话内排序仍须原生 connector。
- 做什么：在当前 Host 保存 `virtualWorkspaceId[]` 全局顺序，支持拖拽、刷新、PeerHost 离线/恢复、删除和重命名；同 Host 局部排序按能力选择是否转发。
- 做完看到什么：本地和多个 PeerHost 工作区可以混合排序，页面重载后顺序保持，目标 Host 恢复后资源回到正确位置。
- 依赖什么：6A.2、6A.4、当前设置存储契约。
- 主要改哪些文件：`src/client/` 聚合顺序 store、`src/host/settings.ts` 或对应设置边界、排序测试。
- 明确不做什么：不把跨 Host 全局顺序写入任一目标 Host 的原生 Workspace Registry。
- 怎么验证：拖拽/重载、同名资源、目标删除、离线恢复、版本变化和并发刷新测试。

### 6A.7 原生 UI 回放与验收门禁

- 状态：`IN_PROGRESS`
- 当前阻塞：代码级 connector 和 fixture 已具备，但尚未在不影响现有 DSH Web 的独立 Profile 中完成真实 `sessions.retain()`、历史、实时事件和右侧工具回放；现有 DOM/HTTP/WS 回放仍只能作为降级和协议测试。
- 做什么：用真实 DSH Web Profile 回放工作区、会话、消息、右侧栏、终端和适配器操作，确认 DOM 注入不再是验收路径。
- 做完看到什么：原生 UI 在本地和至少两个 PeerHost 资源之间切换和操作，所有请求均可追踪到正确 Host。
- 依赖什么：6A.1 至 6A.6、阶段 7 的重连治理。
- 主要改哪些文件：`tests/peer-host-integration.spec.ts`、真实 Profile fixture、验收记录文档。
- 明确不做什么：不依赖不可重复的公网 Host，不把远端插件 Bundle 作为验收前提。
- 怎么验证：三版本 fixture、真实 Web 回放、四项标准验证命令和 `git diff --check`。

## 阶段 6B：远端中栏、聊天输入、实时事件和右侧工具（旧适配器保留）

本阶段已有实现继续保留，用于 Aggregated Host 未装配时的协议测试、能力探测和降级路径；其中 DOM 导航和会话节点不再满足最终原生聚合验收。

### 6B.1 路由远端会话历史和实时事件（降级/验证）

- 状态：`IN_PROGRESS`
- 当前 Host 摘要 source 增量（2026-09-28）：新增 `PeerHostWorkspaceSessionSummarySource` 与 `createAggregateHostSource`。聚合层不再假设 DSH 私有 `SessionStore/WorkspaceRegistry` 结构；未注入稳定 source 时返回 `availability: unsupported` 和明确 `diagnostic`，不把空工作区伪装成成功。注入 source 后统一生成 `hostId/targetHostId/workspaceId/sessionId/scopeGeneration` 作用域节点。
- Host RPC `peerHost/aggregate` 在未注入 source 时同样返回 `当前 Host` 的 unsupported 诊断节点，不再抛出不可区分的 RPC 错误。
- 验证：`pnpm run typecheck`；`pnpm run build`；`node --test tests/peer-host-aggregate.spec.ts`（5 项通过，含 source 不可用诊断和可用 source HostScope 聚合）。
- 本次增量（2026-09-28）：新增 `src/client/peer-host-native-session-ui.ts` 原生会话 UI adapter。adapter 只在结构探测到 DSH `[data-composer-card]`/conversation 容器时挂载，加载历史并把白名单实时事件写入带完整 HostScope 的当前会话节点；generation 失效由 `PeerHostSessionController` 拒绝旧结果。未探测到稳定容器时显示“原生 conversation 容器不可用”降级状态，不创建 iframe 或伪装三栏。
- 验证：`pnpm run typecheck`；`pnpm run build`；`node --test tests/peer-host-native-session-ui.spec.ts`（2 项通过）。
- 本次增量（2026-09-28）：原生会话打开后立即发送作用域绑定的 `session.subscribe`；Client WebSocket 等待真实 `open` 事件后才交付订阅，断线重连只重放白名单中的幂等订阅（工作区、文件树、Git、会话、终端和右侧工具），命令与终端输入不会重放。远端非法消息改为以带完整 HostScope 的 `peerHost.error` 仅回传当前连接。
- 本次修复（2026-09-30）：远端工作区/会话摘要改走 DSH 原生协议。新增 `src/host/modules/peer-host/peer-host-remote-summary-source.ts`：工作区来自 `workspace/follow` 首帧 baseline（`items[].sessionIds` 分组、`archivedSessionIds` 过滤），会话元数据来自 `session/list`（标题取 `projections.values.title`，状态取 `running`），`origin: 'subagent'` 会话不进入摘要；`features/peer-host.ts` 的 `buildSources()` 不再假设目标存在 `/api/workspaces`、`/api/sessions`（实测 404），旧 `loadPeerSummary()` 已删除。
- 本次修复（2026-09-30）：PeerHost 原生调用信封集中到 `src/host/modules/peer-host/peer-host-native-transport.ts` 并导出，正文统一为 `{rpcId, method: 'peerHost/<action>', payload}`，与目标 `/api/codingns/<endpoint>` fetch RPC 入口一致（旧正文缺 rpcId 且 method 写成原生方法名，目标返回 400 `invalid RPC envelope`）；`workspace/follow`、`session/control` 等流式原生方法补兜底 `AbortSignal`，修复 `TypeError: Cannot read properties of undefined (reading 'throwIfAborted')`。
- 本次修复验证：真实目标（LAN 入口 + 有效票据）`session/list` 返回会话数据且信封不再被拒；假目标端到端探针（真实 HTTP + `PeerHostHttpProxyService` + Bearer 注入 + 摘要组装）通过；`node --test tests/*.spec.ts` 760 项通过（新增 `tests/peer-host-remote-summary-source.spec.ts`、`tests/peer-host-native-transport.spec.ts`）。
- 本次修复边界：点击远端会话仍走降级面板，`/api/sessions/<id>/history` 同样是目标不存在的路径，需要后续接入原生 `session/follow` 首帧（snapshot.records）；终端、文件树、Git 等 `PEER_HOST_HTTP_PROXY_RULES` 旧 REST 路径未经验证，迁移前不应视为可用能力。详见 `docs/开发记录/20260930-PeerHost远端工作区会话摘要改造记录.md`。
- 本次修复（2026-09-30）：远端资源改走 DSH 原生界面，删除自绘 DOM 与列表 facade；同时记录关键时序约束——PeerHost Client 模块在设置从 Host 异步返回后才启动，必然晚于 DSH UI 插件打开 `workspace/follow`/`$events`（启动期已由官方 mux 建立），因此不能再依赖"拦截原生流注入帧"。最终实现改为两条真实数据通道：①`src/client/peer-host-native-store-projection.ts` 就地改写原生 UI 按引用持有的 `workspaces.list`（`getSnapshot` 合并虚拟工作区、`subscribe` 转发聚合变化、写入口保持原生行为、合并结果按引用记忆化以满足 `useSyncExternalStore`）；②`src/client/features/peer-host.ts` 在 `session/list` 响应并入虚拟会话摘要（标题用 `projections.values.title` 的 cached 块），并在聚合变化时调用原生 `sessions.refresh()`，把虚拟会话送进原生 `SessionManager`（`sessions.retain()` 可解析、点击可打开）；非白名单 `/api` 流回到 `openDshGatewayStream`，不再抛哨兵错误。
- 本次修复（2026-09-30）：`peerHost/nativeStream` 补齐双向 ID 改写——转发前 `rewriteNativeRequestIds`，返回迭代器逐帧 `rewriteNativeResponseIds`；远端 `session/follow` 现在能带着虚拟 ID 进入、带着虚拟 ID 回帧。
- 本次修复（2026-09-30）：删除 `src/client/peer-host-native-session-ui.ts`、`src/client/host-navigation.ts`、`src/client/peer-host-native-store-adapter.ts` 及对应测试，`src/client/index.ts`、`src/client/features/index.ts` 同步清理导出；`peerHost`/`peerHostSession`/WS 事件通道暂无消费者，保留待确认后单列清理。
- 本次修复验证：`pnpm test` 768 项通过（含构建）；`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check` 通过；新增 `tests/peer-host-native-projection.spec.ts`、`tests/peer-host-native-store-projection.spec.ts`（就地投影、快照引用稳定、订阅转发、卸载还原），扩展 `tests/peer-host-native-connector.spec.ts`（`session/list` 合并、`$events` 本地回退）与 `tests/peer-host-native-protocol.spec.ts`（`session/follow` 流 ID 改写）。详见 `docs/开发记录/20260930-PeerHost远端资源改用原生界面记录.md`。
- 本次修复（2026-09-30 第二轮）：目标侧原生调用改走 DSH 自己的 `typertGateway`。此前把线上载荷 `{args:{...}}` 当作位置参数直接调用 `sessionController`：`session/list` 参数被静默忽略（cursor 丢失），`session/follow` 首帧即抛 `address.kind` 未定义，客户端记为 `session event stream ended before its opening cursor`。新增 `src/host/modules/peer-host/peer-host-native-dispatch.ts`（`invoke`/`stream` + `{args}` 解包 + 方法拆分诊断），`features/peer-host.ts` 的 `nativeLocal`/`nativeStreamOpen` 全部改用该派发；`peer-host-remote-summary-source.ts` 的 `session/list` 改为线上形状 `{args:{_request:{}}}`。
- 本次修复（2026-09-30 第二轮）：右侧文件面板接入转发。`DSH_NATIVE_REMOTE_METHODS` 新增 `workspaceFiles/changes|list|read|readBytes|stat`，并把 lookup 参数 `workspaceFileScopeId`（承载 SessionId）纳入虚拟/真实 Session 身份改写，避免 `lookup provider "workspaceFileScope" did not resolve the requested identity`。
- 本次修复验证（第二轮）：`pnpm test` 772 项通过（含构建）；`pnpm run typecheck` 通过；新增 `tests/peer-host-native-dispatch.spec.ts`（线上载荷解包、方法拆分、Gateway 缺失诊断），`tests/peer-host-remote-summary-source.spec.ts` 断言 `session/list` 的线上载荷形状。
- 本次修复（2026-09-30 第三轮）：虚拟工作区必须携带远端真实 `path`。右侧文件面板按工作区视图的 `path` 解析文件树根目录，而 DSH 的 `workspaceId` 本身就是 UUID（目标实测 `30aead24-…`、`f3c44ab5-…`），此前用 workspaceId 充当 path，导致目标端报 `no entry at "<workspaceId>"`（`workspace-file/not-found`）。`AggregateWorkspaceSource`/`AggregateWorkspaceSummary` 新增 `path`：远端摘要读 `workspace/follow` 首帧的 `path`（缺失退回 workspaceId），本地摘要读 workspaceRegistry 的 `path`/`cwd`；客户端投影改用真实路径，会话摘要 `cwd` 同步修正。
- 本次修复验证（第三轮）：直连目标实测——`workspaceFiles/list` + 真实路径 → 200 且 `entries=32`；同一调用改用 workspaceId → 精确复现 `no entry at "f3c44ab5-…"`；`pnpm test` 772 项通过（含构建）。
- 本次修复（2026-09-30 第四轮）：流通道对目标重启窗口做有限重试。重启 `dsh-stage0` 后页面立刻出现的 `PEER_HOST_PROXY_UNREACHABLE: 目标 Host 代理不可达` 并不是目标插件的业务错误，而是本机代理在连接级失败时生成的 502 信封——目标 LAN 监听由插件启动时创建，比 webserver 晚若干秒，启动窗口内的 `nativeStreamOpen`/`nativeStreamNext` 会直接失败并把已打开的会话流打断。`peer-host-native-transport.ts` 新增 `requestPeerHostStream()`：只对「502 + `PEER_HOST_PROXY_UNREACHABLE`」做最多 3 次退避重试（400ms/800ms），调用方 signal 中止即放弃；unary 调用与业务错误不重试，避免副作用重复执行。
- 本次修复验证（第四轮）：`pnpm test` 776 项通过（含构建），新增用例覆盖「两次连接级失败后成功」与「业务错误只调用一次」。
- 本次修复（第五轮）：登录端点 401 不再被映射成「登录态已失效」。实测目标对错误密码返回 `目标 Host 用户名或密码错误`，而客户端把登录端点的 401 统一按 SESSION_REQUIRED 文案展示，掩盖了真实原因；`PeerHostSessionService.request()` 现按路径区分文案。同时记录：重新保存「登录保护」设置会轮换 salt，旧 PeerHost 凭据立即失效（属预期）；记录进入 `session_required` 后，token 仍有效时点「测试/检查」重新握手即可回到 `ready`。验证：`pnpm test` 777 项通过（含构建）。
- 本次修复（2026-09-28）：管理 API 统一使用 `'/codingns'` RPC 通道并保留 HTTP 回退；原生导航缺失时只保留 `degraded` 状态，不再向 DSH 工作区树顶部注入错误节点。
- 本次修复（2026-09-28）：设置页遇到只读 SettingsScope/ConfigForm 镜像时改走 Host 自有 `settings/get`、`settings/set` 边界；存在 Host writer 时不再误禁用模块开关，PeerHost 可正常停用并触发资源清理。导航重绘同时清理旧版本遗留的顶部状态节点。
- 本次修复（2026-09-28）：远端资源 HTTP 请求适配器同步统一到 `'/codingns'` RPC 通道，并保留 `/api/codingns/peerHost/request` 回退，避免会话、文件、Git、终端和右侧工具在管理 RPC 修复后仍命中旧通道。
- 本次维护策略（2026-09-29）：移除 PeerHost Host/Client 的强制停用标记，允许用户在设置页启用已实现的管理、聚合摘要和降级链路；启用时会检查单插件 preboot shim 并提示刷新。原生 Workspace/Session Store 尚未接入时仍明确显示 `degraded/unsupported`，不会伪装成完整原生聚合。
- 补充验证：`node --test tests/peer-host-management.spec.ts tests/peer-host-ws-proxy.spec.ts tests/peer-host-native-session-ui.spec.ts`（含重连订阅恢复、缺失 sessionId 拒绝和旧面板错误隔离）。
- 本次增量（2026-09-28）：Client WebSocket 工厂增加浏览器标准 `addEventListener` 适配，确保真实浏览器能够收到 `open/message/close/error` 事件；管理测试新增标准 WebSocket fake 回放。
- 补充验证：`node --test tests/peer-host-management.spec.ts`（17 项通过）；`pnpm run typecheck`；`git diff --check`。
- 已完成增量：新增 Host 侧 LAN Host-to-Host WebSocket connector，固定连接目标 DSH `/ws` 工作台端点，在 Host 出站握手注入目标 access token，并把完整 HostScope 传入代理；connector 不接受 Client URL 或凭据。Client 事件流现已严格校验 `hostId`、`targetHostId`、`workspaceId`、`sessionId`、`scopeGeneration`，切换/关闭时清理订阅；事件发送入口仅允许 WS 白名单消息并自动注入作用域。断线采用有界指数退避重连，重连失败不会无限创建定时器。
- 改动文件：`src/client/peer-host-scoped-client.ts`、`src/client/peer-host-session-controller.ts`、`src/client/host-router.ts`、`src/client/features/types.ts`、`src/client/index.ts`、`src/host/modules/peer-host/host-api-proxy-service.ts`、`src/host/modules/peer-host/host-ws-connector.ts`、`src/host/modules/peer-host/host-ws-proxy-service.ts`、`src/host/modules/peer-host/peer-host-session.ts`、`src/host/features/peer-host.ts`、`src/host/rpc.ts`、`tests/peer-host-management.spec.ts`、`tests/peer-host-http-proxy.spec.ts`、`tests/peer-host-ws-connector.spec.ts`、`tests/peer-host-ws-proxy.spec.ts`
- 验证命令：`node --test tests/peer-host-management.spec.ts`（10 项通过，含 HostScope 过滤、终端/右侧工具 WS 消息和有限重连）；`node --test tests/peer-host-ws-connector.spec.ts tests/peer-host-ws-proxy.spec.ts tests/peer-host-ws-gateway.spec.ts`；`pnpm run build`
- 已知限制：已建立带 HostScope 的 HTTP 会话请求适配器、会话控制器、LAN Host-to-Host connector 和插件自有 WebSocket upgrade 入口，可加载历史并在 generation 失效时拒绝旧结果；HTTP 401 与 WS 401/403 会清理该 PeerHost 凭据并转为 `session_required`。原生 DSH 会话导航 store、聊天 UI 和消息写入由独立 UI 适配器接入；本客户端重连沿用当前 generation，generation 重建与摘要刷新必须由上层 HostRouter/会话协调器执行。relay connector 仍保持明确不可用。插件自有网关继续作为当前 Host 的 Client 入口，connector 固定连接目标 DSH `/ws`，不把出口网关当作目标 Host 入站端点。
- 全量回归（2026-09-28）：`pnpm test` 共 566 项，563 项通过、2 项按环境跳过；唯一失败为既有 `tmux-backend` 真实会话在受限环境关闭 socket 时收到 `Operation not permitted`，与 PeerHost 改动无关。
- 对应需求和设计章节：需求 7、9、10、11；设计 §6、§7、§8、§10.1
- 做什么：打开 PeerHost 会话时加载目标历史、订阅实时事件，并将消息写入正确 HostScope。
- 做完看到什么：中栏显示目标 Host 的历史和新消息，切回当前 Host 后旧流停止。
- 依赖什么：3.1、3.2、4.1、4.2；现有 session store 和 remote Web runtime。
- 先看哪些文档：`requirements.md` 需求 9；`design.md` §10.1。
- 主要改哪些文件：`src/client/session/`、`src/client/remote-web-context.ts`、WS adapter、测试。
- 明确不做什么：不把远端消息复制到当前 Host 的持久会话，不用全局 activeHost 推断路由。
- 怎么验证：历史、增量、错误、权限请求、会话删除、切换和旧消息丢弃测试。

### 6B.2 路由聊天发送、停止和权限回复（降级/验证）

- 状态：`IN_PROGRESS`
- 本次增量（2026-09-28）：原生会话节点提供作用域绑定的发送、停止、权限回复和问题回答控件，所有操作直接调用 `PeerHostSessionController`，不接受客户端 target URL/token；发送 Enter、按钮事件均使用当前 HostScope。
- 本次增量（2026-09-28）：`PeerHostSessionController` 的四类命令均在请求前后校验当前 generation；补充切换作用域后发送、停止、权限回复和问题回答的旧结果丢弃测试。新增 `rebuildAfterReconnect` 协调接口，重连成功时强制重建 HostRouter generation、清理旧订阅，并在新作用域上执行可选摘要刷新回调。
- 验证：`pnpm run typecheck`；`pnpm run build`；`node --test tests/peer-host-native-session-ui.spec.ts`（降级路径与无选中会话拒绝通过）。
- 改动文件：`src/client/peer-host-scoped-client.ts`、`src/client/peer-host-session-controller.ts`、`src/client/features/types.ts`、`src/client/index.ts`、`src/host/modules/peer-host/host-api-proxy-service.ts`、`src/host/features/peer-host.ts`、`tests/peer-host-management.spec.ts`
- 验证命令：`node --test tests/peer-host-management.spec.ts`（13 项通过，含四类聊天命令 stale 丢弃与重连 generation 重建）；`pnpm run typecheck`；`pnpm run build`
- 已知限制：已提供发送、停止、权限回复和问题回答的 HostScope HTTP 薄封装，并由会话控制器统一校验当前作用域；重连后的摘要刷新由调用方回调负责，控制器不会复制远端消息到当前 Host 持久会话；未登记的 DSH 原生 command 仍保持明确 unsupported。
- 对应需求和设计章节：需求 9、10、11；设计 §5.2、§6、§7、§10
- 做什么：让发送消息、停止运行、回答问题和权限回复携带目标 HostScope 并通过 PeerHost 代理执行。
- 做完看到什么：聊天框操作进入目标 Host，当前 Host 会话不会收到误发消息。
- 依赖什么：6.1；工作台消息协议和 HTTP/WS 白名单。
- 先看哪些文档：`requirements.md` 需求 9；`design.md` §7、§10。
- 主要改哪些文件：聊天输入组件、session command adapter、相关契约和测试。
- 明确不做什么：不允许用户在请求体中覆盖 targetHostId 或目标 URL。
- 怎么验证：发送、停止、权限、问答、超时和目标登录过期测试。

### 6B.3 路由文件、Git、终端和右侧工具（降级/验证）

- 状态：`IN_REVIEW`
- 本次增量（2026-09-28）：原生会话面板新增作用域绑定的终端订阅、输入、调整大小、关闭和右侧工具订阅/刷新/关闭控件；这些操作通过当前 PeerHost WebSocket 订阅发送，未建立实时通道时明确显示降级，不回退到当前 Host。新增 `peerHost/aggregate` 固定 RPC 入口，Feature 启动时只用 Host 返回的摘要和自有 WS endpoint 装配导航/工具链路。
- 改动文件：`src/client/peer-host-scoped-client.ts`、`src/client/peer-host-session-controller.ts`、`src/client/peer-host-native-session-ui.ts`、`src/client/peer-host-management-api.ts`、`src/client/features/types.ts`、`src/client/index.ts`、`src/client/features/peer-host.ts`、`src/host/modules/peer-host/host-api-proxy-service.ts`、`src/host/modules/peer-host/peer-host-aggregate-service.ts`、`src/host/features/peer-host.ts`、`src/host/rpc.ts`、`tests/peer-host-management.spec.ts`
- 验证命令：`node --test tests/peer-host-management.spec.ts tests/peer-host-native-session-ui.spec.ts`（13 项通过）；`pnpm run typecheck`；`pnpm run build`
- 已知限制：HTTP 适配器已覆盖文件读写、Git 状态、终端和右侧工具固定路径，并统一绑定 HostScope；工具控件仍是 DSH 原生工具 Slot 不可用时的插件节点，不能宣称已替换 DSH 内部工具 Store。未登记消息明确返回 `PEER_HOST_TOOL_UNSUPPORTED`；作用域切换由 HostRouter 清理订阅。
- 对应需求和设计章节：需求 10、11；设计 §6、§7、§8、§10.2
- 做什么：将右侧栏打开/刷新/关闭、文件树、Git、终端和已登记工具绑定到目标 HostScope。
- 做完看到什么：远端文件、Git 状态、终端输出和右侧结果来自目标 Host 的运行时。
- 依赖什么：3.1、3.2、6.1；各工具能力和白名单。
- 先看哪些文档：`requirements.md` 需求 10；`design.md` §6、§7、§10.2。
- 主要改哪些文件：`src/client/features/` 相关工具模块、右侧栏 adapter、Host proxy 白名单和测试。
- 明确不做什么：不把远端路径当作当前 Host 本地路径，不对未登记工具静默降级。
- 怎么验证：作用域隔离、工具切换清理、终端输入/resize、文件读写、Git 刷新和 unsupported 错误测试。

## 阶段 7：中转 PeerHost、断线恢复和运行时治理

### 7.1 验证 Host-to-Host 中转能力

- 状态：`BLOCKED`
- 已完成增量：新增 `peer-host-relay.ts` 的受控 relay connector。它只接受 Host 侧显式注入且 `transportVersion` 匹配的已验证 Transport 工厂，稳定的 `deviceId`/`relayEntryId` 只作为路由标识传递，不解析任意 URL，不持久化短期 ticket；未注入适配器或版本不匹配时返回 `PEER_HOST_RELAY_UNAVAILABLE`，保持 `relay_unavailable/degraded`。
- 改动文件：`src/host/modules/peer-host/peer-host-relay.ts`、`src/host/modules/peer-host/host-ws-connector.ts`、`src/host/features/peer-host.ts`、`tests/peer-host-relay.spec.ts`
- 验证命令：`pnpm run build && node --test tests/peer-host-relay.spec.ts`（4 项通过）；`pnpm run typecheck`
- 已知限制：当前仓库已有的 Relay Transport 是 DSH 二进制 `DshGateway`，尚无经过验证的 Host-to-Host 工作台 JSON/WS 适配层；因此默认和三版本 fixture 仍保持中转不可用，不能将浏览器短期 ticket 或任意公网地址伪装为 PeerHost relay。
- 阻塞原因：没有可验证的 Host 侧工作台 JSON/WS Relay Transport；在补齐该 Transport 前，relay 必须保持 `relay_unavailable/degraded`，不得标记 ready。
- 做什么：确认当前中转 Transport 是否支持 Host 到目标 Host 的双向连接、认证转发和断线恢复。
- 做完看到什么：能力矩阵明确 relay PeerHost 是 ready、degraded 还是 unavailable。
- 依赖什么：阶段 2、3 的局域网路径；中转 Transport 文档和真实 fixture。
- 先看哪些文档：`requirements.md` 需求 4、11；父仓库对照文档；现有中转调查报告。
- 主要改哪些文件：`src/dsh-capabilities/` relay route、`src/host/` relay adapter、fixture 和调查文档。
- 明确不做什么：不把浏览器端短期 ticket 直接转发给目标 Host，不用任意公网 URL 替代中转能力。
- 怎么验证：真实/模拟中转握手、双向 WS、断线、重连、ticket 脱敏和能力缺失测试。

### 7.2 实现断线、重连和状态刷新

- 状态：`IN_PROGRESS`
- 已完成增量：新增 `PeerHostReconnectManager`，管理单 PeerHost 的 `connecting/ready/reconnecting/unreachable/relay_unavailable/stopped` 状态，使用有界指数退避和最大尝试次数；断线后下一次连接只提升该作用域 generation，重连成功触发状态回调并返回新的完整 `HostScope` 快照，关闭时清理 timer、socket 和内存中的短期凭据。PeerHost Feature 已注册 manager 资源清理，并通过 connector 入口接入 LAN/受控 relay 生命周期。
- 本次增量（2026-09-28）：Client `HostRouter.rebuild` 和 `PeerHostSessionController.rebuildAfterReconnect` 已接入重连状态回调边界；重连成功后旧 HostScope disposer/WS 订阅先清理，再递增 Client generation，调用方可在返回的新作用域上刷新摘要并重新订阅。
- 本次增量（2026-09-28）：Client 事件流关闭时同时清理 CONNECTING 和已打开的 socket；重连等待打开超时或作用域关闭时不会遗留 pending socket，且恢复连接后自动重放幂等订阅。
- 本次修复（2026-09-28）：PeerHost Client 启动时对 WS endpoint 做结构防御，非法端点转为降级而不使 Feature 进入启动失败，确保设置开关仍可停用并释放资源。
- 改动文件：`src/host/modules/peer-host/peer-host-relay.ts`、`src/host/features/peer-host.ts`、`tests/peer-host-relay.spec.ts`
- 验证命令：`pnpm run build && node --test tests/peer-host-relay.spec.ts`（4 项通过）；`pnpm run typecheck`
- 已知限制：当前 WebSocket 代理客户端连接关闭后不能在同一个浏览器 socket 上替换远端 socket；manager 负责 Host 侧连接状态和资源治理，UI/session adapter 必须消费新的 `HostScope` 并重新订阅，不能复用旧 generation。relay Transport 未验证时仍保持 `relay_unavailable/degraded`。
- 做什么：为单个 PeerHost 提供有界重试、手动重连、摘要刷新和可恢复订阅。
- 做完看到什么：目标不可达显示真实状态，恢复后只刷新该 Host 并恢复允许的会话流。
- 依赖什么：4.1、4.2、7.1；Host 状态机和 WS 生命周期。
- 先看哪些文档：`requirements.md` 需求 11；`design.md` §7.3、§11。
- 主要改哪些文件：PeerHost service、aggregate store、WS reconnect manager、测试。
- 明确不做什么：不无限创建计时器，不用过期缓存伪装成可用数据。
- 怎么验证：超时、断线、指数退避上限、恢复 generation、单 Host 隔离和模块停用清理测试。

### 7.3 增加运行时诊断和隐私检查

- 状态：`DONE`
- 已完成增量：新增 PeerHost 诊断快照与默认关闭的诊断 sink，仅输出 `peerHostId`、路由类型、状态、稳定错误码、检查时间和脱敏 fingerprint；新增固定错误码文案，网络/Transport 底层异常不再回显原始消息。Transport 调试 logger 改为正向元数据白名单，丢弃 token、password、authorization、Cookie、完整 baseUrl、relay ticket、文件路径/内容、命令、模型正文和错误详情。未知 WS connector 异常统一收敛为 `PEER_HOST_PROXY_UNREACHABLE`。
- 改动文件：`src/host/modules/peer-host/peer-host-diagnostics.ts`、`src/host/modules/peer-host/peer-host-handshake.ts`、`src/host/modules/peer-host/host-ws-proxy-service.ts`、`src/host/features/peer-host.ts`、`src/host/rpc.ts`、`src/host/index.ts`、`src/client/peer-host-management-api.ts`、`src/transport/debug.ts`、`tests/peer-host-privacy.spec.ts`
- 验证命令：`pnpm run build && node --test tests/peer-host-privacy.spec.ts tests/transport-debug.spec.ts tests/peer-host-security.spec.ts`（10 项通过）；`pnpm run typecheck`；`git diff --check`
- 已知限制：诊断 RPC 只返回脱敏快照；默认不输出诊断日志，只有显式设置 `CODINGNS4DSH_DEBUG=1` 才写入 Host 控制台。完整文件、命令和模型消息仍不进入诊断数据结构。
- 做什么：补充 PeerHost 状态诊断、性能指标和日志敏感字段扫描。
- 做完看到什么：维护者能定位握手、代理、作用域和中转失败，同时日志不含凭据和内容数据。
- 依赖什么：全部前置阶段；现有 resource-scope debug log 规范。
- 先看哪些文档：`requirements.md` 需求 12；`design.md` §11、§12。
- 主要改哪些文件：诊断 DTO、日志工具、`tests/peer-host-privacy.spec.ts`、文档。
- 明确不做什么：不采集完整文件、命令、模型消息或 relay ticket。
- 怎么验证：敏感字段断言、错误码覆盖、诊断接口权限和性能计时测试。

## 阶段 8：完整验证、文档和验收

### 8.1 三版本、多场景和 Aggregated Host 原生集成测试

- 状态：`TODO`
- 已有降级集成 fixture 保留，但不再等同于原生聚合验收；必须在 6A.1 至 6A.7 完成后补充 Aggregated Host Transport、虚拟 Registry、本地原生 Store 和多 Host 工具回放。
- 当前验证（2026-09-29）：`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、`pnpm run build` 通过；PeerHost Aggregated Transport、原生 Remote 协议、虚拟 Registry、boot fixture 定向测试通过。完整 `pnpm test` 共 685 项，681 项通过、3 项跳过、1 项失败；失败为受限环境 Host relay 测试绑定 `0.0.0.0` 时的 `Operation not permitted`，与 PeerHost 聚合改动无关。
- 做什么：把当前 Host、局域网 PeerHost、中转 PeerHost、未登录、版本不兼容、fingerprint 变化和断线恢复串成集成 fixture。
- 做完看到什么：一套可重复测试证明单 Host 行为未被破坏，多 Host 作用域正确。
- 依赖什么：阶段 1 至 7、阶段 6A.1 至 6A.7。
- 先看哪些文档：`requirements.md` 全部需求；`design.md` §13、§14。
- 主要改哪些文件：`tests/peer-host-integration.spec.ts`、三版本 fixture、测试脚本。
- 明确不做什么：不依赖未锁定的公网 Host 或不可重复的人工环境。
- 怎么验证：`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、`pnpm test`。

### 8.2 文档、能力报告和索引同步

- 状态：`DONE`
- 本次增量（2026-09-29）：回写 Aggregated Host 架构决策、本地插件基线、虚拟 Workspace/Session Registry、原生 Client boot 接入门槛和 6A.1 至 6A.7 后续任务；旧 DOM/适配器实现明确降级为验证路径。
- 完成记录（2026-09-28）：同步 Spec README、仓库 README、AGENTS Spec 索引、能力报告生成脚本与报告产物；新增 PeerHost 能力与中转边界调查、聚合与断线重连开发记录。文档明确 LAN connector、HostScope/generation、实时工具、有限重连和隐私诊断的已验证边界，并明确真实 DSH source、三版本 fixture、原生容器缺失和 relay Transport 未验证时的降级状态。
- 改动文件：`AGENTS.md`、`README.md`、`specs/spec006-PeerHost管理与多Host工作区会话聚合/README.md`、`scripts/generate-capability-report.mjs`、`docs/生成报告/20260925-能力路由报告.md`、`docs/调查报告/20260928-PeerHost能力与中转边界调查.md`、`docs/开发记录/20260928-PeerHost聚合与断线重连实现记录.md`、`docs/开发记录/20260929-DSH原生Remote协议白名单与虚拟ID改写记录.md`
- 验证命令：`pnpm run capability:report`；`pnpm run capability:check`；`git diff --check`；文档路径与 Spec 索引扫描通过。
- 做什么：更新能力报告、README、AGENTS Spec 索引、调查报告和开发记录，记录已实现能力与降级边界。
- 做完看到什么：新成员能从 Spec、能力矩阵和验证证据追踪 PeerHost 的完整边界。
- 依赖什么：8.1 及各阶段完成证据。
- 先看哪些文档：仓库 `AGENTS.md` 文档规范；本 Spec README、设计和父仓库对照文档。
- 主要改哪些文件：`AGENTS.md`、`README.md`、`docs/生成报告/`、`docs/开发记录/` 和本 Spec 文档。
- 明确不做什么：不手工编辑脚本生成产物，不删除已有 Spec 引用。
- 怎么验证：链接检查、`git diff --check`、能力报告生成和文档路径扫描。

### 8.3 发布前回归与验收签字

- 状态：`TODO`
- 做什么：逐条对照需求 1 至 15 验收标准，确认本地 UI/插件基线、Aggregated Host 原生 Store、混合顺序、适配器能力和未支持工具边界。
- 做完看到什么：需求 1 至 15、非功能需求和成功定义都有测试或明确证据。
- 依赖什么：6A.7、8.1、8.2；用户确认的 fingerprint 信任策略和中转能力结论。
- 先看哪些文档：`requirements.md` 验收标准、`design.md` 风险项、所有测试报告。
- 主要改哪些文件：本 Spec `tasks.md`、验收记录文档、必要的调查报告。
- 明确不做什么：不在没有证据时把降级能力标记为 ready，不执行提交、推送或发布。
- 怎么验证：完整四项验证命令、验收清单逐项勾选和 `git diff --check`。

- 本次修复（2026-09-30）：修复"远端会话历史打不开（session event stream ended before its opening cursor）"。用 Playwright 从浏览器驱动复现并抓包，确认第一次 `peerHost/nativeStreamNext` 即返回 `{"done":true}`：`nativeStream` 分支误绑了本次 HTTP 请求的 `rpcContext.signal`，该 signal 在响应返回后立即中止，导致聚合流第一轮循环即结束；`nativeStreamOpen` 分支本就未绑定（句柄由 `nativeStreamNext/Close` 轮询管理）。修复：`nativeStream` 不再传入请求 signal；`nativeStreamNext` 改为每次轮询续期存活窗口（空闲会话的 `next` 会长时间挂起），窗口收敛为 `NATIVE_STREAM_TTL_MS = 600_000`。对照证据：同一载荷直连目标 LAN 入口的 `session/follow`（四种载荷变体含应用原样）均返回 `snapshot`，经本机 Host 转发在修复前一律 `done:true`。`pnpm test` 777 项通过（含构建），`pnpm run typecheck` 通过。详见 `docs/开发记录/20260930-PeerHost远端资源改用原生界面记录.md`。

- 本次修复（2026-09-30）：右侧「文件管理」「终端」面板接入原生转发。`terminal` 命名空间（`environment/list/create/follow/write/resize/close/rename/retain/shells`）登记进 `DSH_NATIVE_REMOTE_METHODS`：面板挂载时会先经 `terminal.environment(sessionId)` 解析会话环境，此前该调用落到本机 Host，虚拟会话解析不到，表现为"当前 Session 没有关联 Workspace"与面板空白。`pnpm test` 777 项通过（含构建），协议测试补充终端方法登记断言。详见 `docs/开发记录/20260930-PeerHost远端资源改用原生界面记录.md`。

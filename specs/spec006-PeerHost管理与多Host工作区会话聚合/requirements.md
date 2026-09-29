# 需求文档 - PeerHost 管理与多 Host 工作区会话聚合

状态：原始受控代理和 DOM 适配器已完成部分实现；Aggregated Host 原生聚合主线已接入单插件 preboot、原生列表 Store 和 Remote connector，当前进入真实 DSH Web Conversation 回放验收。

## 简介

用户已经可以通过局域网入口或中转入口访问一台 DSH Host，但每个入口仍然只能看到当前 Host 的工作区和会话。对于同时运行多台 DSH Host 的用户，这会造成三个实际问题：

1. 需要在不同页面或不同地址之间切换，无法统一查找工作区和会话。
2. 不同 Host 可能有相同的 `workspaceId` 或 `sessionId`，页面容易把消息、文件、终端和右侧面板串到错误的机器。
3. 目标 Host 的登录态、版本兼容性和断线状态没有清晰的管理入口。

本 Spec 要求当前 Host 以受控代理的方式管理其他已安装本插件的 DSH Host，并通过 Aggregated Host 向本地 DSH Client 暴露统一的 Workspace、Session、Conversation 和工具数据面。Client/UI/插件 Bundle 只使用当前 Host 的版本和状态；远端 Host 只提供执行能力，不参与插件 Bundle 或 UI Slot 合并。

## 术语表

- **当前 Host**：浏览器当前已经连接和登录的 DSH Host，也是 PeerHost 代理的入口。
- **PeerHost**：当前 Host 保存的一条目标 DSH Host 记录，目标必须安装本插件并通过握手检查。
- **目标 Host**：某次请求真正执行的 DSH Host；当前 Host 请求使用 `targetHostId = null`，PeerHost 请求使用具体 ID。
- **Host 作用域**：由 `hostId`、`workspaceId`、可选 `sessionId` 和 `scopeGeneration` 组成的资源身份。
- **聚合导航**：将当前 Host 和已启用 PeerHost 的工作区/会话摘要合并到一个 Client 导航树中。
- **受控代理**：当前 Host 只转发明确登记的 DSH API、WebSocket 路径和消息类型。
- **Host 标签**：显示在工作区名称后的目标 Host 名称或别名，用于区分相同名称的工作区。
- **Aggregated Host**：对 DSH Client 表现为单一 Host、对后端路由当前 Host 和多个 PeerHost 的 Host 适配层。
- **虚拟资源 ID**：带 Host 命名空间的 Workspace/Session ID，例如 `peer-a:workspace-1`，只在聚合数据面中使用。
- **本地插件基线**：当前 Host 已加载的 DSH/CodingNS Client Bundle、Feature、Slot 和设置；远端独有插件不进入本 Spec。

## 范围说明

### In Scope

- 独立的“管理其他 DSH Host”功能模块和设置卡片。
- 右下角连接管理按钮、PeerHost 列表和状态详情。
- 局域网 URL 与中转入口两种 PeerHost 路由模型。
- PeerHost 地址规范化、重复检查、握手、版本/API 兼容和 fingerprint 校验。
- 目标 Host 登录、刷新、退出和凭据的 Host 侧加密保存。
- 工作区、会话、文件、Git、终端和右侧工具所需的受控 HTTP/WS 代理。
- 当前 Host 与 PeerHost 工作区/会话的聚合展示和 Host 标签。
- 远端会话的消息记录、聊天输入、实时事件和右侧栏结果路由。
- 通过 Aggregated Host 让本地 DSH 原生 Workspace、Session、Conversation、终端和右侧工具消费虚拟资源。
- 本地 CodingNS 插件调用多个目标 Host 的适配器对话，并按目标能力显示 `unsupported`。
- 断线、版本变化、登录过期、作用域切换和旧结果丢弃。

### Out of Scope

- 跨 Host 复制文件、迁移会话、同步配置或合并历史数据。
- 任意 URL、任意 Host、任意 WebSocket 消息的通用代理。
- PeerHost 之间的递归代理、代理链路和自动拓扑发现。
- 目标 Host 插件 Bundle 写入当前 Host 的 Profile 或全局 Plugin Loader。
- 远端独有插件、远端 UI Slot、远端设置和远端 Client Bundle 的合并或加载。
- 改变当前 Host 的登录语义、局域网访问语义或中转访问语义。
- 用一个裸 `workspaceId` 或裸 `sessionId` 作为跨 Host 全局主键。

## 需求

### 需求 1：功能模块必须可独立启停

**用户故事：** 作为用户，我希望单独开启或关闭 PeerHost 管理，以便不使用多 Host 时不增加页面和连接负担。

#### 验收标准

1. WHEN 用户启用“管理其他 DSH Host”模块 THEN System SHALL 启动 PeerHost 管理、状态检查、聚合导航和作用域路由所需的 Client/Host 资源。
2. WHEN 用户关闭模块 THEN System SHALL 移除右下角连接管理按钮、停止 PeerHost 轮询和实时订阅，并关闭该模块创建的临时连接。
3. WHEN 模块关闭 THEN System SHALL 保留已保存 PeerHost 配置和目标登录态，但不得继续向页面提供 PeerHost 工作区或会话。
4. WHEN 当前 DSH 版本不具备本模块声明的必需能力 THEN System SHALL 只禁用 PeerHost 模块并显示版本/能力原因，不得影响当前 Host 的登录、局域网和中转访问。

### 需求 2：用户必须能管理 PeerHost 记录

**用户故事：** 作为需要使用多台机器的用户，我希望在当前 DSH 中添加、编辑、检查、重连和删除其他 DSH Host。

#### 验收标准

1. WHEN 用户打开连接管理入口 THEN System SHALL 显示当前 Host、PeerHost 名称、路由类型、连接状态、远端版本和最近检查时间。
2. WHEN 用户添加 PeerHost THEN System SHALL 保存名称、路由配置、创建时间和更新时间，并拒绝空名称、非法地址和重复目标。
3. WHEN 用户编辑 PeerHost 地址 THEN System SHALL 清除旧的握手结果和目标登录态，要求重新检查和登录。
4. WHEN 用户删除 PeerHost THEN System SHALL 删除该 PeerHost 的配置、目标登录态、工作区绑定和本地聚合缓存。
5. WHEN 用户点击右下角连接管理按钮 THEN System SHALL 在不离开当前 DSH 工作区的情况下打开管理面板。

### 需求 3：PeerHost 必须通过目标 Host 握手检查

**用户故事：** 作为维护者，我希望只能连接安装了兼容版本本插件的 DSH Host，避免代理到错误服务或不兼容接口。

#### 验收标准

1. WHEN 添加或检查 PeerHost THEN System SHALL 读取目标 Host 的产品标识、插件版本、DSH 版本、API 兼容标识和 Host fingerprint。
2. WHEN 目标 Host 未安装本插件 THEN System SHALL 标记为 `plugin_missing` 并禁止代理。
3. WHEN 目标 Host 的 DSH 版本或 API 兼容标识不满足矩阵 THEN System SHALL 标记为 `version_mismatch` 并禁止代理。
4. WHEN 目标 Host fingerprint 与已保存身份不一致 THEN System SHALL 清理该 PeerHost 的目标登录态并标记为 `identity_changed`。
5. WHEN 握手成功 THEN System SHALL 记录检查时间、兼容信息和 fingerprint，状态转为 `ready`。
6. WHEN 握手失败 THEN System SHALL 保留用户配置但不得把失败目标伪装成空工作区或可用 Host。

### 需求 4：局域网和中转路由必须使用统一 PeerHost 身份

**用户故事：** 作为用户，我希望目标 Host 无论通过局域网还是中转访问，都在工作区和会话中表现为同一个 Host。

#### 验收标准

1. WHEN 用户添加局域网 PeerHost THEN System SHALL 保存规范化的 HTTP/HTTPS 地址，并通过当前 Host 访问目标。
2. WHEN 用户添加中转 PeerHost THEN System SHALL 保存稳定的设备或绑定标识以及中转配置，不把短期 ticket 当作持久身份。
3. WHEN 同一目标同时存在局域网地址和中转入口 THEN System SHALL 将它们归并到同一个逻辑 PeerHost，并按配置和健康状态选择路由。
4. WHEN 直连路由不可用而中转路由已获明确授权 THEN System SHALL 允许受控回退，并在状态详情中显示当前路由。
5. WHEN 中转链路尚未具备 Host 侧连接能力 THEN System SHALL 显示“中转 PeerHost 暂不可用”，不得静默退回任意公网 URL。

### 需求 5：目标 Host 登录态必须留在当前 Host

**用户故事：** 作为用户，我不希望浏览器保存多台 Host 的 token，也不希望一台 Host 的登录态污染另一台 Host。

#### 验收标准

1. WHEN 用户登录 PeerHost THEN System SHALL 将目标 access token、refresh token 和过期时间只保存到当前 Host 的敏感信息存储中。
2. WHEN Client 发起 PeerHost 请求 THEN System SHALL 只携带 `targetHostId`，不得携带目标 token、密码或目标 base URL。
3. WHEN 目标 access token 过期 THEN System SHALL 由当前 Host 使用目标 refresh token 尝试刷新。
4. WHEN 目标登录态失效 THEN System SHALL 只清理该 PeerHost 的会话并返回 `session_required`，不得清理当前 Host 登录态。
5. WHEN PeerHost 被删除、地址改变或 fingerprint 改变 THEN System SHALL 清理对应目标登录态。

### 需求 6：代理必须有明确的 HTTP/WS 白名单

**用户故事：** 作为维护者，我希望 PeerHost 不会变成任意内网访问器或公网代理。

#### 验收标准

1. WHEN 请求 PeerHost HTTP 代理 THEN System SHALL 校验当前用户、PeerHost 所有权、握手状态和目标登录态。
2. WHEN 请求路径不在 DSH 工作区、会话、文件、Git、终端或右侧工具白名单 THEN System SHALL 拒绝请求。
3. WHEN 请求方法、请求体大小、查询参数或响应头违反白名单 THEN System SHALL 拒绝请求或截断为稳定错误。
4. WHEN 打开 PeerHost WebSocket THEN System SHALL 校验固定路径、消息类型、工作区作用域和会话作用域。
5. WHEN 收到未登记的客户端或远端消息类型 THEN System SHALL 只向当前连接返回错误，不广播给其他 Host 或会话。
6. WHEN 代理失败 THEN System SHALL 返回带 PeerHost 标识和错误类别的稳定错误码，不泄露 token、密码、完整消息或文件内容。

### 需求 7：所有跨 Host 资源必须带作用域

**用户故事：** 作为用户，我希望不同 Host 中同名工作区或相同 ID 的会话不会串线。

#### 验收标准

1. WHEN 系统创建工作区、会话、文件、Git、终端或右侧工具请求 THEN System SHALL 使用 `hostId + workspaceId`，会话请求额外使用 `sessionId`。
2. WHEN 页面切换 Host、工作区或会话 THEN System SHALL 递增 `scopeGeneration`，并先使旧作用域失效。
3. WHEN 旧作用域的异步请求或实时消息返回 THEN System SHALL 丢弃结果，不得写入新作用域页面。
4. WHEN 缓存、订阅或连接建立 THEN System SHALL 使用作用域 key，禁止使用裸 `workspaceId` 或裸 `sessionId`。
5. WHEN 目标 Host 不可用 THEN System SHALL 在对应工作区或会话条目上显示不可用状态，不得返回空列表冒充无数据。

### 需求 8：工作区和会话必须聚合显示并带 Host 标签

**用户故事：** 作为用户，我希望在一个工作区导航中看到多台 DSH Host 的工作区和会话，并且一眼知道资源来自哪台机器。

#### 验收标准

1. WHEN PeerHost 模块启用且至少有一个可用 PeerHost THEN System SHALL 加载当前 Host 与 PeerHost 的工作区/会话摘要。
2. WHEN 工作区名称显示在导航中 THEN System SHALL 在名称后显示稳定的 Host 标签；当前 Host 也必须有可识别标签或默认标记。
3. WHEN 不同 Host 存在同名工作区或相同 `workspaceId` THEN System SHALL 分别显示并分别生成稳定 DOM/React key。
4. WHEN 某个 PeerHost 检查中、不可达或版本不兼容 THEN System SHALL 保留 Host 节点和错误状态，不得阻塞其他 Host 的导航加载。
5. WHEN PeerHost 工作区摘要刷新 THEN System SHALL 合并新数据、删除远端已删除项，并保持当前选中作用域不被错误替换。

### 需求 9：打开远端会话后中栏和聊天输入必须路由正确

**用户故事：** 作为用户，我希望点击 PeerHost 会话后看到的是目标 Host 的消息记录，并且发送的消息确实进入目标 Host。

#### 验收标准

1. WHEN 用户打开带 PeerHost 作用域的会话 THEN System SHALL 使用目标 Host 的会话历史和实时事件初始化中栏。
2. WHEN 用户发送消息、停止运行、回复权限请求或回答问题 THEN System SHALL 将请求路由到该会话所属的 `targetHostId`。
3. WHEN 远端会话实时产生消息、状态、权限或错误事件 THEN System SHALL 只更新对应 Host/Workspace/Session 作用域。
4. WHEN 用户从 PeerHost 会话切回当前 Host 会话 THEN System SHALL 关闭或失效旧实时订阅，旧消息不得继续追加到当前 Host 会话。
5. WHEN 远端会话缺失或被删除 THEN System SHALL 显示目标 Host 的可读错误，并回退到同一 Host 的工作区会话列表，不得跳到另一 Host 的同名会话。

### 需求 10：右侧栏和工具链路必须继承会话作用域

**用户故事：** 作为用户，我希望远端会话打开文件、Git、终端和其他右侧工具时，看到的都是目标 Host 的结果。

#### 验收标准

1. WHEN 当前会话来自 PeerHost THEN System SHALL 将右侧栏打开、刷新、关闭和订阅操作绑定到该会话的 Host/Workspace 作用域。
2. WHEN 远端工作区打开文件或 Git 面板 THEN System SHALL 通过目标 Host 代理执行读写和状态查询。
3. WHEN 远端工作区使用终端或调试面板 THEN System SHALL 使用目标 Host 的运行时、路径和操作系统能力，不得复用当前 Host 的本地路径。
4. WHEN 右侧工具切换到另一个 Host 或工作区 THEN System SHALL 关闭旧工具实时连接并清理旧快照。
5. WHEN 某项工具尚未纳入 PeerHost 白名单 THEN System SHALL 显示明确的功能不可用状态，不得静默请求当前 Host。

### 需求 11：断线、重连和状态刷新必须可解释

**用户故事：** 作为用户，我希望目标 Host 暂时不可用时能看到真实状态，并在恢复后继续使用，而不是看到过期的假数据。

#### 验收标准

1. WHEN PeerHost 连接断开 THEN System SHALL 将其状态标记为 `unreachable` 或 `reconnecting`，并保留最后一次检查时间。
2. WHEN PeerHost 重连成功 THEN System SHALL 创建新的 generation，刷新工作区/会话摘要并恢复允许恢复的订阅。
3. WHEN PeerHost 重连失败 THEN System SHALL 使用有界重试或显式手动重连，不得无限创建计时器或连接。
4. WHEN 目标 Host 版本或 fingerprint 变化 THEN System SHALL 在下一次检查或请求前阻止业务代理。
5. WHEN 当前 Host 重启或模块停用 THEN System SHALL 释放所有 PeerHost 临时连接，但保留可恢复的持久记录。

### 需求 12：兼容性、隐私和可维护性必须可验证

**用户故事：** 作为维护者，我希望 PeerHost 的版本、能力和安全边界可以通过检查和测试持续验证。

#### 验收标准

1. WHEN 新增 DSH 版本或 PeerHost 路由 THEN System SHALL 通过能力矩阵声明对应能力，不得在业务模块散落版本判断。
2. WHEN 运行日志、诊断和错误采集 THEN System SHALL 不包含密码、token、完整文件内容、完整命令、模型消息或中转 ticket。
3. WHEN 执行验证命令 THEN System SHALL 覆盖当前 Host、局域网 PeerHost、不可达 PeerHost、版本不兼容 PeerHost、目标登录失效和旧作用域回写。
4. WHEN PeerHost 模块代码被停用或卸载 THEN System SHALL 不影响当前 Host 原有局域网、中转、登录和其他 Feature。

### 需求 13：Aggregated Host 必须成为原生 UI 的唯一数据面

**用户故事：** 作为用户，我希望本地 DSH 原生组件直接显示和操作本地及多个 PeerHost 资源，而不是看到一层容易失效的 DOM 伪装。

#### 验收标准

1. WHEN PeerHost 聚合功能启用 THEN System SHALL 为本地 DSH Client 提供单一 Aggregated Host Transport，不要求 UI 读取远端 DOM 或创建伪造的原生节点。
2. WHEN DSH 原生 Workspace/Session/Conversation 组件读取列表或历史 THEN System SHALL 返回当前 Host 与 PeerHost 的虚拟资源，并保留资源所属 Host 信息。
3. WHEN DSH 原生组件执行打开、发送、停止、权限回复、工具刷新或终端操作 THEN System SHALL 根据虚拟资源 ID 路由到资源所属 Host。
4. WHEN Aggregated Host 无法装配或当前 DSH 版本不支持所需启动扩展点 THEN System SHALL 保持 PeerHost 原生聚合不可用，并显示明确诊断；不得把 DOM 注入标记为原生成功。

5. WHEN PeerHost 聚合功能启用 THEN System SHALL 由 CodingNS 单插件安装 DSH `0.2.0-rc.1` preboot shim，并包装现有 `workspaces.list`、`sessions.list` 公开快照，让原生列表显示本地与远端虚拟资源。
6. WHEN DSH 原生 Session binding、Conversation stream 或工具 Remote 不可用 THEN System SHALL 仅将对应能力标记为 `unsupported/degraded`；不得伪造 binding，不得通过普通运行时插件覆盖 `ctx.connection`。CodingNS 已通过 `peerHost/native` 与 `peerHost/nativeStream` 提供远端 Remote connector，但仍必须以真实页面回放证明 `sessions.retain()` 全链路。

### 需求 16：单插件安装和 DSH 边界

**用户故事：** 作为用户，我希望安装一个 CodingNS 插件即可启用 PeerHost 聚合，不需要另行安装补丁包或运行时包。

#### 验收标准

1. WHEN 用户安装 PeerHost 聚合功能 THEN System SHALL 只要求安装 CodingNS 插件，不要求安装独立的 Patch Engine、PeerHost Runtime、Store 插件或第二个 PeerHost 插件。
2. WHEN CodingNS 插件声明 `dsh.bundle.patch` THEN System SHALL 只使用其现有配置 entry 调整和插件 entry 注册语义，不以此替换 DSH 原生模块实现。
3. WHEN DSH 将来新增更早的 pre-boot Transport Provider 能力 THEN CodingNS MAY 适配该入口，但当前实现 SHALL 继续使用插件内置 shim，不得要求用户额外安装包，也不得由安装脚本覆盖 DSH 安装目录。
4. WHEN DSH 版本不满足 CodingNS shim 或列表 facade 的兼容条件 THEN CodingNS SHALL 保持原有单 Host 行为，并显示可解释的版本/能力诊断。
5. WHEN 聚合功能启用 THEN System SHALL 只加载当前 Host 的 DSH/CodingNS UI Bundle、Feature、Slot 和设置；远端 Host 的 Manifest、Bundle 和 UI Slot 永远不进入加载范围。

### 需求 14：本地插件状态必须是唯一 UI 基线

**用户故事：** 作为维护者，我希望多 Host 聚合不引入远端插件 Bundle 冲突，同时本地 CodingNS 插件可以统一操作不同 Host 的适配器。

#### 验收标准

1. WHEN DSH Client 启动 Aggregated Host THEN System SHALL 只加载当前 Host 的 DSH/CodingNS Client Bundle、Feature、Slot 和设置。
2. WHEN PeerHost 握手或摘要返回远端能力 THEN System SHALL 将其作为执行能力状态，不加载远端 Plugin Manifest、Bundle 或 UI Slot。
3. WHEN 本地插件调用目标 Host 的适配器、文件、Git、终端或右侧工具 THEN System SHALL 使用虚拟资源作用域和目标能力摘要。
4. WHEN 目标 Host 缺少本地 UI 所请求的能力 THEN System SHALL 返回稳定的 `unsupported` 错误，不得静默切换到当前 Host。
5. WHEN 本地插件升级或重新装配 THEN System SHALL 不要求所有 PeerHost 同步安装 Client Bundle，但目标 Host API 兼容性必须通过能力矩阵验证。

### 需求 15：虚拟资源和混合顺序必须可持久化

**用户故事：** 作为用户，我希望本地和多个 PeerHost 的工作区可以在同一列表中排序，刷新页面后顺序仍然保持。

#### 验收标准

1. WHEN Aggregated Host 返回工作区或会话 THEN System SHALL 为每条资源生成稳定的 Host 命名空间 ID，禁止使用裸远端 ID。
2. WHEN 用户调整本地与远端工作区的混合顺序 THEN System SHALL 将全局顺序保存到当前 Host 的聚合设置中。
3. WHEN 用户调整同一远端 Host 内部的工作区顺序 THEN System MAY 转发目标 Host 原生排序，但不得丢失当前 Host 的全局混合顺序。
4. WHEN PeerHost 删除、重命名或暂时不可用 THEN System SHALL 保留可恢复的顺序记录，并按稳定虚拟 ID 重新合并。
5. WHEN 两个 Host 存在相同工作区或会话 ID THEN System SHALL 在排序、缓存、订阅、路由和 React key 中保持隔离。

## 非功能需求

### 非功能需求 1：性能

1. WHEN 加载多个 PeerHost 的导航 THEN System SHALL 并发获取摘要，但每个 Host 的请求必须有独立超时和取消信号。
2. WHEN 页面只显示工作区摘要 THEN System SHALL 不预加载所有会话全文、文件内容或远端 Bundle；远端 Bundle 永远不属于本 Spec 的加载范围。
3. WHEN 收到实时事件 THEN System SHALL 使用有界队列和背压，不因单个慢 Host 阻塞其他 Host。
4. WHEN 作用域切换 THEN System SHALL 在旧结果回写前完成 generation 校验，避免用全局锁阻塞新作用域。

### 非功能需求 2：可靠性

1. WHEN 一个 PeerHost 不可用 THEN System SHALL 只影响该 PeerHost 条目，不得阻塞当前 Host 和其他 PeerHost。
2. WHEN 请求超时、WebSocket 关闭或响应格式错误 THEN System SHALL 进入可诊断状态，不得返回半初始化资源。
3. WHEN 模块重复启停 THEN System SHALL 不残留定时器、订阅、WebSocket、iframe 或 DOM 注入节点。
4. WHEN 旧 generation 的清理函数执行失败 THEN System SHALL 继续建立新作用域，同时记录可追踪的清理错误。

### 非功能需求 3：安全

1. 目标 Host 凭据只能存在当前 Host 的敏感存储边界，浏览器只能看到脱敏状态。
2. 代理目标必须来自当前用户已保存的 PeerHost 记录，不允许请求临时传入 URL。
3. 代理路径和消息类型必须使用正向白名单，不能使用“所有 `/api`”或“所有文本消息”规则。
4. 默认不开放 PeerHost 的递归代理、管理接口、认证接口和任意插件接口。
5. 所有 fingerprint、版本和登录态变更都必须使旧资源作用域可失效。

### 非功能需求 4：可维护性

1. Host、Client、Transport、UI 和错误码必须以内部稳定契约连接，业务模块不得导入 DSH 版本专属私有类型。
2. 每个新增代理路径必须同时增加白名单、契约测试和安全测试。
3. 设计文档必须记录 DSH 0.1.5、0.1.6、0.1.7 的能力差异和降级行为。
4. 所有未实现或暂不支持的 Host 工具必须有明确错误码和 UI 文案。

## 成功定义

- 用户可以从当前 DSH 设置启用 PeerHost 模块，并在右下角管理入口添加至少一个局域网 PeerHost。
- 目标 Host 未安装插件、版本不兼容、fingerprint 变化或未登录时，系统都能阻止代理并显示可解释状态。
- 当前 Host 与 PeerHost 的工作区、会话和同名资源可以同时显示，且每项带 Host 标签。
- 本地 DSH 原生 Workspace、Session、Conversation、终端和右侧工具可以消费 Aggregated Host 的虚拟资源；验证不依赖 DOM 选择器。
- 本地 CodingNS 插件可以使用统一 UI 调用多个 PeerHost 的适配器对话，目标能力缺失时显示可解释的 `unsupported`。
- 打开 PeerHost 会话后，中栏历史、聊天输入、实时事件和右侧工具不会请求到错误 Host。
- 切换 Host 作用域后旧 WebSocket、缓存和异步结果不会污染新页面。
- 全量验证可以证明当前 Host 原有局域网、中转和其他功能不受 PeerHost 模块影响。

# 需求文档 - DSH 多路复用网关

状态：Draft。

## 硬门禁

1. 控制站和 Relay 只能看到控制面元数据：账号、设备、Host binding、ticket、SDP/ICE、在线状态和流量统计。
2. RPC、模型消息、CLI 输出、PTY、任务、文件、端口、PeerHost 和远程 Web 内容必须在 DSH Client 与 DSH Host 之间端到端加密。
3. Gateway 不得把业务消息交给 Relay，也不得让控制站终止业务 HTTP/WebSocket。
4. `CodingNS TunnelFrame`、`DSH Envelope`、DSH 应用协议族和 DSH 运行时版本必须分别协商，不能混用版本字段。

## 需求

### 需求 1：单会话多逻辑流

一个 WebRTC 会话只打开一个 DSH WebSocket Gateway。Gateway 必须按 `streamId` 复用 RPC、adapter、pty、task、file、port、peerhost、plugin 和 web 流；一个流的错误不能广播给其他流。

### 需求 2：统一 Envelope

所有消息使用统一 Envelope，包含 `version`、`messageId`、`streamId`、`channel`、`type`、`sequence`、`generation`、`hostScope`、`meta` 和可选二进制 `body`。模块不得自行定义不可路由的封装。

### 需求 3：握手、能力和 generation

首条业务消息必须是 `session.hello`。双方校验协议、DSH 版本、HostScope、能力和窗口后返回 `session.ready`。断线时当前 generation 立即失效；恢复由 DSH Connection recovery 创建新载体和新 generation。

### 需求 4：流控和二进制传输

单消息、单流、会话和模块都必须有大小/窗口/队列上限。窗口耗尽时暂停读取上游，不能无限缓存。文件、PTY 和 CLI 输出使用原始二进制分块，不经过 Base64。

### 需求 5：DSH 和业务频道

支持 DSH RPC、Remote、事件和文件；CodingNS CLI 适配器；tmux/PTY/后台任务；进程/端口/反向代理；PeerHost；以及远程 DSH Web Runtime 所需的 `web.*` 和 `plugin.*` 消息。

### 需求 6：HostScope 路由

每个逻辑流必须携带 `hostScope.hostId` 和 `generation`，需要时携带 `workspaceId`、`sessionId`。Gateway 必须拒绝旧 HostScope 或旧 generation 的消息，不能使用裸资源 ID。

### 需求 7：远程 Web Runtime

Gateway 支持 `web.session.open`、`web.boot.get`、`web.asset.get`、`web.ws.*`、`web.plugin.manifest` 和 `web.plugin.bundle`。这些消息返回远程 Host 自己的 DSH Web 与插件结果，不代表控制站部署或代理一套固定前端。

### 需求 8：远程插件临时加载

远程 Host 提供 Manifest 和 Bundle，Client 只能在对应 HostScope 的 Remote DSH Web Context 临时加载。Gateway 必须校验 HostScope、Manifest 版本、来源和 generation；不得把 Bundle 写入本地 Profile 或全局 Loader。

### 需求 9：PeerHost 直连与回退

Remote Host 可作为 PeerHost 逻辑资源。优先建立 Client 到目标 Host 的直接 WebRTC；直连不可用时才允许当前 Host 受信任代转。代转必须经过目标会话、方法/路径/消息类型白名单，且 Relay/控制站仍不能看到明文。

### 需求 10：DSH Sidebar 终端 UI 与插件自有持久运行时

DSH Web 是终端功能的唯一主体界面。`dsh-codingns` 必须通过 DSH 公开 Slot 提供自己的 Sidebar 终端 UI，并实现与 DSH `webTerminals` 服务契约兼容的 controller；浏览器只调用 DSH Remote，不得直连本机终端 broker，也不得获得任何本机控制凭据。

插件必须独立实现终端运行时，不能导入、启动或调用 CodingNS 父仓库及其 Host 私有接口。持久映射以 `hostId + workspaceId + plugin terminalId` 唯一定位，并记录 `runtimeSessionKey + runtimeType`；DSH `sessionId` 只用于当前请求的 attach、权限和工作区解析，不得成为终端所有者。持久运行时记录与当前 generation 的临时 attach 分开保存。裸 `sessionId` 或裸 `terminalId` 不能作为跨 Host 的全局标识。

平台行为固定如下：

1. macOS 和 Linux 使用 tmux 作为持久运行时，默认 shell 为 zsh；Linux 未安装可执行的 zsh 时允许回退到 bash。shell 必须先检测并解析成可执行路径，不能把未经验证的 `fish`、`zsh` 等名称直接交给子进程。
2. Windows 使用独立于 DSH 主进程生命周期的 ConPTY broker。用户可以从已安装的 cmd、PowerShell 和 Git Bash 中选择；未安装项不能作为可创建选项。
3. “持久化”只承诺跨浏览器刷新或关闭、插件卸载和重新加载、generation 切换以及 DSH 进程重启保留同一运行时；不承诺跨操作系统重启。
4. 浏览器、插件或 DSH 断开时只释放订阅和 attach。只有用户明确关闭终端时才结束对应 tmux session 或 ConPTY/shell 进程；关闭操作必须可重复执行。
5. DSH 或插件重启后必须检查持久运行时是否仍然存在并重新 attach，不能只凭数据库记录宣称终端仍在运行，也不能在原运行时丢失后悄悄用同一 ID 创建新进程。
6. 官方 `terminal-controller` 与官方 terminal UI 必须成对启用或成对禁用。插件接管时必须在同一 Bundle generation 内一次性提供严格 Typert manifest、Host controller、浏览器 `webTerminals` 和 Sidebar UI，不能让 Web 启动进入等待服务的半替换状态，也不能注册重复的 `terminal` namespace。
7. DSH「设置 → CodingNS」必须增加名为“终端强化”的独立模块卡片。标题栏 Switch 保存启用意图，但启用和禁用都只在重启 DSH 后生效；设置页必须同时显示当前运行状态和待重启状态，不能让用户误以为已经即时切换 controller。禁用时若仍有持久终端运行，必须显示数量和“不结束这些会话”的明确提示。
8. “终端强化”必须允许设置新建终端的默认 profile。默认值为“系统推荐”：macOS 选择 zsh；Linux 选择 zsh，未安装时回退 bash；Windows 优先可用的 PowerShell，否则回退 cmd。用户也可以从当前平台已检测到的 shell 中指定默认项；已保存项变为不可用时回退“系统推荐”并显示原因。
9. “终端强化”必须允许设置终端外观，至少包括主题继承或自定义、背景色、前景色、光标颜色、字体、字号、行高、光标形状、光标闪烁和回滚行数。默认继承 DSH 设计令牌；不得接受任意 CSS、背景图片或远程 URL。xterm 样式必须封装在插件终端的 Shadow DOM 中，不能污染全局页面或其他插件。

## 非功能需求

- 兼容 DSH 官方 Web、Desktop 和其他插件，不覆盖全局 Connection 或插件命名空间。
- 不为模块创建私有重连器、无限队列或独立任务调度器。
- 错误不包含 token、密码、命令、文件内容或目标 Host 凭据。
- 协议拒绝、能力不足、HostScope 失效、流关闭和资源清理都有稳定错误码。
- 终端输出、attach 和 broker 通道必须有明确的缓冲上限；断开期间不得无限占用内存。
- 终端字号、行高和回滚行数必须有明确上下限；颜色和字体值必须经过格式、长度与控制字符校验。

## 成功定义

Fake Carrier 和真实 WebRTC 两条路径都能验证：一个会话可并发承载多个业务流，慢文件流不阻塞 RPC/PTY；断线后旧 generation 不污染新 generation；H5 与官方 Desktop 能打开远程 DSH Web；远程插件只在对应 HostScope 临时加载；PeerHost 直连/回退和控制站明文门禁均有证据。

终端能力还必须在 macOS、Linux 和 Windows 分别完成 DSH Sidebar UI 验收：POSIX 终端在 DSH 重启后重新 attach 到同一 tmux session；Windows 终端在 DSH 重启后重新 attach 到同一 broker、ConPTY 和 shell 进程；显式关闭后对应运行时确实结束。Linux 缺少 zsh 时必须验证 bash 回退，操作系统重启后的旧映射只允许标记为丢失或不可恢复，不能伪装成仍在运行。设置验收还必须证明启用和禁用在重启前不会改变当前 controller、重启后才切换有效状态；默认 profile 能按平台解析；外观设置能更新插件终端且不会影响终端以外的页面。

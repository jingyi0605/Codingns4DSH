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

## 非功能需求

- 兼容 DSH 官方 Web、Desktop 和其他插件，不覆盖全局 Connection 或插件命名空间。
- 不为模块创建私有重连器、无限队列或独立任务调度器。
- 错误不包含 token、密码、命令、文件内容或目标 Host 凭据。
- 协议拒绝、能力不足、HostScope 失效、流关闭和资源清理都有稳定错误码。

## 成功定义

Fake Carrier 和真实 WebRTC 两条路径都能验证：一个会话可并发承载多个业务流，慢文件流不阻塞 RPC/PTY；断线后旧 generation 不污染新 generation；H5 与官方 Desktop 能打开远程 DSH Web；远程插件只在对应 HostScope 临时加载；PeerHost 直连/回退和控制站明文门禁均有证据。

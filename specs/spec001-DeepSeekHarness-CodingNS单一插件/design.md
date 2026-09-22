# 设计文档 - DeepSeek Harness 的 CodingNS 单一插件

状态：Draft。阶段 0 已验证插件骨架、Profile、Host/Client 出口和启动装配；真实远端连接、远程 Web Runtime、多 Host 聚合和业务模块仍未完成。

## 1. 总体原则

DSH 是唯一主体宿主。`dsh-codingns` 是一个同时包含 Host half、Client half、Transport 和可选模块的 Bundle。插件不复制 DSH Web，不替换官方 Desktop，也不要求用户把其他 DSH 插件重新安装一遍。

控制面和数据面分开：`apps/codingns-proxy` 只做 Auth、Device、Host binding、短期 ticket、Relay signaling、Tailscale、Multi-Host 和状态统计；业务数据由 DSH Client 与目标 Host 通过 WebRTC DataChannel 端到端传输。

数据面固定为三层：

```text
CodingNS WebRTC / HTTP / WebSocket Tunnel
  -> DSH Multiplex Transport（单 WebSocket、多逻辑流、统一 Envelope）
    -> DSH / CLI / PTY / Task / File / Port / PeerHost / Web 模块
```

## 2. 运行形态

### 2.1 Host 形态

```text
DSH Runtime
  ├── 官方 DSH Web / Desktop UI
  ├── 官方 DSH Profile
  ├── 用户安装的其他 DSH 插件
  └── dsh-codingns Host half
       ├── CodingNS Auth / Device / Host binding
       ├── WebRTC Host Gateway
       ├── CLI / 文件 / PTY / Task / Process / Port
       ├── PeerHost Registry / Proxy
       └── Remote DSH Web Runtime Provider
```

### 2.2 H5 形态

H5 部署的只是控制站 Bootstrap，不是固定版本的 DSH 前端：

```text
浏览器
  -> 控制站 HttpOnly 会话或一次性访问码
  -> H5 Bootstrap
  -> dsh-codingns Client Transport
  -> WebRTC DataChannel（Relay 只转发加密流量）
  -> 远程 DSH Host Gateway
  -> web.session.open / web.boot.get / web.asset.get
  -> 远程 Host 自己的 DSH Web、Profile 和插件结果
```

Bootstrap 不保存 refresh token。Service Worker、WebSocket Shim 只允许作为兼容旧 DSH Web 的过渡层，不能成为主数据面。

### 2.3 Desktop 形态

第一阶段直接扩展官方 DSH Desktop，不自行打包 Win/macOS：

```text
DSH Desktop Shell
  ├── Local DSH Web Context
  ├── Remote DSH Web Context（remote-a）
  └── Remote DSH Web Context（remote-b）
       每个 Context 独立拥有：Client、Connection、HostScope、generation、Plugin Loader
```

用户在 Desktop 安装一次 `dsh-codingns` Client 即可访问远程 Host。只有未来需要系统托盘、后台 WebRTC、原生通知或统一升级时，才评估自建 Desktop Edition。

## 3. HostScope 与资源模型

### 3.1 HostScope

```ts
interface HostScope {
  hostId: string;
  hostLabel: string;
  connectionId: string;
  generation: string;
  kind: "local" | "remote";
  status: "connecting" | "ready" | "degraded" | "closed";
}

interface ResourceScopeRef {
  hostId: string;
  workspaceId?: string;
  sessionId?: string;
}
```

所有工作区、会话、终端、文件、任务和插件资源必须携带作用域。`sessionId`、`workspaceId` 和插件资源 ID 不能单独作为全局 ID。每个 HostScope 拥有独立 generation；旧 generation 的异步结果不能写入新作用域。

### 3.2 HostRouter

`HostRouter` 是 Client 侧的唯一路由入口：

- 维护本地和远程 HostScope 的连接、状态和 generation。
- 把 `session.list` 聚合请求分发到多个 Host，再把结果附加 `hostId`、`hostLabel` 和连接状态。
- 打开会话或 Web Runtime 时，根据 `hostId` 选择正确的 Context。
- 断开或切换 HostScope 时关闭旧流、撤销旧 Loader 和清理远程 Web Context。

Remote Host 可以在 UI 中显示为 PeerHost，但 PeerHost 是逻辑资源名称，不规定物理路径。物理连接优先是 Desktop/H5 直接 WebRTC 到 Remote Host；当前 Host 代转是受信任的兼容回退，必须显式开启并标记为代理路径。

## 4. 远程插件加载

远程插件始终由远程 DSH Host 安装、启用和管理。Host 通过以下接口向对应 Context 提供它自己的插件结果：

```text
web.session.open
web.boot.get
web.asset.get
web.plugin.manifest
web.plugin.bundle
web.ws.open
web.ws.data
web.ws.close
```

Client 处理规则：

1. 打开 Remote DSH Web Context，并绑定唯一 HostScope。
2. 读取远程 Host 的 DSH Web boot、Profile 和 Plugin Manifest。
3. 需要 Client UI 的插件才按需下载 Bundle，在该 Context 的临时 Loader 中执行。
4. 不写入本地 DSH Profile，不注册到本地全局 Plugin Loader，不把不同 Host 的同名插件版本合并。
5. 关闭 Context、generation 失效或 Host 切换时，撤销临时 Loader、WebSocket 和资源引用。

“不在本地安装”不等于“浏览器完全不下载代码”；代码可以在远程 Context 中执行，但来源、版本和权限始终由对应 Remote Host 决定。Host-only 插件只在 Host 执行。

## 5. 组件职责

| 组件 | 职责 |
| --- | --- |
| `control-api-client` | 登录、刷新、设备、Host binding、ticket 和能力协商 |
| `credential-store` | Host 安全保存 refresh token、设备密钥和目标会话 |
| `signaling-client` | 通过短期 ticket 交换 SDP、ICE 和 TURN 信息 |
| `webrtc-carrier` | DataChannel、fingerprint 校验、分帧、关闭和背压入口 |
| `dsh-multiplexer` | 单 WebSocket 上复用多逻辑流、序号、取消、窗口和错误 |
| `dsh-transport-provider` | 接入 DSH `ClientTransportHooks`、`installConnection()`、`loadBundle()` 和 generation |
| `feature-registry` | 模块依赖、启停、权限和资源清理 |
| `host-router` | 多 HostScope、连接、会话聚合和 Context 路由 |
| `remote-dsh-web-runtime` | 远程 Web boot、资源、插件 Manifest/Bundle 和 WebSocket |
| `cli-adapters` | CodingNS CLI Provider 的统一启动、输入、输出和退出 |
| `workspace-files` | 工作区树、预览和文件流 |
| `terminal` / `task` | tmux、PTY、后台任务、恢复和取消 |
| `process-network` | 进程、端口、显式反向代理 |
| `peerhost` | PeerHost 检查、目标会话、HTTP/WS 白名单代理和回退路径 |

## 6. 连接流程

### 6.1 Host 启动

1. Profile 先检查 DSH 精确版本和插件兼容矩阵。
2. pre-Cordis Bootstrap 创建 Transport 并登记 `globalThis.__DSH_TRANSPORT__`。
3. DSH 启动官方 Client/Cordis；普通插件不得重复创建默认 Connection。
4. Host half 注册 Gateway、模块和凭据存储，但不主动读取业务数据。

### 6.2 Client 连接远程 Host

1. Client 通过控制站会话申请短期 connect ticket。
2. Client 与 Host 经 Relay Signaling 完成 offer/answer、ICE/TURN 和 DTLS fingerprint 校验。
3. 建立单一 WebRTC DataChannel 后打开 `dsh-transport-v1` Session。
4. 双方交换 DSH 版本、能力、HostScope 和 generation，收到 `session.ready` 后才创建业务流。
5. `HostRouter` 发布该 HostScope；DSH Remote 和 Web Runtime 开始工作。

### 6.3 断线恢复

DataChannel 或任一底层流断开时，当前 generation 立即失效。由 DSH Connection recovery 重新申请 ticket、建立载体和新 generation；模块不得创建私有重连队列。可恢复的 PTY、任务和 Web Context 使用稳定资源 ID attach，不可恢复的流返回 `STREAM_LOST`。

### 6.4 PeerHost

PeerHost 记录、目标 Host 检查、目标登录态和白名单规则沿用 CodingNS 既有实现。直接 WebRTC 失败时，才允许当前 Host 通过受控 HTTP/WS Proxy 代转；当前 Host 会看到业务明文，因此该路径必须标为受信任回退，控制站和 Relay 仍不能看到明文。

## 7. 核心协议数据

```ts
interface DshEnvelope {
  version: 1;
  messageId: string;
  streamId: string;
  channel: "session" | "rpc" | "adapter" | "pty" | "task" | "file" | "port" | "peerhost" | "plugin" | "web";
  type: string;
  sequence: number;
  generation: string;
  hostScope: HostScope;
  flags?: { endOfStream?: boolean; cancelled?: boolean; binary?: boolean };
  meta: Record<string, unknown>;
  body?: Uint8Array;
}
```

`meta` 只放路由、状态和小字段；文件内容、命令输出、模型消息和 token 必须放在端到端加密的二进制 body 或 DSH 业务流中。单流、会话和模块都必须执行窗口及队列上限。

## 8. 安全与兼容

- 控制站和 Relay 只处理账号、设备、binding、ticket、SDP/ICE、在线状态和统计，禁止解析 Envelope。
- 连接失败、版本不兼容、fingerprint 变化、模块停用和权限拒绝都使用稳定错误码并记录脱敏日志。
- 远程 Web Runtime 必须校验 HostScope、generation、Manifest 版本和 Bundle 来源；不能让远程 Bundle 写入本地 Profile。
- `dsh-codingns` 必须遵守 DSH 官方插件加载契约，保留其他插件的加载顺序和命名空间。

## 9. 验证策略

- 单元：Envelope、HostScope、HostRouter、generation、权限、Bundle 来源和白名单。
- 集成：Fake Carrier 上并发 RPC、文件、PTY、CLI、Web 和插件流；切换 HostScope 后旧流不能更新新页面。
- 端到端：真实 Control API、Relay、Host、H5 和官方 Desktop，覆盖直连、TURN、断线恢复和远程插件。
- 安全：检查控制站/Relay 日志和抓包，证明不存在 DSH 业务明文；检查浏览器持久化状态无 refresh token。

## 10. 未完成风险

- DSH `ClientTransportHooks` 的长流取消、`loadBundle()` 和官方 Desktop 注入顺序仍需真实版本联调。
- 浏览器和桌面 WebView 对 WebRTC DataChannel、二进制 WebSocket 和远程 Bundle 加载的差异需要矩阵测试。
- PeerHost 代转路径会在当前 Host 看到明文，必须默认关闭并留下审计记录。
- 移动端壳只复用 Client Transport 和 Remote Web Runtime；原生打包不属于当前阶段。

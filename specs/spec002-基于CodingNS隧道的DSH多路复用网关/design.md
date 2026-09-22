# 设计文档 - 基于 CodingNS HTTP/WS 隧道的 DSH 多路复用网关

状态：Draft。

## 1. 数据面结构

```text
H5 Bootstrap / 官方 DSH Desktop / DSH Client
             │
             │ dsh-codingns Client Transport
             ▼
       WebRTC DataChannel
             │ 直连；失败时 TURN 只转发加密包
             ▼
CodingNS Tunnel（WebSocket 载体）
             │
             ▼
DSH Multiplex Gateway（远程 Host 的 dsh-codingns Host half）
             ├── Session / Capability / Generation
             ├── RPC / Event / File
             ├── CLI / PTY / Task
             ├── Process / Port / Reverse Proxy
             ├── PeerHost Direct-or-Proxy
             └── Remote DSH Web / Plugin Runtime
```

控制站 `apps/codingns-proxy` 只负责 Auth、Device、Host binding、ticket、Relay Signaling、Tailscale、Multi-Host 和连接状态。Relay 不读取 Gateway 消息。

## 2. 载体与连接

Carrier 只提供可靠有序的二进制消息：打开、收发、关闭和错误。DSH Gateway 把 Carrier 映射到固定入口 `/__dsh__/transport/v1`（实现可使用等价版本化路径），不把 Envelope 当作普通 CodingNS 业务 HTTP。

连接顺序：

1. Client 用控制站会话申请短期 ticket。
2. Relay 交换 SDP、ICE 和 TURN 信息；双方校验 Host DTLS fingerprint。
3. 建立单个 WebSocket 载体并发送 `session.hello`。
4. Host 校验协议族、DSH 版本、能力、HostScope 和策略，返回 `session.ready`。
5. Gateway 将后续 Envelope 按 `channel + streamId` 路由到唯一模块。

## 3. 组件职责

| 组件 | 做什么 | 不做什么 |
| --- | --- | --- |
| `CodingNsCarrier` | 承载二进制消息、关闭和错误 | 不解析业务 Envelope |
| `DshSession` | hello、ready、心跳、版本和能力 | 不执行命令或访问文件 |
| `StreamMultiplexer` | stream 创建、路由、顺序、取消和关闭 | 不包含业务逻辑 |
| `FlowController` | 字节/消息窗口和队列上限 | 不偷偷缓存无限数据 |
| `FeatureRegistry` | 模块注册、开关、权限和清理 | 不绕过模块权限 |
| `DshRpcModule` | RPC、Remote、事件、文件和 bundle | 不直接控制 Relay |
| `AdapterModule` | CLI 生命周期和 stdout/stderr | 不修改 CLI 私有协议 |
| `TerminalModule` | tmux、PTY、resize、任务 attach | 不创建私有 TaskManager |
| `ProcessNetworkModule` | 进程、端口和显式反向代理 | 不提供任意 URL 代理 |
| `PeerHostModule` | 目标检查、会话、直连选择和受控回退 | 不把 token 下发 Client |
| `RemoteWebRuntimeModule` | 远程 DSH Web、Manifest、Bundle 和 WebSocket | 不部署独立固定前端 |
| `CapabilityPolicy` | 账号、HostScope、工作区、模块和路径校验 | 不在 Relay 侧判定业务 |

## 4. HostScope 和多 Host

```ts
interface HostScope {
  hostId: string;
  hostLabel: string;
  workspaceId?: string;
  sessionId?: string;
  generation: string;
  kind: "local" | "remote";
}
```

Gateway 不负责把所有 Host 合成一个全局资源表；Client 侧 `HostRouter` 负责：

- 聚合 `session.list`，给每条记录补 `hostId`、`hostLabel`、`workspaceId`、`sessionId` 和连接状态。
- 将打开请求路由到对应 HostScope 和 Remote DSH Web Context。
- 在 Host 切换或 generation 替换时关闭旧流、撤销旧 WebSocket 和临时插件 Loader。

## 5. 远程 DSH Web 和插件

远程 Web 频道：

```text
web.session.open
web.boot.get
web.asset.get
web.ws.open
web.ws.data
web.ws.close
web.plugin.manifest
web.plugin.bundle
```

Host 返回自己的 DSH Web boot、Profile、资源和插件 Manifest。Client 在对应 HostScope 创建独立 Web Context；Client Bundle 只在该 Context 的临时 Loader 执行，不写入本地 Profile，也不与其他 Host 的同名插件合并。Host-only 插件只在 Host 运行。

## 6. Envelope 与流控

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

`meta` 只放路由、状态和小字段；二进制正文不 Base64。发送方同时受单消息、单流、会话和模块窗口限制；窗口耗尽时暂停读取上游。`sequence` 在一个 `streamId` 内递增，关闭后的流 ID 不能复用。

## 7. PeerHost 选择

Remote Host 被列为 PeerHost 逻辑资源，但物理路径按以下顺序选择：

1. Client 通过控制站 ticket 直接与目标 Host 建立 WebRTC。
2. 直连失败且用户/策略允许时，当前 Host 通过白名单 HTTP/WS 受信任代转。
3. 代转路径只接受已登记、已检查、已登录的 `targetHostId`，当前 Host 可看到业务明文；控制站和 Relay 仍只能看到加密载体。

## 8. 状态和错误

会话状态：`idle`、`handshaking`、`ready`、`degraded`、`closed`。流状态：`opening`、`active`、`closing`、`closed`。所有异步结果写入前必须检查 generation 和 HostScope。

稳定错误包括：`PROTOCOL_VERSION_UNSUPPORTED`、`MESSAGE_INVALID`、`SESSION_NOT_READY`、`FEATURE_DISABLED`、`FORBIDDEN`、`FLOW_CONTROL_INVALID`、`STREAM_LOST`、`RESOURCE_SCOPE_STALE`、`PLUGIN_SCOPE_MISMATCH`、`PEERHOST_NOT_ALLOWED` 和 `PEERHOST_PROXY_UNREACHABLE`。

## 9. 测试策略

- 单元：Envelope 编解码、未知频道、序号、窗口、HostScope、Manifest/Bundle 来源和权限。
- 集成：Fake Carrier 上并发 RPC、文件、PTY、CLI、PeerHost 和 Web 流；慢流不阻塞其他流。
- 多 Host：本地与两个远程 Host 的会话聚合、同名资源隔离、generation 切换和临时 Loader 清理。
- 端到端：真实 Control API、Relay、TURN、DSH Host、H5 Bootstrap 和官方 Desktop。
- 安全：控制站/Relay 日志、抓包和浏览器存储检查，确认无业务明文和 refresh token。

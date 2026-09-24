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

## 10. DSH Sidebar 终端与持久运行时

### 10.1 所有权边界

DSH Web 仍是主体。`dsh-codingns` 通过 DSH 公开 Sidebar Slot 提供终端页面，并同时提供浏览器 `webTerminals` 与 Host controller。终端进程由插件自己的 Host half 管理，不依赖 CodingNS 父仓库，不调用 `apps/host/src`，也不把终端能力暴露为浏览器可直连的服务。

```text
插件 DSH Sidebar UI + Shadow DOM xterm
  -> 插件浏览器 webTerminals
  -> DSH Remote terminal namespace
  -> 插件 Host controller
  -> 插件终端服务
       -> macOS/Linux：tmux backend
       -> Windows：独立 ConPTY broker
```

官方 controller、官方 terminal UI 与插件终端栈不能混装。Bundle 必须成对禁用官方两行，并在同一个插件行中原子提供 Typert manifest、Host controller、浏览器 `webTerminals` 和 Sidebar UI。任一组成部分激活失败时整次终端功能失败，不能伪装成功，也不能留下只有 UI、没有服务的状态。

### 10.2 持久记录与临时 attach

持久记录描述“终端是什么、由哪个运行时持有”，临时 attach 描述“当前哪个 generation 正在看它”。两者不能混成一张只靠布尔状态判断的记录。

```ts
type PersistentTerminalRuntimeType =
  | "tmux"
  | "conpty-powershell"
  | "conpty-cmd"
  | "conpty-git-bash";

interface PersistentTerminalRecord {
  hostId: string;
  workspaceId: string;
  dshSessionId: string;
  terminalId: string;
  runtimeSessionKey: string;
  runtimeType: PersistentTerminalRuntimeType;
  shellPath: string;
  cwd: string;
  state: "starting" | "running" | "closing" | "lost" | "closed" | "error";
  createdAt: string;
  updatedAt: string;
}

interface TerminalAttachment {
  terminalId: string;
  generation: string;
  streamId: string;
  subscriptionId: string;
}
```

持久记录以 `hostId + workspaceId + terminalId` 查找，`dshSessionId` 只作为当前 attach 的上下文，不拥有终端，并保存插件自己的 `runtimeSessionKey`。记录必须写入 DSH Host 的持久数据目录，不能只放在进程内存或 Bundle 安装目录；升级或重新装载同一插件不得删除仍在运行的会话映射。`generation`、WebSocket、订阅回调和 attach 子进程属于临时资源，不写成持久运行时的所有者。映射创建、运行时启动结果和关闭状态必须按可恢复顺序落盘；启动失败不能留下看似 `running` 的孤儿记录。

### 10.3 POSIX tmux backend

macOS 和 Linux 每个持久终端对应一个插件命名空间内的 tmux session。创建前先探测 tmux 与 shell 的绝对路径：macOS 默认 `/bin/zsh`；Linux 优先 zsh，找不到可执行 zsh 时回退 bash。没有可用 tmux 或 shell 时返回稳定的能力错误，不退化成随 DSH 一起退出的普通 PTY。

创建、检查、attach、resize 和显式关闭分别映射到 tmux 的明确操作。浏览器断开、插件卸载、generation 切换和 DSH 关闭只结束 attach；用户明确关闭终端才结束 tmux session。恢复时必须用 `runtimeSessionKey` 检查原 tmux session，存在才重新 attach，不存在则把持久记录标为 `lost`。

### 10.4 Windows ConPTY broker

Windows 不能让 DSH 主进程直接持有需要跨重启保留的 ConPTY。插件必须启动独立于 DSH 生命周期的 broker，由 broker 创建并持有 ConPTY 和 shell，再通过仅限本机的 Named Pipe 接受 `inspect`、`attach`、`input`、`resize`、`detach` 和 `terminate`。Named Pipe 只允许启动 DSH 的同一操作系统用户访问，名称从不可猜测的 `runtimeSessionKey` 派生；浏览器永远看不到 pipe 或本机控制凭据。

DSH 关闭或 attach 连接断开时，broker 只清除连接并继续持有 ConPTY。重启后的插件先通过 `inspect` 取得同一 broker 和 shell 的身份，再建立新 attach；检查失败时标记 `lost`，不能在原 `terminalId` 下偷偷启动新 shell。只有显式 `terminate` 才结束 shell、关闭 ConPTY 并退出 broker。无 attach 时的输出必须采用有界缓冲或持久日志，超过上限时按明确策略截断。

### 10.5 生命周期与崩溃协调

| 事件 | 持久运行时 | 临时 attach | 持久记录 |
| --- | --- | --- | --- |
| 浏览器刷新或关闭 | 保留 | 释放 | 保持 `running` |
| 插件卸载或 generation 切换 | 保留 | 释放旧 generation | 保持 `running` |
| DSH 正常退出或崩溃 | tmux/broker 保留 | 连接自然释放 | 下次启动重新检查 |
| 用户明确关闭终端 | 结束 | 释放 | 标记 `closed` |
| tmux session 或 broker 意外退出 | 已丢失 | 释放 | 标记 `lost` 或 `error` |
| 操作系统重启 | 不保证保留 | 全部释放 | 启动后检查并标记 `lost` |

恢复顺序固定为：读取持久记录、检查 backend、更新真实状态、等待 UI 订阅后 attach。close 顺序固定为：先把状态写成 `closing`、结束 backend、释放 attach、确认退出、再标记 `closed`；如果 DSH 在中途崩溃，下次启动必须继续完成关闭，不能把 `closing` 会话重新暴露为可交互终端。同一个终端的恢复和关闭必须串行化，旧 generation 的回调在每次写状态前重新核对 generation；重复 close 返回成功，但不能结束后来创建的其他终端。

### 10.6 “终端强化”设置模型

设置页通过注册表增加稳定模块名 `terminalEnhancement`，显示名称为“终端强化”，默认关闭以保留现有用户行为。功能模块描述符增加 `activation: "live" | "restart"`，缺省为 `live`；终端强化固定声明为 `restart`。该模块的标题栏 Switch 修改 `modules.terminalEnhancement` 中的下次启动意图，但当前进程不调用 `FeatureRegistry.reconcile()` 切换 controller。注册表在启动时捕获一次 `effectiveEnabled`，设置卡片同时显示它和已保存的目标状态；两者不一致时显示“重启 DSH 后生效”。设置页不主动重启 DSH。

插件兼容 controller 始终负责提供 `webTerminals`，启动时按设置快照选择模式：

- 启用：创建新终端时使用 tmux 或 ConPTY broker，并恢复插件持久记录。
- 禁用：使用插件自有 Local PTY 和内存映射；进程随 DSH 或插件生命周期结束，不读取或 attach 持久运行时。

禁用强化不能结束已有 tmux session、ConPTY、shell 或删除映射。它们保持脱离状态，重新启用并重启 DSH 后才能再次恢复；用户必须在禁用前通过插件 Sidebar UI 显式关闭不再需要的会话。两种模式共用同一套插件 controller 与 wire 契约，只替换 backend 和 store；禁止导入官方 controller 私有实现，也禁止运行中注销再注册同名服务。

持久配置使用向后兼容的独立对象，模块开关仍由通用 `modules` 字典保存：

```ts
type TerminalProfileId =
  | "system"
  | "zsh"
  | "bash"
  | "powershell"
  | "cmd"
  | "git-bash";

interface TerminalEnhancementSettings {
  defaultProfile: TerminalProfileId;
  appearance: {
    theme: "inherit" | "custom";
    background: string | null;
    foreground: string | null;
    cursorColor: string | null;
    fontFamily: string | null;
    fontSize: number | null;
    lineHeight: number | null;
    cursorStyle: "block" | "bar" | "underline" | null;
    cursorBlink: boolean | null;
    scrollback: number | null;
  };
}
```

`CodingNsSettings` 通过单一 `terminalEnhancement: TerminalEnhancementSettings` 字段保存上述配置，不在模块字典或 Client 本地状态复制第二份。默认值是 `defaultProfile: "system"`、`theme: "inherit"`，其余外观字段为 `null` 并继承 DSH 设计令牌。颜色只接受 `#RRGGBB`，字体字段限制长度并拒绝控制字符；非空字号范围为 10～32 px，非空行高范围为 1.0～2.0，非空回滚行数范围为 1000～100000。保存默认 profile 和外观不需要重启 DSH：默认 profile 从下一次新建终端起生效，外观设置通过 Client 侧订阅应用到当前和后续插件终端；只有模块启用状态需要重启。

### 10.7 Shell 检测、默认 profile 与 Sidebar UI

Host 向兼容 controller 返回平台和可用 shell 列表，Client 在插件注册的 DSH Sidebar 新建终端入口展示它们：

- macOS：“系统推荐”解析为 zsh。
- Linux：“系统推荐”解析为 zsh，zsh 不可用时解析为 bash。
- Windows：“系统推荐”优先解析为 PowerShell，PowerShell 不可用时解析为 cmd；Git Bash 只在检测可用且用户明确选择时成为默认项。

检测结果必须包含规范化 profile ID、显示名、绝对路径、是否可用和不可用原因；创建请求只提交规范化 ID，Host 再解析实际路径。已保存的 profile 当前不可用时，Host 使用“系统推荐”创建终端，并让设置页显示回退原因。不能信任浏览器传入的任意可执行文件路径。

“终端强化”卡片遵守 CodingNS 设置页通用规则：标题栏右侧使用 Switch，未启用时表单保持可见但整体灰显且不可编辑，已保存值不删除。关闭 Switch 时如果存在运行中的持久终端，卡片先显示会话数量并明确说明重启后只会停止 attach、不会结束进程。默认终端使用下拉菜单；颜色使用颜色选择器和“恢复继承”；字号、行高和回滚行数使用带边界的数字输入；光标闪烁使用 Switch，光标形状使用选项菜单。不得提供任意 CSS 文本框。

插件直接通过 xterm 公开 options 应用外观，并把 xterm CSS 注入终端自己的 Shadow DOM。禁止修改全局 `body`、覆盖其他终端插件选择器、依赖官方 terminal UI 私有 DOM，或向页面注入无作用域样式。

### 10.8 Controller 替换门禁

Bundle 的替换单位是完整终端栈，不能只替换官方 Host controller。静态装配必须证明官方 Host controller 与官方 terminal UI 均被禁用，插件行同时暴露 `./typert`、Host 和 Client 入口；契约测试必须证明 `webTerminals`、Sidebar UI 和十个 `terminal/*` 方法一致。发布前还必须完成 POSIX tmux、Windows ConPTY broker、attach、恢复、显式关闭、崩溃协调、终端强化设置、平台默认 profile、外观设置以及 macOS、Linux、Windows 的 DSH Sidebar UI 回放，并验证冷启动不出现 `waiting for service: webTerminals`。当前 Bundle 替换属于待三平台验收的候选实现，不得把静态合成通过写成发布验收完成。

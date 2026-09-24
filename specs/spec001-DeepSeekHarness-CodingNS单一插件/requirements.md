# 需求文档 - DeepSeek Harness 的 CodingNS 单一插件

状态：Draft；阶段 0 契约已完成，远程 Web Runtime、多 Host 和真实联调未完成。

## 术语

- **DSH**：DeepSeek Harness，唯一的主体宿主，提供 Host、Client、Web、Desktop、Remote 和插件运行时。
- **Host**：运行 DSH 与 `dsh-codingns` Host half 的开发机，拥有工作区和本机执行权限。
- **Client**：DSH Web、官方 Desktop 或未来移动壳中的 `dsh-codingns` Client half。
- **HostScope**：一个 Host 在客户端中的独立作用域，资源标识至少包含 `hostId`，需要工作区或会话时再加 `workspaceId`、`sessionId`。
- **Remote DSH Web Runtime**：由远程 Host 提供的官方 DSH Web boot、Profile 和插件结果，在对应 HostScope 内临时运行。
- **控制站**：`apps/codingns-proxy`，提供 Auth、Device、Workspace、Relay、Tailscale、Multi-Host 和 Host binding 控制面。

## 硬门禁

1. 控制站和 Relay 永远看不到 DSH 业务明文，包括 RPC、模型消息、CLI 输出、PTY、任务、文件、端口和 PeerHost 内容。
2. 控制站不终止业务 HTTPS/WebSocket；业务数据在 DSH Client 与目标 DSH Host 之间端到端加密。
3. refresh token 只存在 Host 安全存储。H5 只使用控制站 HttpOnly 会话、一次性访问码或 Device Code。
4. 远程插件必须在对应远程 DSH Host 上安装和管理。客户端可以按需下载该 Host 的 Client Bundle，但只能在对应 Remote DSH Web Runtime 临时执行，不得写入本地 Profile 或全局 Loader。
5. 现有本地 DSH 和用户安装的其他插件必须继续加载；`dsh-codingns` 只能使用官方扩展点和独立 HostScope，不能覆盖全局插件命名空间。

## 功能需求

### 需求 1：单一插件与模块开关

插件发行包必须同时提供 Host entry、Client entry、Transport、Profile 和功能模块清单。基础认证、HostScope、Transport 和 Web Runtime 装配不可关闭；CLI、文件、终端、任务、进程、端口、反向代理和 PeerHost 可以独立启用、禁用和卸载。模块失败只能影响自己，并清理自己创建的流、进程、终端、任务和监听器。

### 需求 2：认证、设备和 Host 绑定

用户必须能在 DSH 内完成登录、刷新、退出、设备管理和 Host 选择。Host 侧调用控制站并保存 refresh token；Client 只看到脱敏的账号、设备、Host 状态和短期 connect ticket。撤销设备或退出登录后，凭据和连接尝试必须停止。

### 需求 3：统一远程连接

Client 获取短期 signaling ticket，完成 SDP、ICE/TURN、DTLS fingerprint 校验并建立 WebRTC DataChannel。随后打开单一 DSH Multiplex Gateway，支持 RPC、Remote、事件、文件、取消、背压和 generation recovery。旧 generation 的结果不得写入新 generation。

### 需求 4：CLI 适配器

CodingNS 已支持的 Codex、Command Code、Claude Code 等 CLI 适配器统一映射到 `adapter` 频道，支持启动、输入、输出、取消、信号、退出和资源清理。某个 Provider 不可用不能影响其他 Provider。

### 需求 5：工作区文件树和预览

Host 在工作区权限范围内提供稳定排序的目录、文本/图片预览和受限二进制摘要。路径越界、文件过大或权限不足必须用稳定错误码拒绝。

### 需求 6：Shell、PTY 和后台任务

DSH Web 仍是终端功能的主体，但终端栈由 `dsh-codingns` 自身完整提供：Typert manifest、Host controller、浏览器 `webTerminals`、DSH Sidebar UI、xterm、持久映射、POSIX tmux backend 和 Windows ConPTY broker。插件不得导入或调用 CodingNS 父仓库及其 Host 私有接口，浏览器不得直连本机 broker。终端必须支持长期会话、输入、输出、resize、显式关闭和断线后的可恢复 attach；后台任务通过独立 `task` 频道管理，不能与终端关闭语义混用。

终端持久化只承诺跨浏览器、插件、generation 和 DSH 重启，不承诺跨操作系统重启。macOS/Linux 默认使用 zsh，Linux 未安装 zsh 时允许回退 bash；Windows 从已安装的 cmd、PowerShell 和 Git Bash 中选择。浏览器断开、插件卸载和 generation 切换只释放订阅与 attach，只有用户明确关闭终端才结束 tmux 或 ConPTY 运行时。官方 Host controller 和官方 terminal UI 必须成对禁用，插件必须在同一 Bundle generation 内一次性提供 Host 与 Client 四个组成部分，不能留下 `webTerminals` 服务空洞。

DSH「设置 → CodingNS」必须提供“终端强化”模块。启用或禁用只在重启 DSH 后生效，设置页必须区分当前状态和下次启动目标状态。模块内允许选择按平台检测的默认新建终端，并配置只作用于插件终端 Shadow DOM 的背景、前景、光标、字体、字号、行高、光标行为和回滚行数；默认 profile 与外观设置不要求重启。

### 需求 7：进程、端口和反向代理

提供授权范围内的进程启动、停止、状态、端口查询和反向代理。反向代理默认关闭，只允许显式登记的端口、方法和路径，不得成为任意 URL 转发器。

### 需求 8：PeerHost

PeerHost 是逻辑资源模型，不强制代表物理转发路径。Desktop/H5 连接远程 Host 时优先直接 WebRTC；当前 Host 代转仅为受信任回退。PeerHost 配置必须经过目标 Host 握手、产品/API 兼容、fingerprint 和登录态检查；Client 只能提交 `targetHostId`，不得获得目标 token。所有 HTTP/WS 路由和消息类型都必须通过白名单。

### 需求 9：H5 远程访问

H5 不部署固定版本的独立 DSH 前端。控制站只提供极小 Bootstrap，负责浏览器会话、申请 ticket、建立 WebRTC 和启动 `web.session.open`。远程 Host 返回官方 DSH Web boot、Profile、资源和插件 Manifest/Bundle；H5 在对应 HostScope 中渲染远程 DSH Web，刷新或断开时清理运行时。

### 需求 10：Desktop 远程访问

官方 DSH Desktop 安装 `dsh-codingns` Client 后即可连接远程 Host，不要求第一阶段自行打包 Win/macOS。Desktop 维护本地、remote-a、remote-b 等独立 Web Context；每个 Context 拥有独立 connection、generation、Profile、Plugin Manifest 和 Loader。远程插件不安装到本地 Profile，只由远程 Host 按需提供并在其 Context 临时加载。

### 需求 11：多 Host 会话聚合

插件在 Shell 层聚合本地和远程 Host 的会话列表。每一条记录必须带 `hostId`、`hostLabel`、`workspaceId`、`sessionId` 和连接状态；打开记录时路由到对应 HostScope，不能使用裸 `sessionId` 或全局插件列表。

## 非功能需求

- **安全**：日志不得包含 token、密码、完整命令、文件内容或 PeerHost 凭据；控制站和 Relay 不解析业务 Envelope。
- **可靠性**：控制站、Relay、ICE 或 Host 暂时不可用时复用 DSH generation recovery，不能为每个模块创建私有重连器。
- **性能**：所有长流使用分帧、单流/会话/模块窗口和背压；窗口耗尽时暂停读取上游，不无限缓存。
- **兼容性**：锁定 DSH 版本兼容矩阵，保留官方 Web、Desktop 和其他插件的加载行为；未知版本或能力必须在握手阶段明确失败。

## 成功定义

一个 `dsh-codingns` 插件可以在 DSH Host 上启用，用户可从 H5 或官方 Desktop 登录控制站、选择 Host、建立端到端远程 DSH 会话，并在同一套 Transport 上使用 CLI、文件、PTY、任务、进程、端口、反向代理和 PeerHost。多 Host 资源不串线，远程插件不污染本地 Profile，模块关闭后无残留资源，控制站和 Relay 始终看不到业务明文。

# spec001：DeepSeek Harness 的 CodingNS 单一插件

状态：阶段 0 骨架与发行装配已完成；Transport、远程 Web Runtime、多 Host 和业务模块仍按任务清单推进。

## 这份 Spec 要解决什么问题

`dsh-codingns` 是运行在 DSH 上的单一插件，不是替代 DSH 的独立客户端，也不是一套独立部署的 DSH 前端。DSH 始终是主体宿主；插件同时提供 Host half 和 Client half，把 CodingNS 的认证、WebRTC 连接、CLI、文件、PTY、任务、进程、端口、反向代理和 PeerHost 能力接入 DSH。

插件支持三种使用方式：本机 DSH 使用本机 Host；浏览器 H5 通过最小 Bootstrap 建立端到端连接并直接加载用户 Host 上的 DSH Web；官方 DSH Desktop 通过本地插件连接远程 Host，将远程 Host 作为带 `HostScope` 的会话展示。远程插件仍由远程 Host 安装和管理，不写入本地 Profile。

控制站和 Relay 只负责认证、绑定、短期 ticket、信令和连接状态，永远不能看到 DSH 业务明文。所有 DSH、CLI、PTY、任务、文件、端口和 PeerHost 流量都走统一的“单 WebSocket、多逻辑流、DSH Envelope”数据面。

## 阅读顺序

1. `requirements.md`：必须支持的场景、安全门禁和兼容边界。
2. `design.md`：Host/Client、H5、Desktop、HostScope 和 Transport 的协作方式。
3. `tasks.md`：已完成证据和未完成任务；只有有验证证据才能标记 `DONE`。

## 外部依赖

- DSH `0.1.6-alpha.2` 的 `ClientTransportHooks`、`installConnection()`、`loadBundle()` 和 connection generation；后续版本必须维护兼容矩阵。
- `/Users/jackson/Code/CodingNS/apps/codingns-proxy` 的 Auth、Device、Workspace、Relay、Tailscale、Multi-Host、Host binding 和 signaling ticket 契约。
- CodingNS Host 现有工作区、终端、PTY、TaskManager、进程、端口、反向代理和 PeerHost 服务。
- CodingNS 主仓库 `spec001.3.2-当前HOST代理访问其他HOST仓库`、`spec001.3.3-HOST与PEERHOST资源作用域统一与切换收口` 定义的 PeerHost 白名单、目标会话和资源作用域规则。

## 明确不做

- 不把 DSH Web 静态资源固定复制到 `app.codingns.com`，也不维护脱离用户 Host 版本的独立前端。
- 不让控制站或 Relay 终止 HTTPS/WebSocket 并解析业务；它们只能转发加密 WebRTC 和信令。
- 不把远程 Host 的插件安装到本地 DSH Profile，也不把不同 Host 的插件版本合并到全局 Plugin Loader。
- 不在浏览器持久化 refresh token；浏览器只使用控制站 HttpOnly 会话、一次性访问码或 Device Code。
- 不强制第一阶段自行打包 Win、macOS 或移动端；优先扩展官方 DSH Desktop 和官方 Web Runtime。
- 不把 PeerHost 简化成任意 URL 代理。直接 WebRTC 连接优先，当前 Host 代转只作为受信任回退路径。

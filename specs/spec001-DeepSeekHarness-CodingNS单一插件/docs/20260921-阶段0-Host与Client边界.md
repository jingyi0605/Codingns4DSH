# 阶段 0：Host 与 Client 边界

## Host 侧允许的能力

Host entry 运行在 DSH 的 Node/Cordis 进程，可在后续阶段依赖：

- Node.js API、凭据存储和 CodingNS Control API Client；
- CodingNS Host 的工作区、终端、任务、进程和端口服务；
- Node WebRTC 运行时，以及 Host 私钥和信令票据签发相关的 Host-only 能力。

阶段 0 的 Host entry 目前不导入任何 Node API，不访问控制站，不读取账号、密码或 refresh token，不创建服务器、WebRTC、timer、socket 或子进程。

## Client 侧允许的能力

Client entry 运行在 DSH 浏览器 Client，可在后续阶段依赖：

- DSH Client API；
- 浏览器 WebRTC API；
- `ClientTransportHooks`、`installConnection()` 和 `ConnectionGenerationSource` 的类型/调用契约；
- Client UI Slot 和浏览器安全的共享 DTO。

阶段 0 的 Client entry 只导出空 `apply()`，不发起登录请求、不创建 WebRTC、不写入模型、Session 或普通页面状态。

## Client 明确禁止的依赖

Client 构建产物不得依赖或导入：

- `node:crypto`
- `node:fs`
- `node:net`
- `node:child_process`
- Host refresh token、Host 私钥、控制站内部密钥和信令 ticket 签发密钥

`apps/codingns-proxy/packages/shared-contracts/src/signaling-ticket.ts` 明确依赖 `node:crypto`，因此不能被打进浏览器包；阶段 0 没有复制或引用该实现。

## 生命周期原则

Host 与 Client 均使用 DSH/Cordis 的 entry fiber 生命周期。阶段 0 入口没有副作用，加载后可以立即 dispose，卸载后不会留下 timer、socket、进程、监听器或凭据。后续模块必须把所有资源注册到拥有它们的 entry/fiber，并在 dispose 中关闭资源。

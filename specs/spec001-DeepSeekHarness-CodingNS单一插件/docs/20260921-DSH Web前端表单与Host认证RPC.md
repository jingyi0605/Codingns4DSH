# DSH Web 前端表单与 Host 认证 RPC

## 已实现

`src/client/index.ts` 现在向 DSH Web 的 `settings.section` 注册 CodingNS 设置区块，包含：

- Control API 地址；
- 邮箱和密码登录表单；
- 当前账号、设备和 Host 绑定摘要；
- 刷新设备、绑定 Host、解绑 Host 和退出登录操作；
- 中转访问服务开关。

浏览器端只在 React 组件内暂存密码。密码通过 DSH Connection 的 `/codingns` RPC 一次性提交给 Host，
不会写入 settings、URL、Session、模型上下文或日志。

## Host 边界

`src/host/rpc.ts` 注册 `/codingns` Host RPC，并调用已有的 `CodingNsAuthSession` 和
`HttpCodingNsControlApiClient`。Host 只向浏览器返回脱敏的认证快照、设备摘要和绑定摘要。
access token 和 refresh token 不出 Host RPC 响应。

当前凭据存储使用 `InMemoryCodingNsCredentialStore`，用于本轮端到端测试；DSH Host 重启后不会保留
登录态。接入生产发行前必须替换为 DSH/CodingNS 的安全凭据存储实现。

## 验证

```bash
pnpm test -- tests/client-entry.spec.ts tests/contracts.spec.ts tests/host-entry.spec.ts
pnpm exec tsc --noEmit
```

验证结果：9/9 定向测试通过，TypeScript 检查通过；Client 构建产物未包含 Node 专属模块。

## 尚未包含

真实 WebRTC 连接、登录后自动申请 signaling ticket、设备撤销、Host 公钥自动发现和完整 PeerHost
管理仍属于后续工作。当前表单的目标是让 DSH Web 可以实际提交登录和 Host 管理请求，支持端到端联调起步。

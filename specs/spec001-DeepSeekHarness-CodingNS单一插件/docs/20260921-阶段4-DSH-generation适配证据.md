# 阶段 4：DSH generation 与 Transport 装配证据

## 版本与实际源码

本适配按本机 DSH `0.1.6-alpha.2` 实现。读取的实际文件为：

- `~/.dsh/profiles/stage0/node_modules/@deepseek-ai/dsh-client-connection/package.json`
- `~/.dsh/profiles/stage0/node_modules/@deepseek-ai/dsh-client-connection/lib/types/client/index.d.ts`
- `~/.dsh/profiles/stage0/node_modules/@deepseek-ai/dsh-client-connection/lib/types/client/connection.d.ts`
- `~/.dsh/profiles/stage0/node_modules/@deepseek-ai/dsh-client-connection/lib/types/rpc.d.ts`
- `~/.dsh/profiles/stage0/node_modules/@deepseek-ai/dsh-client-connection/lib/client.js`

## 已确认的 DSH 装配顺序

DSH `dsh-client-connection` 的 Client plugin 会读取 `globalThis.__DSH_TRANSPORT__`，然后调用 `installConnection(ctx, { transport })`。该调用只创建 `ctx.connection` 服务，不会替插件注册 generation source。

同时，`@deepseek-ai/dsh-api-gateway` 的 `ClientRemoteEvents` 会注册唯一的
`ConnectionGenerationSource`，`ClientRemoteService` 再调用 `connection.start()`。
因此普通 dsh-codingns Client entry 不能再次注册 source 或启动 connection；否则会触发
DSH 的“generation source 已注册”错误。

正式的 generation 装配顺序是：

1. pre-Cordis 启动胶水将 Transport hooks 写入 `globalThis.__DSH_TRANSPORT__`。
2. DSH `dsh-client-connection` plugin 调用 `installConnection()`。
3. DSH API Gateway 注册唯一 generation source，并调用 `connection.start()`。
4. CodingNS Transport 仅提供 `rpc/openStream/fetch/loadBundle` 以及 generation/reconnect hooks。
5. DSH source 第一次调用 `ready({ home })` 后，DSH 才发布 `connected` 和 generation。
6. source promise 结束或 signal 被 abort 后，DSH 清理当前 generation 并按自身退避策略重试。
7. 插件卸载时由 DSH 负责停止官方 connection；插件只关闭自身 Transport。

这条路径使用 DSH 已有的正式 API，不覆盖默认 Connection，也不修改 DSH 核心源码。

## 真实类型契约

`ClientTransportHooks.rpc` 的真实类型不是函数，而是：

```ts
interface ClientConnectionRpc {
  call(channel, endpoint, payload, signal?): Promise<ConnectionRpcResult<unknown>>
  open?(channel, endpoint, payload, signal): AsyncIterable<unknown>
}
```

`ConnectionGenerationSource` 的真实类型是：

```ts
type ConnectionGenerationSource =
  (signal: AbortSignal, ready: (host: ConnectionHostInfo) => void) => Promise<void>
```

适配器位于 `src/bootstrap/dsh-connection-adapter.ts`，负责：

- 将插件内部 `rpc(request)` 映射为 DSH `rpc.call()` 和 `rpc.open()`。
- 将当前 CodingNS generation 映射为 DSH `ready({ home })`（仅供显式 adapter API 使用）。
- generation 失效时结束 source，由 DSH ConnectionController 负责重试。
- 在 `onReconnectRequested` 中调用插件 Transport 的 reconnect 回调。
- `bindDshConnection*` 只用于独立运行时或测试，不由普通 Client entry 自动调用；普通插件不会
  再次 `registerGenerationSource()` 或 `start()`。

## 测试证据

```bash
pnpm test -- tests/dsh-connection-adapter.spec.ts tests/client-entry.spec.ts
pnpm exec tsc --noEmit
```

当前结果：适配器 4/4 通过；连同 Client entry 测试共 6/6 通过；TypeScript 检查通过。

## 明确边界与残余风险

- 当前只完成浏览器侧 DSH hooks 装配和 Fake carrier 验证；正常运行路径由 DSH API Gateway
  独占 generation owner。
- CodingNS Host acceptor、Relay 四端真实联调尚未完成。
- `DshCodingNsTransport` 当前实例的 carrier 不可替换；真实 reconnect 需要后续增加稳定 Transport owner 或 carrier replacement 设计。
- 内部 Tunnel RPC 暂以 `{ channel, payload }` 保留 DSH 绝对 channel；Host 侧必须确认并固定该线路协议后，才能标记真实 RPC 完成。
- 不能据此声称文件、终端、进程、PeerHost 或远程连接业务已经可用。

# spec002：基于 CodingNS HTTP/WS 隧道的 DSH 多路复用网关

状态：Draft；这是 `dsh-codingns` 的统一数据面专项，不是独立前端项目。

## 这份 Spec 要解决什么问题

把一个 CodingNS WebRTC 会话包装成单一 DSH Multiplex Gateway：一个 WebSocket 会话承载多个逻辑流，统一传输 DSH RPC、事件、文件、CLI、PTY、后台任务、端口、PeerHost 和远程 DSH Web。控制站和 Relay 只提供认证、短期 ticket、SDP/ICE 信令和连接状态，不能看见任何业务明文。

三层结构固定如下：

```text
CodingNS WebRTC / HTTP / WebSocket Tunnel
  -> DSH Multiplex Transport（统一 Envelope、多 Stream、流控）
    -> DSH / CLI / PTY / Task / File / Port / PeerHost / Web 模块
```

## 使用边界

- DSH 是主体，Gateway 运行在 `dsh-codingns` Host half；H5 和 Desktop 通过 Client half 使用它。
- H5 只部署最小 Bootstrap，远程 DSH Web、Profile 和插件结果由用户自己的 Host 返回。
- 官方 DSH Desktop 维护本地和远程 Web Context；远程插件不安装到本地 Profile，只在对应 HostScope 临时加载。
- Remote Host 可以作为 PeerHost 资源显示，但物理连接优先直接 WebRTC；当前 Host 代转只作为受信任回退。
- Relay 不终止业务 WebSocket，不解析 DSH Envelope，不保存业务内容。
- 终端能力由插件自身实现：自有 UI 挂载到 DSH Sidebar，POSIX 使用 tmux，Windows 使用独立 ConPTY broker；不调用 CodingNS 父仓库或 Host 私有接口。
- 终端持久化只承诺跨浏览器、插件和 DSH 重启，不承诺跨操作系统重启。官方 Host controller 与官方 terminal UI 成对禁用，由插件原子提供 Typert、Host controller、`webTerminals` 与 Sidebar UI。
- DSH「设置 → CodingNS」提供“终端强化”模块；启用或禁用需要重启 DSH，默认终端和外观设置在模块已启用时分别从下一次新建终端或当前插件终端开始生效。

## 文档顺序

1. `requirements.md`：数据面必须保证的行为和安全门禁。
2. `design.md`：Gateway、HostScope、Web Runtime 和模块路由设计。
3. `docs/20260921-DSH多路复用协议草案.md`：Envelope、频道和消息级契约。
4. `tasks.md`：实现顺序、验证命令和未完成项。

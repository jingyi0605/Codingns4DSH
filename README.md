# dsh-codingns

这是把 CodingNS 接入 DeepSeek Harness（DSH）的独立插件包。阶段 0 至 3 的结构、契约和最小实现已完成；阶段 4 已完成可注入的 WebRTC/Transport 连接骨架和 Fake 联调。DSH Web 设置页已经提供登录、设备和 Host 绑定表单，但真实 Host/Relay/Browser 四端联调尚未完成。

## DSH 装配

包根导出 `dist/index.js` 是 Host Cordis 入口，`exports["./client"]` 是浏览器入口。Client 入口声明为立即加载，确保 DSH 设置页打开时 CodingNS 区块已经注册。`package.json` 的 `dsh.bundle.patch` 指向 `dsh.bundle.patch`，Profile 通过 `dsh.profile.bundles` 按包名选择它。

当前 DSH 版本约束为 `0.1.6-alpha.2`。启动期 Transport 事实和限制记录在 `specs/spec001-DeepSeekHarness-CodingNS单一插件/docs/20260921-阶段0-DSH插件装配调查.md`。

## 三件套装配

- `dsh-codingns`：DSH Bundle，提供 Host/Client 入口和后续 CodingNS 能力。
- `profile/`：独立 CodingNS Profile，只声明 `dsh-codingns` Bundle，并锁定 DSH `0.1.6-alpha.2`。
- `exports["./bootstrap"]`：启动胶水。桌面壳或页面必须在创建 DSH Client/Cordis 之前调用 `installPreCordisTransport()`，再启动 DSH；它不是普通动态插件，也不覆盖默认 Connection。

启动胶水当前负责版本校验、唯一 Transport 登记和失败清理；`DshCodingNsTransport` 通过 `asTransportHooks()` 提供给它。普通动态插件不会覆盖默认 Connection。

## 当前阶段能力

- 阶段 1：功能模块注册、依赖排序、启停和资源清理。Host 与 Client 两侧入口都已接入 `FeatureRegistry`，设置里的模块开关通过 `reconcile` 驱动模块启停，模块在 `start` 中登记的资源随停用释放。
- 模块化扩展：模块自带界面描述（标题、说明、排序、是否可关闭）和设置面板，设置页只做遍历渲染，RPC 也按 `namespace/action` 前缀分发。新增模块只需实现模块文件并在对应清单登记一行，不需要修改设置页、入口或中心分发代码。
- 阶段 2：Host 侧登录、refresh token 存储、设备查询和 Host 绑定；Control API 使用 CodingNS 当前真实路径。这些能力由 Host 侧 `auth` 模块以 `auth/*` 命名空间提供。
- 阶段 3：Host/Workspace/PeerHost 资源作用域切换和旧 generation 回写隔离。
- 阶段 4：Relay ticket、ICE 配置、offer/answer、candidate、DTLS fingerprint 校验、DataChannel Carrier 和 DSH Transport/Tunnel Frame 骨架。
- 中转访问服务的 Control API 地址默认是 `https://channel.codingns.com:1443`。设置页使用下拉框选择已保存地址，也可以添加新的 HTTP(S) 地址；地址列表只保存地址，不保存账号、密码或 refresh token。
- 局域网访问DSH模块：Client 入口加载时自动补齐 `crypto.randomUUID`，并在设置卡片中管理 Host 侧的单一 DSH Web 监听；已有浏览器实现不会被覆盖。

这些能力不等于已经提供文件树、终端、通用进程管理或 PeerHost 代理；这些业务模块仍未实现。八个外部 Agent 已通过同一套消息边界接入：流式 JSON、JSON-RPC/ACP 和 HTTP/SSE 驱动只负责把 Provider 私有协议转换为 `CodingNsAgentEvent`，Registry 只管理执行和会话状态，公共消息投影器再统一处理正文、思考、工具、权限、问题、用量和终态。只有公共投影器及原生桥接理解 DSH 消息协议，单个驱动不得直接构造 DSH 原生消息。Host 会持久化外部会话摘要，只读检查 Provider 原始会话是否仍然存在，并复用 DSH 原生会话消息和归档 API；外部 CLI 已执行的工具由公共投影层保存为成对的 DSH `tool/call` 与 `tool/result` 历史事件，不会作为模型流中的 `tool-call` 交给 Agent Loop，因此不会被二次执行。当前验证覆盖 fake 进程、SSE、取消清理、会话恢复、原始会话探测、权限和问题回传以及原生会话桥接；真实 CLI 版本差异、宿主的磁盘 Session persistence 插件以及远程 Host/Client 端到端联调仍需人工验收。

### 局域网访问DSH

安装并启用本插件后，局域网浏览器访问 DSH Web 服务无需额外安装 `dsh-lan-access`。浏览器 Client 入口会幂等执行 `crypto.randomUUID` 兼容补丁：优先使用浏览器的 `crypto.getRandomValues` 生成 RFC 4122 v4 UUID，在极旧环境中才退回非加密随机数。该模块也可通过 `dsh-codingns/client/lan-access` 单独导入并调用 `ensureCryptoRandomUUID()`。

局域网访问DSH卡片只管理一条监听：从下拉框选择本机网卡地址或 `0.0.0.0`，监听端口默认 `13080`，并把请求转发到当前 DSH Web。DSH 本地端口会自动探测；检测到多个 DSH 实例时，可手动填写正确端口。这条路径不经过“中转访问服务”，也不包含规则 ID 或任意目标地址配置。

该模块同时显示在 DSH 的“CodingNS”设置页中，作为“局域网访问DSH”功能卡。UUID 兼容补丁始终启用；监听器只有在用户明确启动后才会打开，停用插件时会自动关闭。

Profile 安装完成后，使用 DSH 官方启动器启动：

```bash
dsh plugin --profile dsh-codingns add dsh-codingns@0.1.0
dsh --profile dsh-codingns
```

## 本地开发：重启 DSH 即加载最新代码

DSH 运行时加载的是 `dist/` 中的 JavaScript，不能直接加载 `src/` 下的 TypeScript。开发时只需首次把某个本地 Profile 的插件目录链接到当前仓库，并启动一次监听编译：

```bash
pnpm dev:link stage0
pnpm dev:watch
```

`dev:link` 会把原来的插件目录改名为可恢复的 `.bak-dev-*` 备份，然后创建指向当前仓库的链接；已经链接过时会直接复用。`dev:watch` 同时监听 Host 的 TypeScript 输出和浏览器 Client bundle。保持它运行，之后每次修改代码只需重启 DSH：

```bash
dsh --profile stage0 --no-open
```

不需要再次执行 `pnpm build`、打包或安装插件。若使用其他 Profile，把 `stage0` 换成对应名称；也可以通过 `DSH_HOME` 指定 DSH 数据目录。

升级 DSH 时必须先匹配新的插件版本。版本不等于 `0.1.6-alpha.2` 时，启动胶水会明确抛出 `DSH_VERSION_UNSUPPORTED`，不会静默降级或覆盖默认连接。

验证：

```bash
pnpm install --ignore-scripts
pnpm test -- tests/manifest.spec.ts tests/contracts.spec.ts tests/host-entry.spec.ts tests/client-entry.spec.ts tests/bootstrap.spec.ts tests/feature-registry.spec.ts tests/feature-wiring.spec.ts
pnpm exec tsc --noEmit
```

# 设计文档 - 工作区 Agent 接入：Webhook 投递

状态：已完成

## 1. 概述

### 1.1 目标

- 把 DSH 会话里“需要外部 Agent 响应”的变化，变成一条条带签名的 HTTP POST，发给用户配置的目的地。
- 消息里的 ID 和下一步提示，要能直接对上 spec008 的 MCP 工具。
- 投递落盘、可重试、重启不丢。
- 不碰 spec008 现有 MCP 工具的名字、参数和认证。

### 1.2 覆盖需求

- `requirements.md` 需求 1 到 6，以及全部非功能需求。

### 1.3 技术约束

- 后端：Host 功能模块（TypeScript），挂在现有 `workspaceMcp` 功能旁边。
- 前端：`src/client/features/workspace-mcp.ts` 的面板，文案进 `src/client/locale.ts`。
- 数据存储：Host 私有目录下的 owner-only JSON 文件，不进 DSH 设置文档。
- 认证授权：管理接口只允许 Host 所有者，复用 `generate-key` 的所有者判断。
- 外部依赖：目的地 HTTP 服务。使用 Node 内置 `fetch`，不引入新依赖。

## 2. 当前代码里已经有的东西

| 需要的能力 | 现状 | 位置 |
| --- | --- | --- |
| 会话事件订阅 | `nativeSessions.subscribe({ onEvent })`，对应 DSH 的 `session/event` | `src/host/native-session-bridge.ts` |
| 权限/提问的等待事件 | `services.events.on('approval/request' 等)`，PWA 通知已在用 | `src/host/features/lan-access-dsh.ts` |
| 会话结束识别 | PWA 通知按归一化后的 `turn_end` 判断 | `src/host/modules/pwa/pwa-session-notifications.ts` |
| 会话属于哪个工作区 | `findSessionWorkspace(services, sessionId)` | `src/host/workspace-mcp/tools.ts` |
| 待回答问题快照 | `WorkspacePendingQuestionsAdapter` | `src/dsh-capabilities/host/workspace-pending-questions-adapter.ts` |
| owner-only 私有文件 | `FileWorkspaceMcpApiKeyStore` 的写法 | `src/host/workspace-mcp/api-key-store.ts` |
| 所有者判断、RPC 注册 | `generate-key` 分支 | `src/host/features/workspace-mcp.ts` |
| 设置页面板 | `WorkspaceMcpPanel` | `src/client/features/workspace-mcp.ts` |

**任务 1.1 的静态调查结论**（完整证据见 `docs/调查报告/20261110-DSH会话事件形态调查.md`）：

1. 会话事件形状是 `{ type, seq, time, data }`。一轮对话结束是 `type === 'turn/end'`，正常完成使用 `data.reason.kind === 'completed'`，出错使用 `data.reason.kind === 'error'`。错误字段为 `data.reason.error.code` 和 `message`。`turn_failed` 之类是外部 Agent 驱动内部的名字，不是 DSH 原生事件。
2. 用户取消在 DSH 类型契约中是 `reason.kind === 'aborted'` 且 `reason.reason.kind === 'user'`，不产生 `session.failed`。`blocked`、`max-tokens`、`interrupted`、`forked` 等其他终态也不映射为正常完成或错误事件；未知原因忽略。
3. 权限申请是 `type === 'approval/asked'`，`data.id` 就是请求 ID，`toolName`、`reason`、`callId`（可选）都在 `data` 里。
4. 提问通过 `services.events` 的 `user-questions/request` 触发；该事件没有稳定的 `callId` 契约。要延迟读提问快照（`WorkspacePendingQuestionsAdapter.list`）取得活动问题的 `callId` 和问题内容。读不到时延迟重读，仍没有对应活动提问就忽略并记一条诊断。
5. `session_permission_status` 只认 MCP 自己发起的请求。DSH 自己发起的权限申请查不到，所以权限事件的 `nextActions` 不放这个工具。

当前字段契约来自锁定的 DSH 0.2.2-rc.1 类型声明及仓库生产代码、测试夹具，尚未做运行时抓包。提问事件在 Host 的实际触发时序、事件触发时快照是否已更新、会话加载是否重放历史终态及 `time` 单位仍未验证。实现用延迟快照读取处理提问，不依据 `time` 阈值判断新旧事件；事件回调只处理当前收到的事件。插件最低支持 DSH 0.2.1-alpha.2，较早版本不支持；事件字段的最早引入版本无法从现有旧版依赖确认，能力缺失时由运行时探测并在状态中标为不可用。

## 3. 架构

### 3.1 数据流

```text
DSH 会话事件 ──► 事件识别器 ──► 目的地匹配 ──► 投递队列(落盘) ──► 发送器 ──► 目的地 URL
(session/event,    (分类、去重、     (工作区+事件类型)    ▲                  │ 签名、超时、重试
 approval/request) 补全上下文)                          │                  ▼
                                                  界面读取投递记录     外部 Agent
                                                                           │
                                                                           ▼
                                                              MCP 工具（spec008，不改）
```

### 3.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `workspace-mcp/webhook-events.ts` | 把原始 DSH 事件分类成四种业务事件，去重，补全上下文 | `session`、`event` | `WebhookEvent \| null` |
| `workspace-mcp/webhook-payload.ts` | 生成消息体、下一步提示，做脱敏和截断 | `WebhookEvent`、工作区信息 | JSON 对象 |
| `workspace-mcp/webhook-store.ts` | 目的地配置与投递队列的落盘读写 | 配置变更、队列变更 | 文件 |
| `workspace-mcp/webhook-dispatcher.ts` | 按目的地逐条发送、退避重试、尊重 `Retry-After`、签名 | 队列 | HTTP 请求、投递结果 |
| `features/workspace-mcp.ts` | 注册 `workspaceMcp/webhook-*` RPC，管理订阅生命周期 | RPC 请求、Host 服务 | RPC 响应 |
| `client/features/workspace-mcp.ts` | 设置页“消息通知”区块 | RPC 响应 | 界面 |

### 3.3 关键流程

#### 3.3.1 事件到投递

1. 订阅回调收到原始事件，只做分类，不做网络和大文件操作。
2. 分类成功后，用 `findSessionWorkspace` 找到工作区；找不到就丢弃。
3. 按去重键判断是否重复（见 4.3）。
4. 对每个启用、且工作区和事件类型都匹配的目的地，生成一条投递并追加到队列。
5. 队列写盘（合并写，避免每个事件一次同步写），然后唤醒发送器。

#### 3.3.2 发送与重试

1. 发送器按目的地取队首投递，同一目的地串行，不同目的地并发，总并发有上限。
2. 构造请求体和签名头，用 `fetch` 发送，`redirect: 'error'`，超时 10 秒。
3. 2xx：标记已送达。可重试错误：按退避重新排期。永久错误或次数用尽：标记失败。
4. 每次状态变化更新落盘队列和最近记录。
5. 唯一的定时器由发送器持有：只在存在“等待到点重试”的投递时才设置，队列空了就清掉。

#### 3.3.3 Host 重启

1. 功能启动时读取队列文件，把状态为 `sending` 的投递改回 `pending`（可能重复送达，消息带固定 `Delivery-Id`，接收方可去重）。
2. 只有存在启用的目的地时才订阅事件。
3. 立即让发送器处理到点的投递。

## 4. 数据结构

### 4.1 目的地

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `id` | string | 是 | 目的地 ID | 随机，创建后不变 |
| `name` | string | 是 | 界面显示名 | 1 到 80 字符 |
| `url` | string | 是 | 投递地址 | `http`/`https`，不超过 2048 字符，不含用户名密码 |
| `secret` | string | 是 | 签名密钥 | 随机 32 字节，base64url，只在创建/轮换响应里出现一次 |
| `enabled` | boolean | 是 | 是否启用 | 默认 true |
| `workspaceIds` | string[] \| null | 是 | 工作区范围，`null` 表示全部 | 最多 100 项 |
| `eventTypes` | string[] | 是 | 要接收的事件类型 | 至少 1 项，只能是事件目录里的值 |
| `includeLastMessage` | boolean | 是 | 完成通知是否附带最后回复摘录 | 默认 true；false 时省略 `data.lastMessage` |
| `createdAt` / `updatedAt` | string | 是 | ISO 时间 | |

对外（RPC 返回）的目的地视图：把 `url` 换成脱敏形式（只保留协议、主机、端口，路径显示为 `/…`），把 `secret` 换成 `secretConfigured: true`。

上限：目的地最多 20 个。

### 4.2 投递

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `deliveryId` | string | 投递 ID，重试不变 |
| `eventId` | string | 事件 ID，同一事件发给多个目的地时相同 |
| `dedupeKey` | string | 持久去重键摘要，按目的地与事件唯一身份生成 |
| `destinationId` | string | 目标目的地 |
| `status` | `pending` \| `sending` \| `delivered` \| `failed` | 见 4.4 |
| `attempts` | number | 已尝试次数 |
| `nextAttemptAt` | number | 下次尝试的时间戳 |
| `lastError` | string \| null | 错误类别，如 `timeout`、`http_503`，不含 URL 和响应体 |
| `body` | string | 入队时就生成好的请求体原文，保证重试时签名内容一致 |
| `destinationSnapshot` | object | 入队时的 URL、签名密钥和消息选项快照；目的地之后修改不影响已排队投递 |
| `createdAt` / `finishedAt` | string | |

### 4.3 事件目录与去重键

| 事件类型 | 界面名称 | 触发 | 去重键 |
| --- | --- | --- | --- |
| `session.completed` | 会话已完成 | `session/event` 的 `turn/end`，`reason.kind === 'completed'`，且父会话没有被子代理屏障拦住 | `sessionId` + 事件 `seq` |
| `session.failed` | 会话出错 | `turn/end` 且 `reason.kind === 'error'`，错误码和文本取 `reason.error.code`、`reason.error.message`；其他终态不投递 | 同上 |
| `session.permission_requested` | 需要权限确认 | `session/event` 的 `approval/asked` | `sessionId` + `data.id` |
| `session.question_asked` | 会话在等你回答 | `services.events` 的 `user-questions/request`，延迟读提问快照取 `callId` | `sessionId` + `callId` |

事件处理器从入站数据只构造白名单结构字段：

- 工作区 ID 和名称只取受管工作区注册表记录；不序列化工作区服务对象或根目录。
- 会话 ID 只取 DSH 会话标识；标题只接受 `session_list` 返回的安全 `projections.values.title` 字符串，缺失时省略标题。
- 正文和问题字段来自已验证的 DSH 最终文本字段/问题投影字段；只截断到字节上限，不做关键词扫描、路径匹配或正文改写。
- 事件 ID、时间、事件类型、请求 ID、错误码等只接受明确类型的原始标量；密钥、URL、内部服务引用不属于事件结构。

入队时对投递行使用持久唯一键：

```text
destinationId + sessionId + eventType + (requestId | callId | turnSeq)
```

每条投递用 `destinationId + sessionId + eventType + occurrenceId` 计算稳定 SHA-256 `dedupeKey`；`occurrenceId` 是终态事件序号、审批请求 ID 或问题 callId。键与投递一同保存在私有队列文件。存储层 `enqueueOnce` 原子检查并追加：重复时不写第二行，成功时先合并写盘完成，再允许发送器发送。Host 重启后同一事件再次到达仍命中此键。Webhook 接收方另按稳定的 `Delivery-Id` 对网络层至少一次投递去重。

### 4.4 投递状态

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `pending` | 等待发送或等待重试 | 入队；重试排期；重启恢复 | 开始发送 |
| `sending` | 请求已发出 | 发送器取出 | 得到结果 |
| `delivered` | 已送达 | 收到 2xx | 超过保留期被清理 |
| `failed` | 不再重试 | 永久错误或次数用尽 | 超过保留期被清理 |

重试间隔：2 秒、10 秒、60 秒、5 分钟、30 分钟，每次加最多 20% 的随机抖动。`Retry-After` 取秒数，上限 30 分钟。

队列上限：待发送最多 1000 条，最近记录最多 200 条，保留 7 天。淘汰已结束或待发送记录时分别累加状态诊断计数。

## 5. 消息格式

请求：`POST <url>`，`Content-Type: application/json; charset=utf-8`。

请求头：

- `X-CodingNS-Event-Id`
- `X-CodingNS-Delivery-Id`
- `X-CodingNS-Event-Type`
- `X-CodingNS-Timestamp`：Unix 秒
- `X-CodingNS-Signature`：`sha256=<hex>`，内容是 `HMAC-SHA256(secret, timestamp + "." + body)`
- `User-Agent: codingns-workspace-webhook/1`

请求体（示例，会话在等回答）：

```json
{
  "schemaVersion": 1,
  "eventId": "evt_…",
  "type": "session.question_asked",
  "occurredAt": "2026-11-10T08:00:00.000Z",
  "destinationId": "dst_…",
  "workspace": { "id": "ws_…", "name": "my-project" },
  "session": { "id": "sess_…", "title": "修复登录问题" },
  "data": {
    "callId": "call_…",
    "questions": [
      { "id": "q1", "text": "使用哪种方案？", "options": ["A", "B"], "allowCustom": true }
    ]
  },
  "nextActions": [
    {
      "tool": "session_answer",
      "description": "回答这个问题",
      "arguments": { "sessionId": "sess_…", "callId": "call_…" },
      "note": "answer 字段需要按 questions 里的 id 逐题填写"
    },
    { "tool": "session_questions", "arguments": { "sessionId": "sess_…" } }
  ],
  "truncated": false
}
```

各类型 `data` 的内容：

| 类型 | `data` 字段 | `nextActions` |
| --- | --- | --- |
| `session.completed` | `lastMessage`（目的地开启时附带，摘录上限 4 KB，取不到则省略） | `session_continue`、`session_list` |
| `session.failed` | `errorCode`、`errorMessage`（上限 1 KB） | `session_continue`、`session_create` |
| `session.permission_requested` | `requestId`、`toolName`、`reason`、`callId`（可选），另有 `decidableByExternalAgent: false` | 空（`session_permission_status` 只认 MCP 自己发起的请求，查不到 DSH 自己发起的，所以不放） |
| `session.question_asked` | `callId`、`questions` | `session_answer`、`session_questions` |
| `webhook.test` | `message` | 空 |

`nextActions` 里的工具名必须是 `WORKSPACE_MCP_TOOL_DEFINITIONS` 里存在的名字。测试里要加一条断言来保证这一点，防止以后改了工具名而消息没跟着改。

整个请求体上限 16 KB；超出时只截断 `lastMessage` / `questions` 等正文文本并设置 `truncated: true`，ID 等标识字段不截断。正文逐字取自 DSH 已选定的最终回复或问题投影，只按 UTF-8 字节数截断，不用关键词规则扫描或改写；不得把 workspace path、环境变量、密钥或 Host 服务对象拼入结构字段。

## 6. 接口契约

全部走现有 `workspaceMcp` RPC 通道，新增 action，全部要求所有者。

| action | 输入 | 输出 |
| --- | --- | --- |
| `webhook-list` | 无 | 目的地视图列表、最近投递记录、事件类型可用性、队列诊断 |
| `webhook-create` | `name`、`url`、`workspaceIds`、`eventTypes`、可选 `includeLastMessage` | 目的地视图 + 一次性 `secret` |
| `webhook-update` | `id` + 可改字段（`name`、`url`、`enabled`、`workspaceIds`、`eventTypes`、`includeLastMessage`） | 目的地视图 |
| `webhook-rotate-secret` | `id` | 目的地视图 + 一次性 `secret` |
| `webhook-delete` | `id` | `{ removed: true }` |
| `webhook-test` | `id` | `{ ok, httpStatus?, errorKind? }` |

错误码：`WORKSPACE_MCP_WEBHOOK_INVALID_URL`、`…_LIMIT`、`…_NOT_FOUND`、`…_STORE_UNAVAILABLE`，权限不足沿用 `CODINGNS_RPC_FORBIDDEN`。

`src/host/rpc.ts` 里有一份 RPC 白名单（`workspaceMcp/status`、`workspaceMcp/generate-key` 所在的列表），新 action 要加进去。

## 7. 存储

- 路径：与 API key 同一个状态目录（`CODINGNS4DSH_STATE_DIR` 或 `~/.config/codingns4dsh`），文件 `workspace-mcp-webhooks.json`。
- 内容：`{ version: 1, destinations: [...], deliveries: [...] }`。
- 权限：目录 `0700`，文件 `0600`，临时文件加重命名，与 `api-key-store.ts` 一致。
- 写入：合并写，同一个事件循环周期内的多次变更只落盘一次；关闭时强制落盘一次。
- 损坏：读取失败时把原文件改名为 `.corrupt-<时间>` 备份，以空配置启动，状态接口返回 `store: 'recovered'`。

密钥以明文存放在这个 owner-only 文件里，因为签名时需要原文。风险和 API key 文件相同。

## 8. 生命周期与现有代码的关系

- 新逻辑放在 `workspace-mcp` 目录下，由 `createWorkspaceMcpHostFeature` 创建和释放，不新增 `HOST_FEATURES` 条目。
- 订阅按需建立：有启用的目的地才订阅 `session/event` 和等待类事件；目的地变更时重新评估。
- 关闭顺序：停止订阅，取消正在进行的请求（`AbortController`），清掉重试定时器，强制落盘，最后释放。
- spec008 的 MCP 传输、认证、工具和 `cli-bridge` 都不改动。唯一碰到的共享点是 `features/workspace-mcp.ts` 里的 RPC 分发和 `rpc.ts` 白名单。
- Webhook 与 MCP 监听器的开关彼此独立：MCP 监听器没开也能收通知，但消息里的 `nextActions` 需要 MCP 开着才能执行。界面要提示这一点。

## 9. 错误处理

| 场景 | 处理 |
| --- | --- |
| URL 非法 | 创建/修改时拒绝 |
| 目的地超时或网络错误 | 重试，记录错误类别 |
| 目的地 4xx（除 408、429） | 永久失败 |
| 目的地 5xx、408、429 | 重试 |
| 重定向 | 失败，不跟随 |
| 磁盘写入失败 | 保留内存队列继续发送，状态里标记 `store: 'degraded'`，下次变更再尝试写 |
| 事件上下文取不全 | 发送已有字段，缺失字段省略，不阻塞投递 |

## 10. 正确性属性

### 10.1 不泄露

*对于任何* 投递的消息体、日志和状态响应，都不包含工作区路径、签名密钥、MCP API key、完整目的地 URL。

**验证需求：** 3.2、5.3、1.3

### 10.2 至少一次且可去重

*对于任何* 已入队的投递，在目的地最终可用且重试窗口未用尽时至少送达一次；同一投递的所有重试使用相同的 `Delivery-Id` 和相同的请求体。

**验证需求：** 4.3、4.6

### 10.3 顺序

*对于任何* 单个目的地，同一会话的投递按产生顺序发送，前一条未结束时后一条不会发出。

**验证需求：** 4.8

### 10.4 无残留

*对于任何* 功能关闭或所有目的地被停用的情况，不存在活跃订阅、重试定时器和进行中的请求。

**验证需求：** 5.1

## 11. 测试策略

### 11.1 单元测试

- 事件识别：四类事件的分类、用户中断不算失败、未知事件被忽略、去重。
- 消息体：各类型字段、截断、不含路径和密钥、`nextActions` 工具名都存在于 MCP 工具定义中。
- 签名：固定密钥与时间戳得到固定签名。
- 存储：权限位、损坏恢复、合并写、上限清理。
- 发送器（用假 `fetch` 和假时钟）：2xx、5xx 重试、429 与 `Retry-After`、其他 4xx 永久失败、重定向失败、超时、串行顺序、并发上限。

### 11.2 集成测试

- 假 Host 服务下：配置目的地 → 触发假会话事件 → 收到签名正确的请求 → 重启后未完成的投递继续发送。
- 所有者校验：非所有者调用被拒。
- 关闭功能后无订阅、无定时器。

### 11.3 回归

- `tests/workspace-mcp-tools.spec.ts`、`workspace-mcp-transport.spec.ts`、`workspace-mcp-capabilities.spec.ts` 不改动即可通过。

### 11.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| 需求 1 | §4.1、§6 | 管理接口单测 + 所有者校验测试 |
| 需求 2 | §3.3.1、§4.3 | 事件识别单测 |
| 需求 3 | §5 | 消息体单测、工具名一致性断言 |
| 需求 4 | §3.3.2、§3.3.3、§4.4、§7 | 发送器单测、重启集成测试 |
| 需求 5 | §7、§8、§10 | 脱敏断言、无残留断言 |
| 需求 6 | §6 | 客户端面板测试、`pnpm run i18n:check` |

命令：`pnpm run typecheck`、`pnpm run i18n:check`、`pnpm run version:check`、`pnpm run capability:check`，再加本 Spec 新增和 spec008 相关的测试文件。

## 12. 风险与待确认项

### 12.1 风险

- 原生类型声明明确区分 `completed`、`error` 和用户 `aborted`；字段契约尚未通过运行时抓包验证。实现只对明确终态分类，其他原因忽略。
- `session.question_asked` 依赖 `services.events` 触发和提问快照更新的先后顺序，没有运行时验证。延迟重读后仍读不到匹配快照时不投递。
- 父会话 `turn/end` 可能被子代理屏障拦住，不能直接当“已完成”。
- 会话加载是否重放历史事件、`time` 单位尚未确认；分类不按时间阈值过滤，按当前事件序号和请求 ID 去重。
- 允许投递到本机和局域网，意味着 Host 可被用来向内网地址发 POST。缓解措施是只有所有者能配置、默认关闭、界面明确提示、不跟随重定向、不回传响应体。
- 重启可能让 `sending` 状态的投递重复送达。接收方需要按 `Delivery-Id` 去重，文档里要写清。
- `lastMessage` 摘录默认会包含用户回复内容的少量文本，可能含代码或敏感内容。所有者可逐个目的地关闭；界面仍要提示消息会包含会话摘要。

### 12.2 已确认决策

- `lastMessage` 摘录默认开启，每个目的地提供“不带正文摘录”的开关；关闭后完成通知省略 `data.lastMessage`。
- 外部 Agent 自己用 `session_request_permission` 发起的权限申请，也会触发 `approval/asked`；保留这条通知，让 Agent 能确认请求已交给 DSH 等待用户决定。

### 12.3 事件可用性

- 消息字段安全边界：workspace ID/name 来自受管 workspace 注册表；session title 只来自 `session_list` 已有的 `projections.values.title` 安全投影，缺失则省略；session ID 来自原生 Session 标识；事件和问题字段逐项按明确类型组装。禁止复制整个 Host/DSH 服务对象。正文仅取 DSH 的所选最终回复或结构化问题文本，按长度截断。
- `session.completed`：原生 `turn/end.reason.kind === 'completed'` 时可用。
- `session.failed`：原生 `turn/end.reason.kind === 'error'` 时可用，错误码和摘要来自 `reason.error.code`、`reason.error.message`。用户 `aborted`、`blocked`、`max-tokens`、`interrupted`、`forked` 不映射为该事件。
- `session.permission_requested`：具备原生会话事件订阅时可用；缺少订阅能力时在状态接口标为不可用。
- `session.question_asked`：具备 Host 提问事件通道和 `workspace.pending-questions` 适配器时可用；任一缺失时在状态接口标为不可用。问题 ID 和文本以活动问题快照为准。
- 字段按锁定的 DSH 0.2.2-rc.1 契约核对。插件最低支持版本为 DSH 0.2.1-alpha.2；字段契约最早引入版本未能从仓库材料确认，运行时能力缺失时按不可用处理。

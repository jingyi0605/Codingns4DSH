# 需求文档 - 工作区 Agent 接入：Webhook 投递

状态：已完成

## 简介

spec008 已经让外部 Agent 能通过 MCP 进来：新建会话、继续会话、回答问题、读写终端。但这条路是单向的。外部 Agent 只能主动轮询，不知道会话什么时候跑完了、跑挂了、在等它回答问题。

本 Spec 补上反方向：用户在 Workspace MCP 模块里配置若干 Webhook 目的地。DSH 里的会话出现指定类型的事件时，Host 把一条带足够信息的 JSON 消息 POST 到目的地 URL。外部 Agent 收到后，可以直接用 MCP 工具继续处理。两条路合在一起，就是“工作区 Agent 接入”的完整来回。

## 术语表

- **目的地（Destination）**：一条 Webhook 配置，包含 URL、签名密钥、要接收的工作区、要接收的事件类型。
- **事件（Event）**：Host 从 DSH 会话里识别出来的一次值得通知外部 Agent 的变化，例如会话完成。
- **投递（Delivery）**：把一个事件发给一个目的地的一次任务。一个事件匹配几个目的地，就产生几个投递。
- **投递队列**：落盘保存、等待发送或重试的投递列表，Host 重启后继续处理。
- **下一步提示（nextActions）**：消息里附带的“你可以调用哪个 MCP 工具、传什么参数”的清单，让 Agent 不用猜。

## 范围说明

### In Scope

- 在 Workspace MCP 模块里管理 Webhook 目的地：新增、修改、启用/停用、删除、发送测试消息。
- 每个目的地可选：工作区范围（全部或指定几个）、事件类型（见需求 2）。
- 识别并投递四类事件：会话完成、会话失败、权限申请、会话提问。
- 消息体带足够的标识和上下文，并附下一步提示，指向 spec008 已有的 MCP 工具。
- HMAC 签名、超时、有限次重试、落盘队列、投递记录。
- 目的地配置与签名密钥存放在 Host 私有的 owner-only 文件里。
- 设置页 UI 和中英文文案。

### Out of Scope

- 不新增 MCP 工具去“批准权限”。外部 Agent 仍然不能替用户批准权限（沿用 spec008 的规则）。
- 不做 Webhook 入站（外部系统往 DSH 发事件）。
- 不做事件全文回放、不推送完整会话历史。
- 不做按用户自定义模板改写消息体。
- 不做 Webhook 的远程中转或公网穿透。
- 不操作 Desktop，不改 dsh-web，不启动开发服务器。

## 需求

### 需求 1：配置 Webhook 目的地

**用户故事：** 作为 Host 所有者，我希望在设置页添加一个 Webhook 地址并选好工作区和事件类型，以便让指定的外部 Agent 收到我关心的通知。

#### 验收标准

1. WHEN 所有者新增目的地 THEN System SHALL 校验 URL 是 `http` 或 `https`、长度在上限内，并生成一个随机签名密钥，只在创建响应里返回一次。
2. WHEN 非所有者调用任何目的地管理接口 THEN System SHALL 拒绝，并返回和 `generate-key` 一致的权限错误。
3. WHEN 状态或列表接口被调用 THEN System SHALL 只返回脱敏后的 URL（隐藏路径和查询串里的内容）和“密钥已配置”标记，不返回完整 URL 中的令牌和签名密钥。
4. WHEN 所有者修改目的地的工作区范围、事件类型或启用状态 THEN System SHALL 对之后产生的事件立即生效，已排队的投递保持原目的地配置。
5. WHEN 所有者删除目的地 THEN System SHALL 同时丢弃该目的地尚未发送的投递。
6. WHEN 所有者轮换某个目的地的密钥 THEN System SHALL 让旧密钥立即失效，并只返回一次新密钥。
7. WHEN 目的地数量超过上限 THEN System SHALL 拒绝新增并给出明确错误。
8. WHEN 所有者点“发送测试” THEN System SHALL 向该目的地发一条 `webhook.test` 消息，并在界面上显示结果，该消息不进入重试队列。
9. WHEN 创建目的地 THEN System SHALL 默认在完成通知中附带最后回复摘录；所有者可以逐个目的地关闭此项，关闭后完成通知不包含正文摘录。

### 需求 2：识别要投递的事件

**用户故事：** 作为外部 Agent 的使用者，我希望只收到需要 Agent 响应的事件，以便它不会被无关通知打扰。

#### 验收标准

1. WHEN 一个会话的一轮对话正常结束 THEN System SHALL 产生 `session.completed` 事件。
2. WHEN 一个会话的一轮对话以错误结束 THEN System SHALL 产生 `session.failed` 事件，并带错误码和简短错误信息。
3. WHEN 会话向用户发起权限申请 THEN System SHALL 产生 `session.permission_requested` 事件。
4. WHEN 会话向用户发起提问 THEN System SHALL 产生 `session.question_asked` 事件，并带当前待回答问题的快照。
5. WHEN 用户主动中断会话 THEN System SHALL NOT 产生 `session.failed`。
6. WHEN 事件所在会话不属于任何受管工作区 THEN System SHALL 丢弃该事件，不投递。
7. WHEN 同一个终态事件被重复报告或 Host 重启后恢复处理 THEN System SHALL 通过私有文件中持久保存的唯一投递键，只为匹配的目的地保留一条投递（会话 ID + 事件类型 + 请求 ID 或轮次序号 + 目的地 ID）。
8. WHEN Host 无法识别事件类型或所需 DSH 能力缺失 THEN System SHALL 安静忽略该事件，并在状态接口里说明哪些事件类型当前不可用。

### 需求 3：消息内容要让 Agent 能接着干活

**用户故事：** 作为外部 Agent，我希望收到的消息里有工作区、会话、请求 ID 和下一步该调用的 MCP 工具，以便我不用再去猜怎么处理。

#### 验收标准

1. WHEN 消息被发送 THEN System SHALL 包含：事件 ID、事件类型、发生时间、工作区 ID 和名称、会话 ID 和标题、目的地 ID。
2. WHEN 消息被发送 THEN System SHALL 只从明确列出的工作区、会话、事件和问题安全投影字段构造消息；不得复制 Host 服务对象、环境变量、MCP API key、签名密钥或文件系统路径。用户或 Agent 正文只按长度限制截断，不扫描或改写正文内容。
3. WHEN 事件是 `session.question_asked` THEN System SHALL 带上待回答问题的 `callId`、问题文本和选项，并提示用 `session_answer` 回答。
4. WHEN 事件是 `session.permission_requested` THEN System SHALL 带上请求 ID、工具名和原因，并明确标注“需要用户在 DSH 里决定，外部 Agent 无法批准”。
5. WHEN 事件是 `session.completed` THEN System SHALL 提示可用 `session_continue` 继续、`session_list` 查看状态，并在能取到时带一段有长度上限的最后回复摘录。
6. WHEN 事件是 `session.failed` THEN System SHALL 带错误码和错误摘要，并提示可用 `session_continue` 重试或 `session_create` 新建。
7. WHEN 消息体超过大小上限 THEN System SHALL 截断文本字段并标记 `truncated: true`，不丢弃标识字段。
8. WHEN 请求被发出 THEN System SHALL 带 `X-CodingNS-Event-Id`、`X-CodingNS-Delivery-Id`、`X-CodingNS-Timestamp` 和 `X-CodingNS-Signature`，签名是用目的地密钥对“时间戳 + 点 + 原始请求体”做的 HMAC-SHA256。

### 需求 4：可靠投递

**用户故事：** 作为 Host 所有者，我希望目的地短暂不可用或 Host 重启时，消息不会丢，以便外部 Agent 最终能收到。

#### 验收标准

1. WHEN 一个事件匹配到目的地 THEN System SHALL 先把投递写入落盘队列，再尝试发送。
2. WHEN 目的地返回 2xx THEN System SHALL 把投递标记为已送达并从待发送中移除。
3. WHEN 目的地返回 5xx、408、429，或网络错误、超时 THEN System SHALL 按退避间隔重试，最多 5 次；429 带 `Retry-After` 时 System SHALL 尊重它（有上限）。
4. WHEN 目的地返回其他 4xx THEN System SHALL 判定为永久失败，不再重试。
5. WHEN 重试用尽 THEN System SHALL 把投递标记为失败，并保留在最近记录里供界面查看。
6. WHEN Host 重启 THEN System SHALL 恢复未完成的投递并继续发送，同一投递的 `Delivery-Id` 不变。
7. WHEN 队列超过条数上限或投递超过保留时间 THEN System SHALL 先丢弃最旧的已结束记录，再丢弃最旧的待发送记录，并记入诊断。
8. WHEN 同一目的地有多条待发送投递 THEN System SHALL 按产生顺序逐条发送，避免同一会话的消息乱序。
9. WHEN 发送请求遇到重定向 THEN System SHALL NOT 跟随，并按失败处理。

### 需求 5：安全边界

**用户故事：** 作为 Host 所有者，我希望 Webhook 功能不会成为泄露数据或探测内网的口子。

#### 验收标准

1. WHEN 模块关闭或没有任何启用的目的地 THEN System SHALL NOT 订阅会话事件，也不发起任何外部请求。
2. WHEN 目的地配置、密钥、队列写盘 THEN System SHALL 使用 owner-only 权限的独立文件，不写入 DSH 设置文档，也不出现在普通设置同步里。
3. WHEN 日志或诊断输出 THEN System SHALL NOT 记录完整 URL、签名密钥或消息体正文。
4. WHEN 外部 Agent 回调 MCP THEN System SHALL 仍然走 spec008 的 API key 认证和工作区校验，Webhook 消息本身不携带可免认证调用 MCP 的凭据。
5. 本 Spec 明确允许目的地指向本机和局域网地址（外部 Agent 常运行在本机）。因此该功能默认关闭，只有所有者能配置，并且界面上要明确提示“Host 会向该地址发送会话摘要”。

### 需求 6：设置页体验

**用户故事：** 作为 Host 所有者，我希望在 Workspace MCP 卡片里直接看到并管理 Webhook，不用懂内部概念。

#### 验收标准

1. WHEN 打开 Workspace MCP 设置 THEN System SHALL 显示“消息通知（Webhook）”区块，列出目的地、状态（正常/最近失败/已停用）、最近一次投递结果。
2. WHEN 新增目的地成功 THEN System SHALL 弹出一次性展示的签名密钥，并提供复制按钮，关闭后无法再次查看。
3. WHEN 用户选择事件类型和工作区 THEN System SHALL 用普通用户能看懂的名称，例如“会话已完成”“会话出错”“需要权限确认”“会话在等你回答”。
4. WHEN 界面文案出现 THEN System SHALL 全部走 i18n 字典，中英文齐全，不使用工程师语言。
5. WHEN 遵循前端规范 THEN System SHALL 按仓库现有 Workspace MCP 面板的结构和模态框用法实现。

## 非功能需求

### 非功能需求 1：性能

1. WHEN DSH 产生会话事件 THEN System SHALL 在事件回调内只做轻量分类和入队，不在回调里发网络请求或同步大文件写。
2. WHEN 多个目的地同时不可用 THEN System SHALL 限制并发发送数，不拖慢会话事件处理。

### 非功能需求 2：可靠性

1. WHEN 单个目的地一直失败 THEN System SHALL NOT 影响其他目的地的投递，也不影响 DSH 会话本身。
2. WHEN 队列文件损坏 THEN System SHALL 备份损坏文件、以空队列启动，并在状态里说明。

### 非功能需求 3：可维护性

1. WHEN 以后新增事件类型 THEN System SHALL 只需要在事件目录里加一项并补测试，不改投递器。
2. WHEN 排查问题 THEN System SHALL 能在界面看到最近投递记录：时间、事件类型、目的地、HTTP 状态或错误类别、重试次数。

## 成功定义

- 一个本机运行的 Agent 配好 Webhook 后，能在会话完成、失败、提问时收到消息，并仅凭消息内容用 MCP 工具完成下一步。
- 目的地宕机后恢复，未送达的消息在重试窗口内送达；Host 重启不丢未完成投递。
- 状态、日志、设置同步里不出现完整 URL 和签名密钥。
- 关闭模块后，没有事件订阅、没有外部请求、没有残留定时器。

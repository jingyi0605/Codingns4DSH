# 工作区 MCP 与 OutcomeGo 接入变更

## 待发布

- `session_create` 可保存会话关联的 `agentId`。`session_continue` 可指定本条消息的发送者和优先级，并返回消息 ID、当前状态、队列位置及预计等待时间。
- `message_status`、`message_cancel`、`message_prioritize` 和 `session_queue_peek` 可查询和管理 MCP 消息。优先级相同的消息按进入队列的顺序处理。取消和调整顺序只适用于仍在 MCP 队列中等待的消息。
- 支持读取工作区文件树、文件内容和 Git 状态、历史、差异。文件上限为 1 MiB。Git 命令最长运行 5 秒，输出最多读取 10 MiB。
- Webhook 可订阅消息进入和离开队列、优先级调整及 Agent 消息发送事件。会话通知在能关联到发送者时附带 `agentId` 和 `messageId`。可重试的失败按 1、2、4 秒重试，HTTP 429 仍支持 `Retry-After`。
- 网页会话历史中的 Agent 消息显示「发送自 Agent」，点击可查看该消息的发送者 ID。
- 新增 `session_history` 和 `session_search`。前者按页读取会话里的用户与助手文字，后者按关键词查找会话。两者只面向受管理工作区：归档会话、未纳入受管理工作区的会话和未分组会话都读不到。
- 历史每条消息最多 8 KiB、每页文字最多 256 KiB，用 `nextCursor` 继续往前翻。通过 `session_continue` 发出的消息会带上发送它的 `agentId`。
- 搜索由 DSH 在整个 Host 范围内完成并最多返回 20 个会话，之后才过滤掉受管理工作区以外的会话，所以结果可能少于 `limit` 而 `hasMore` 仍为真。需要更精确时缩短关键词或指定 `workspaceId`。

工作区 MCP 保留现有的 API Key 和 Webhook 签名格式。旧客户端仍可省略 `agentId` 和 `priority`。不具备会话事件能力的 Host 保留原有的提交回执，新增队列工具会返回能力不可用。

Host 重启时会继续提交尚在等待的消息。提交结果不明的消息标记为 `uncertain`，可以用 `message_status` 查询。接入参数和错误处理见 `SKILL.md`。

## 本轮验证

- 105 项定向测试通过，覆盖队列恢复、取消及重排、Webhook 回传归属和三次重试、标签点击、1 MiB 文件经 HTTP 返回、Git 的 5 秒超时。
- 定向行覆盖率：消息队列 95.32%，文件工具 92.41%，Git 工具 86.83%。
- 未启动 Stage0，未操作 Desktop，未执行 OutcomeGo 跨仓库端到端联调。消息标签按网页会话历史验证，未验证原生导出格式。
- 历史与搜索：新增 10 项测试覆盖工具层（排序、分页游标、大小上限、Agent 标注、授权拒绝、入参校验、搜索过滤）和适配器转发（`events` 优先于 `page`、缺失时不暴露、取消信号）。这两项的覆盖率没有单独统计。
- 搜索不可用的原因：DSH Web 部署默认把会话查询索引设为 `openAt: never`，`session/search` 因此一律失败。工具现在对这种情况返回 `WORKSPACE_MCP_SESSION_SEARCH_DISABLED`，并说明需要宿主开启索引；其他失败仍用通用提示，不转发 DSH 的原始报错。新增 2 项测试覆盖这两种情况。
- Stage0 的 `dsh-stage0.patch.yml` 已加入 `session-query-sqlite`（内存索引，`openAt: first-search`）。需要重启 Stage0 才生效，本轮未重启，开启后的实际搜索结果尚未验证。
- 版本未变更，未发布。

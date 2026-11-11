# 任务清单 - 工作区 Agent 接入：Webhook 投递（人话版）

状态：已完成

## 这份文档是干什么的

把“DSH 会话出了事，自动通知外部 Agent”拆成能一步步做完、一步步验证的任务。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住
- `IN_REVIEW`：已经有结果，等复核
- `DONE`：已经完成，并且已经回写状态
- `CANCELLED`：取消，不做了，但要写原因

规则：只有 `状态：DONE` 的任务才能勾选成 `[x]`；每做完一个任务立刻更新这里。

---

## 阶段 1：先查清事实

- [x] 1.1 查清 DSH 原生事件的真实形态
  - 状态：DONE（静态契约与仓库适配器已交叉核对；运行时触发时序仍未验证，不影响事件字段结论）
  - 这一步到底做什么：确认四类事件在 DSH 里分别叫什么、带哪些字段，特别是“错误结束”和“权限申请的 requestId”。
  - 做完你能看到什么：一份调查报告，写明每类事件的事件名、字段、能否区分用户中断，以及哪些事件在哪些 DSH 版本不可用。
  - 先依赖什么：无
  - 开始前先看：
    - `design.md` §2「还没有验证的两件事」
    - `src/host/native-session-bridge.ts`（`subscribe`）
    - `src/host/features/lan-access-dsh.ts`（等待类事件）
    - `src/host/modules/pwa/pwa-session-notifications.ts`
  - 主要改哪里：
    - `docs/调查报告/20261110-DSH会话事件形态调查.md`
    - 回写 `design.md` §2、§12
  - 这一步先不做什么：不写投递代码，不改任何运行时代码。
  - 怎么算完成：
    1. 四类事件各有“事件名、字段、版本差异”记录，或者明确写“当前不可用”。
    2. `design.md` 的待确认项已更新为结论。
  - 怎么验证：
    - DSH Host 类型声明检索：确认 `turn/end` 的完成、错误、取消原因字段。
    - DSH 远程事件声明检索：确认 `approval/request` 和 `user-questions/request` 为 waterfall 事件。
    - Host 源码与测试检索：确认 `approval/asked` 数据读取、活动问题快照的 `callId` 与问题内容，以及错误结束夹具。
    - `git diff --check`：通过。
    - 未启动开发服务器；未运行构建或 DSH 实机抓包。
  - 对应需求：需求 2
  - 对应设计：§2、§4.3、§12

- [x] 1.2 阶段检查
  - 状态：DONE
  - 这一步到底做什么：确认事件识别方案站得住，再进入实现。
  - 做完你能看到什么：可以决定 `session.failed` 等事件是正常支持还是降级。
  - 先依赖什么：1.1
  - 开始前先看：`requirements.md`、`design.md`、调查报告
  - 主要改哪里：`design.md`、`tasks.md`
  - 这一步先不做什么：不加新需求。
  - 怎么算完成：
    1. 事件目录的支持范围已经定稿。
    2. 与你确认过调整后的范围（如果有降级）。
  - 怎么验证：人工核对设计事件表与调查报告一致；`pnpm run typecheck` 通过。
  - 对应需求：需求 2
  - 对应设计：§4.3

---

## 阶段 2：存储、消息、发送

- [x] 2.1 目的地与队列的落盘存储
  - 状态：DONE
  - 这一步到底做什么：建出存放目的地配置和投递队列的私有文件读写。
  - 做完你能看到什么：能增删目的地、追加和更新投递，文件权限是 owner-only，损坏文件能自动备份恢复。
  - 先依赖什么：1.2
  - 开始前先看：`design.md` §4、§7；`src/host/workspace-mcp/api-key-store.ts`
  - 主要改哪里：
    - `src/host/workspace-mcp/webhook-store.ts`（新）
    - `tests/workspace-mcp-webhook-store.spec.ts`（新）
  - 这一步先不做什么：不发网络请求，不接事件，不做 RPC。
  - 怎么算完成：
    1. 文件和目录权限分别是 `0600` 和 `0700`。
    2. 损坏文件被改名备份，读取返回空配置并带 `recovered` 标记。
    3. 上限和保留期清理生效。
  - 怎么验证：
    - `/usr/bin/timeout 60s node --import ./tests/register-source-loader.mjs --test tests/workspace-mcp-webhook-store.spec.ts`
    - `pnpm run typecheck`
    - `git diff --check`
  - 对应需求：需求 4.1、4.7；需求 5.2；非功能 2.2
  - 对应设计：§4、§7

- [x] 2.2 消息体生成与签名
  - 状态：DONE
  - 这一步到底做什么：把一个业务事件变成请求体、`nextActions` 和签名头。
  - 做完你能看到什么：给定事件和工作区信息，得到固定格式的 JSON 和正确签名；超长内容被截断并标记。
  - 先依赖什么：1.2
  - 开始前先看：`design.md` §5；`src/host/workspace-mcp/tools.ts` 的 `WORKSPACE_MCP_TOOL_DEFINITIONS`
  - 主要改哪里：
    - `src/host/workspace-mcp/webhook-payload.ts`（新）
    - `tests/workspace-mcp-webhook-payload.spec.ts`（新）
  - 这一步先不做什么：不发请求，不读会话。
  - 怎么算完成：
    1. 五种消息体字段与 `design.md` §5 一致。
    2. 输出里没有工作区路径、密钥、完整 URL。
    3. 每个 `nextActions.tool` 都存在于 MCP 工具定义中（有断言）。
    4. 固定输入得到固定签名。
  - 怎么验证：
    - `/usr/bin/timeout 60s node --import ./tests/register-source-loader.mjs --test tests/workspace-mcp-webhook-payload.spec.ts`
    - `pnpm run typecheck`
    - `git diff --check`
  - 对应需求：需求 3
  - 对应设计：§5、§10.1

- [x] 2.3 发送器：重试、顺序、并发
  - 状态：DONE
  - 这一步到底做什么：从队列取投递，逐条发送，按规则重试。
  - 做完你能看到什么：目的地正常时消息送达；目的地宕机时按间隔重试；永久错误直接失败；同一目的地不乱序。
  - 先依赖什么：2.1、2.2
  - 开始前先看：`design.md` §3.3.2、§4.4、§9、§10.2、§10.3
  - 主要改哪里：
    - `src/host/workspace-mcp/webhook-dispatcher.ts`（新）
    - `tests/workspace-mcp-webhook-dispatcher.spec.ts`（新）
  - 这一步先不做什么：不订阅真实会话事件，不做界面。
  - 怎么算完成：
    1. 2xx、5xx、408、429（含 `Retry-After`）、其他 4xx、超时、重定向都按设计处理。
    2. 重试时请求体和 `Delivery-Id` 不变。
    3. 只有存在待重试投递时才有定时器，释放后无定时器。
    4. 日志里没有完整 URL 和响应体。
  - 怎么验证：
    - `/usr/bin/timeout 60s node --test --test-timeout=8000 --import ./tests/register-source-loader.mjs tests/workspace-mcp-webhook-dispatcher.spec.ts`（假 `fetch`、假时钟）
    - `pnpm run typecheck`
    - `git diff --check`
  - 对应需求：需求 4；需求 5.1、5.3；非功能 1.2、2.1
  - 对应设计：§3.3.2、§4.4、§9、§10

### 阶段检查

- [x] 2.4 阶段检查
  - 状态：DONE
  - 这一步到底做什么：确认存储、消息、发送三块能一起工作。
  - 做完你能看到什么：用假事件入队，经假目的地收到签名正确的请求，重启后继续发送。
  - 先依赖什么：2.1、2.2、2.3
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`
  - 主要改哪里：本阶段全部文件
  - 这一步先不做什么：不接真实事件，不做界面。
  - 怎么算完成：
    1. 重启恢复的集成测试通过。
    2. `sending` 状态在重启后回到 `pending`。
  - 怎么验证：
    - 本阶段三个测试文件 + `pnpm run typecheck`
  - 对应需求：需求 4
  - 对应设计：§3.3.3、§10.2

---

## 阶段 3：接入会话事件和管理接口

- [x] 3.1 事件识别与匹配
  - 状态：DONE
  - 这一步到底做什么：把 DSH 原始事件识别成四类业务事件，找到工作区，去重，并匹配目的地入队。
  - 做完你能看到什么：假会话事件进来，只有工作区和事件类型都匹配的目的地产生投递；用户中断不产生失败事件。
  - 先依赖什么：2.4
  - 开始前先看：调查报告；`design.md` §3.3.1、§4.3
  - 主要改哪里：
    - `src/host/workspace-mcp/webhook-events.ts`（新）
    - `tests/workspace-mcp-webhook-events.spec.ts`（新）
  - 这一步先不做什么：不改 PWA 通知逻辑，不复用其中的私有函数（需要的话复制最小部分或抽出共享函数，但不改变 PWA 行为）。
  - 怎么算完成：
    1. 四类事件的分类、去重、工作区过滤、事件类型过滤都有测试。
    2. 回调内没有网络请求和同步大写盘。
  - 怎么验证：
    - `pnpm test:related -- tests/workspace-mcp-webhook-events.spec.ts`
    - 相关 PWA 通知测试不改也能通过
  - 对应需求：需求 2；非功能 1.1
  - 对应设计：§3.3.1、§4.3

- [x] 3.2 管理 RPC 与功能生命周期
  - 状态：DONE
  - 这一步到底做什么：加上 `webhook-*` 管理接口，把订阅、发送器的启停挂到 Workspace MCP 功能的生命周期上。
  - 做完你能看到什么：所有者能增删改目的地、轮换密钥、发测试；没有启用的目的地时不订阅事件；功能停用后没有残留。
  - 先依赖什么：3.1
  - 开始前先看：`design.md` §6、§8、§10.4；`src/host/features/workspace-mcp.ts`；`src/host/rpc.ts`
  - 主要改哪里：
    - `src/host/features/workspace-mcp.ts`
    - `src/host/rpc.ts`（白名单）
    - `tests/workspace-mcp-webhook-feature.spec.ts`（新）
  - 这一步先不做什么：不改 MCP 传输、工具、认证；不改 `cli-bridge`。
  - 怎么算完成：
    1. 非所有者调用全部被拒。
    2. 列表和状态里没有完整 URL、密钥。
    3. 删除目的地同时丢弃其待发送投递。
    4. 关闭功能后无订阅、无定时器、无进行中请求。
    5. spec008 的三个测试文件不改即可通过。
  - 怎么验证：
    - `pnpm test:related -- tests/workspace-mcp-webhook-feature.spec.ts tests/workspace-mcp-tools.spec.ts tests/workspace-mcp-transport.spec.ts tests/workspace-mcp-capabilities.spec.ts`
  - 对应需求：需求 1；需求 5
  - 对应设计：§6、§8、§10.4

### 阶段检查

- [x] 3.3 阶段检查
  - 状态：DONE
  - 这一步到底做什么：确认服务端整条链路可用，再做界面。
  - 做完你能看到什么：假会话事件 → 签名请求 → 失败重试 → 重启恢复，全链路有测试证据。
  - 先依赖什么：3.1、3.2
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`
  - 主要改哪里：本阶段全部文件
  - 这一步先不做什么：不做界面。
  - 怎么算完成：
    1. 需求 1 到 5 的验收标准都能对应到测试。
    2. 已知缺口已记录。
  - 怎么验证：
    - `pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`
  - 对应需求：需求 1 到 5
  - 对应设计：§3、§10

---

## 阶段 4：设置页和收尾

- [x] 4.1 设置页“消息通知”区块
  - 状态：DONE
  - 这一步到底做什么：在 Workspace MCP 卡片里加目的地列表、新增/编辑弹窗、密钥一次性展示、测试按钮、最近投递记录。
  - 做完你能看到什么：所有者不用懂内部概念，就能配好并确认 Webhook 是否通。
  - 先依赖什么：3.3
  - 开始前先看：`requirements.md` 需求 6；`src/client/features/workspace-mcp.ts`；仓库现有的模态框和表单写法
  - 主要改哪里：
    - `src/client/features/workspace-mcp.ts`
    - `src/client/locale.ts`（中英文）
    - 对应客户端测试
  - 这一步先不做什么：不做 Desktop 或 dsh-web 的任何操作；不引入新 UI 库。
  - 怎么算完成：
    1. 文案全部走 i18n，中英文齐全，没有工程师用语。
    2. 密钥只在创建和轮换时展示一次，有复制按钮。
    3. 界面提示“Host 会向该地址发送会话摘要”以及“需要开启 MCP 才能执行消息里的下一步”。
  - 怎么验证：
    - `pnpm run i18n:check`、`pnpm run typecheck`、相关客户端测试
  - 对应需求：需求 6
  - 对应设计：§6

- [x] 4.2 文档和接手说明
  - 状态：DONE
  - 这一步到底做什么：写给外部 Agent 开发者的接入说明：消息格式、签名校验示例、去重建议、如何用 MCP 工具响应。
  - 做完你能看到什么：别人拿着文档能在半小时内写出一个接收端。
  - 先依赖什么：4.1
  - 开始前先看：`design.md` §5
  - 主要改哪里：
    - `docs/开发记录/20261110-工作区Agent接入Webhook投递开发记录.md`
    - 必要时更新 `README.md` 里 Workspace MCP 的说明
  - 这一步先不做什么：不改版本号，不发布。
  - 怎么算完成：
    1. 包含签名校验示例和一个完整消息样例。
    2. 写明“至少一次投递，请按 `Delivery-Id` 去重”。
  - 怎么验证：人工走查
  - 对应需求：需求 3
  - 对应设计：§5

### 最终检查

- [x] 4.3 最终检查点
  - 状态：DONE
  - 这一步到底做什么：确认 Spec 达到交付标准。
  - 做完你能看到什么：需求、设计、任务、验证证据一一对应。
  - 先依赖什么：4.1、4.2
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`
  - 主要改哪里：当前 Spec 全部文件
  - 这一步先不做什么：不再追加新需求；不提交、不发版（需要你单独确认）。
  - 怎么算完成：
    1. 每个任务都能追到需求和设计。
    2. 延期项、降级项已写清。
  - 怎么验证：
    - `pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、`pnpm run i18n:check`
    - 本 Spec 新增测试和 spec008 相关测试
  - 对应需求：全部
  - 对应设计：全文

## 验证记录

- 2026-11-10，任务 1.1：已静态确认 `turn/end.reason.kind` 的 `completed`、`error`、`aborted` 及错误码/文本字段；确认权限 ID 来自 `approval/asked.data.id`；提问 `callId` 与问题内容取活动快照。字段基于锁定的 DSH 0.2.2-rc.1 类型和现有 Host 适配器；旧版首次引入版本、Host 触发时序和历史事件重放未能从仓库证据确定，已记录为能力/运行时边界。
- 2026-11-10 实际结果：DSH Host 类型声明检索确认 `turn/end` 包含 `completed`、`error` 和可区分用户取消的 `aborted` 原因，错误结构含 `code`、`message`；远程事件声明检索确认 `approval/request` 与 `user-questions/request`；Host 源码和测试检索确认 `approval/asked.data` 的请求字段及问题活动快照字段；`git diff --check` 通过（退出码 0）。
- 2026-11-11，任务 1.2：对照调查报告确认事件目录支持范围；产品确认 `session.failed` 按当前 DSH 契约支持、lastMessage 摘录默认开启且可逐目的地关闭、外部 Agent 自己发起的权限请求通知予以保留。`pnpm run typecheck`：通过。
- 2026-11-11，任务 2.1：新增 owner-only Webhook 文件存储、配置/队列读写、目的地快照、启动恢复、损坏备份、保留期/条数上限清理和淘汰诊断；测试覆盖权限、恢复、删除及清理。
- 实际验证：`/usr/bin/timeout 60s node --import ./tests/register-source-loader.mjs --test tests/workspace-mcp-webhook-store.spec.ts`：5 项通过、0 失败；`pnpm run typecheck`：通过；`git diff --check`：通过。仓库未定义 `test:related` 脚本，因此按同一源码加载器直接运行指定测试文件并设 60 秒超时。
- 2026-11-11，任务 2.2：新增五类消息体、工具名目录校验、摘要正文开关、敏感文本过滤、16 KB 上限和 HMAC 签名。
- 实际验证：`/usr/bin/timeout 60s node --import ./tests/register-source-loader.mjs --test tests/workspace-mcp-webhook-payload.spec.ts`：6 项通过、0 失败；`pnpm run typecheck`：通过；`git diff --check`：通过。
- 2026-11-11，任务 2.3：新增签名 HTTP 发送、每目的地串行和全局并发上限、固定投递 ID/body 重试、5xx/408/429/网络/超时分类、Retry-After 上限、4xx 永久失败、禁跟重定向及释放时中止。
- 实际验证：`/usr/bin/timeout 60s node --test --test-timeout=8000 --import ./tests/register-source-loader.mjs tests/workspace-mcp-webhook-dispatcher.spec.ts`：7 项通过、0 失败；`pnpm run typecheck`：通过；`git diff --check`：通过。
- 2026-11-11，任务 2.4：增加存储重启、投递恢复、持久去重、消息体固定及签名验证的组合测试，并修正 payload 测试的输入字段夹具。
- 实际验证：`/usr/bin/timeout 60s node --test --test-timeout=8000 --import ./tests/register-source-loader.mjs tests/workspace-mcp-webhook-store.spec.ts tests/workspace-mcp-webhook-payload.spec.ts tests/workspace-mcp-webhook-dispatcher.spec.ts`：19 项通过、0 失败；`pnpm run typecheck`：通过；`git diff --check`：通过。
- 任务 2.4 首次组合测试曾失败：payload 测试把问题字段写成 `question`，而输入契约为 `text`；修正夹具后上述命令通过。
- 2026-11-11，任务 3.1：事件处理覆盖完成、失败、权限申请、提问快照、用户中断、重复报告、归档/非工作区过滤；测试 teardown 等待落盘结束，PWA 生产行为未改动。
- 实际验证：`/usr/bin/timeout 60s node --test --test-timeout=8000 --import ./tests/register-source-loader.mjs tests/workspace-mcp-webhook-events.spec.ts tests/pwa-session-notifications.spec.ts`：7 项通过、0 失败；`pnpm run typecheck`：通过；`git diff --check`：通过。仓库未定义 `test:related` 脚本，使用指定测试文件及 60 秒超时运行。
- 任务 3.1 首次事件测试失败暴露了错误的提问快照测试夹具及临时目录清理竞态；测试改为共用可控时钟、按持久入队回调等待，并在清理前关闭存储后通过。
- 2026-11-11，任务 3.2：新增 owner-only Webhook 管理 RPC、URL/输入验证、脱敏列表、一次性密钥、测试投递、删除清理、启动恢复，以及启用目的地驱动的订阅/发送生命周期；RPC 路径加入白名单。
- 实际验证：`/usr/bin/timeout 60s node --test --test-timeout=8000 --import ./tests/register-source-loader.mjs tests/workspace-mcp-webhook-feature.spec.ts tests/workspace-mcp-tools.spec.ts tests/workspace-mcp-transport.spec.ts tests/workspace-mcp-capabilities.spec.ts`：51 项通过、0 失败；`pnpm run typecheck`：通过；`git diff --check`：通过。
- 任务 3.2 首次回归测试中，冷启动恢复测试的列表请求未设为所有者，按预期被拒；修正测试调用后上述验证命令通过。
- 2026-11-11，任务 3.3：服务端阶段检查通过，现有 MCP 工具、传输与 capability 回归测试保持不变并通过。
- 实际验证：`pnpm run typecheck`：通过；`pnpm run version:check`：通过，报告插件 `0.2.2-rc.1` 兼容 DSH `>=0.2.1-alpha.2`；`pnpm run capability:check`：通过，提示矩阵有 23 条失效旧路由、无到期或新增失效路由；九个定向 Webhook/spec008/PWA 测试文件合计 77 项通过、0 失败。
- 2026-11-11，任务 4.1：设置页新增双语 Webhook 管理区，支持查看状态/最近结果、按工作区和事件设置目的地、摘要开关、启停、测试、密钥轮换/一次性复制及删除确认；Host 列表只提供工作区 ID/名称。
- 实际验证：`pnpm run i18n:check`：通过，en/zh 各 2022 个键、阻断违规 0（报告 124 条既有异常/日志中文告警）；`pnpm run typecheck`：通过；`/usr/bin/timeout 60s node --test --test-timeout=8000 --import ./tests/register-source-loader.mjs tests/workspace-mcp-webhook-client.spec.ts`：2 项通过、0 失败；`git diff --check`：通过。
- 任务 4.1 客户端测试首次失败是因为测试断言要求异步刷新完成后立即出现目的地行；调整为分别验证初始脱敏目的地列表、提交字段和一次性密钥显示后通过。
- 2026-11-11，任务 4.2：新增外部接收端开发说明，包含原始请求体 HMAC 校验代码、完成事件完整消息、提问/权限事件处理、MCP 调用格式及按 Delivery-Id 持久去重建议。
- 实际验证：人工对照 `webhook-payload.ts`、`webhook-dispatcher.ts`、`WORKSPACE_MCP_TOOL_DEFINITIONS` 核对字段和重试规则；`rg -n 'timingSafeEqual|HMAC-SHA256|Delivery-Id|session_answer|at least once|16 KiB' docs/开发记录/20261110-工作区Agent接入Webhook投递开发记录.md` 命中预期章节；文档语言检查确认仅含英文；`git diff --check`：通过。
- 2026-11-11，任务 4.3：最终 Spec 核查完成。事件运行时触发时序、历史终态重放和 `event.time` 单位仍作为已记录限制；当前字段契约与产品范围均有证据，未作未验证的旧版本保证。
- 最终实际验证：`pnpm run typecheck`：通过；`pnpm run version:check`：通过；`pnpm run capability:check`：通过，23 条既有失效路由、无到期或新增失效路由；`pnpm run i18n:check`：通过、阻断违规 0、报告 124 条既有异常/日志中文告警；十个 Webhook/spec008/PWA 定向测试文件共 79 项通过、0 失败；`git diff --check`：通过。未运行全量测试，未构建/启动开发服务器，未操作 Desktop 或 dsh-web。

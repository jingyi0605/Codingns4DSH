# 设计文档 - CodingNS Agent Team 与 DSH Agent Team 分层集成

状态：技术规划修订完成，待实施。

## 1. 设计目标和约束

### 1.1 目标

- 先建立不依赖 DSH 私有类型的 `CodingNSAgentTeam` 核心。
- 将 Codex、Claude Code、Gemini、Kimi 等外部 adapter 统一为逻辑 Team 成员。
- 通过 `DshCodingNsAgentTeamAdapter` 接入 DSH 的公开 Team/Host 边界。
- 将 Provider 原生 sub-agent 作为可选能力，不污染逻辑成员模型。
- 让外部事件、权限、问题、usage、恢复和中断拥有统一的 Host-only 语义。

### 1.2 约束

- 当前目标 DSH 版本为 `0.2.0-rc.1`；`0.1.7-rc.2` 只作为历史调查样本。
- 不修改 DSH Host、TeamService 私有字段、Agent prototype 或 continuation manager。
- 不覆盖官方 Team 工具，不直接写入 DSH `agentTeam` projection。
- `CodingNSAgentTeam` 核心不得导入 DSH 版本专属类型。
- 复用现有 CLI driver/registry，但不把虚构的 member id 当作 DSH session id。

## 2. 总体架构

```text
┌──────────────────────────────────────────────────────────┐
│ DSH Agent Team / DSH Lead                                │
│  官方工具、生命周期、可选 roster 摘要镜像                 │
└──────────────────────┬───────────────────────────────────┘
                       │ DSH public adapter boundary
┌──────────────────────▼───────────────────────────────────┐
│ DshCodingNsAgentTeamAdapter                              │
│  DSH request/event ↔ CodingNS DTO                         │
└──────────────────────┬───────────────────────────────────┘
                       │ stable internal contract
┌──────────────────────▼───────────────────────────────────┐
│ CodingNSAgentTeam                                        │
│  Team / Member / Run / Task / Event Journal / Scheduler    │
└───────────────┬──────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────┐
│ CodingNsCliAdapterRegistry + CodingNsCliDriver             │
│  execute / resume / permission / question / interrupt      │
└───────────────┬──────────────────────────────────────────┘
                │
        外部 CLI 进程或协议会话
```

权威边界：

| 数据 | 权威层 | DSH 是否镜像 |
| --- | --- | --- |
| 外部成员、run、Provider session | `CodingNSAgentTeam` | 可镜像摘要 |
| 外部事件、权限、问题、usage | `CodingNSAgentTeam` | 只投影可表达摘要 |
| DSH 原生 Team roster | DSH Agent Team | 不回写插件核心 |
| DSH 原生任务板 | 由集成模式决定，但同一 Team 只能有一个权威 | 不双写 |

默认采用“插件 Team 任务权威”模式；只有明确启用 DSH 原生任务镜像时，才由 DSH 任务板作为外部 Team 的任务权威，并禁止插件任务板再次写同一任务。

## 3. 核心接口

### 3.1 `CodingNSAgentTeam`

核心接口只使用插件自己的 DTO：

```ts
interface CodingNsAgentTeam {
  createTeam(input: CreateTeamInput): Promise<CodingNsTeamSnapshot>
  spawnMember(input: SpawnMemberInput): Promise<CodingNsMemberSnapshot>
  sendMessage(input: SendMemberMessageInput): Promise<CodingNsDeliveryReceipt>
  listMembers(teamId: string): Promise<readonly CodingNsMemberSnapshot[]>
  interruptMember(memberId: string): Promise<void>
  createTask(input: CreateTaskInput): Promise<CodingNsTaskSnapshot>
  updateTask(input: UpdateTaskInput): Promise<CodingNsTaskSnapshot>
  listTasks(teamId: string): Promise<readonly CodingNsTaskSnapshot[]>
  subscribe(teamId: string, listener: CodingNsAgentTeamListener): () => void
  disposeTeam(teamId: string): Promise<void>
}
```

`SpawnMemberInput` 至少包含：`teamId`、`parentMemberId`、`adapterId`、`modelId?`、`effortId?`、`prompt?`、`cwd?` 和 `signal`。核心层生成 `codingNsMemberId`、`runId` 和事件序号，不接受 Client 指定这些身份字段。

### 3.2 成员和运行

```ts
interface CodingNsMemberSnapshot {
  readonly teamId: string
  readonly memberId: string
  readonly parentMemberId?: string
  readonly adapterId: string
  readonly modelId?: string
  readonly effortId?: string
  readonly providerSessionId?: string
  readonly dshMemberSessionId?: string
  readonly status: 'provisioning' | 'idle' | 'running' | 'error' | 'archived'
  readonly nativeSubagent: boolean
  readonly generation: number
}

interface CodingNsRunSnapshot {
  readonly runId: string
  readonly teamId: string
  readonly memberId: string
  readonly status: 'starting' | 'running' | 'completed' | 'interrupted' | 'failed'
  readonly lastEventSeq: number
}
```

`dshMemberSessionId` 是可选关联字段，不能作为 `memberId` 的替代。`providerSessionId` 只由外部 driver 使用。

### 3.3 Provider 原生 sub-agent 可选能力

现有 `CodingNsCliDriver` 保持兼容，新增能力只能作为可选扩展：

```ts
interface CodingNsNativeSubagentDriver {
  spawnSubagent?(input: NativeSubagentSpawnInput): Promise<NativeSubagentHandle>
  sendSubagentMessage?(input: NativeSubagentMessageInput): Promise<void>
  interruptSubagent?(providerSessionId: string): Promise<void>
  disposeSubagent?(providerSessionId: string): Promise<void>
}
```

driver 未实现这些方法时，`CodingNSAgentTeam` 使用逻辑外部成员路径：每个成员拥有独立 Provider session，由插件负责父子关系和消息调度。不能把独立会话标记为 `nativeSubagent: true`。

## 4. DSH 适配边界

### 4.1 `DshCodingNsAgentTeamAdapter`

该适配器是唯一允许依赖 DSH 类型的模块，职责包括：

- 将 DSH Team/Host 请求转换为 `CodingNSAgentTeam` DTO。
- 将插件成员、run、任务和错误转换为 DSH 可接受的摘要。
- 监听 DSH `agent/created`、`agent/status`、`agent/disposed` 等公开事件。
- 在启用 Proxy 镜像时维护 `dshMemberSessionId ↔ codingNsMemberId` 关联。
- 在 DSH 能力缺失时返回明确的 disabled/degraded 诊断。

适配器不得：

- 访问 DSH TeamService 私有字段。
- 把外部事件直接写进 `agentTeam` projection。
- 用 provider 名称编码 adapter、model 或 effort。
- 将 DSH `Agent` 对象传入 `CodingNSAgentTeam` 核心。

### 4.2 三种集成模式

| 模式 | 说明 | 交付阶段 |
| --- | --- | --- |
| 插件独立模式 | 只使用 `CodingNSAgentTeam` 和插件 UI/RPC | 第一阶段 |
| DSH 桥接模式 | DSH Lead 通过插件工具/RPC 调用核心 | 第二阶段 |
| DSH Proxy 镜像 | 可选创建 DSH Proxy，镜像成员摘要和生命周期 | 第三阶段，需公开 API 门禁 |

第一、二阶段不要求外部成员成为 DSH 原生 Agent；第三阶段也只能把 Proxy 作为 DSH 侧表示，不能改变插件核心身份。

### 4.3 任务权威选择

默认由 `CodingNSAgentTeam` 管理任务。若未来需要 DSH 原生任务板作为权威，必须通过适配器实现单向同步：

```text
DSH task board -> DshCodingNsAgentTeamAdapter -> CodingNSAgentTeam
```

禁止 DSH 和插件双方对同一任务执行双向无版本同步。

## 5. 事件和状态机

### 5.1 事件契约

```ts
type CodingNsAgentTeamEvent =
  | { type: 'member/created'; teamId: string; memberId: string }
  | { type: 'member/status'; teamId: string; memberId: string; status: string }
  | { type: 'run/start'; teamId: string; memberId: string; runId: string }
  | { type: 'text'; runId: string; text: string }
  | { type: 'reasoning'; runId: string; text: string }
  | { type: 'tool'; runId: string; toolName: string; status: string; detail?: string }
  | { type: 'permission'; runId: string; requestId: string; detail: string }
  | { type: 'question'; runId: string; requestId: string; detail: string }
  | { type: 'usage'; runId: string; inputTokens?: number; outputTokens?: number }
  | { type: 'run/end'; runId: string; status: 'completed' | 'interrupted' | 'failed' }
```

Host 为每个事件分配 `eventSeq`。driver 提供的序号只能作为诊断字段，不能作为 Host 顺序依据。

### 5.2 成员状态

```text
provisioning -> idle -> running -> idle
                          ├──────> error
                          └──────> archived
```

同一 `memberId` 最多一个活动 `runId`。旧 generation 的事件、重复完成和重复中断均为无副作用操作。

## 6. 存储和安全

Host-only store 保存：`codingNsTeamId`、`codingNsMemberId`、adapter、model、effort、脱敏 Provider session 摘要、状态、generation、lastEventSeq 和时间戳。

不得保存或返回：token、refresh token、环境变量、完整命令行、完整本地绝对路径和未经脱敏的 Provider 原始 payload。

所有 RPC 都必须校验：当前用户、`teamId`、`memberId`、`runId` 和可选 `dshMemberSessionId` 的关联关系。

## 7. 错误和恢复

- adapter 未安装或未启用：拒绝创建成员，不产生孤儿记录。
- Provider session 丢失：成员进入 `error`，只允许显式恢复或归档。
- 外部进程崩溃：保留 Team 和任务历史，其他成员继续运行。
- 中断超时：先记录 `interrupted`/`error`，再执行有限的资源清理，不无限等待。
- Host 重启：恢复绑定和最近事件窗口，不自动重放未确认的 prompt。

## 8. 能力矩阵

建议使用独立能力 ID：

- `agent-team.codingns-core`
- `agent-team.external-executor`
- `agent-team.native-subagent`
- `agent-team.dsh-adapter`
- `agent-team.dsh-proxy-mirror`

`agent-team.native` 只能表示 DSH 原生 Team 服务存在，不得用它暗示外部 adapter 已经可以作为原生 sub-agent。

当前 DSH `0.2.0-rc.1` 只在探测到公开 Team/Session/事件边界时启用 `agent-team.dsh-adapter`；没有公开 Proxy 创建契约时，`agent-team.dsh-proxy-mirror` 必须为 `degraded` 或 `unavailable`。

## 9. 测试和门禁

### 9.1 核心层

- fake driver 创建多个逻辑成员并执行并发 run。
- 消息、任务、状态迁移、幂等中断和 Team dispose。
- 事件顺序、cursor、背压、旧 generation 丢弃和关键事件保留。

### 9.2 适配器层

- DSH 能力存在、缺失、Profile 关闭和版本不匹配。
- DSH 请求到 CodingNS DTO 的转换不泄露 DSH Agent 对象。
- 公开生命周期事件与成员绑定、归档、释放的一致性。

### 9.3 Provider 层

- 声明原生 sub-agent 的 driver 走原生路径。
- 未声明能力的 driver 只能走逻辑成员路径。
- Provider session 丢失和恢复不会重复执行。

只有核心层和适配器层门禁通过后，才允许增加 Proxy 镜像和 Client 详情面板。

# 任务清单 - CodingNS Agent Team 与 DSH Agent Team 分层集成

状态：技术规划修订完成，待实施。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部 API 或明确前置条件卡住，必须写原因
- `IN_REVIEW`：已有实现和验证证据，等待复核
- `DONE`：实现和验证证据已回写
- `CANCELLED`：明确取消并写原因

只有完成验证并回写证据后才允许标记 `DONE`。本轮只更新规划，实施任务保持 `TODO`。

## 阶段 0：调查和规划

- [x] 0.1 完成 DSH Agent Team 与外部 adapter 调查
  - 状态：DONE；已确认 DSH `SubagentProvider` 的 continuable 扩展不能直接接管外部 CLI 执行，外部 adapter 当前只有 driver/registry 级会话能力。
  - 验证：调查文档、真实 DSH 包类型和现有 driver 契约交叉复核。

- [x] 0.2 完成分层方案修订
  - 状态：DONE；已确定 `CodingNSAgentTeam` 为核心、`DshCodingNsAgentTeamAdapter` 为边界、Provider 原生 sub-agent 为可选能力。
  - 验证：README、requirements、design、tasks 和 20260929 规划文档互相引用一致。

- [x] 0.3 规划阶段检查点
  - 状态：DONE；已明确逻辑外部成员、Provider 原生 sub-agent、DSH 桥接和 Proxy 镜像的不同交付级别。
  - 验证：核心层不依赖 DSH 私有类型；不把 DSH Team projection 和插件状态双写为同一权威。

## 阶段 1：CodingNSAgentTeam 核心

- [ ] 1.1 定义核心 DTO 和稳定接口
  - 状态：TODO
  - 这一步到底做什么：新增 `CodingNsAgentTeam`、Team/Member/Run/Task/Event DTO 和 listener 契约。
  - 做完你能看到什么：核心接口可以在没有 DSH Context 的 fake Host 中编译和运行。
  - 先依赖什么：0.3。
  - 主要改哪里：`src/host/modules/agent-team/`、`src/shared/contracts/agent-team.ts`、导出入口和契约测试。
  - 这一步先不做什么：不导入 DSH `Agent`、`Session`、TeamService 类型，不接 Client。
  - 怎么验证：`pnpm run typecheck`、核心 DTO 单测。

- [ ] 1.2 实现 Team/Member/Run 状态机和 Host-only store
  - 状态：TODO
  - 这一步到底做什么：实现成员唯一性、父子关系、单活动 run、状态迁移、恢复索引和脱敏持久化。
  - 做完你能看到什么：重启后可以恢复成员摘要和最近事件，不会恢复出重复活动 run。
  - 先依赖什么：1.1。
  - 主要改哪里：`src/host/modules/agent-team/codingns-agent-team-store.ts`、状态机、序列化和测试。
  - 这一步先不做什么：不创建 DSH Proxy，不把 Provider session 当成员身份。
  - 怎么验证：状态迁移、重复创建、重启恢复、敏感字段扫描。

- [ ] 1.3 实现逻辑外部成员调度
  - 状态：TODO
  - 这一步到底做什么：使用现有 CLI registry/driver 创建独立外部会话，支持消息、执行、恢复、中断、释放和失败隔离。
  - 做完你能看到什么：Codex 和 Claude Code 可以作为两个独立逻辑成员并发运行。
  - 先依赖什么：1.1、1.2。
  - 主要改哪里：`src/host/modules/agent-team/codingns-agent-team.ts`、scheduler、CLI registry 边界和 fake driver。
  - 这一步先不做什么：不声称 Provider 原生 sub-agent，不伪造 DSH session。
  - 怎么验证：fake driver 集成测试、并发和幂等中断测试。

- [ ] 1.4 实现外部事件 journal 和 cursor
  - 状态：TODO
  - 这一步到底做什么：统一文本、思考、工具、权限、问题、usage、完成和错误事件，分配 `runId + eventSeq`，实现有界背压。
  - 做完你能看到什么：详情读取可以按 cursor 重放，旧 run 事件不会改变新 run 状态。
  - 先依赖什么：1.2、1.3。
  - 主要改哪里：`external-event-journal.ts`、事件 DTO、脱敏器和压力测试。
  - 怎么验证：事件顺序、cursor、背压、关键事件保留和旧 generation 丢弃测试。

### 阶段检查 1

- [ ] 1.5 CodingNSAgentTeam 核心门禁
  - 状态：TODO
  - 进入条件：1.1 至 1.4 全部完成。
  - 通过标准：核心可以脱离 DSH 完成创建成员、执行、消息、任务、中断、恢复、归档和事件回放。
  - 不通过处理：不得开始 DSH 适配；先修复核心状态机和资源释放。
  - 验证：Host 集成测试、`pnpm run typecheck`、`git diff --check`。

## 阶段 2：Provider 能力扩展

- [ ] 2.1 增加可选 native-subagent driver 契约
  - 状态：TODO
  - 这一步到底做什么：为真实支持原生子 Agent 的 adapter 增加可选 `spawnSubagent`、消息、中断和释放契约。
  - 做完你能看到什么：driver 可以声明 `native-subagent`，未声明的 driver 自动走逻辑成员路径。
  - 先依赖什么：1.5。
  - 主要改哪里：`src/host/cli-adapters/driver.ts`、共享能力枚举、driver fake 和 registry 适配层。
  - 这一步先不做什么：不为不支持的 CLI 添加猜测性协议。
  - 怎么验证：能力声明、缺省回退、原生路径和逻辑路径对比测试。

- [ ] 2.2 为首个真实 adapter 实现原生 sub-agent 探测
  - 状态：TODO
  - 这一步到底做什么：选择一个有公开、可验证协议的 adapter，完成能力探测、创建、消息、恢复和释放闭环。
  - 做完你能看到什么：原生能力只在真实探测成功时启用。
  - 先依赖什么：2.1。
  - 这一步先不做什么：不把该 adapter 的私有字段扩散到 Team 核心。
  - 怎么验证：协议 fixture、失败恢复、凭据脱敏和进程清理测试。

### 阶段检查 2

- [ ] 2.3 Provider 能力门禁
  - 状态：TODO
  - 通过标准：逻辑成员与原生 sub-agent 的状态、ID、错误和恢复路径明确分离。
  - 不通过处理：所有 adapter 继续使用逻辑成员，不阻塞核心 Team。

## 阶段 3：DSH 公开边界适配

- [ ] 3.1 增加 DSH `0.2.0-rc.1` capability route 和 fixture
  - 状态：TODO
  - 这一步到底做什么：区分 `agent-team.codingns-core`、`agent-team.external-executor`、`agent-team.dsh-adapter` 和 `agent-team.dsh-proxy-mirror`。
  - 主要改哪里：`src/dsh-capabilities/types.ts`、`matrix.ts`、`routes.ts`、fixture 和能力测试。
  - 这一步先不做什么：不把 `agent-team.native` 的存在误报为外部 adapter 已接入。
  - 怎么验证：`pnpm run typecheck`、`pnpm run capability:check`、三类能力缺失诊断测试。

- [ ] 3.2 实现 `DshCodingNsAgentTeamAdapter`
  - 状态：TODO
  - 这一步到底做什么：将 DSH Lead/Team 的公开请求、生命周期事件和可选摘要镜像转换为 CodingNS DTO。
  - 做完你能看到什么：DSH 可以通过稳定的桥接接口创建、查询、消息投递和中断 CodingNS 成员。
  - 先依赖什么：1.5、3.1。
  - 主要改哪里：`src/host/modules/agent-team/dsh-codingns-agent-team-adapter.ts`、适配器测试。
  - 这一步先不做什么：不访问 TeamService 私有字段，不覆盖官方 Team 工具，不把 DSH Agent 对象传入核心。
  - 怎么验证：fake DSH Context、请求映射、生命周期和能力降级测试。

- [ ] 3.3 接入 DSH Host 工具/RPC 入口
  - 状态：TODO
  - 这一步到底做什么：提供命名空间明确的插件工具或 RPC，调用适配器，不修改官方工具名称。
  - 主要改哪里：Host feature、`rpc.ts`、共享契约和安全测试。
  - 怎么验证：作用域、错误码、旧 DSH 降级和非 Team CLI 回归测试。

- [ ] 3.4 验证 Proxy 镜像是否具备公开契约
  - 状态：TODO；没有公开 continuable Proxy 契约时允许标记 `BLOCKED`。
  - 这一步到底做什么：验证是否能安全建立 `dshMemberSessionId ↔ codingNsMemberId` 的只读/生命周期镜像。
  - 通过标准：公开 API 可验证创建、继续、中断和释放；否则只交付 DSH 桥接模式。
  - 禁止：读取私有 TeamService map、monkey patch Agent、伪造 projection。

### 阶段检查 3

- [ ] 3.5 DSH 集成门禁
  - 状态：TODO
  - 通过标准：DSH 适配层可独立替换，核心 Team 测试不依赖 DSH；能力缺失时核心和普通 CLI 仍可用。

## 阶段 4：详情 RPC 和 Client 面板

- [ ] 4.1 实现详情 RPC、事件窗口和脱敏 DTO
  - 状态：TODO
  - 先依赖什么：1.5、3.5。
  - 主要改哪里：Host RPC、共享契约和安全测试。
  - 怎么验证：作用域、cursor、分页、敏感字段扫描和错误码测试。

- [ ] 4.2 实现外部 Agent 详情面板
  - 状态：TODO
  - 先依赖什么：4.1。
  - 主要改哪里：Client feature、详情面板、locale 和组件测试。
  - 怎么验证：加载、增量事件、权限/问题响应、中断、恢复、错误和空状态走查。

## 阶段 5：兼容性和最终验收

- [ ] 5.1 旧 DSH 与 Team Profile 降级回归
  - 状态：TODO
  - 验证：`0.1.5-rc.3`、`0.1.6-alpha.2`、`0.1.7-rc.2` 历史 fixture、`0.2.0-rc.1` 当前 fixture、Team 开关组合和普通 CLI 回归。

- [ ] 5.2 资源、安全和并发验收
  - 状态：TODO
  - 验证：`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、`pnpm test`、进程泄漏、背压、脱敏和 Host 关闭清理。

- [ ] 5.3 最终交付检查点
  - 状态：TODO
  - 通过标准：能够明确回答 CodingNS 核心、DSH 适配器、逻辑成员、原生 sub-agent 和 Proxy 镜像分别支持什么；所有 BLOCKED 项有原因，未把未验证能力写成 supported。

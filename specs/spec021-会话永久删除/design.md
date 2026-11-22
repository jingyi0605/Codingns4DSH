# 设计文档 - DSH 本地会话永久删除

状态：In Progress

## 1. 概述

### 1.1 目标

- 通过 DSH 能力矩阵注册稳定能力，将版本和结构探测隔离在 `src/dsh-capabilities/`。
- 在 Host 侧实现经过授权、准入预留、跨进程写锁、原子 staging 移动、崩溃恢复与幂等派生清理的 `sessionDeletion/*` RPC 服务。
- 在 Client 侧扩展「工作区会话增强」，通过原生 `contextMenus` (`target: 'session'`) 提供安全确认弹窗与列表/主视图协调。

### 1.2 覆盖需求

- `requirements.md` 需求 1、需求 2、需求 3

### 1.3 技术约束

- 运行环境：Node.js Host + 浏览器 React Client（DSH `>=0.2.2-alpha.2`，重点验证 `0.2.2-rc.5` 与 `0.2.3-alpha.1`）
- 持久化后端：DSH JSONL 后端（`dsh-session-persistence-jsonl`，含 `stat`、`list`、`acquireWriteLease` 与基于 `session.lock` 的跨进程锁）
- 状态存储：原子写入当前 Profile 的 CodingNS 状态目录（`CODINGNS4DSH_STATE_DIR` 或默认状态目录）

## 2. 架构

### 2.1 系统结构

1. **能力探测层**（`src/dsh-capabilities/`）：探测菜单定位、持久化位置、立即排他删除、启动回放、工作区清理、投影缓存清理、spill 清理与搜索索引协调能力。
2. **共享契约层**（`src/shared/contracts/session-deletion.ts`、`config.ts`）：定义开关默认值、RPC 请求/返回契约及稳定状态/错误码。
3. **Host 编排层**（`src/host/session-deletion/` & `src/host/features/session-deletion.ts`）：
   - `admission-guard.ts`：在 `sessionPersistence` 上安装按 `sessionId` 隔离的准入保护包装，卸载时只撤销本层。
   - `target-locator.ts`：结合 `stat()` 与 `lstat`/`realpath` 校验根目录、项目目录、会话目录、重复位置、symlink/junction 与同文件系统 staging。
   - `activity-inspector.ts`：结合持久化 header、`workspace/session-activity`、`sessions`、`agents`、`jobs`、`schedule` 与 `subagent` 关系检查活动与归属。
   - `store.ts`：管理内存短期确认令牌与持久化删除意图文件。
   - `cleanup.ts`：按「先确认日志消失、再核验无替代会话、最后清派生数据」顺序清理工作区、投影缓存、spill 与搜索索引。
   - `service.ts`：串联 `prepare`、`commit`、`status`、`cancel` 与 `replayOnStartup`。
4. **Client UI 层**（`src/client/session-deletion.ts`、`src/client/features/workspace-session-enhancement*.ts`）：注册原生菜单项、渲染确认与状态弹窗、刷新列表与按需清空主视图。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `dsh-capabilities/*` | 结构探测 DSH 各子能力 | DSH Context / 版本 | `DshCapabilityProfile` |
| `host/session-deletion/admission-guard.ts` | 阻断目标新准入与追踪活跃写句柄 | `sessionPersistence` | `SessionAdmissionGuard` |
| `host/session-deletion/target-locator.ts` | 路径、重复位置与同文件系统 staging 校验 | `sessionId`, `stat` 快照 | `VerifiedTargetLocation` |
| `host/session-deletion/activity-inspector.ts` | 归属、子代理与运行时活跃状态检查 | `sessionId`, Host Context | `ActivityInspection` |
| `host/session-deletion/store.ts` | 短期令牌与持久化意图原子读写 | 操作记录 / token | 状态持久化与查询 |
| `host/session-deletion/cleanup.ts` | 清理工作区、缓存、spill、搜索并核验 | `sessionId`, Host 服务 | 每项清理结果 |
| `host/session-deletion/service.ts` | RPC 编排、跨进程写锁、原子移动与恢复 | RPC 请求 / 启动回放 | 结构化结果或错误 |
| `client/session-deletion.ts` | 菜单校验、确认弹窗、视图刷新与通知 | 原生菜单 payload | RPC 调用与 UI 协调 |

### 2.3 关键流程

#### 2.3.1 立即删除 (`prepare` -> `commit`)

1. `prepare` 验证本地所有者、`sessionId` 合法且非虚拟 ID、定位与归属检查通过、无活跃状态且具备 `immediate` 能力后，生成绑定调用者与生命周期身份的短期内存 `operationId`。
2. `commit` 校验 `operationId`、调用者、模式与有效期后，进入按 `sessionId` 的串行队列，获取进程内准入预留并等待已准入操作退出。
3. 重新检查无 live session/agent/activity，获取跨进程 `acquireWriteLease`，复核 `stat()` 与路径安全后原子持久化意图并 `rename(sessionDir, stagingDir)`。
4. 标记 `log-removed`，清空 `stagingDir` 并验证原目录与 staging 均消失，确认 `stat()` 为 `undefined` 且无替代会话后执行派生清理，发射 `api-session/removed`。

#### 2.3.2 延迟排队与重启回放 (`restart-required`)

1. 若会话被运行时持有但满足定位与归属要求、且 `restart-replay` 能力就绪，`prepare` 返回 `restart-required` 模式。
2. 用户勾选「下次重启时删除」确认后，`commit` 持久化 `queued` 意图记录（不强制终止任务或重启 DSH）。
3. 排队阶段且未进入 `committing` 前，同一授权调用者可通过 `cancel` 取消。
4. 下次正常启动先安装准入保护并校验运行时与后端根目录身份一致，再对非 `cancelled`/非 `completed` 记录按阶段恢复或执行，且严格校验生命周期身份不误删替代会话。

## 3. 组件和接口

### 3.1 RPC 接口

- `sessionDeletion/prepare`: `{ sessionId }` -> `{ sessionId, title, mode, reasonCode?, reasonMessage?, subagentStatus, activeReasons, operationId?, expiresAt?, existingOperation?, storageSummary }`
- `sessionDeletion/commit`: `{ operationId, mode }` -> `{ operationId, sessionId, status, code?, message?, pendingCleanupItems?, completedCleanupItems? }`
- `sessionDeletion/status`: `{ operationId?, sessionId? }` -> `{ operationId?, sessionId?, status, mode?, code?, message?, cancellable, retryableCleanup, pendingCleanupItems, completedCleanupItems, updatedAt }`
- `sessionDeletion/cancel`: `{ operationId }` -> `{ operationId, sessionId, cancelled, status, code?, message? }`

## 4. 状态流转

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `queued` | 用户确认下次重启时删除 | `commit(restart-required)` | 启动回放进入 `committing`、取消变为 `cancelled`、或目标变更/阻塞变为 `failed` |
| `committing` | 已获排他锁准备移动目录 | 立即/回放开始提交 | 原子移动成功变为 `log-removed`，移动失败变为 `failed` |
| `log-removed` | 日志已移出搜索根至 staging | `rename` 成功 | staging 清空并核验完成进入派生清理 |
| `cleanup-pending` | 日志已删但部分派生项失败 | 派生项清理异常或未消除 | 重试成功变为 `completed` |
| `completed` / `deleted` | 全部日志与必需清理项完成并验证 | 所有清理项完成 | 终态 |
| `cancelled` | 排队被授权调用者取消 | `cancel` 在 `queued` 成功 | 终态 |
| `failed` | 执行失败或身份已改变 | 路径/排他/身份校验失败 | 终态或重新准备 |

# 任务清单 - DSH 本地会话永久删除

状态：Done

## 阶段 1：契约与能力登记

- [x] 1.1 定义共享契约与配置开关
  - 状态：DONE
  - 这一步到底做什么：新增会话永久删除的共享类型、错误码和 RPC 契约，并在「工作区会话增强」设置中增加默认关闭的 `enableSessionDeletion` 开关。
  - 做完你能看到什么：共享契约和设置 schema 就位，默认不开启删除入口。
  - 先依赖什么：无
  - 开始前先看：
    - `requirements.md` 需求 1、需求 2
    - `design.md` §3.1
  - 主要改哪里：
    - `src/shared/contracts/session-deletion.ts`
    - `src/shared/contracts/config.ts`
    - `src/host/settings.ts`
  - 这一步先不做什么：不写 Host 删除逻辑或前端菜单。
  - 怎么算完成：类型检查通过且配置默认值保持关闭。
  - 怎么验证：`pnpm run typecheck`
  - 对应需求：`requirements.md` 需求 1
  - 对应设计：`design.md` §3.1

- [x] 1.2 注册 DSH 能力矩阵与 Host/Client 适配器
  - 状态：DONE
  - 这一步到底做什么：在能力矩阵与路由中区分菜单定位、持久化位置、立即删除、延迟回放与各类清理能力，并重新生成能力报告。
  - 做完你能看到什么：不同 DSH 版本与服务装配的运行态能力能被准确诊断，缺能力时只停用对应路径。
  - 先依赖什么：1.1
  - 开始前先看：
    - `design.md` §2.1
  - 主要改哪里：
    - `src/dsh-capabilities/types.ts`
    - `src/dsh-capabilities/matrix.ts`
    - `src/dsh-capabilities/routes.ts`
    - `src/dsh-capabilities/host/session-deletion-adapter.ts`
    - `src/dsh-capabilities/client/session-deletion-adapter.ts`
    - `docs/生成报告/20260925-能力路由报告.md`（脚本生成）
  - 这一步先不做什么：不把版本判断写进业务代码。
  - 怎么算完成：`pnpm run capability:check` 与 `pnpm run capability:report` 通过。
  - 怎么验证：`pnpm run capability:check && pnpm run typecheck`
  - 对应需求：`requirements.md` 需求 2
  - 对应设计：`design.md` §2.1

## 阶段 2：Host 删除引擎、并发控制与恢复

- [x] 2.1 实现准入保护、路径安全校验与活动归属检查
  - 状态：DONE
  - 这一步到底做什么：构建 Host 准入预留包装、路径与同文件系统 staging 校验器，以及基于持久化与实时服务的子代理/活跃状态检查器。
  - 做完你能看到什么：能够安全拒绝非本地、虚拟、有子代理、存在 symlink 或活跃 writer 的删除目标。
  - 先依赖什么：1.2
  - 开始前先看：
    - `requirements.md` 需求 2
    - `design.md` §2.2
  - 主要改哪里：
    - `src/host/session-deletion/admission-guard.ts`
    - `src/host/session-deletion/target-locator.ts`
    - `src/host/session-deletion/activity-inspector.ts`
  - 这一步先不做什么：不写磁盘删除或派生清理。
  - 怎么算完成：单元测试覆盖竞争准入与非法路径拒绝。
  - 怎么验证：`pnpm run typecheck`
  - 对应需求：`requirements.md` 需求 2
  - 对应设计：`design.md` §2.2

- [x] 2.2 实现意图持久化、跨进程写锁提交、派生清理、启动回放与 RPC 模块
  - 状态：DONE
  - 这一步到底做什么：实现原子状态与令牌存储、staging 原子重命名删除、工作区/投影缓存/spill/搜索协调清理、崩溃恢复回放以及 `sessionDeletion/*` RPC 注册。
  - 做完你能看到什么：Host Feature 完整接入 `FeatureRegistry` 与 `rpc.ts`，支持立即删除、排队取消、启动回放与部分清理重试。
  - 先依赖什么：2.1
  - 开始前先看：
    - `requirements.md` 需求 2、需求 3
    - `design.md` §2.3、§4
  - 主要改哪里：
    - `src/host/session-deletion/store.ts`
    - `src/host/session-deletion/cleanup.ts`
    - `src/host/session-deletion/service.ts`
    - `src/host/features/session-deletion.ts`
    - `src/host/features/index.ts`
    - `src/host/rpc.ts`
    - `src/host/index.ts`
  - 这一步先不做什么：不修改无关 Host 功能模块。
  - 怎么算完成：Host RPC 与恢复测试全部通过。
  - 怎么验证：`pnpm run typecheck`
  - 对应需求：`requirements.md` 需求 2、需求 3
  - 对应设计：`design.md` §2.3、§4

## 阶段 3：Client 菜单、确认框、视图刷新与测试文档验收

- [x] 3.1 实现 Client 菜单项、确认弹窗、i18n 词典与视图刷新
  - 状态：DONE
  - 这一步到底做什么：扩展工作区会话增强开关与原生行菜单，实现严格结构校验、确认弹窗、重启排队反馈、主视图精确清空与原生列表刷新。
  - 做完你能看到什么：开启开关后会话行右键/`…` 可弹出精确 ID 的删除确认框，删除后无幽灵行且不误清其他主会话。
  - 先依赖什么：2.2
  - 开始前先看：
    - `requirements.md` 需求 1、需求 3
    - `design.md` §2.1、§3.1
  - 主要改哪里：
    - `src/client/locales/sessionDeletion.ts`
    - `src/client/locale.ts`
    - `src/client/session-deletion.ts`
    - `src/client/session-adapter-cache.ts`
    - `src/client/features/workspace-session-enhancement.ts`
    - `src/client/features/workspace-session-enhancement-panel.ts`
  - 这一步先不做什么：不使用 DOM 猜行或客户端假墓碑。
  - 怎么算完成：`pnpm run i18n:check` 与 UI 单元测试通过。
  - 怎么验证：`pnpm run i18n:check && pnpm run typecheck`
  - 对应需求：`requirements.md` 需求 1、需求 3
  - 对应设计：`design.md` §2.1、§3.1

- [x] 3.2 编写全量测试、开发记录与总体验收
  - 状态：DONE
  - 这一步到底做什么：编写覆盖 UI、RPC、并发、路径安全、崩溃恢复、派生清理与跨版本兼容的测试，并完成开发记录与全量校验。
  - 做完你能看到什么：所有窄测试与全仓门禁通过，开发记录和 Spec 状态准确闭环。
  - 先依赖什么：3.1
  - 开始前先看：
    - `requirements.md` 全部需求
    - `design.md` 全文
  - 主要改哪里：
    - `tests/session-deletion-*.spec.ts`
    - `docs/开发记录/20261122-会话永久删除实现.md`
    - `specs/spec021-会话永久删除/tasks.md`
  - 这一步先不做什么：不启动开发服务器、不操作 Desktop、不提交 git。
  - 怎么算完成：新增测试、`typecheck`、`version:check`、`capability:check`、`i18n:check` 与 `pnpm test` 全部通过。
  - 怎么验证：`pnpm run typecheck && pnpm run version:check && pnpm run capability:check && pnpm run i18n:check && pnpm test`
  - 对应需求：`requirements.md` 全部需求
  - 对应设计：`design.md` 全文

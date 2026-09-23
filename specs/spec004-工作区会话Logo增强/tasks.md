# 任务清单 - 工作区会话 Logo 增强

状态：IN_REVIEW

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住
- `IN_REVIEW`：已有结果，等待复核
- `DONE`：完成且验证结果已回写
- `CANCELLED`：明确取消并记录原因

## 阶段 1：确认边界和设计

- [x] 1.1 建立本 Spec
  - 状态：DONE
  - 这一步到底做什么：记录只做 Logo 注入的新范围、固定版本兼容方式和安全边界。
  - 做完你能看到什么：需求、设计、任务和验收文档可以互相追踪。
  - 先依赖什么：用户确认放弃会话删除。
  - 开始前先看：仓库 `AGENTS.md`、功能模块规则、设置表单规则、DSH 0.1.6-alpha.2 WorkspaceBrowser 实现。
  - 主要改哪里：本 Spec 全部文件。
  - 这一步先不做什么：不写功能代码，不恢复删除范围。
  - 怎么算完成：范围、数据来源、DOM 失败策略、验证方式写清楚。
  - 怎么验证：`rg -n "闭环|抽象层|赋能|治理|编排|底座|能力沉淀" specs/spec004-工作区会话Logo增强 --glob '!tasks.md'`，结果无匹配。
  - 对应需求：全部需求
  - 对应设计：全文

## 阶段 2：实现模块和兼容注入器

- [x] 2.1 增加设置、映射接口和客户端缓存
  - 状态：DONE
  - 这一步到底做什么：增加子设置和只返回 sessionId/adapterId 的读取接口，并建立浏览器共享缓存。
  - 做完你能看到什么：Client 一次加载后可按 sessionId O(1) 查询适配器，且收不到 Host-only 字段。
  - 先依赖什么：1.1。
  - 开始前先看：`requirements.md` 需求 1、2、3，`design.md` §2、§4、§7。
  - 主要改哪里：`src/shared/contracts/config.ts`、`src/host/cli-adapters/feature.ts`、`src/client/session-adapter-cache.ts`。
  - 这一步先不做什么：不添加轮询，不建立第二份持久化索引。
  - 怎么算完成：默认值、持久化路径、脱敏返回和缓存通知都有测试。
  - 怎么验证：`pnpm exec tsc --noEmit` 通过；`node --test tests/workspace-session-enhancement.spec.ts tests/contracts.spec.ts tests/feature-wiring.spec.ts` 通过，29 项测试全部成功。
  - 对应需求：需求 1、需求 2、需求 3
  - 对应设计：§2、§4、§7

- [x] 2.2 增加 DOM Logo 注入器和功能模块
  - 状态：DONE
  - 这一步到底做什么：实现 Fiber 身份解析、Logo 节点插入、MutationObserver 扫描和完整清理，并登记客户端模块。
  - 做完你能看到什么：分组、平铺和搜索会话行显示正确 Logo，开关实时生效。
  - 先依赖什么：2.1。
  - 开始前先看：`requirements.md` 全部需求，`design.md` §3、§5、§6。
  - 主要改哪里：`src/client/workspace-session-logo-dom.ts`、`src/client/features/workspace-session-enhancement*.ts`、`src/client/features/index.ts`。
  - 这一步先不做什么：不修改 DSH 文件，不按标题猜 sessionId。
  - 怎么算完成：重复扫描不重复注入，关闭后节点与观察器清零。
  - 怎么验证：`pnpm build` 通过；`node --test tests/client-entry.spec.ts tests/client-theme.spec.ts tests/manifest.spec.ts` 通过，15 项测试全部成功。
  - 对应需求：需求 1、需求 2、需求 3
  - 对应设计：§3、§5、§6、§8

## 阶段 3：验证和记录

- [x] 3.1 执行自动验证并回写结果
  - 状态：DONE
  - 这一步到底做什么：执行类型检查、构建、定向测试、全量 Node 测试和 diff 检查。
  - 做完你能看到什么：每个已完成任务都有实际命令和结果，失败能区分本次改动和已有工作区问题。
  - 先依赖什么：2.2。
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`。
  - 主要改哪里：`tasks.md`、`docs/20260923-兼容性与验收记录.md`。
  - 这一步先不做什么：不启动开发服务器，不把未做的人工验收写成通过。
  - 怎么算完成：全部要求命令有记录，真实宿主人工验收保持明确状态。
  - 怎么验证：`pnpm exec tsc --noEmit` 通过；`pnpm build` 通过；`node --test tests/*.spec.ts` 通过，246 项测试全部成功；`git diff --check` 通过。
  - 对应需求：全部需求
  - 对应设计：§9、§10

- [ ] 3.2 真实宿主人工验收
  - 状态：TODO
  - 这一步到底做什么：在真实 DSH 0.1.6-alpha.2 中检查亮暗主题、窄侧栏、长标题、分组、平铺和搜索。
  - 做完你能看到什么：实际页面截图或验收记录，而不是只依赖源码测试。
  - 先依赖什么：3.1，且由用户明确允许启动真实宿主。
  - 开始前先看：`docs/20260923-兼容性与验收记录.md`。
  - 主要改哪里：验收记录。
  - 这一步先不做什么：未获允许不启动开发服务器或 DSH Host。
  - 怎么算完成：六类场景都有人工结论。
  - 怎么验证：真实宿主操作和截图。
  - 对应需求：需求 1、需求 2、需求 3
  - 对应设计：§9、§10

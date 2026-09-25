# 项目规则与技术索引

## 基本规则

- 与用户、文档、注释和规范始终使用中文；代码标识符使用英文。
- 新建说明类 Markdown 文件时，文件名以当前日期 `YYYYMMDD-` 开头。
- 不主动启动开发服务器；不执行 `git reset --hard`、`git checkout --` 等破坏性操作。
- 修改前先保留工作区已有改动；所有手工编辑使用 `apply_patch`。
- 版本发布、提交、推送、创建 tag 和 npm 发布不属于普通开发任务，必须单独确认。

## Spec 索引

- [spec005：DSH 能力注册与版本路由机制](specs/spec005-DSH能力注册与版本路由机制/README.md)
  - [需求](specs/spec005-DSH能力注册与版本路由机制/requirements.md)
  - [设计](specs/spec005-DSH能力注册与版本路由机制/design.md)
  - [任务清单](specs/spec005-DSH能力注册与版本路由机制/tasks.md)
  - [技术规划与能力矩阵](specs/spec005-DSH能力注册与版本路由机制/docs/20260925-技术规划与能力矩阵.md)

## 文档索引与新增文档规则

`docs/` 按文档类型分目录，新增文档必须放进对应目录，不得直接放在 `docs/` 根下：

| 目录 | 收录内容 | 现有文档 |
| --- | --- | --- |
| `docs/开发规范/` | 约束类规则：新增模块、设置页、表单的写法，长期有效 | [功能模块开发规则](docs/开发规范/20260922-功能模块开发规则.md)、[设置选项与表单开发规则](docs/开发规范/20260922-设置选项与表单开发规则.md) |
| `docs/调查报告/` | 对 DSH 与上游接口、兼容性、实际行为的调查证据 | [DSH 0.1.7 接口与调用变化](docs/调查报告/20260925-DSH-0.1.7接口与调用变化.md)、[DSH 终端兼容接口与阻塞调查](docs/调查报告/20260922-DSH终端兼容接口与阻塞调查.md) |
| `docs/开发记录/` | 一次改造的过程、关键决策和验证结果 | [功能模块注册表与设置页驱动记录](docs/开发记录/20260922-功能模块注册表与设置页驱动记录.md)、[外部会话持久化与 DSH 原生侧栏集成](docs/开发记录/20260922-外部会话持久化与DSH原生侧栏集成.md)、[终端启动进程调用说明](docs/开发记录/20260923-终端启动进程调用说明.md) |
| `docs/生成报告/` | 脚本生成、可重复生成的报告，不手工编辑 | [能力路由报告](docs/生成报告/20260925-能力路由报告.md) |
| `docs/配图/` | README 配图清单与截图素材 `docs/配图/imgs/` | [README 配图清单](docs/配图/20260925-README配图清单.md) |

新增、移动或删除文档时：

1. 文件名以 `YYYYMMDD-` 开头、使用中文标题；正文中的跨目录引用写仓库根相对路径（如 `docs/调查报告/xxx.md`）。
2. 版本变化、接口调查和外部证据写进 `docs/调查报告/`；实现过程与决策回写 `docs/开发记录/`；规则性内容只进 `docs/开发规范/`。
3. `docs/生成报告/` 下的文件由脚本生成：改路径要同时改生成脚本和读取它的测试，产物本身不手工编辑。
4. 移动、改名或删除文档后，同步更新 `README.md`、`AGENTS.md`、`specs/**` 以及相关脚本和测试中的引用。
5. 需要新分类时，先在 AGENTS.md 的这张表里登记目录与用途，再创建目录。

## 能力注册表入口

- 类型契约：`src/dsh-capabilities/types.ts`
- Registry：`src/dsh-capabilities/registry.ts`
- 版本矩阵：`src/dsh-capabilities/matrix.ts`
- 运行时路由装配：`src/dsh-capabilities/routes.ts`
- 内部设置接口：`src/dsh-capabilities/settings-store.ts`
- 退休检查：`scripts/check-capability-retirement.mjs`
- 报告生成：`scripts/generate-capability-report.mjs`

## 新版本、新模块、新能力开发规范

### 新增 DSH 版本

1. 先在 `docs/调查报告/` 增加版本变化报告，明确新增、删除、签名变化和行为变化。
2. 在 `src/dsh-capabilities/matrix.ts` 增加新旧路由和生命周期信息。
3. 在 `src/dsh-capabilities/routes.ts` 增加结构探测和工厂；禁止把版本判断散落到业务模块。
4. 更新 `version.json`、`package.json`、`profile/` 和 `src/shared/contracts/version.ts`，运行 `pnpm run version:check`。
5. 为旧版本、新版本和当前版本各增加 fake Context 测试，再运行完整类型检查和测试。

### 新增功能模块

1. 必须登记到对应的 `FeatureRegistry`，描述依赖、运行时、启用策略和 UI 元数据。
2. 通过 `descriptor.requires` 声明能力要求，并选择 `disable`、`degrade` 或 `error` 回退策略。
3. 业务代码只依赖 CodingNS 内部服务，不直接导入 DSH 版本专属类型或写版本 `if`。
4. 启停、依赖、资源释放和能力诊断必须有测试；能力缺失只能影响对应模块。

### 新增能力或接口

1. 先新增稳定的 `DshCapabilityId`，再新增矩阵 route、适配器、诊断码和消费者清单。
2. 适配器必须位于 `src/dsh-capabilities/` 边界层，内部接口保持与 DSH 类型解耦。
3. 更新能力报告并运行 `pnpm run capability:report`、`pnpm run capability:check`。
4. 新能力必须覆盖至少 `0.1.5-rc.3`、`0.1.6-alpha.2`、`0.1.7-rc.2` 三套 fixture；不支持的版本必须有可解释诊断。

### 淘汰旧接口

1. 在矩阵中标记 `deprecated`、替代 route 和 `removableAfter`，不得直接删除代码。
2. 先提高最低兼容版本，确认 Feature、测试、manifest 和文档不再引用旧 route。
3. 运行 `pnpm run capability:check`；退休检查失败时不得合并删除。
4. 删除后重新生成报告、运行 `pnpm run version:check`、`pnpm run typecheck` 和 `pnpm test`，并在 Spec 任务清单记录证据。

## 验证命令

```bash
pnpm run typecheck
pnpm run version:check
pnpm run capability:check
pnpm test
```

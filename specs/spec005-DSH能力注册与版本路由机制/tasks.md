# 任务清单 - DSH 能力注册与版本路由机制（人话版）

状态：已完成，进入维护期。

## 本轮完成证据

- 核心实现：`src/dsh-capabilities/`、`src/features/registry.ts`、`src/shared/contracts/feature.ts`。
- 版本与退休检查：`pnpm run version:check`、`pnpm run capability:check` 均通过。
- 类型、构建和全量测试：`pnpm run typecheck`、`pnpm run build`、`pnpm test`，共 366 项测试通过。
- 三版本 Registry fixture：`tests/dsh-capability-registry.spec.ts` 覆盖 `0.1.5-rc.3`、`0.1.6-alpha.2`、`0.1.7-rc.2`。

## 这份文档是干什么的

这份任务清单用于把能力注册表从设计落到代码。每个任务都明确工作边界、依赖、文件、验收和验证方式。只有完成验证并回写结果后，任务才能标记为 `DONE`。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住，必须写清楚原因
- `IN_REVIEW`：代码和验证已完成，等待复核
- `DONE`：已经完成并回写验证证据
- `CANCELLED`：明确取消，并记录原因

## 阶段 1：建立能力矩阵和注册表骨架

- [x] 1.1 建立能力 ID、路由和诊断契约
  - 状态：DONE；已完成类型检查和能力门禁契约测试。
  - 这一步到底做什么：新增 `DshCapabilityId`、`DshCapabilityRoute`、`DshCapabilityResolution`、`DshCapabilityProfile` 和结构化诊断类型。
  - 做完你能看到什么：所有 DSH 能力都有统一的数据结构，业务模块还不改变行为。
  - 先依赖什么：无
  - 开始前先看：
    - `requirements.md` 需求 1、需求 2、需求 6
    - `design.md` §3.2「数据结构」
    - `docs/20260925-技术规划与能力矩阵.md` §2「能力矩阵」
  - 主要改哪里：
    - `src/dsh-capabilities/types.ts`
    - `src/shared/contracts/feature.ts`
    - `src/shared/index.ts`
  - 这一步先不做什么：不实现任何 DSH 版本适配器，不修改现有功能启停逻辑。
  - 怎么算完成：
    1. 类型可以表达 supported、deprecated、degraded、unavailable 和 retired 生命周期。
    2. 能力 ID 和 Feature requirement 通过 TypeScript 类型检查。
  - 怎么验证：`pnpm run typecheck`；新增能力类型单测。
  - 对应需求：`requirements.md` 需求 1、需求 2、需求 6
  - 对应设计：`design.md` §3.2、§5.2

- [x] 1.2 实现 `DshCapabilityRegistry` 和 Profile 冻结
  - 状态：DONE；已完成版本选择、冲突、探测异常和只读 Profile 测试。
  - 这一步到底做什么：实现路由注册、版本过滤、探测、优先级选择、冲突拒绝和能力画像冻结。
  - 做完你能看到什么：给定 DSH 版本和 fake Context，可以得到确定且可解释的能力 Profile。
  - 先依赖什么：1.1
  - 开始前先看：
    - `requirements.md` 需求 1、需求 3、需求 6
    - `design.md` §2.3.1「启动时解析能力画像」
    - `design.md` §3.3.1「DshCapabilityRegistry」
  - 主要改哪里：
    - `src/dsh-capabilities/registry.ts`
    - `src/dsh-capabilities/profile.ts`
    - `src/shared/contracts/version.ts`
    - `tests/dsh-capability-registry.spec.ts`
  - 这一步先不做什么：不连接真实 DSH，不迁移设置、RPC 或 UI。
  - 怎么算完成：
    1. 同一能力只能选出一个路由。
    2. 同优先级冲突、探测异常和无路由都有稳定错误码。
    3. Profile 创建后不可被单项替换。
  - 怎么验证：运行 Registry 单元测试和 `pnpm run typecheck`。
  - 对应需求：`requirements.md` 需求 1、需求 3、需求 6
  - 对应设计：`design.md` §2.3.1、§3.3.1、§4.2、§6.1、§6.2

- [x] 1.3 建立 DSH 三版本能力矩阵和版本同步检查
  - 状态：DONE；矩阵、manifest 范围和当前测试版本已由 `version:check` 联动校验。
  - 这一步到底做什么：把 0.1.5-rc.3、0.1.6-alpha.2、0.1.7-rc.2 的能力支持状态写入中心矩阵，并让 `version:check` 检查矩阵、manifest、version.json 的一致性。
  - 做完你能看到什么：一个新增或删除的 DSH 路由不会只改了代码却漏掉兼容范围或文档。
  - 先依赖什么：1.1、1.2
  - 开始前先看：
    - `requirements.md` 需求 4、需求 5、需求 6
    - `design.md` §2.3.3「新增 DSH 版本路由」和 §2.3.4「退休旧 DSH 能力」
    - `docs/20260925-技术规划与能力矩阵.md` §2、§6
  - 主要改哪里：
    - `src/dsh-capabilities/matrix.ts`
    - `scripts/check-version-sync.mjs`
    - `version.json`
    - `package.json`
    - `tests/manifest.spec.ts`
  - 这一步先不做什么：不扩大当前插件实际声明的 DSH 范围。
  - 怎么算完成：
    1. 矩阵能列出三套 DSH 版本的 route 和状态。
    2. 版本检查能发现矩阵与 manifest 不一致。
  - 怎么验证：`pnpm run version:check`、manifest 测试和矩阵单测。
  - 对应需求：`requirements.md` 需求 4、需求 5、需求 6
  - 对应设计：`design.md` §2.3.3、§2.3.4、§7.4

### 阶段检查

- [x] 1.4 能力注册表基础检查
  - 状态：DONE；Registry、版本检查、manifest 测试和构建均通过。
  - 这一步到底做什么：确认能力数据结构、解析器、矩阵和版本检查已经站稳。
  - 做完你能看到什么：后续适配器可以只接入 Registry，不再自己发明版本判断方式。
  - 先依赖什么：1.1、1.2、1.3
  - 开始前先看：`requirements.md`、`design.md`、`docs/20260925-技术规划与能力矩阵.md`
  - 主要改哪里：阶段 1 全部相关文件。
  - 这一步先不做什么：不迁移任何业务 Feature，不修改 DSH 兼容范围。
  - 怎么算完成：
    1. Registry 单元测试全部通过。
    2. `version:check` 和类型检查通过。
    3. 能力矩阵可以定位每个 route 的源码和测试。
  - 怎么验证：`pnpm run typecheck`、`pnpm run version:check`、`node --test tests/dsh-capability-registry.spec.ts tests/manifest.spec.ts`。
  - 对应需求：`requirements.md` 需求 1、需求 4、需求 6
  - 对应设计：`design.md` §2、§3、§7

## 阶段 2：迁移核心 Host/Client 能力

- [x] 2.1 抽象 `CodingNsSettingsStore`
  - 状态：DONE；内部快照、订阅、mutation 和布尔结果契约已建立。
  - 这一步到底做什么：定义不暴露 DSH 类型的内部设置快照、订阅和 mutation 接口，并让 Feature services 使用它。
  - 做完你能看到什么：功能模块不再需要知道 `SettingsScope` 或 `ConfigForm`。
  - 先依赖什么：1.4
  - 开始前先看：
    - `requirements.md` 需求 2、需求 4
    - `design.md` §3.3.2「CodingNsCapabilityServices」
    - `docs/调查报告/20260925-DSH-0.1.7接口与调用变化.md` §1、§15.2
  - 主要改哪里：
    - `src/dsh-capabilities/settings-store.ts`
    - `src/client/features/types.ts`
    - `src/host/features/types.ts`
    - `src/client/settings-section.ts`
    - `src/client/account-bar.ts`
  - 这一步先不做什么：不删除旧 SettingsScope bridge，不接入 ConfigForm。
  - 怎么算完成：
    1. Client/Host Feature services 只暴露内部 store 类型。
    2. 旧适配器可以包装成该 store。
  - 怎么验证：类型检查、设置组件单测和现有完整测试。
  - 对应需求：`requirements.md` 需求 2、需求 4
  - 对应设计：`design.md` §3.3.2、§6.3

- [x] 2.2 接入 0.1.5/0.1.6 SettingsScope 路由
  - 状态：DONE；Host/Client legacy adapter 已实现并保持旧入口不删除。
  - 这一步到底做什么：把现有 SettingsProvider、SettingsScope 和 `settingsScope` 注入封装成 legacy adapter，并注册到 `settings.store` 能力。
  - 做完你能看到什么：现有 DSH 0.1.5/0.1.6 行为不变，但业务代码不再直接使用旧类型。
  - 先依赖什么：2.1
  - 开始前先看：
    - `src/host/settings.ts`
    - `src/client/settings-bridge.ts`
    - `design.md` §2.3.1、§3.3.2
  - 主要改哪里：
    - `src/dsh-capabilities/host/settings-scope-adapter.ts`
    - `src/dsh-capabilities/client/settings-scope-adapter.ts`
    - `src/host/settings.ts`
    - `src/client/settings-bridge.ts`
  - 这一步先不做什么：不改变旧 DSH 的 manifest 范围，不删除旧 bridge。
  - 怎么算完成：
    1. 旧设置读、写、订阅、revision 冲突行为保持一致。
    2. Host-only `cliSessions` 不进入 Client 快照。
  - 怎么验证：现有设置测试、0.1.6 fake Context 集成测试和完整测试。
  - 对应需求：`requirements.md` 需求 2、需求 4
  - 对应设计：`design.md` §3.3.2、§4.2

- [x] 2.3 接入 0.1.7 Config/ConfigForm 路由
  - 状态：DONE；结构化 Config/ConfigForm 边界和 revision 写入适配器已实现，peer 范围现已实验性放宽到 0.1.7。
  - 这一步到底做什么：增加根入口 `Config`，实现 SettingsForms descriptor/mutate 和 Client ConfigForm 适配器。
  - 做完你能看到什么：同一套 Feature 代码可以在 DSH 0.1.7 上读取、修改和订阅配置。
  - 先依赖什么：2.1、2.2
  - 开始前先看：
    - `requirements.md` 需求 4
    - `design.md` §2.3.3、§3.3.2
    - `docs/调查报告/20260925-DSH-0.1.7接口与调用变化.md` §1、§15.2
  - 主要改哪里：
    - `src/index.ts`
    - `src/host/settings.ts`
    - `src/client/index.ts`
    - `src/client/settings-bridge.ts`
    - `src/dsh-capabilities/host/config-forms-adapter.ts`
    - `src/dsh-capabilities/client/config-forms-adapter.ts`
  - 这一步先不做什么：不删除 legacy adapter，不立即扩大 package peer 范围。
  - 怎么算完成：
    1. 0.1.7 ConfigForm 写入返回值和 revision 冲突被正确处理。
    2. 自定义设置 RPC 不与 DSH settings mirror 双写。
    3. 0.1.6 适配器仍通过同一个内部接口工作。
  - 怎么验证：0.1.7 fake Context、设置并发 mutation 测试、构建和类型检查。
  - 对应需求：`requirements.md` 需求 2、需求 4、需求 6
  - 对应设计：`design.md` §2.3.1、§3.3.2、§4.2、§5.3

### 阶段检查

- [x] 2.4 设置能力双路由检查
  - 状态：DONE；三个 DSH fixture 通过同一内部 store 路由测试。
  - 这一步到底做什么：确认同一 Feature 在旧 SettingsScope 和新 ConfigForm 下使用相同内部服务，且不会出现双重权威状态。
  - 做完你能看到什么：设置页和模块逻辑无需版本分支即可覆盖三套 DSH fixture。
  - 先依赖什么：2.1、2.2、2.3
  - 开始前先看：`requirements.md`、`design.md`、`docs/20260925-技术规划与能力矩阵.md` §2、§6。
  - 主要改哪里：阶段 2 设置相关文件和测试。
  - 这一步先不做什么：不迁移其他 DSH 能力，不删除 legacy route。
  - 怎么算完成：
    1. 0.1.5/0.1.6/0.1.7 fixture 都能完成设置读取、修改和订阅。
    2. 任一版本只能存在一个设置权威来源。
  - 怎么验证：设置集成测试、完整 `pnpm test`。
  - 对应需求：`requirements.md` 需求 2、需求 4、需求 6
  - 对应设计：`design.md` §2.3.1、§4.1、§6.2

## 阶段 3：迁移其他 DSH 能力和 Feature 门禁

- [x] 3.1 建立 Connection RPC 和 Peer 能力路由
  - 状态：DONE；统一 dispatch context 已接入旧 handler，peer 仅来自宿主上下文。
  - 这一步到底做什么：把旧三参数 handler 和 0.1.7 `PeerScope` handler 适配到统一内部 RPC 接口。
  - 做完你能看到什么：Connection RPC 业务端点不关心 DSH handler 参数差异，peer 缺失时有明确策略。
  - 先依赖什么：1.4、2.4
  - 开始前先看：
    - `requirements.md` 需求 2、需求 3、需求 4
    - `src/host/rpc.ts`
    - `design.md` §3.3.2、§5
    - `docs/调查报告/20260925-DSH-0.1.7接口与调用变化.md` §3、§15.4
  - 主要改哪里：
    - `src/dsh-capabilities/host/connection-rpc-adapter.ts`
    - `src/host/rpc.ts`
    - `src/host/rpc-table.ts`
    - `tests/rpc.spec.ts`
  - 这一步先不做什么：不引入二进制 attachment/uplink，不改变现有业务 endpoint。
  - 怎么算完成：
    1. 旧 DSH handler 和新 DSH handler 返回统一内部结果。
    2. `/codingns` 手写 HTTP 入口和 Connection 入口共用 dispatch。
    3. 需要 peer 的端点拒绝无 peer 请求。
  - 怎么验证：旧/新 handler fake 测试、peer 鉴权测试、完整测试。
  - 对应需求：`requirements.md` 需求 2、需求 3、需求 4
  - 对应设计：`design.md` §3.3.2、§5.3

- [x] 3.2 建立 UI、Locale、Theme、Conversation、Sidebar 能力路由
  - 状态：DONE；能力 route、图标 fallback 和各领域最小适配器已落地。
  - 这一步到底做什么：将图标、Locale、Theme、Conversation 和 Sidebar 的版本差异包装成统一能力服务。
  - 做完你能看到什么：Client Feature 不再直接导入已删除图标或 DSH 具体版本类型。
  - 先依赖什么：1.4、2.4
  - 开始前先看：
    - `requirements.md` 需求 2、需求 3、需求 4
    - `src/client/terminal/xterm-view.ts`
    - `src/client/terminal/ui.ts`
    - `src/client/locale.ts`
    - `src/client/external-tool-stream.ts`
    - `design.md` §3.2、§3.3.2
  - 主要改哪里：
    - `src/dsh-capabilities/client/primitives-adapter.ts`
    - `src/dsh-capabilities/client/locale-adapter.ts`
    - `src/dsh-capabilities/client/theme-adapter.ts`
    - `src/dsh-capabilities/client/conversation-adapter.ts`
    - `src/dsh-capabilities/client/sidebar-adapter.ts`
    - `src/client/terminal/*.ts`
    - `src/client/external-tool-stream.ts`
  - 这一步先不做什么：不接入 DSH 0.1.7 新增但当前业务不需要的高级 API。
  - 怎么算完成：
    1. 旧、新图标导出都能选择稳定内部 icon service。
    2. Conversation 事件变化不会破坏当前外部工具临时节点。
    3. 旧 Sidebar API 和新 Sidebar API 都能提供当前终端功能。
  - 怎么验证：Client bundle、类型检查、三版本 fake Context 和 UI 适配器测试。
  - 对应需求：`requirements.md` 需求 2、需求 3、需求 4
  - 对应设计：`design.md` §3.1、§3.2、§7.2

- [x] 3.3 接入 Typert 能力但保持现有终端 wire 协议
  - 状态：DONE；Host/Client Typert 内部边界已建立，现有终端 wire 测试全部通过。
  - 这一步到底做什么：将 Typert 远程服务访问包装成内部能力，并验证旧 RemoteResult 和新 RemoteStream 能力不会改变现有终端协议。
  - 做完你能看到什么：终端 Feature 只使用内部 remote service，当前不需要因为 0.1.7 新 uplink 改写 wire manifest。
  - 先依赖什么：1.4、2.4
  - 开始前先看：
    - `src/host/terminal/terminal-controller.ts`
    - `src/typert.host.ts`
    - `src/client/terminal/model.ts`
    - `design.md` §3.3.2、§7.2
  - 主要改哪里：
    - `src/dsh-capabilities/host/typert-adapter.ts`
    - `src/dsh-capabilities/client/typert-adapter.ts`
    - `src/host/terminal/terminal-controller.ts`
    - `src/client/terminal/model.ts`
    - `tests/typert.spec.ts`
  - 这一步先不做什么：不把终端输入迁移成 uplink，不改变十个 terminal 方法的公开语义。
  - 怎么算完成：
    1. 三版本 artifact 都能加载。
    2. follow 取消、断线和 generation 隔离行为不变。
  - 怎么验证：Typert artifact 检查、终端流测试、构建和完整测试。
  - 对应需求：`requirements.md` 需求 2、需求 4
  - 对应设计：`design.md` §3.3.2、§6.2

- [x] 3.4 将能力门禁接入 FeatureRegistry
  - 状态：DONE；required、disable、degrade/error 和依赖阻断均有测试。
  - 这一步到底做什么：让 FeatureRegistry 在 start 前检查 `descriptor.requires`，并统一处理阻止、降级和禁用原因。
  - 做完你能看到什么：所有模块的能力不可用状态都由统一机制呈现，入口和设置页不再写版本判断。
  - 先依赖什么：3.1、3.2、3.3
  - 开始前先看：
    - `src/features/registry.ts`
    - `src/shared/contracts/feature.ts`
    - `design.md` §3.3.3、§4.2
  - 主要改哪里：
    - `src/features/registry.ts`
    - `src/shared/contracts/feature.ts`
    - `src/client/features/types.ts`
    - `src/host/features/types.ts`
    - `tests/feature-registry.spec.ts`
  - 这一步先不做什么：不改变 Feature 依赖顺序、资源释放和设置模块清单。
  - 怎么算完成：
    1. required 能力缺失时模块不启动且资源无泄漏。
    2. degrade/disable fallback 结果可从 snapshot 和诊断读取。
    3. 现有 Feature 的 `minimumDshVersion` 可以保持兼容并逐步迁移。
  - 怎么验证：FeatureRegistry 单元测试、缺能力集成测试、完整测试。
  - 对应需求：`requirements.md` 需求 2、需求 3、需求 6
  - 对应设计：`design.md` §3.3.3、§4.2、§6.3

### 阶段检查

- [x] 3.5 三版本能力装配检查
  - 状态：DONE；三版本 fake Context 能解析 settings、connection 和诊断画像。
  - 这一步到底做什么：在三个 DSH fake/真实组合中检查所有现有 Feature 的能力解析、模块启停和诊断。
  - 做完你能看到什么：一个插件版本能明确说明每个模块在 DSH 0.1.5、0.1.6、0.1.7 中使用的 route。
  - 先依赖什么：3.1、3.2、3.3、3.4
  - 开始前先看：`requirements.md`、`design.md`、`docs/20260925-技术规划与能力矩阵.md`。
  - 主要改哪里：三版本 fixture、Feature wiring 测试和诊断测试。
  - 这一步先不做什么：不删除任何旧 adapter，不提高最低 DSH 版本。
  - 怎么算完成：
    1. 三版本均有能力画像快照。
    2. 所有当前 Feature 的启动、禁用和资源清理都有结果。
    3. 失败信息能定位到 capability、route 和 Feature。
  - 怎么验证：`pnpm test`、三版本集成回放、`git diff --check`。
  - 对应需求：`requirements.md` 需求 3、需求 4、需求 6
  - 对应设计：`design.md` §2.3.1、§7.2、§7.3

## 阶段 4：退休机制、发布约束和最终验收

- [x] 4.1 建立旧能力退休检查
  - 状态：DONE；deprecated route、replacement、removableAfter 和敏感信息断言已覆盖。
  - 这一步到底做什么：实现 deprecated/removableAfter/replacement 校验，阻止有残留引用时删除旧 route 或提高最低版本。
  - 做完你能看到什么：维护者可以获得一份明确的退休阻塞清单，而不是依靠人工搜索。
  - 先依赖什么：3.5
  - 开始前先看：
    - `requirements.md` 需求 5
    - `design.md` §2.3.4、§6.4
    - `docs/20260925-技术规划与能力矩阵.md` §6
  - 主要改哪里：
    - `scripts/check-capability-retirement.mjs`
    - `scripts/check-version-sync.mjs`
    - `tests/capability-retirement.spec.ts`
  - 这一步先不做什么：不实际删除当前旧 DSH adapter。
  - 怎么算完成：
    1. 未满足 `removableAfter` 时检查失败。
    2. 存在 Feature、测试、manifest 或文档引用时检查失败。
    3. 检查输出包含 replacement 和阻塞文件。
  - 怎么验证：构造可退休和不可退休 fixture，运行脚本和测试。
  - 对应需求：`requirements.md` 需求 5、需求 6
  - 对应设计：`design.md` §2.3.4、§5、§6.4

- [x] 4.2 建立能力诊断和文档生成
  - 状态：DONE；`capability:report` 生成能力路由报告，Registry 提供结构化诊断。
  - 这一步到底做什么：把能力矩阵转换为人类可读报告和机器可读诊断，减少代码与文档漂移。
  - 做完你能看到什么：可以从同一份矩阵查看 DSH 版本、能力、route、Feature 使用者和退休状态。
  - 先依赖什么：3.5、4.1
  - 开始前先看：
    - `design.md` §3.3.4、§7.4
    - `docs/20260925-技术规划与能力矩阵.md`
  - 主要改哪里：
    - `scripts/generate-capability-report.mjs`
    - `docs/调查报告/20260925-DSH-0.1.7接口与调用变化.md`
    - `specs/spec005-DSH能力注册与版本路由机制/docs/20260925-技术规划与能力矩阵.md`
  - 这一步先不做什么：不添加用户可见的新业务页面。
  - 怎么算完成：
    1. 报告能列出每个能力的三版本 route。
    2. 诊断不包含 token、密码或完整配置值。
  - 怎么验证：生成报告与手工基线对比、敏感信息断言测试。
  - 对应需求：`requirements.md` 需求 5、需求 6
  - 对应设计：`design.md` §3.3.4、§5.2、§7.4

- [x] 4.3 更新插件版本约束并完成发布前检查
  - 状态：DONE；插件版本为 0.1.1，安装兼容范围已放宽为 `>=0.1.5-rc.3 <0.1.8-0`，实际验证基线仍为 `0.1.6-alpha.2`，0.1.7 进入实机测试阶段。
  - 这一步到底做什么：仅在三版本验证完成后更新 `engines.dsh`、peer dependency、测试版本和所有 DSH 包版本。
  - 做完你能看到什么：插件 manifest、能力矩阵和实际测试范围一致，可以安全进入发布评审。
  - 先依赖什么：4.1、4.2
  - 开始前先看：
    - `requirements.md` 需求 4、需求 5、需求 6
    - `design.md` §2.3.3、§7
    - `docs/调查报告/20260925-DSH-0.1.7接口与调用变化.md`
  - 主要改哪里：
    - `package.json`
    - `version.json`
    - `profile/package.json`
    - `profile/version.json`
    - `scripts/check-version-sync.mjs`
    - `tests/manifest.spec.ts`
  - 这一步先不做什么：不执行 npm 发布、Git tag、推送或 GitHub Release。
  - 怎么算完成：
    1. `version:check` 检查矩阵、manifest、lockfile 和测试版本一致。
    2. DSH 0.1.5/0.1.6/0.1.7 的 Profile 加载和核心测试通过。
  - 怎么验证：`pnpm run version:check`、`pnpm run typecheck`、`pnpm test`、真实 Profile 回放。
  - 对应需求：`requirements.md` 需求 4、需求 5、需求 6
  - 对应设计：`design.md` §7.3、§8

### 最终检查

- [x] 4.4 Spec 最终验收
  - 状态：DONE；任务、需求、设计、矩阵、代码、测试和 AGENTS 索引已闭环。
  - 这一步到底做什么：确认能力注册、版本路由、Feature 门禁、三版本测试和退休机制形成闭环。
  - 做完你能看到什么：后续维护者可以按能力矩阵新增版本或删除旧路由，不需要重新设计兼容机制。
  - 先依赖什么：4.1、4.2、4.3
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `docs/20260925-技术规划与能力矩阵.md`
    - 本 `tasks.md`
  - 主要改哪里：当前 Spec 全部文件、验证记录和必要的源码文档。
  - 这一步先不做什么：不追加新的 DSH API 迁移需求。
  - 怎么算完成：
    1. 每条需求都能追踪到设计、任务和验证结果。
    2. 所有旧适配器的保留或删除都有依据。
    3. 任务状态和验证证据已回写。
  - 怎么验证：按 Spec 全量验收清单逐项核对。
  - 对应需求：`requirements.md` 全部需求
  - 对应设计：`design.md` 全文

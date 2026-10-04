# 任务清单 - New-API 自定义上游订阅与用量

状态：已完成

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住
- `IN_REVIEW`：已经有结果，等复核
- `DONE`：已经完成，并且已经回写验证证据

## 阶段 1：调查与契约

- [x] 1.1 New-API 接口调查
  - 状态：DONE
  - 这一步到底做什么：确认示例站点和上游源码的 Token、billing、日志、订阅、分组接口权限与字段。
  - 做完你能看到什么：知道普通 API Key 能查什么，不能查什么。
  - 先依赖什么：无。
  - 开始前先看：`docs/调查报告/20261002-New-API用户级订阅与用量接口调查.md`。
  - 主要改哪里：调查报告和本 Spec。
  - 这一步先不做什么：不调用用户登录态或管理员接口。
  - 怎么算完成：接口路径、鉴权、字段和缺失能力均有证据。
  - 怎么验证：示例站点只读请求、上游源码路由检查。

- [x] 1.2 确定独立读取契约
  - 状态：DONE
  - 这一步到底做什么：增加 New-API 读取器选项和 ProviderBalance 映射规则。
  - 做完你能看到什么：New-API 与 Sub2API 的解析边界清晰。
  - 先依赖什么：1.1。
  - 开始前先看：`requirements.md` 需求 1、需求 2；`design.md` §2、§3。
  - 主要改哪里：`src/host/cli-adapters/provider-subscription.ts`、共享契约和测试。
  - 这一步先不做什么：不改变 Sub2API 归一化函数。
  - 怎么算完成：New-API 缺失字段为 null，成功部分 billing 不影响主结果。
  - 怎么验证：New-API 解析单元测试。

## 阶段 2：读取器与来源发现

- [x] 2.1 实现 New-API 读取器
  - 状态：DONE
  - 这一步到底做什么：实现 Token 主接口和两个 billing 补充接口。
  - 做完你能看到什么：Host 能返回真实余额、累计用量和到期时间。
  - 先依赖什么：1.2。
  - 开始前先看：`design.md` §2、§3。
  - 主要改哪里：`src/host/cli-adapters/new-api-subscription.ts` 或等价 Host 模块、`provider-subscription.ts`。
  - 这一步先不做什么：不读取登录态订阅和用户日志。
  - 怎么算完成：认证失败为空；可选接口失败不丢失主接口数据；不泄漏凭据。
  - 怎么验证：定向单元测试。

- [x] 2.2 扩展自定义来源发现
  - 状态：DONE
  - 这一步到底做什么：让所有有可读自定义 Provider 配置的适配器共用来源发现。
  - 做完你能看到什么：DSH、Codex、Claude Code、OpenCode、Grok、Command Code、ZCode 不再被固定在 Sub2API 入口。
  - 先依赖什么：2.1。
  - 开始前先看：`design.md` §4；各适配器配置读取代码。
  - 主要改哪里：`provider-subscription.ts`、适配器来源测试。
  - 这一步先不做什么：不读取官方账号的私有凭据，不新增管理员密钥配置。
  - 怎么算完成：有来源才读取，无来源安全跳过，Sub2API 仍走原读取器。
  - 怎么验证：来源解析和路由隔离测试。

### 阶段检查 2.3

- [x] 2.3 读取器隔离检查
  - 状态：DONE
  - 这一步到底做什么：确认 New-API 失败不会改变 Sub2API，Sub2API 失败不会伪造 New-API。
  - 做完你能看到什么：两条协议可以独立升级和回退。
  - 先依赖什么：2.1、2.2。
  - 开始前先看：`requirements.md`、`design.md`、测试夹具。
  - 主要改哪里：读取路由和测试。
  - 这一步先不做什么：不扩展 CLIProxyAPI。
  - 怎么算完成：隔离测试通过且原有 Sub2API 测试无语义变化。
  - 怎么验证：定向测试和 `git diff --check`。

## 阶段 3：验证与文档

- [x] 3.1 完整验证与实现记录
  - 状态：DONE
  - 证据：`pnpm run build`、`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check` 和 New-API/Sub2API 定向测试通过；最近一次完整 `pnpm test` 共 1133 项，其中 1132 项通过，剩余 1 项为当前工作区其他改动涉及的终端 UI 断言。
  - 这一步到底做什么：运行项目要求的检查并记录结果。
  - 做完你能看到什么：实现、测试、调查证据和任务状态相互对应。
  - 先依赖什么：阶段检查 2.3。
  - 开始前先看：`AGENTS.md` 验证命令和文档索引规则。
  - 主要改哪里：开发记录、Spec 任务清单、必要的 README/AGENTS 索引。
  - 这一步先不做什么：不发布、不提交、不启动开发服务器。
  - 怎么算完成：typecheck、version、capability 和测试通过，文档链接有效。
  - 怎么验证：`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、`pnpm test`；完整测试失败项未触及 New-API、Sub2API 或订阅读取代码。

### 最终检查 3.2

- [x] 3.2 最终验收
  - 状态：DONE
  - 这一步到底做什么：逐项核对需求、设计、实现和验证证据。
  - 做完你能看到什么：New-API 能力可用，Sub2API 行为保持不变。
  - 先依赖什么：3.1。
  - 开始前先看：本 Spec 全部文档。
  - 主要改哪里：本 Spec 任务状态和最终开发记录。
  - 这一步先不做什么：不追加 CPA 管理接口。
  - 怎么算完成：所有已实现任务标记 DONE，剩余限制写清楚。
  - 怎么验证：人工走查；`pnpm run build`、`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`；New-API、Sub2API、ZCode、官方订阅和适配器定向测试共 99 项通过。完整 `pnpm test` 的 1 个失败项属于当前工作区其他改动，详见 3.1 证据。

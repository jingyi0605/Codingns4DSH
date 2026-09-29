# 需求文档 - 外部 Agent 适配器扩展

状态：Draft

## 简介

插件当前已经接入 8 个外部 Agent 适配器：Command Code、Claude Code、Kimi、Gemini、Pi、Codex、OpenCode、Grok。这些适配器共用一套 Host 侧边界（`CodingNsCliDriver` + `CodingNsCliAdapterRegistry`），已经能完成安装探测、模型目录、单轮执行、会话续接、权限应答、提问、中断和释放。

上一轮调查（`docs/调查报告/20260929-Zcode与WorkBuddy外部Agent适配器可行性调查.md`）确认了两个新对象：`WorkBuddy`（腾讯 CodeBuddy 体系）与 `ZCode`（Z.ai）都可以按现有边界接入；同时发现 `codex-host` 这个同类宿主已经接入 15 个适配器，其中 11 个是本项目没有的。

当前痛点有三个：

1. **选型没有依据**。面对 codex-host 的 15 个适配器，缺少一份带证据的取舍结论，容易凭"名字熟"决定接哪个。
2. **接入方式没有统一规范**。同一个产品可能有多条接入路径（WorkBuddy 既能走 ACP 也能走 stream-json；CodeBuddy 既有 npm CLI 也有 WorkBuddy 内置副本），缺少"什么情况下选哪条"的判断标准。
3. **风险边界没有前置约定**。新增适配器涉及第三方二进制发现、配置根隔离、凭据边界和"未验证能力不得声明"的要求，这些如果等到实现阶段再补，很容易出现互相覆盖配置或虚报能力。

本 Spec 覆盖"选型 + 接入架构 + 验收标准"，为后续按适配器逐个实施提供依据。本 Spec 不直接改代码。

## 术语表

- **适配器（Adapter）**：本项目中一个可被用户选择的外部 Agent 运行时，由 `CodingNsCliDriver` 实现，在设置页和输入栏表现为一个可选项。
- **驱动（Driver）**：适配器在 Host 侧的实现类，负责探测、执行和事件归一化。
- **传输基座**：把外部协议统一成 `CodingNsAgentEvent` 的公共实现，当前有三种：`StandardStreamDriver`（子进程 stdout 逐行 JSON）、`JsonRpcProcess`（JSON-RPC/ACP over stdio）、HTTP/SSE 客户端。
- **stream-json**：外部 CLI 以 `--print` 之类参数单次执行、把每一条事件按行写成 JSON 的输出格式。
- **ACP（Agent Client Protocol）**：Zed 提出的通用智能体协议，通过 stdio 上的 JSON-RPC 做会话创建、加载、提问、权限请求和取消。
- **产品身份（Product Identity）**：同一个 CLI 二进制在不同产品下的配置根、认证端点、数据目录和历史目录集合。例如 CodeBuddy 与 WorkBuddy 共用 CLI 代码但产品身份不同。
- **配置根隔离**：让两个适配器指向各自独立的数据目录，避免历史、认证和设置互相泄漏。
- **能力声明**：适配器在 `descriptor.capabilities` 中显式列出的已实现能力。未声明即按不支持处理。
- **无模型探测**：只做安装、版本、初始化一类的检查，不提交 Prompt、不产生计费和会话副作用。
- **选型矩阵**：逐适配器列出产品身份、接入协议、接入成本、成熟度和建议结论的对照表。

## 范围说明

### In Scope

- 对 `codex-host` 已有的 15 个适配器做逐项评估，产出带证据的选型矩阵与优先级建议。
- 把上一轮调查的 `WorkBuddy`、`ZCode` 纳入同一矩阵统一排序。
- 明确新增适配器的接入架构：复用哪套传输基座、在哪一层做协议映射、能力如何声明。
- 明确产品身份与配置根隔离规则，避免 CodeBuddy / WorkBuddy / Kimi / Kimi Code 这类同源产品互相污染。
- 明确安装发现规则与平台边界，包括"只随桌面应用分发、不安装到 PATH"的 CLI。
- 明确未验证能力的处理要求：不得声明、不得虚报、必须有可解释诊断。
- 明确新增适配器对现有 8 个适配器的回归要求。
- 产出实施任务的分解与验收标准。

### Out of Scope

- 本 Spec 不写实现代码，不新增或修改任何适配器源码。
- 不替换或重写现有 8 个适配器的传输实现。
- 不引入厂商 SDK 依赖（如 Qoder SDK、CodeBuddy SDK），除非选型矩阵明确判定某适配器只能走 SDK 且给出理由。
- 不实现跨 Harness 委派、Team 编排或外部成员生命周期；这些属于 spec007 主线的范围。
- 不接管桌面应用自身的窗口、登录态或私有 owner runtime。
- 不做版本发布、提交、推送或 npm 发布。

## 需求 1：适配器选型矩阵

**用户故事：** 作为项目维护者，我希望有一份带证据的适配器取舍结论，以便决定先接哪个、暂缓哪个，而不是凭直觉排期。

### 验收标准

1. WHEN 完成选型 THEN System SHALL 为每个候选适配器给出产品身份、接入协议、启动方式、成熟度证据、接入成本和建议结论。
2. WHEN 给出建议结论 THEN System SHALL 使用统一分级（强烈推荐 / 值得 / 观望 / 不推荐），并写明理由。
3. WHEN 某个候选与已有适配器是同源产品 THEN System SHALL 明确标注，并说明是"新增适配器"还是"升级已有适配器的协议路径"。
4. WHEN 证据来自第三方项目或社区包 THEN System SHALL 标注证据等级，不得把社区逆向结论当作官方契约。
5. WHEN 无法确认某项事实 THEN System SHALL 标注为待实测项，不得用推测填补。

## 需求 2：接入方式选择规则

**用户故事：** 作为实现者，我希望有明确的判断标准来决定一个适配器走哪条传输路径，以便不在每个适配器上重复试错。

### 验收标准

1. WHEN 目标 CLI 同时支持 stream-json 与 ACP THEN System SHALL 按"是否需要可应答的权限与提问、是否需要精确回滚、是否需要会话级配置"给出选择规则。
2. WHEN 目标 CLI 的输出格式与某个已有驱动同构 THEN System SHALL 优先复用对应传输基座，而不是新写一套。
3. WHEN 目标 CLI 只有厂商 SDK 可用 THEN System SHALL 把引入 SDK 依赖列为独立决策点，说明它带来的依赖、凭据和版本耦合成本。
4. WHEN 目标 CLI 的事件协议是自有点号体系或私有格式 THEN System SHALL 明确需要新写映射器，并列出必须实测的事件形状。
5. WHEN 选择某条路径 THEN System SHALL 记录该路径明确不覆盖的能力，避免后续误认为已支持。

## 需求 3：产品身份与配置根隔离

**用户故事：** 作为用户，我希望同时安装 CodeBuddy 与 WorkBuddy 时，两边的历史、认证和设置不会互相覆盖。

### 验收标准

1. WHEN 两个适配器来自同一 CLI 代码库但属于不同产品 THEN System SHALL 为它们分别指定独立的配置根环境变量，并强制两个变量指向同一产品根。
2. WHEN 某个产品的内置 CLI 默认会回退到另一个产品的配置目录 THEN System SHALL 显式覆盖该默认值，不依赖 CLI 自身的默认行为。
3. WHEN 配置根由用户显式指定 THEN System SHALL 采用用户值；用户未指定时使用该产品的默认根。
4. WHEN 写入 Host 存储或日志 THEN System SHALL 不保存凭据、完整命令行、完整本地绝对路径或原始敏感输入。
5. WHEN 适配器需要登录 THEN System SHALL 由外部 CLI 自己完成认证，Host 不复制、不推断、不代存桌面应用的登录态。

## 需求 4：安装发现与平台边界

**用户故事：** 作为用户，我希望插件能找到我实际安装的那个 Agent，而不是错误地启动另一个同名程序。

### 验收标准

1. WHEN 目标 CLI 只随桌面应用分发、不安装到 PATH THEN System SHALL 按已知安装布局发现它，并允许用户显式指定安装目录。
2. WHEN 用户显式指定了安装路径 THEN System SHALL 使用该路径；路径无效时明确失败，不静默回退到其他安装。
3. WHEN 目标产品在某个平台没有官方分发 THEN System SHALL 在该平台不猜测安装路径，并给出可解释诊断。
4. WHEN 同一产品存在多个安装 THEN System SHALL 不混用不同安装的可执行文件与其内置资源。
5. WHEN 探测失败 THEN System SHALL 把适配器标记为未安装，并保持其他适配器和默认会话不受影响。

## 需求 5：能力声明与降级

**用户故事：** 作为用户，我希望界面上显示的能力是真实可用的，而不是"看起来支持但一用就卡住"。

### 验收标准

1. WHEN 某项能力未经过实测验证 THEN System SHALL 不在 `capabilities` 中声明该能力。
2. WHEN 某个传输路径下权限请求只能被拒绝、无法应答 THEN System SHALL 不声明 `permission`，并在选型矩阵中记录该限制。
3. WHEN 某个原生交互会让运行无限等待且没有回传通道 THEN System SHALL 在接入方案中给出禁用或规避策略，不得默认放任。
4. WHEN 能力缺失 THEN System SHALL 只影响对应适配器，不改变其他适配器和默认 DSH 会话。
5. WHEN 用户选择了一个该适配器不支持的操作 THEN System SHALL 返回结构化的不可用诊断，不静默伪造成功。

## 需求 6：会话标识与续接

**用户故事：** 作为用户，我希望切换适配器后仍能正确恢复会话，且不会把不同产品的会话混在一起。

### 验收标准

1. WHEN 适配器提供可恢复会话标识 THEN System SHALL 从事件流或初始化消息中取得该标识并绑定到 DSH 会话。
2. WHEN 会话存储不是逐会话 JSONL THEN System SHALL 明确说明探测方式，不得套用 JSONL 校验逻辑。
3. WHEN 会话探测 THEN System SHALL 只做只读检查，不通过 resume/load/prompt 探测，避免修改 Provider 状态或创建新会话。
4. WHEN 会话丢失或损坏 THEN System SHALL 标记为不可恢复并保留诊断，不自动重放请求。
5. WHEN 不同产品的历史目录规则不同 THEN System SHALL 按各自规则解析，不复用另一产品的路径编码。

## 需求 7：与现有适配器的兼容

**用户故事：** 作为现有用户，我希望新增适配器不会影响我已经在用的 Agent。

### 验收标准

1. WHEN 新增适配器 THEN System SHALL 保持现有 8 个适配器的探测、执行、恢复、权限、提问、中断和释放行为不变。
2. WHEN 新增适配器 THEN System SHALL 复用现有 `CodingNsCliDriver` 与注册表契约，不修改已有适配器的行为语义。
3. WHEN 新增适配器未安装 THEN System SHALL 只影响它自身的可选项，不阻塞启动和其他适配器。
4. WHEN 适配器 ID 与已有 ID 冲突 THEN System SHALL 在注册阶段明确报错，不静默覆盖。
5. WHEN 变更传输基座或注册表 THEN System SHALL 运行完整类型检查、版本检查、能力检查和测试。

## 非功能需求

### 性能

1. WHEN 适配器探测 THEN System SHALL 使用现有缓存与超时机制，不在启动路径上做无界等待。
2. WHEN 用户打开模型目录 THEN System SHALL 复用现有模型缓存策略，不对每个适配器重复探测。

### 可靠性

1. WHEN 外部进程异常退出 THEN System SHALL 只影响对应会话，其他适配器和成员继续可用。
2. WHEN 适配器被停用 THEN System SHALL 释放其进程、订阅和临时资源。

### 可维护性

1. WHEN 新增适配器 THEN System SHALL 只需实现驱动并登记，不修改其他适配器代码。
2. WHEN 同源产品共用实现 THEN System SHALL 通过产品身份参数复用同一驱动，避免复制粘贴出两份近乎相同的实现。
3. WHEN 排查问题 THEN System SHALL 能按适配器 ID 区分日志，且日志中不含凭据。

## 成功定义

- 选型矩阵覆盖 codex-host 的 15 个适配器加 WorkBuddy、ZCode，每项都有结论和证据来源。
- 每个"值得"及以上结论都说明接入协议、复用哪套基座、以及不覆盖的能力。
- 产品身份隔离、安装发现、能力声明、会话探测四类规则都有可执行的验收标准。
- 现有 8 个适配器的回归要求明确，且不要求改动它们的实现。
- 后续实现者只看本 Spec 就能知道先做哪个适配器、走哪条路径、怎么验证。

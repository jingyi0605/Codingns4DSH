# 任务清单 - 外部 Agent 适配器扩展（人话版）

状态：Draft

## 这份文档是干什么的

这份清单回答一件事：要把"哪些外部 Agent 值得接、怎么接"落到可执行的步骤，先做什么、后做什么、每步做完能看到什么。

本 Spec 只做选型和接入规范，**不写实现代码**。所以这里的任务大多是"产出文档和结论"，只有最后一段是"把规则写成可检查的清单"。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住，必须写清楚卡在哪里
- `IN_REVIEW`：已有结果，等复核
- `DONE`：已完成，并且已回写状态
- `CANCELLED`：取消，不做了，但要写原因

规则：只有 `状态：DONE` 才能勾选成 `[x]`；`BLOCKED` 和 `CANCELLED` 都必须写原因。

## 写法要求

每个任务都回答七个问题：做什么、做完看到什么、依赖什么、先看哪些文档、主要改哪些文件、明确不做什么、怎么验证。

---

## 阶段 1：选型取证

- [ ] 1.1 盘点候选适配器与差集
  - 状态：TODO
  - 这一步到底做什么：把 codex-host 的 15 个适配器与本项目已有的 8 个做差集，确认哪些是真正的新增对象，哪些其实是已有适配器的另一条协议路径。
  - 做完你能看到什么：一张"新增候选 / 同源产品 / 已有覆盖"的分类表，不会再出现把 Kimi Code 当成全新产品的情况。
  - 先依赖什么：无
  - 开始前先看：
    - `requirements.md` 需求 1
    - `design.md` §2.1「现有分层」
    - `docs/调查报告/20260929-Zcode与WorkBuddy外部Agent适配器可行性调查.md`
  - 主要改哪里：
    - `specs/spec007.1-外部Agent适配器扩展/docs/20260929-适配器选型矩阵.md`（新建）
  - 这一步先不做什么：不下结论，不排优先级，只做分类。
  - 怎么算完成：
    1. 分类表覆盖 codex-host 全部 15 个适配器加 WorkBuddy、ZCode。
    2. 每个同源产品都写明"是新增适配器还是升级已有适配器的协议路径"。
  - 怎么验证：
    - 与 `src/host/cli-adapters/feature.ts` 的驱动数组逐项核对。
  - 对应需求：`requirements.md` 需求 1 / 验收 1.3
  - 对应设计：`design.md` §2.1

- [ ] 1.2 逐适配器取证
  - 状态：TODO
  - 这一步到底做什么：为每个候选确认产品身份、官方文档、CLI 包名或安装方式、启动命令、接入协议和成熟度证据。
  - 做完你能看到什么：每个候选都有一组可点开的 URL 证据，而不是"听说支持"。
  - 先依赖什么：1.1
  - 开始前先看：
    - `requirements.md` 需求 1、需求 2
    - `design.md` §3.3.1「传输基座选择规则」
  - 主要改哪里：
    - `specs/spec007.1-外部Agent适配器扩展/docs/20260929-适配器选型矩阵.md`
  - 这一步先不做什么：不做本机安装实测，只做资料取证；证据来源要标等级。
  - 怎么算完成：
    1. 每个候选都有产品身份、接入协议、启动方式三项。
    2. 社区逆向来源的结论被显式标注，不与官方契约混写。
  - 怎么验证：
    - 抽查任意 3 个候选，URL 可打开且内容与结论一致。
  - 对应需求：`requirements.md` 需求 1 / 验收 1.1、1.4
  - 对应设计：`design.md` §3.1

- [ ] 1.3 记录待实测项
  - 状态：TODO
  - 这一步到底做什么：把无法从资料确认、必须真机跑一遍才能定的事实单独列出来。
  - 做完你能看到什么：一张待实测清单，后续实现者不用重复踩。
  - 先依赖什么：1.2
  - 开始前先看：
    - `requirements.md` 需求 1 / 验收 1.5
    - `design.md` §8.2「待确认项」
  - 主要改哪里：
    - `specs/spec007.1-外部Agent适配器扩展/docs/20260929-适配器选型矩阵.md`
  - 这一步先不做什么：不把推测写成结论。
  - 怎么算完成：
    1. 每条待实测项写明"要验证什么"和"怎么验证"。
  - 怎么验证：
    - 人工走查清单，确认没有无验证方式的条目。
  - 对应需求：`requirements.md` 需求 1 / 验收 1.5
  - 对应设计：`design.md` §8.2

### 阶段检查

- [ ] 1.4 选型取证门禁
  - 状态：TODO
  - 这一步到底做什么：检查证据是否足以支撑排期，不再扩范围。
  - 做完你能看到什么：可以进入排序阶段，而不是带着"资料不全"往前冲。
  - 先依赖什么：1.1、1.2、1.3
  - 开始前先看：
    - `requirements.md`
    - `design.md`
  - 主要改哪里：本阶段全部相关文件
  - 这一步先不做什么：不加新候选。
  - 怎么算完成：
    1. 候选分类、逐项取证、待实测清单三部分齐备。
    2. 已知缺口和风险已记录。
  - 怎么验证：
    - 人工走查
  - 对应需求：`requirements.md` 需求 1
  - 对应设计：`design.md` §3.1、§8.2

---

## 阶段 2：选型结论

- [ ] 2.1 给出分级结论与理由
  - 状态：TODO
  - 这一步到底做什么：为每个候选给出"强烈推荐 / 值得 / 观望 / 不推荐"的结论，并写明理由。
  - 做完你能看到什么：一份可以直接拿去排期的优先级清单。
  - 先依赖什么：1.4
  - 开始前先看：
    - `requirements.md` 需求 1 / 验收 1.2
    - `design.md` §3.3.1
  - 主要改哪里：
    - `specs/spec007.1-外部Agent适配器扩展/docs/20260929-适配器选型矩阵.md`
  - 这一步先不做什么：不承诺具体交付日期。
  - 怎么算完成：
    1. 每个候选都有分级与理由。
    2. 每个"值得"及以上都写明接入协议与复用哪套基座。
  - 怎么验证：
    - 人工走查，确认没有"只有结论没有理由"的条目。
  - 对应需求：`requirements.md` 需求 1 / 验收 1.2
  - 对应设计：`design.md` §3.1

- [ ] 2.2 标明不覆盖能力与风险
  - 状态：TODO
  - 这一步到底做什么：为每个推荐的候选写明"接了之后哪些能力仍然没有"，避免后续误以为全都能用。
  - 做完你能看到什么：每个推荐项都带一份能力缺口说明。
  - 先依赖什么：2.1
  - 开始前先看：
    - `requirements.md` 需求 2 / 验收 2.5、需求 5
    - `design.md` §3.3.2「能力声明门槛」
  - 主要改哪里：
    - `specs/spec007.1-外部Agent适配器扩展/docs/20260929-适配器选型矩阵.md`
  - 这一步先不做什么：不把未验证能力写成已支持。
  - 怎么算完成：
    1. 每个推荐项都列出不覆盖能力。
    2. 存在"权限只能拒不能问""原生交互会让运行无限等待"这类硬限制时已明确标注。
  - 怎么验证：
    - 对照 `requirements.md` 需求 5 的验收标准逐条核对。
  - 对应需求：`requirements.md` 需求 2、需求 5
  - 对应设计：`design.md` §3.3.2、§8.1

- [ ] 2.3 确定实施批次
  - 状态：TODO
  - 这一步到底做什么：把推荐项分成批次，说明为什么这样排。
  - 做完你能看到什么：一份分批次清单，第一批可以直接开工。
  - 先依赖什么：2.2
  - 开始前先看：
    - `requirements.md` 需求 2
    - `design.md` §2.3.1「新增一个适配器」
  - 主要改哪里：
    - `specs/spec007.1-外部Agent适配器扩展/docs/20260929-适配器选型矩阵.md`
  - 这一步先不做什么：不把批次写成硬性排期承诺。
  - 怎么算完成：
    1. 批次划分给出排序依据（用户重叠度、接入成本、复用程度）。
  - 怎么验证：
    - 人工走查
  - 对应需求：`requirements.md` 需求 2
  - 对应设计：`design.md` §2.3.1

### 阶段检查

- [ ] 2.4 选型结论门禁
  - 状态：TODO
  - 这一步到底做什么：确认结论可执行。
  - 做完你能看到什么：一个实现者只看结论就知道先做哪个。
  - 先依赖什么：2.1、2.2、2.3
  - 开始前先看：
    - `requirements.md`
    - `design.md`
  - 主要改哪里：本阶段全部相关文件
  - 这一步先不做什么：不加新范围。
  - 怎么算完成：
    1. 结论、理由、缺口、批次四部分齐备。
  - 怎么验证：
    - 人工走查
  - 对应需求：`requirements.md` 需求 1、需求 2
  - 对应设计：`design.md` §3.1、§3.3

---

## 阶段 3：接入规范与验收

- [ ] 3.1 固化产品身份与配置根规则
  - 状态：TODO
  - 这一步到底做什么：把同源产品的配置根隔离要求写成可执行的检查项。
  - 做完你能看到什么：实现者照着做就不会让 CodeBuddy 与 WorkBuddy 互相覆盖配置。
  - 先依赖什么：2.4
  - 开始前先看：
    - `requirements.md` 需求 3
    - `design.md` §3.2.1「产品身份描述」、§6.3
  - 主要改哪里：
    - `specs/spec007.1-外部Agent适配器扩展/docs/20260929-适配器接入规范.md`（新建）
  - 这一步先不做什么：不写实现代码。
  - 怎么算完成：
    1. 同源产品清单与其配置根差异已列明。
    2. 明确"不依赖 CLI 自身默认配置根"的要求。
  - 怎么验证：
    - 对照 `design.md` §3.2.1 字段逐项核对。
  - 对应需求：`requirements.md` 需求 3
  - 对应设计：`design.md` §3.2.1、§6.3

- [ ] 3.2 固化安装发现与平台边界规则
  - 状态：TODO
  - 这一步到底做什么：写清什么情况下按安装布局发现、什么情况下明确不支持。
  - 做完你能看到什么：实现者不会错误地启动 PATH 上的另一个同名程序。
  - 先依赖什么：3.1
  - 开始前先看：
    - `requirements.md` 需求 4
    - `design.md` §3.2.2「发现规格」、§6.1
  - 主要改哪里：
    - `specs/spec007.1-外部Agent适配器扩展/docs/20260929-适配器接入规范.md`
  - 这一步先不做什么：不为没有官方分发的平台猜路径。
  - 怎么算完成：
    1. 每个"随应用分发"的产品都写明发现位置与显式覆盖方式。
    2. 平台缺口写明不支持。
  - 怎么验证：
    - 对照 `requirements.md` 需求 4 的验收标准逐条核对。
  - 对应需求：`requirements.md` 需求 4
  - 对应设计：`design.md` §3.2.2、§6.1

- [ ] 3.3 固化能力声明与会话探测规则
  - 状态：TODO
  - 这一步到底做什么：把"没实测不声明"和"探测不许有副作用"写成检查项。
  - 做完你能看到什么：能力列表可信，探测不会意外创建会话。
  - 先依赖什么：3.2
  - 开始前先看：
    - `requirements.md` 需求 5、需求 6
    - `design.md` §3.3.2、§6.2、§6.4
  - 主要改哪里：
    - `specs/spec007.1-外部Agent适配器扩展/docs/20260929-适配器接入规范.md`
  - 这一步先不做什么：不新增能力枚举值。
  - 怎么算完成：
    1. 能力声明门槛与探测副作用约束都有可检查表述。
    2. 非 JSONL 会话存储的探测方式已明确。
  - 怎么验证：
    - 对照 `design.md` §6.2、§6.4 逐条核对。
  - 对应需求：`requirements.md` 需求 5、需求 6
  - 对应设计：`design.md` §3.3.2、§6.2、§6.4

- [ ] 3.4 固化回归要求
  - 状态：TODO
  - 这一步到底做什么：写清新增适配器不得影响现有 8 个适配器，以及必须跑哪些验证命令。
  - 做完你能看到什么：一份可以直接执行的回归清单。
  - 先依赖什么：3.3
  - 开始前先看：
    - `requirements.md` 需求 7
    - `design.md` §7「测试策略」
  - 主要改哪里：
    - `specs/spec007.1-外部Agent适配器扩展/docs/20260929-适配器接入规范.md`
  - 这一步先不做什么：不修改现有测试。
  - 怎么算完成：
    1. 回归清单包含 `pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、`pnpm test`。
    2. 明确 ID 冲突必须报错。
  - 怎么验证：
    - 对照 `requirements.md` 需求 7 的验收标准逐条核对。
  - 对应需求：`requirements.md` 需求 7
  - 对应设计：`design.md` §7

### 最终检查

- [ ] 3.5 最终检查点
  - 状态：TODO
  - 这一步到底做什么：确认这个 Spec 达到交付标准，而不是"差一点点以后再说"。
  - 做完你能看到什么：需求、设计、任务、选型矩阵、接入规范能一一对上。
  - 先依赖什么：3.1、3.2、3.3、3.4
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
    - `docs/`
  - 主要改哪里：当前 Spec 全部文件
  - 这一步先不做什么：不再追加新需求。
  - 怎么算完成：
    1. 每条需求都能追到设计与验证方式。
    2. 风险、待实测项、暂缓项已写清楚。
    3. 后续接手的人只看本 Spec 就能开工。
  - 怎么验证：
    - 按 Spec 验收清单逐项核对
    - `README.md`、`requirements.md`、`design.md`、`tasks.md` 互相引用一致
  - 对应需求：`requirements.md` 全部需求
  - 对应设计：`design.md` 全文

---

## 阶段 4：首批适配器实现（20261002）

本阶段是基于本 Spec 的后续实现记录；原有阶段 1～3 保留为选型和接入规范的追踪清单。

- [x] 4.1 CodeBuddy 与 WorkBuddy
  - 状态：DONE
  - 结果：共用 ACP 驱动，隔离产品配置根和安装发现；WorkBuddy 只扫描桌面应用内置 CLI。
- [x] 4.2 Cursor CLI 与 Kiro CLI
  - 状态：DONE
  - 结果：共用最小 ACP 基座，固定各自启动参数；未验证的 Usage、Fork、压缩和权限交互不声明。
- [x] 4.3 Qoder 与 Qoder CN
  - 状态：DONE
  - 结果：共用官方 ACP 驱动，隔离 token 与用户配置环境，支持权限请求应答；模型刷新不创建 ACP 会话。
- [x] 4.4 Antigravity
  - 状态：DONE
  - 初版结果：复用 stream-json 事件归一化并增加 stdin NDJSON 输入；调用 `agy models` 动态加载模型并合并思考档位。无头模式无法回传交互式审批。
  - 2026-11-18 上下文显示修复：原生 Gemini 4 Argon 的窗口为 1,048,576 token。上下文仪表使用最后一次模型调用的输入与缓存读取量，整轮用量继续累计各次调用。
  - 修复验证：通过源码加载器运行 AGY、原生会话桥接、会话计量和 ZCode 上下文测试，149 项通过、3 项跳过。回放中整轮用量超出窗口，仪表按最后一次调用显示 12%。类型、版本和能力检查通过。扩大到适配器测试时发现的 22 个失败均在基线 `a6ca6a1e` 复现。
  - Stage0 实机验证：Windows 上使用 DSH `0.2.2-rc.4` 和 AGY `1.5.11`。在验收工作区选择原生 `gemini-4-argon` 的低思考档位，发起一次要求读取两个测试文件的对话。两次读取均落盘，回合正常结束。Host 查得最新上下文占用为 9,905 / 1,048,576 token。Chrome 打开验收会话后显示上下文已用 1%，整轮用量标签显示 29.4K token。
  - 2026-11-19 修复 PR #91 引入的上下文入口回归。原生 Gemini 4 Neon 按 AGY `1.5.11` 和 `1.5.12` 状态行实测的 1,048,576 token 显示。Antigravity 公开文档的 512K 与这两个版本的实测值不同。已有最近一次调用样本的 Neon 会话打开后即可显示原生仪表。容量未知的模型仍有备用入口，只有整轮用量的会话显示暂无样本。Magpie 确认的实际容量仍优先使用。
  - 本次源码定向测试 77 项通过、3 项跳过。外部 Agent 扩展回归 868 项通过、11 项跳过，两项失败在 `main` 的 `07341bcd` 复现。类型、版本、能力和国际化检查通过。
  - Windows 独立 Stage0 使用 DSH `0.2.2-rc.5` 和 AGY `1.5.12`。Host、Web Client 和 H5 构建通过。Chrome 验证旧 Neon、新 Neon 和 Argon 都只显示一个原生上下文仪表，可用 Esc 关闭。占用分别为 10,054、10,001 和 10,432 / 1,048,576 token，均显示 1%。本机启动器、验收快捷方式和截图保存在 `~/.dsh-stage0-agy-neon-panel/`，服务监听 `127.0.0.1:17892`。
  - Antigravity 上下文弹窗增加自动压缩阈值。Host 根据会话绑定只读 AGY 最近一次调用记录的 `max_context_tokens`，缺少记录时显示暂无阈值。Windows Stage0 的三个既有 Neon 和 Argon 会话均在 Chrome 的原生弹窗显示 512,000 tokens。类型和国际化检查通过，源码定向测试 89 项通过、3 项跳过。
  - Antigravity 上下文弹窗显示两条进度条。上条按模型容量计算，下方黄色进度条按自动压缩阈值计算，达到或超过阈值时显示 100%。Chrome 在 Windows Stage0 验证了两个 Neon 会话和一个 Argon 会话，约 10K tokens 分别达到模型容量（1,048,576）的 1% 和自动压缩阈值（512,000）的 2%。本次类型检查通过，源码定向测试 18 项通过、3 项跳过。
  - 双进度条按参考图排版，左侧显示名称和百分比，右侧显示紧凑的「用量 / 上限」，悬停可查看精确数字。上下文占用为蓝色，自动压缩为黄色。Client 构建、类型和国际化检查通过，定向测试 18 项通过、3 项跳过。Chrome 在 Windows Stage0 验证了两个 Neon 会话和一个 Argon 会话的对齐、两条进度条和 Esc 关闭，弹窗截图保存在 `~/.dsh-stage0-agy-neon-panel/`。
  - 弹窗从 AGY 最新一次生成记录的 `token_breakdown` 读取系统提示词、工具定义（含 MCP 工具）和对话消息的估算。缺少构成数据时显示提示。两条进度条继续使用最近一次模型调用的输入用量。Windows Stage0 的两个 Neon 会话和一个 Argon 会话均显示三项明细，系统提示词约 3.7K，工具定义约 7K，对话消息约 1.8–2.2K token。Host 编译、Web Client 构建、类型、国际化、版本和能力检查均通过。定向源码测试 46 项通过，3 项跳过。
  - 2026-11-20 修复 DSH Desktop `0.2.2-rc.5` 中 AGY 原生弹窗缺少自动压缩进度和用量明细的问题。Desktop 和 Stage0 的样式类名不同，插件现按当前输入区的 `--dsh-context-` 锚点匹配弹窗。回归测试覆盖两个构建的类名、其他输入区的弹窗和模型选择弹窗。定向源码测试 90 项通过、3 项跳过，类型、国际化、版本和能力检查通过。
  - Desktop 首次重启后，用户确认弹窗出现，但阈值和明细显示暂无数据。同一会话的 AGY 数据库可读出 512,000 tokens 和三类明细。详情请求改用共享 RPC 客户端，并登记 Desktop 的精确 Fetch 路由。原生通道、Fetch 回退、路由登记和数据读取的定向测试共 35 项通过、3 项跳过。合并版 Host 和 Client 已构建并更新到本机 Desktop，用户确认修复通过实机验收。
  - Windows 路径回归（2026-11-18，PR #81 作者报告）：用 `tests/cli-adapters-antigravity-argv.spec.ts` 记录子进程收到的参数。文本回合、模型探测和图片 ACP 回合分别通过原生 `.exe`、`.cmd`、`.bat` 启动，九组均保留了带空格路径的参数边界。本次合并仅 macOS 验证、Windows 路径未验证。
  - 2026-11-19 原生审批修复，状态为 `DONE`。依赖支持 `agy acp` 的 CLI，按需求 2、5、6 和设计 §3.3 复用 `antigravity-driver.ts` 与 `acp-cli-driver.ts`。DSH 的人工审批、规划、自动接受编辑和自动审查均走 ACP，并将需确认的工具交给 DSH 原生审批。默认仍是规划，完全访问的文本回合保留 stream-json。审批只回传本次允许或拒绝，取消会结束请求并释放子进程。结构化提问和发布不在本次范围。
  - 源码验收覆盖审批菜单、真实 Registry 和消息投影、审批选项映射、取消、会话续接和缓存用量。AGY 及相关 ACP、原生审批测试共 215 项通过。类型、版本、能力和国际化检查通过。Windows 使用 agy `1.5.12` 在临时工作区通过真实进程执行 `Write-Output` 验收。批准得到输出，续接同一会话后拒绝未得到输出，取消以 `cancel` 结束。
  - Stage0 验收通过。在 Windows 用独立目录 `~/.dsh-stage0-agy-approval/` 构建 Host、Web Client 和 H5，使用 DSH `0.2.2-rc.5` 和 agy `1.5.12`，监听 `127.0.0.1:17893`。Chrome 中从「规划」切换到「人工审批」。三次 `Set-Content` 都显示正确命令。「允许一次」写入预期内容，点击「拒绝」和调用 DSH `session/cancel` 均关闭审批卡且未创建文件。复跑入口为 `node ~/.dsh-stage0-agy-approval/acceptance.mjs`。同一目录保留 `acceptance.json`、三张审批截图和本机登录快捷方式 `Stage0-验收.url`，新浏览器登录验证返回 HTTP 200。
  - Desktop 复测发现，DSH 会话审批策略为 `never` 时，请求已抵达原生审批服务，但会被自动拒绝。agy 的模式菜单此前替换了 DSH 权限菜单，工具结果也没有说明拒绝原因。现在两套菜单都可用。Host 使用原生审批服务的生效策略识别自动拒绝，在回传本次拒绝后提示用户从 DSH 菜单选用允许审批的权限模式。
  - 2026-11-19 改为单个 agy 模式菜单。本机 agy 1.5.12 的 ACP 会话报告 `default`、`accept-edits`、`plan`。用户从完全权限选择其中一个模式时同步使用 DSH 可询问的工作区预设。菜单和审批等 84 项源码测试通过，Desktop 重启后的界面待验。
  - 2026-11-20 修复 ACP 工具结果与表单提问。按会话及调用 ID 读取 agy SQLite，验证记录的 23 次调用可匹配到 22 条输出和 1 条错误。独立 agy 会话验证 `manage_task` 返回正文，`ask_question` 收到 `Blue` 后继续。Desktop 界面待重启复测。
  - Desktop 已复测工具结果和提问，通过。新增「完全访问」并让普通新会话继承最近一次选择，旧会话保存模型时保留用户当前偏好。实测 agy ACP 完全访问执行 `Write-Output` 成功，收到结果，审批请求数为零。相关源码测试 145 项通过、1 项跳过。新增模式的 Desktop 界面待重启复测。
  - 补充验证共 124 项定向源码测试通过，覆盖原生审批策略、拒绝后的回合结束与清理、两套权限菜单独立保存及其他适配器的审批回归。类型、版本、能力与国际化检查通过。
- [x] 4.5 登记、图标、回归测试与文档
  - 状态：DONE
  - 结果：七个 adapter ID 已登记，新增 SVG 图标、驱动测试、README 能力表和开发记录。
  - 验证：`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、`node --test --test-concurrency=1 tests/*.spec.ts`（1073 项通过）。
- [x] 4.6 AGY 模型探测异步化与后台预热
  - 状态：DONE
  - 结果：`agy models` 改用异步子进程；Host 启动后按驱动声明后台预热模型目录；静态回退目录按短周期重试，避免错误缓存真实模型列表。
  - 验证：Antigravity 驱动真实模型目录回放返回 8 个模型；`pnpm test`（1079 项通过）。
- [x] 4.7 WorkBuddy 默认直接启动内置 ACP CLI（2026-11-05）
  - 结果：每轮启动同安装 Electron 与内置 CLI，通过 stdio ACP 创建或恢复原生会话；不再默认依赖桌面 sidecar 或桌面首条消息。旧 sidecar 仅保留为显式兼容选项。
  - 认证：使用 WorkBuddy 原有登录态；字段加密初始化在原生子进程内完成，Host 不接收密钥或登录令牌。配置根保持 `.workbuddy`，不继承独立 CodeBuddy 的 `CODEBUDDY_CONFIG_DIR`。
  - 版本差异：本机 WorkBuddy 5.9.3.0 / CLI 2.165.0 同时携带多套 bundle；full/headless 的 `required` / `mode` 与 lite 的 `fields` / `policy` 认证协议不同。存在 `codebuddy-lite-wb.mjs` 时优先使用它，并完成原生 `session.ready` 握手；仅监听本机随机端口，使用随机网关密码。
  - 实机验证：Windows 上使用真实驱动与已登录的内置 CLI，桌面未运行；首轮记住随机标记，第二轮以新进程 `session/load` 后正确复述，两轮均正常结束且未调用工具。
  - Stage0 验证：复用独立 Home `~/.dsh-stage0-020` 下已运行的 DSH `0.2.1-rc.5`（`127.0.0.1:17891`），源码 junction 指向本仓库，已有编译监听生成并热加载本分支产物；未重启现有服务。通过真实认证 HTTP RPC 完成首轮、恢复续聊、原生 `Read` 读取独立测试文件三轮，均为 `completed`、无错误，并保持同一 WorkBuddy 会话标识；客户端插件资源 HTTP 200。
  - Stage0 证据：验收会话 `session-eee11d7c-0906-4926-8349-18eb44d2f916`，标题“WorkBuddy 直连验收：首轮、续聊、工具读取”；本机报告 `~/.config/codingns4dsh/stage0-020/workbuddy-stage0-verification-1793850263774.json`，仅包含验收摘要，不含登录令牌。登录快捷入口只保存在本机；普通根地址在无 cookie 时返回 401，原生登录重定向为 303，登录后首页为 200。
  - 源码验证：直连、凭据初始化、Windows 发现、ACP 提问与命令发现的定向测试 41/41 通过；另覆盖取消、并发、权限拒绝、结构化问题及含中文、空格、`&` 路径的真实子进程启动。类型、版本、能力检查通过；i18n 检查 0 阻断、125 条原有告警。
  - 回归对照：相同 Windows 环境下，适配器范围回归当前分支 590 通过、39 失败、7 跳过；`main`（`9337ce55`）579 通过、40 失败、7 跳过。当前 39 项失败均在基线复现；额外修正了原有 WorkBuddy 测试写死 `/tmp` 的路径问题，未扩大修复其他适配器。
  - 命令：`node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`、`node scripts/check-version-sync.mjs`、`node scripts/check-capability-retirement.mjs`、`node scripts/check-client-i18n.mjs`，以及 `node --import ./tests/register-source-loader.mjs --test` 指定相关测试。未运行完整 `pnpm build` 或发布；Stage0 使用已有编译监听产物。
  - 尚未验证：浏览器实际点击、macOS 实机以及其他 WorkBuddy 版本。Stage0 日志中已有独立凭据模块的 `CREDENTIAL_BROKER_UNAVAILABLE` 告警，本次未使用该凭据库的 WorkBuddy 三轮验收未受影响；未扩大修改该模块。

## 5. Codex 完全访问并保留危险操作确认（2026-11-21）

- [x] 5.1 新增 `full-access-confirm` 模式
  - 状态：DONE（源码、隔离浏览器夹具及 Windows 真实 Stage0/Codex 审批与重启恢复验收完成）
  - 做什么与可见结果：Codex 权限菜单新增「完全访问，危险操作需确认」。勾选风险确认后保存，下一轮使用 `danger-full-access`、`on-request` 和 `user`；普通文件访问没有沙箱限制，被 Codex 要求审批的命令交给 DSH 人工确认。
  - 依赖与先读：已有原生审批菜单、Registry 权限快照、Codex app-server 和 DSH 原生审批服务。先读本 Spec 需求 5–7、设计 §3.3、§4.2、§7，以及 [权限说明](../../docs/agent-native-permissions.md) 和外部 Agent、设置、国际化开发规则。原 Spec 的选型草案未描述此已实施的菜单，本条是用户明确要求的现有实现扩展。
  - 改哪里：`src/shared/native-approval-modes.ts`、`contracts/cli-adapter.ts`、Host 设置 schema、Client selector/slot/词典、`registry.ts`、`native-session-bridge.ts`、`dsh-capabilities/host/workspace-approval-adapter.ts`、能力矩阵及相关测试。
  - 设计决定：只给 Codex 开放；复用 DSH 风险确认组件，取消和失败保留旧值。回合快照选了新模式时，发出审批请求才临时切到 `ask`，DSH 受理后立即恢复原有显式 `never`，不等待答复。原本是 `ask` 就不写入；仅继承部署默认 `never` 且不能清除覆盖时，启动前报错。切换模式或切回 DSH 原生不改变原有预设；`custom` 只是 DSH 计算出的显示值。旧模式继续保留原含义，子会话不继承普通会话偏好。
  - 范围边界：不升级项目依赖、不改变插件默认权限、不替换 Codex 的危险命令判断、不修改正式 Desktop、不发布。首轮未构建应用；随后用户明确授权 Stage0，已在独立源码副本构建，不写主工作区 `data/build/dist/`。验收通过后用户追加授权清理全部 Stage0、中文提交并向上游发起 PR。
  - 验证方式：源码覆盖启动/thread/turn 权限、命令批准/拒绝/取消、旧 `never`、服务不可用、持久化与偏好隔离、下一轮生效和 UI 确认/失败恢复；真实 Chrome 加载安装包提取的 PermissionSelect 验证 320/360/390/430/768/1280 宽度。运行类型、国际化、版本、能力、diff 检查及适配器源码回归。
  - 验证证据：权限和菜单源码 39 项通过；另生命周期/原生桥接/UI 61 项通过；能力、模块和 ZCode 回归 59 项通过；最终菜单/持久化/下一轮/能力适配器复查 43 项通过。Chrome 临时夹具 1 项通过，覆盖新模式勾选、取消、保存及原模式回归；截图和摘要原保存在本机临时目录，验收通过后按用户要求清理。类型、版本、能力和 `git diff --check` 通过，国际化 0 阻断、124 条原有告警。
  - 广范围回归：`node --import ./tests/register-source-loader.mjs --test --test-concurrency=1` 后传入 `tests/cli-adapters*.spec.ts`、`tests/cli-catalog-cache.spec.ts`、`tests/external-agent-pr.spec.ts`，共 59 个套件、881 项：867 通过、4 失败、10 跳过。四项均在 `main`（`cc02a733`）原始源码的同环境内存覆盖复跑中复现（对应三个套件 103 通过、4 失败、1 跳过），没有切换或覆盖工作区。两项 `cli-adapters-codex-desktop.spec.ts` 写死探测命令列表，未包含 Windows PowerShell/where；一项 `cli-adapters-command-code-acp.spec.ts` 受当前 Magpie session 环境影响；一项 `cli-adapters-rpc.spec.ts` 未预期本机 Magpie 参数。未扩大修复这些基线问题。
  - 定向复跑：`node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/cli-adapters-codex-permissions.spec.ts tests/native-approval-next-turn.spec.ts tests/native-approval-modes.spec.ts tests/native-approval-ui.spec.ts tests/workspace-mcp-capabilities.spec.ts`。浏览器按 [权限说明](../../docs/agent-native-permissions.md) 设置安装包提取组件和 Chrome 路径，再运行 `tests/native-approval-mobile-browser.spec.ts`；本次输出在 `%TEMP%`，不覆盖应用产物。
  - 复跑注意：本机 pnpm 11 的默认依赖预检会尝试重装并因无 TTY 中止；使用 `pnpm --config.verify-deps-before-run=false run <check>` 执行现有依赖，不改依赖或锁文件。浏览器夹具原有 Antigravity「规划」断言与当前「默认」实现不符，本次修正该断言；提取器兼容 `exports.apply` 的空格差异。
  - Stage0 追加验收：Windows 隔离环境 DSH `0.2.2-rc.5`、真实 Codex `0.169.1`、真实 Chrome 通过。批准删除专用测试文件，拒绝与取消保留文件；同一 Provider 会话续聊与两次重启恢复通过。真实界面保存会话模式与偏好后核对 Profile 持久化；原生审批审计依次为 `allowed-once`、`rejected`、`cancelled`、`allowed-once`。用户确认通过后已关闭并清理隔离环境，`17896` 已释放，旧验收入口失效；正式 `17890` 服务保持原进程。过程、配置覆盖层持久化问题修正及清理结果见 [Stage0 验收记录](docs/20261121-Codex完全访问危险操作确认Stage0验收.md)。
  - 恢复策略回归：`tests/cli-adapters-codex-permissions.spec.ts` 在同一会话覆盖 `never → 新模式 → DSH 原生` 和 `never → 新模式 → 原完全访问`，验证回切后仍为原预设；`tests/workspace-mcp-capabilities.spec.ts` 验证审批待答、请求报错和继承部署默认时均不留下临时覆盖。
  - 待验：恢复策略补丁没有重跑 Windows Stage0；正式 Desktop 安装后的交互、物理手机和其他操作系统也未验证。先前浏览器夹具没有模型请求；初版 Stage0 使用真实 Codex 模型与原生审批。

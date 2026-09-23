# 需求文档 - 工作区调试面板与外部仓库运行编排

状态：Draft，等待方案评审。

## 简介

当前插件没有统一的工作区调试入口。用户可以编辑文件和使用终端，但常用启动命令、运行实例、端口、日志和访问地址没有稳定关系，多开工作区或 Git worktree 后还会频繁发生默认端口冲突。

本 Spec 要建立一条完整主链路：用户在 DSH 右侧栏登记真实启动项，Host 分析框架并生成启动计划，为各服务分配端口，在 Host 上启动并管理进程，验证真实监听地址，最后通过受限反向代理提供浏览器可访问入口。

## 术语表

- **System**：`dsh-codingns` 插件的 Host half 与 Client half
- **Host**：运行插件 Host half 的本机 DSH Node.js/Cordis 进程及其辅助进程
- **Client**：运行在 DSH Web 页面中的浏览器插件代码
- **Workspace（工作区）**：DSH 中持久化的项目目录和 Session 归属边界
- **LaunchProfile（启动项）**：用户确认并持久化的启动配置，是“实际启动什么”的唯一配置来源
- **ProcessInstance（进程实例）**：Host 某次实际创建并登记的进程记录
- **ProcessCandidate（进程候选）**：Host 根据端口临时查到并等待用户确认的进程快照；它有短期有效期，不等于插件已拥有该进程
- **Process Ownership（进程归属）**：进程与插件的关系，分为调试面板创建、AI Agent 终端可归属、仅端口发现三类
- **DebugTarget（调试目标）**：一个 Workspace 或 worktree 对应的调试对象
- **DebugService（调试服务）**：调试目标中的前端、后端、Worker、Mock 或自定义服务
- **调试运行编排**：在真正启动前，把多个已登记服务的执行顺序、端口、环境变量、服务地址和代理入口算清楚；它不是容器调度平台
- **PortLease（端口租约）**：Host 为某次运行的某个服务保留的端口记录
- **RuntimeBinding（运行时绑定）**：进程实例、服务、租约端口、实际监听端口和代理入口的关系
- **OverrideArtifact（覆盖产物）**：写在插件受控目录、用于改变开发启动行为的临时配置或脚本
- **AI Fallback（AI 兜底）**：前三种非侵入适配失败后，由用户确认的受限补丁生成、应用和回滚流程
- **Reverse Proxy（反向代理）**：Host 把受控路径下的 HTTP、SSE 或 WebSocket 请求转发到已登记的本机调试服务

## 范围说明

### In Scope

- DSH 右侧栏调试页面和开始页入口
- Workspace 级启动项、分析结果、端口池、运行记录和代理配置
- Host 进程启动、停止、重启、日志和状态恢复
- 框架分析、兼容矩阵和启动适配器
- 主工作区到 Git worktree 工作区的启动项继承
- 端口租约、监听探测和异常回收
- 前后端发现、HMR、WebSocket 和 callback 处理
- AI 补丁生成、预览、确认、应用、回滚和未处理补丁提示
- HTTP、SSE、WebSocket 反向代理
- macOS、Linux、Windows 支持

### Out of Scope

- 容器和虚拟网络
- 跨机器调度同一个进程
- 生产环境发布和流量管理
- 自动修复与启动无关的项目构建错误
- 任意公网或局域网 URL 代理
- 未经用户明确确认和执行前身份复核的外部进程结束

## 需求

### 需求 1：调试面板必须是正式的 DSH 右侧栏页面

**用户故事：** 作为开发者，我希望从 DSH 右侧栏直接打开工作区调试面板，以便在当前开发上下文内反复使用。

#### 验收标准

1. WHEN 插件 Client half 启动 THEN System SHALL 注册唯一的 `debug` 页面类型和“调试面板”开始页入口，不覆盖 DSH 内置页面。
2. WHEN 用户切换到属于同一 Workspace 的不同 Session THEN System SHALL 展示同一份工作区启动项和调试状态。
3. WHEN 当前 Session 不属于任何 Workspace THEN System SHALL 显示明确空态，不创建 Session 私有启动数据。
4. WHEN 页面被分栏、浮动、全屏、折叠或恢复 THEN System SHALL 使用 DSH 原生侧栏行为，不自行复制布局状态。

### 需求 2：启动项和运行实例必须分开建模

**用户故事：** 作为维护者，我希望“保存的启动配置”和“某次实际运行”是两个对象，以便历史记录、重启和失败状态不会反过来污染配置。

#### 验收标准

1. WHEN 用户创建启动项 THEN System SHALL 持久化名称、相对目录、命令、参数、环境变量、Shell、服务角色、端口提示和代理设置。
2. WHEN Host 启动服务 THEN System SHALL 新建独立 `ProcessInstance`，记录实际命令、环境摘要、进程身份、日志引用、退出码和状态。
3. WHEN 用户修改或删除启动项 THEN System SHALL 不改写已有运行历史。
4. WHEN 浏览器断开、侧栏关闭或 Client 插件重载 THEN System SHALL 不把仍在运行的进程误判为已停止。

### 需求 3：所有执行和停止动作必须由 Host 完成

**用户故事：** 作为用户，我希望浏览器只发出意图，由拥有本机权限和真实状态的 Host 执行，以免页面刷新或伪造状态导致失控。

#### 验收标准

1. WHEN 用户启动、停止或重启服务 THEN Client SHALL 只发送 Workspace、启动项或运行实例标识，Host SHALL 完成权限、归属和状态校验后执行。
2. WHEN Host 创建进程 THEN System SHALL 保存足以防止 PID 复用误判的进程身份，并把该身份与 `ProcessInstance` 绑定。
3. WHEN 用户停止运行实例 THEN Host SHALL 只结束该实例登记的进程树或受控运行时，不根据端口查询结果决定停止目标。
4. WHEN 监听进程能通过 `terminalId`、命令执行记录和进程树证明来自当前 Workspace 的 AI Agent 私有终端 THEN System SHALL 标记为 `agent_terminal`，并允许用户停止该次命令的进程子树，不结束 Agent 或终端 Shell。
5. WHEN 端口被无法归属的进程占用且用户主动要求处理 THEN Host SHALL 返回带短期有效期的 `ProcessCandidate`，展示 PID、启动时间、命令、目录、父进程链和 Workspace 关系，取得用户明确确认后才允许结束。
6. WHEN Host 真正执行外部进程结束 THEN System SHALL 重新检查端口、PID、进程启动身份和保护进程名单；任一信息变化都必须拒绝执行并要求重新检查。

### 需求 4：进程生命周期、日志和恢复必须完整

**用户故事：** 作为调试者，我希望能启动、停止、重启、看日志和查看失败原因，以便不必回到系统终端排查。

#### 验收标准

1. WHEN Host 启动进程 THEN System SHALL 采集 stdout、stderr、启动时间、退出时间和退出码，并支持游标增量读取。
2. WHEN 用户停止或重启 THEN System SHALL 先请求优雅退出，超时后再结束受控进程树，并返回实际结果。
3. WHEN Host 重启 THEN System SHALL 对持久化的活动实例进行身份核验，恢复仍存在的实例或把已经消失的实例收敛到明确终态。
4. WHEN 插件停用 THEN System SHALL 停止新请求、释放订阅和定时器；是否结束正在运行的项目进程必须遵守用户选择和已记录策略。

### 需求 5：框架分析与启动执行必须使用不同的数据线

**用户故事：** 作为用户，我希望看到仓库分析结论，但实际执行仍以我登记的启动项为准，避免系统凭文件猜错命令。

#### 验收标准

1. WHEN 用户分析 Workspace THEN System SHALL 输出候选框架、置信度、兼容等级、证据文件、服务角色建议和额外处理要求。
2. WHEN 页面决定实际启动哪些服务 THEN System SHALL 只使用已登记 `LaunchProfile`，不得根据分析结果自行生成并立即执行未知命令。
3. WHEN 兼容等级为 `supported` 或 `conditional` THEN System SHALL 才允许自动生成端口注入计划。
4. WHEN 兼容等级为 `unsupported` 或 `unknown` THEN System SHALL 默认停止自动注入，并说明人工配置或 AI 兜底的可选条件。

### 需求 6：worktree 必须继承启动项并重新编排运行数据

**用户故事：** 作为并行开发用户，我希望新 worktree 自动继承主工作区的服务配置，但使用自己的目录、端口、运行记录和代理入口。

#### 验收标准

1. WHEN Host 确认两个 Workspace 属于同一 Git 仓库的主工作区和 worktree THEN System SHALL 允许用户预览并确认启动项继承。
2. WHEN 启动项被复制到子 Workspace THEN System SHALL 保留相对目录、命令、服务角色和适配设置，不复制活动运行实例、端口租约和日志。
3. WHEN 子 Workspace 生成启动计划 THEN System SHALL 为每个服务申请新的端口，并重新计算服务发现、HMR 和代理入口。
4. WHEN 无法可靠确认 worktree 血缘或相对目录不存在 THEN System SHALL 停止自动继承并给出可读原因。

### 需求 7：启动适配必须按固定顺序执行

**用户故事：** 作为用户，我希望系统优先选择不修改仓库的方式改变端口，避免调试功能把工作区弄脏。

#### 验收标准

1. WHEN 生成启动计划 THEN System SHALL 按 `CLI 参数 -> 环境变量 -> 临时覆盖产物 -> AI 兜底` 的顺序选择方案。
2. WHEN 某一非侵入方式已经可用 THEN System SHALL 不进入后续更高破坏性的方式。
3. WHEN 框架要求处理服务发现、HMR、WebSocket 或 callback THEN System SHALL 在启动计划中列出并验证对应处理，缺失时不得标记为可自动运行。
4. WHEN 启动完成 THEN System SHALL 比较租约端口与真实监听端口，并把不一致作为明确失败或待确认状态。

### 需求 8：端口必须通过租约分配并可靠回收

**用户故事：** 作为多工作区用户，我希望平台不会让多个服务抢同一个端口，也不会在异常退出后永久占住端口记录。

#### 验收标准

1. WHEN 服务准备启动 THEN System SHALL 按 Workspace、运行实例和服务角色创建唯一端口租约。
2. WHEN 候选端口已被受管实例或外部进程占用 THEN System SHALL 跳过该端口并尝试池内下一个端口，耗尽时返回明确错误。
3. WHEN 进程退出、启动失败或用户取消 THEN System SHALL 释放对应租约和代理绑定。
4. WHEN Host 冷启动或定时巡检发现失去进程身份的活动租约 THEN System SHALL 先标记为 `STALE`，完成核验后再释放。

### 需求 9：AI 兜底必须真实可用且可回滚

**用户故事：** 作为用户，我允许 AI 在有限范围内帮我改开发配置，但必须先看差异、主动确认，并能安全撤回。

#### 验收标准

1. WHEN CLI、环境变量和覆盖产物均不可用且兼容矩阵允许 AI THEN System SHALL 收敛候选文件、记录原因并生成补丁，不得直接写文件。
2. WHEN AI 返回补丁 THEN System SHALL 校验文件白名单、Workspace 边界、补丁大小、原文件哈希和禁止文件清单。
3. WHEN 用户确认应用 THEN Host SHALL 原子应用补丁并保存逆向补丁；文件内容已经变化时必须拒绝覆盖。
4. WHEN 用户回滚 THEN Host SHALL 只撤销该记录拥有的改动，不使用 `git reset`、`git checkout` 或覆盖用户后续修改。
5. WHEN 存在 `PENDING` 或 `APPLIED` 的 AI 记录 THEN 调试面板 SHALL 持续提示，直到拒绝、回滚或用户确认保留。

### 需求 10：反向代理必须覆盖真实开发服务需要的协议

**用户故事：** 作为远程开发用户，我希望从 DSH 页面打开前端或 API 服务，并让页面资源、SSE 和 HMR WebSocket 正常工作。

#### 验收标准

1. WHEN 启动项启用代理且 `RuntimeBinding` 已验证监听 THEN Host SHALL 创建唯一代理路由，并只转发到该绑定的回环地址和实际端口。
2. WHEN 请求经过代理 THEN System SHALL 支持常用 HTTP 方法、流式响应、SSE、WebSocket Upgrade、重定向、查询参数和请求体透传。
3. WHEN 上游返回路径、Cookie 或重定向信息 THEN System SHALL 按代理前缀规则做受控改写，并明确不支持的响应类型。
4. WHEN 运行实例停止、绑定变化或租约释放 THEN System SHALL 立即停用旧代理路由，不把路径转发给后来占用同一端口的进程。
5. WHEN 用户尝试指定任意 Host、URL 或未登记端口 THEN System SHALL 拒绝创建代理。

### 需求 11：Workspace、generation 和凭据边界不得被破坏

**用户故事：** 作为远程用户，我希望不同工作区和连接代际的数据不会串线，也不会因为调试面板泄露凭据。

#### 验收标准

1. WHEN RPC 访问某 Workspace 数据 THEN Host SHALL 验证当前 Session 与 Workspace 归属，不接受 Client 单方面声明的绝对路径。
2. WHEN generation 切换 THEN System SHALL 丢弃旧 generation 的异步结果和订阅，不能回写新页面状态。
3. WHEN 保存环境变量、日志或 AI 上下文 THEN System SHALL 对已知凭据字段做脱敏，不把 refresh token、Host token 或完整秘密写入持久化记录。
4. WHEN 解析相对工作目录或候选文件 THEN Host SHALL 防止 `..`、绝对路径和符号链接逃出 Workspace。

## 非功能需求

### 非功能需求 1：跨平台

1. macOS、Linux、Windows 必须分别验证进程树停止、端口探测、日志和代理。
2. 平台特有辅助进程必须隐藏在统一接口后，不能把 PowerShell、`lsof` 或 `ss` 命令写进业务层。

### 非功能需求 2：性能和限额

1. 正常负载下，启动项列表和已有运行状态应在 1 秒内返回首个快照。
2. 日志必须增量读取并设置文件、单次响应和保留周期上限。
3. 框架分析必须限制文件数量、单文件大小和总读取字节数。
4. 代理必须限制并发连接、请求体、缓冲改写响应和空闲时间。

### 非功能需求 3：可靠性

1. 配置写入必须先持久化成功再更新内存和页面。
2. 启动计划创建、租约分配和运行失败必须有补偿逻辑，不留下半套活动状态。
3. 停止、释放、关闭代理和回滚必须幂等。

### 非功能需求 4：可维护性

1. 新框架通过“识别器 + 注入器 + 验证器”注册，不修改全部启动主链路。
2. Client 页面只消费共享 DTO，不复制 Host 的状态推导规则。
3. 父仓库源码不得成为插件依赖，移植行为必须有插件自己的测试证据。

## 成功定义

- 用户能在右侧栏完成启动项管理、方案预览、启动、停止、重启、日志查看和访问服务
- 同一 Workspace 的数据可恢复，不同 Workspace 不串线
- 多个 worktree 能继承配置并使用各自端口并行运行
- AI 只在允许范围内生成经用户确认的可回滚补丁
- HTTP、SSE 和 HMR WebSocket 能通过受控代理访问
- 未知端口占用不会被误认成插件拥有的进程；用户主动结束外部进程时，Host 会在执行前重新核验身份，避免误杀已经变化的 PID

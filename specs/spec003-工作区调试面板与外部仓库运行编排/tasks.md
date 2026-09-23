# 任务清单 - 工作区调试面板与外部仓库运行编排（人话版）

状态：Draft，等待方案评审；所有实现任务均为 `TODO`。

## 这份文档是干什么的

这份清单把完整实现拆成可验证的阶段。它不是承诺“代码写了就算完成”，每个任务只有在类型检查、定向测试和对应人工检查通过后才能标记为 `DONE`。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：同一外部阻塞经过实际验证仍无法继续，必须写清原因
- `IN_REVIEW`：实现和最小验证已完成，等待复核
- `DONE`：验收通过并已回写证据
- `CANCELLED`：经评审取消，必须写清原因

规则：

- 只有 `DONE` 才能勾选 `[x]`
- 每完成一个任务，立刻在本文件记录实际命令和结果
- 任务中的文件路径是当前设计落点；开发时可按已验证的 DSH 接口调整，但必须回写原因
- 不主动启动开发服务器；真实联调需要用户明确要求

---

## 阶段 0：先确认 DSH 接口，不拿猜测写核心代码

- [ ] 0.1 验证侧栏、Workspace、Storage Domain、数据目录、Web Server 和 Terminal 接口
  - 状态：TODO
  - 这一步到底做什么：针对锁定的 DSH `0.1.6-alpha.2` 写最小测试或调查代码，确认页面注册、Session 到 Workspace 解析、领域存储、插件数据目录、HTTP/Upgrade 扩展点，以及 Terminal 创建和定位方式。
  - 做完你能看到什么：一份带类型声明、最小调用结果和限制说明的调查记录；后续不需要靠 DOM、私有字段或延时猜新 Terminal tab。
  - 先依赖什么：用户确认终端能力已经成熟并正式开始实现。
  - 开始前先看：`requirements.md` 需求 1、3、4、10；`design.md` §2、§4、§13；DSH 安装版对应包的 README 和 `.d.ts`。
  - 主要改哪里：`docs/` 下新增当日 DSH 接口调查记录；必要的 `tests/dsh-debug-integration.spec.ts`；不保留无用原型源码。
  - 这一步先不做什么：不做完整 UI，不启动真实项目，不用 DOM 补丁或未经声明的 DSH 内部对象绕过失败。
  - 怎么算完成：侧栏页面能注册/注销；Host 能权威读取 Workspace；Storage Domain 可重开恢复；确认稳定数据目录；确认 HTTP 与 WebSocket 接入点；Terminal 创建桥得到明确“可行实现”或真实阻塞结论。
  - 怎么验证：`pnpm exec tsc --noEmit`；相关最小测试；人工核对调查记录中的证据路径和版本。
  - 对应需求：需求 1、3、4、10、11
  - 对应设计：§2、§4、§9、§13

- [ ] 0.2 冻结共享契约、状态机和错误码
  - 状态：TODO
  - 这一步到底做什么：把启动项、进程、Agent 终端命令、外部进程候选、调试目标、分析、计划、租约、绑定、AI 补丁、代理和 RPC 请求响应定义成 Host/Client 共用类型，并给所有外部输入加运行时解析。
  - 做完你能看到什么：浏览器和 Host 不再各自拼对象；非法状态、非法端口、非法路径和旧版本请求在进入业务层前被拒绝。
  - 先依赖什么：0.1。
  - 开始前先看：`requirements.md` 全部需求；`design.md` §4～§11；`src/shared/contracts/` 现有写法。
  - 主要改哪里：`src/shared/contracts/debug.ts`、`src/shared/contracts/errors.ts`、`src/shared/index.ts`、`tests/debug-contracts.spec.ts`、必要的包导出。
  - 这一步先不做什么：不访问文件、不启动进程、不实现页面。
  - 怎么算完成：所有状态采用封闭联合类型；输入 DTO 有大小和字段限制；错误码稳定；秘密字段不出现在浏览器 DTO。
  - 怎么验证：`pnpm test -- tests/debug-contracts.spec.ts tests/contracts.spec.ts`；`pnpm exec tsc --noEmit`。
  - 对应需求：全部需求
  - 对应设计：§5、§10、§11

### 阶段检查

- [ ] 0.3 DSH 接口和契约基线检查
  - 状态：TODO
  - 这一步到底做什么：确认所有后续能力都有正式 DSH 接口和共享契约承载。
  - 做完你能看到什么：可以进入持久化和进程实现，不会边写业务边修改对象含义。
  - 先依赖什么：0.1、0.2。
  - 开始前先看：本 Spec 全部主文档和 0.1 调查记录。
  - 主要改哪里：本阶段文档、契约和测试。
  - 这一步先不做什么：不扩展需求，不实现下一阶段代码。
  - 怎么算完成：每条需求能映射到已验证接口和 DTO；所有待确认项有结论或明确阻塞，不存在“以后大概能接”的假设。
  - 怎么验证：人工追踪检查；`git diff --check`；运行本阶段全部定向测试。
  - 对应需求：全部需求
  - 对应设计：全文

---

## 阶段 1：建立 Workspace 数据和启动项

- [ ] 1.1 实现 Debug Storage Domain 和 Workspace 访问守卫
  - 状态：TODO
  - 这一步到底做什么：声明并打开 `dsh-codingns-debug` 领域，建立各表的 repository，并让每次 RPC 都通过 Host Workspace Registry 校验 Session、Workspace 和根目录。
  - 做完你能看到什么：重启 Host 后记录仍存在；两个 Workspace 使用相同记录 ID 也不会串数据；伪造路径和跨 Workspace 请求被拒绝。
  - 先依赖什么：0.3。
  - 开始前先看：`requirements.md` 需求 1、2、11；`design.md` §4.2～§4.4、§11.1。
  - 主要改哪里：`src/host/debug/domain.ts`、`src/host/debug/repositories/`、`src/host/debug/workspace-guard.ts`、`src/host/features/debug.ts`、`tests/debug-domain.spec.ts`、`tests/debug-workspace-guard.spec.ts`。
  - 这一步先不做什么：不存日志正文，不分析仓库，不启动进程。
  - 怎么算完成：写入持久化后才发布状态；domain 关闭可重复；无效记录按已评审策略备份或失败；Workspace 删除后的孤儿记录有清理策略。
  - 怎么验证：`pnpm test -- tests/debug-domain.spec.ts tests/debug-workspace-guard.spec.ts`；`pnpm exec tsc --noEmit`。
  - 对应需求：需求 1、2、11
  - 对应设计：§4、§5、§11.1

- [ ] 1.2 实现启动项 CRUD、并发版本和 worktree 继承
  - 状态：TODO
  - 这一步到底做什么：完成启动项增删改查、相对目录校验、秘密字段处理、乐观并发，并识别 Git worktree 血缘后提供可预览确认的复制操作。
  - 做完你能看到什么：同一 Workspace 的多个 Session 看到相同启动项；子 worktree 可继承配置但拥有独立端口、代理和运行数据。
  - 先依赖什么：1.1。
  - 开始前先看：`requirements.md` 需求 2、6、11；`design.md` §5.1、§7.4。
  - 主要改哪里：`src/host/debug/launch-profile-service.ts`、`src/host/debug/worktree-service.ts`、`src/host/debug/rpc.ts`、`tests/debug-launch-profile.spec.ts`、`tests/debug-worktree.spec.ts`。
  - 这一步先不做什么：不自动执行继承后的命令，不做主/子工作区隐式双向同步。
  - 怎么算完成：绝对路径、`..` 和符号链接越界全部拒绝；复制不带运行记录、租约、slug 和 AI 记录；revision 冲突返回明确错误。
  - 怎么验证：`pnpm test -- tests/debug-launch-profile.spec.ts tests/debug-worktree.spec.ts`；`pnpm exec tsc --noEmit`。
  - 对应需求：需求 2、6、11
  - 对应设计：§4.2、§5.1、§7.4

### 阶段检查

- [ ] 1.3 Workspace 数据检查
  - 状态：TODO
  - 这一步到底做什么：验证持久化、隔离、并发和继承确实成立，不继续堆业务。
  - 做完你能看到什么：配置层已经独立可靠，后续进程失败不会破坏启动项。
  - 先依赖什么：1.1、1.2。
  - 开始前先看：`requirements.md` 需求 1、2、6、11；本阶段测试。
  - 主要改哪里：本阶段全部相关文件。
  - 这一步先不做什么：不增加新表或新 UI。
  - 怎么算完成：Host 重开恢复、跨 Workspace 拒绝、并发修改冲突、worktree 映射失败四类用例全部有证据。
  - 怎么验证：运行本阶段全部定向测试；`git diff --check`；人工检查 Storage Domain 中不含绝对路径和秘密明文。
  - 对应需求：需求 1、2、6、11
  - 对应设计：§4、§5、§7.4、§11.1

---

## 阶段 2：建立独立进程、日志和端口真相

- [ ] 2.1 实现跨平台受控进程和有界日志
  - 状态：TODO
  - 这一步到底做什么：实现统一 `ProcessRuntimeAdapter`，在日志接好后启动项目进程，保存不可仅靠 PID 冒充的身份，并支持优雅停止、强制停止、重启和增量日志。
  - 做完你能看到什么：浏览器刷新或关闭侧栏后进程继续受 Host 管理；停止只作用于该运行实例；日志可按游标读取。
  - 先依赖什么：1.3。
  - 开始前先看：`requirements.md` 需求 3、4、11；`design.md` §2.2、§2.3、§5.2、§6。
  - 主要改哪里：`src/host/debug/process/`、`src/host/debug/logs/`、`src/host/debug/process-service.ts`、`tests/debug-process.spec.ts`、`tests/debug-log-store.spec.ts`。
  - 这一步先不做什么：不把端口查询结果直接当作停止目标，不把日志全文写入 Storage Domain，不假装一次开发机验证等于跨平台完成。
  - 怎么算完成：Fake adapter 覆盖全状态机；POSIX 与 Windows 适配边界清楚；停止幂等；PID 复用和身份不符时拒绝停止；日志限额和秘密替换生效。
  - 怎么验证：`pnpm test -- tests/debug-process.spec.ts tests/debug-log-store.spec.ts`；`pnpm exec tsc --noEmit`；对应平台集成测试按环境回写。
  - 对应需求：需求 3、4、11
  - 对应设计：§5.2、§6、§11.2

- [ ] 2.2 实现端口租约、监听绑定和冷启动恢复
  - 状态：TODO
  - 这一步到底做什么：实现端口池配置、原子租约、外部占用检测、真实监听验证、运行绑定、退出释放和 Host 冷启动巡检。
  - 做完你能看到什么：并行服务不会拿到同一端口；未知占用只显示冲突；进程消失后的脏租约会被收敛释放。
  - 先依赖什么：2.1。
  - 开始前先看：`requirements.md` 需求 3、7、8；`design.md` §3.3.2、§5.3、§6.2、§11.3。
  - 主要改哪里：`src/host/debug/ports/`、`src/host/debug/runtime-binding-service.ts`、`src/host/debug/recovery.ts`、`tests/debug-port-lease.spec.ts`、`tests/debug-runtime-binding.spec.ts`。
  - 这一步先不做什么：不结束外部占用进程，不做跨机器锁，不把一次端口探测当永久状态。
  - 怎么算完成：并发申请唯一；池耗尽明确失败；租约与监听不一致可见；正常退出、启动失败、取消、Host 重启四条清理路径都有测试。
  - 怎么验证：`pnpm test -- tests/debug-port-lease.spec.ts tests/debug-runtime-binding.spec.ts`；`pnpm exec tsc --noEmit`。
  - 对应需求：需求 3、7、8
  - 对应设计：§5.3、§6.2、§11.2～§11.4

- [ ] 2.3 实现 Agent 终端归属和外部进程受控结束
  - 状态：TODO
  - 这一步到底做什么：接入 AI Agent 私有终端的命令执行记录，按端口发现监听进程并匹配进程祖先链；对无法归属的进程生成短时确认候选，用户确认后在 Host 重新核验身份再结束。
  - 做完你能看到什么：Agent 在私有终端启动的服务可以从调试面板停止；未知进程也能在查看详情和明确确认后结束，而不是要求用户手敲命令。
  - 先依赖什么：2.1、2.2。
  - 开始前先看：`requirements.md` 需求 3、4、8、11；`design.md` §2.2、§3.3.4、§5.2.1、§6.4、§11.2。
  - 主要改哪里：`src/host/debug/process-discovery/`、`src/host/debug/terminal-execution-registry.ts`、`src/host/debug/rpc.ts`、`tests/debug-process-discovery.spec.ts`、`tests/debug-external-process-termination.spec.ts`。
  - 这一步先不做什么：不允许 Client 提交 PID 直接结束，不结束 Agent 或终端 Shell，不自动扩大到未知父进程组，不尝试提权结束其他系统用户的进程。
  - 怎么算完成：`managed/agent_terminal/discovered` 三级状态稳定；候选短时有效；确认后重新核验端口、PID 和启动身份；PID 复用、保护进程、候选过期和 daemonize 降级都有测试。
  - 怎么验证：`pnpm test -- tests/debug-process-discovery.spec.ts tests/debug-external-process-termination.spec.ts`；`pnpm exec tsc --noEmit`；人工审查所有 `kill`、负 PID signal、Job Object 和 `taskkill` 调用的候选来源。
  - 对应需求：需求 3、4、8、11
  - 对应设计：§2.2、§3.3.4、§5.2.1、§6.4、§11.2

### 阶段检查

- [ ] 2.4 进程和端口所有权检查
  - 状态：TODO
  - 这一步到底做什么：用“插件进程监听”“Agent 终端命令监听”“未知进程占用”“确认前监听者变化”“PID 被复用”“目标是保护进程”六组场景检查停止行为。
  - 做完你能看到什么：可以证明自动停止依赖进程所有权，端口发现的外部进程只有经过用户确认和执行前复核才会被结束。
  - 先依赖什么：2.1、2.2、2.3。
  - 开始前先看：`design.md` §2.2、§6.2、§6.4、§11.2。
  - 主要改哪里：本阶段进程、端口、发现、恢复代码和测试。
  - 这一步先不做什么：不开发调试 UI，不弱化保护名单或候选过期规则换取测试通过。
  - 怎么算完成：六组场景全部固定为自动测试；Agent 服务停止不结束 Agent/终端；旧候选不能结束后来占用同一 PID 或端口的进程。
  - 怎么验证：运行本阶段全部测试；人工审查跨平台停止实现和保护名单。
  - 对应需求：需求 3、4、8、11
  - 对应设计：§2.2、§6、§11.2、§11.3

---

## 阶段 3：完整实现外部仓库启动适配

- [ ] 3.1 实现框架分析、兼容矩阵和服务模型
  - 状态：TODO
  - 这一步到底做什么：实现有读取限额的仓库分析器、可注册识别器和矩阵查询，覆盖文档承诺的前端、Node、JVM、Python、Ruby、.NET 和明确不支持场景。
  - 做完你能看到什么：用户可以看到识别证据、置信度、兼容等级、服务建议和额外处理要求，但实际命令仍来自启动项。
  - 先依赖什么：2.4。
  - 开始前先看：`requirements.md` 需求 5、7；`design.md` §7.1；`docs/20260922-框架兼容矩阵.md`。
  - 主要改哪里：`src/host/debug/analysis/`、`src/host/debug/adapters/compatibility-matrix.ts`、`src/host/debug/debug-target-service.ts`、`tests/debug-analysis.spec.ts`。
  - 这一步先不做什么：不从 `package.json` 猜命令并自动执行，不无限遍历 monorepo，不读取大文件或秘密目录。
  - 怎么算完成：矩阵每一行有识别和准入测试；未知/不支持明确拒绝自动注入；分析限额和取消生效。
  - 怎么验证：`pnpm test -- tests/debug-analysis.spec.ts`；`pnpm exec tsc --noEmit`；矩阵与注册表逐项对照。
  - 对应需求：需求 5、7、11
  - 对应设计：§7.1、§11.6

- [ ] 3.2 实现启动计划、四层适配和服务联动
  - 状态：TODO
  - 这一步到底做什么：建立固定适配器注册表，生成可预览且有版本的多服务启动计划，处理端口注入、前后端发现、HMR WebSocket、callback 提示和启动顺序。
  - 做完你能看到什么：Vite/Node 等常见项目可以拿到不污染仓库的真实计划；每个失败都能说清发生在哪个适配层。
  - 先依赖什么：3.1、2.2。
  - 开始前先看：`requirements.md` 需求 5～8；`design.md` §3.3.2、§7.2、§7.3。
  - 主要改哪里：`src/host/debug/adapters/`、`src/host/debug/launch-plan-service.ts`、`src/host/debug/override-artifact-service.ts`、`tests/debug-launch-plan.spec.ts`、`tests/debug-service-linking.spec.ts`。
  - 这一步先不做什么：不跳过用户预览直接运行，不把 callback 第三方后台修改伪装成自动完成，不在 Workspace 写临时垃圾文件。
  - 怎么算完成：CLI、env、override 按顺序短路；计划过期拒绝执行；多服务端口和依赖一致；HMR/WS 要求没有满足时计划不可自动运行。
  - 怎么验证：`pnpm test -- tests/debug-launch-plan.spec.ts tests/debug-service-linking.spec.ts`；`pnpm exec tsc --noEmit`。
  - 对应需求：需求 5～8
  - 对应设计：§3.3.2、§7

- [ ] 3.3 实现 AI 补丁生成、确认、应用和回滚
  - 状态：TODO
  - 这一步到底做什么：接入经 0.1 确认的 DSH AI 接口，限制候选文件和上下文，生成统一 diff，完成预览、用户确认、原子应用、冲突拒绝、回滚和确认保留。
  - 做完你能看到什么：前三层失败后，允许的项目能得到真实可用补丁；用户能看到改动并安全撤回，不再只是留一条“需要 AI”的记录。
  - 先依赖什么：3.2；DSH 必须存在经确认的 Agent/模型调用接口。
  - 开始前先看：`requirements.md` 需求 9、11；`design.md` §3.3.5、§8、§11.5。
  - 主要改哪里：`src/host/debug/ai/`、`src/shared/contracts/debug.ts`、`src/client/debug/ai-patch-dialog.ts`、`tests/debug-ai-fallback.spec.ts`、`tests/debug-ai-patch-apply.spec.ts`。
  - 这一步先不做什么：不让模型直接写文件，不发送秘密，不改业务源码、依赖清单、迁移或生产配置，不用破坏性 Git 命令回滚。
  - 怎么算完成：准入、白名单、大小、哈希和禁止文件全部强制执行；应用前必须用户确认；用户后续修改导致回滚冲突时不覆盖；未处理记录持续可见。
  - 怎么验证：`pnpm test -- tests/debug-ai-fallback.spec.ts tests/debug-ai-patch-apply.spec.ts`；`pnpm exec tsc --noEmit`；人工审查一次生成、应用、冲突和回滚记录。
  - 对应需求：需求 7、9、11
  - 对应设计：§8、§11.5

### 阶段检查

- [ ] 3.4 外部仓库编排主链路检查
  - 状态：TODO
  - 这一步到底做什么：用最小样本覆盖前端单服务、前后端双服务、worktree 并行、非侵入适配失败和 AI 回滚。
  - 做完你能看到什么：父仓库 `spec007.1` 的完整能力已经在插件 Host 内形成一条真实链路。
  - 先依赖什么：3.1、3.2、3.3。
  - 开始前先看：需求 5～9、框架矩阵和本阶段测试。
  - 主要改哪里：本阶段全部代码、测试和 `docs/` 验收记录。
  - 这一步先不做什么：不接反向代理 UI，不拿 mock 结果冒充真实样本验证。
  - 怎么算完成：每个样本都有分析、计划、租约、运行/失败、日志和清理证据；AI 路径确实生成并处理补丁。
  - 怎么验证：定向集成测试；实际样本命令由用户允许后执行；回写样本版本和结果。
  - 对应需求：需求 5～9
  - 对应设计：§7、§8、§12

---

## 阶段 4：实现反向代理和调试面板

- [ ] 4.1 实现绑定运行实例的 HTTP、SSE 和 WebSocket 代理
  - 状态：TODO
  - 这一步到底做什么：在 DSH Host Web Server 的正式扩展点注册调试代理，建立不可猜 slug、绑定核验、HTTP/SSE 流式转发、WebSocket Upgrade、Header/Cookie/Location 改写和限额。
  - 做完你能看到什么：运行中的前端、API、SSE 和 HMR 服务可从 DSH 页面访问；实例停止后旧地址立即失效。
  - 先依赖什么：2.4、3.4、0.1 已确认 HTTP/Upgrade 接口。
  - 开始前先看：`requirements.md` 需求 10、11；`design.md` §3.3.6、§5.4、§9、§11.4。
  - 主要改哪里：`src/host/debug/proxy/`、`src/host/features/debug.ts`、`tests/debug-proxy-http.spec.ts`、`tests/debug-proxy-websocket.spec.ts`。
  - 这一步先不做什么：不代理任意 URL，不信任 Client 给的目标端口，不无上限缓冲响应，不用正则重写任意 JavaScript/CSS。
  - 怎么算完成：常用 HTTP 方法、请求体、查询参数、重定向、Cookie、SSE、WS、上游失败、限额和停止失效都有测试；端口复用不能复活旧 slug。
  - 怎么验证：`pnpm test -- tests/debug-proxy-http.spec.ts tests/debug-proxy-websocket.spec.ts`；`pnpm exec tsc --noEmit`。
  - 对应需求：需求 10、11
  - 对应设计：§9、§11.4

- [ ] 4.2 实现 DSH 右侧栏调试面板
  - 状态：TODO
  - 这一步到底做什么：注册页面类型和开始页入口，完成启动项列表、统计、编辑、分析、计划预览、启动/停止/重启、日志、端口进程详情与确认结束、AI 差异和代理入口界面。
  - 做完你能看到什么：用户在一个可分栏的 DSH 原生页面中完成全部工作流；无 Workspace、加载、空数据、冲突、失败和旧 generation 都有清楚状态。
  - 先依赖什么：4.1、3.4、0.1 的侧栏和 Terminal 结论。
  - 开始前先看：`requirements.md` 需求 1 和全部用户流程；`design.md` §3、§4.1、§4.4；现有 Client feature 和主题实现。
  - 主要改哪里：`src/client/debug/`、`src/client/features/debug.ts`、`src/client/features/index.ts`、`src/client/features/types.ts`、`src/client/index.ts`、`tests/debug-panel.spec.ts`、`tests/debug-sidebar.spec.ts`。
  - 这一步先不做什么：不复制 DSH 侧栏布局，不把页面做成卡片套卡片，不在 Client 推导启动真相，不因 Terminal 桥不可用而回退到字符串注入 DOM。
  - 怎么算完成：主要操作键盘可达；窄屏和宽屏不重叠；同 Workspace 多 Session 共享数据；旧 generation 响应被丢弃；所有文案接入 DSH locale。
  - 怎么验证：`pnpm test -- tests/debug-panel.spec.ts tests/debug-sidebar.spec.ts`；`pnpm exec tsc --noEmit`；Playwright 或项目认可的真实浏览器截图与交互检查。
  - 对应需求：全部需求
  - 对应设计：§3、§4、§12.4

### 阶段检查

- [ ] 4.3 页面到代理完整检查
  - 状态：TODO
  - 这一步到底做什么：从侧栏创建启动项、生成计划、启动服务、看日志、打开代理、停止服务，回放完整用户路径。
  - 做完你能看到什么：UI 不只是展示静态数据，Host 主链路和代理可以被真实操作。
  - 先依赖什么：4.1、4.2。
  - 开始前先看：全部需求和本阶段测试。
  - 主要改哪里：本阶段 Client、Host、测试和验收记录。
  - 这一步先不做什么：不顺手调整无关设置页面，不掩盖未支持框架。
  - 怎么算完成：HTTP、SSE、HMR WS 至少各一条链路通过；停止后代理立即失败；页面刷新后配置与运行真相正确恢复。
  - 怎么验证：定向集成测试；用户明确要求后启动真实 DSH 联调并记录结果。
  - 对应需求：全部需求
  - 对应设计：§3.3、§9、§12.4

---

## 阶段 5：跨平台和最终验收

- [ ] 5.1 完成 macOS、Linux、Windows 平台矩阵
  - 状态：TODO
  - 这一步到底做什么：在三个系统分别验证进程身份、进程树停止、Host 重启恢复、端口探测、日志和 HTTP/WS 代理。
  - 做完你能看到什么：跨平台不是类型层面的口号，每个平台都有命令、版本和结果证据。
  - 先依赖什么：4.3。
  - 开始前先看：`requirements.md` 非功能需求 1～3；`design.md` §6、§12.3。
  - 主要改哪里：平台适配器、测试脚本、`docs/` 平台验收记录。
  - 这一步先不做什么：不把未执行的平台标成通过，不用单个平台的 Fake 测试替代真实进程行为。
  - 怎么算完成：三个系统的关键矩阵全部有结果；已知平台差异写入兼容说明；资源清理后无遗留受控进程、监听器或代理连接。
  - 怎么验证：各平台定向命令和人工检查；`pnpm exec tsc --noEmit`；记录实际 Node/DSH 版本。
  - 对应需求：需求 3、4、7、8、10；非功能需求 1～3
  - 对应设计：§6、§9、§12.3

- [ ] 5.2 最终需求、测试、安全和文档验收
  - 状态：TODO
  - 这一步到底做什么：逐条核对需求、设计、任务、测试和人工证据，运行完整测试，并同步 README、开发文档和残余风险。
  - 做完你能看到什么：每一条“已实现”都有证据；未完成项不会藏在模糊表述里。
  - 先依赖什么：5.1。
  - 开始前先看：本 Spec 全部文件、项目 README、现有开发规范、所有验收记录。
  - 主要改哪里：本 Spec、项目 `README.md`、相关 `docs/`、必要的包导出和发布文件。
  - 这一步先不做什么：不临时追加新功能，不在验证失败时勾选完成。
  - 怎么算完成：需求追踪无空项；安全检查覆盖路径、秘密、进程、AI 和代理；完整测试通过；真实 DSH 联调记录完整；所有资源清理检查通过。
  - 怎么验证：`pnpm exec tsc --noEmit`；相关定向测试；`pnpm test`；`git diff --check`；人工验收清单逐项签收。
  - 对应需求：全部需求
  - 对应设计：全文

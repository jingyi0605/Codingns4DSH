# 设计

## 1. 架构与核心判断

值得实现：普通对话、专家、工作任务已在 macOS App 原生后台页验证，具有真实接入基础。最大的风险是把用户正在使用的会话误当后台运行，所以隔离以显式创建的会话 ID 为核心，不以窗口标题或当前聊天路由为依据。

数据路径：`Registry → DoubaoAppDriver → HttpSseClient → 豆包 CDP fetch 桥 → 原生后台页 fetch → 豆包服务`。登录参数只存在 App 内，Host 不读取 Cookie、账户文件或鉴权头。

## 2. 组件

### 2.1 App 连接管理

发现默认 macOS 安装路径或显式 `CODINGNS_DOUBAO_APP_PATH`；调试端口由 `CODINGNS_DOUBAO_CDP_PORT` 指定，默认 9225。检测不启动。只接受 `127.0.0.1` 和固定端口，校验 discovery 返回的 WebSocket 归属和后台页 URL。已运行而无端口直接报错。macOS 启动采用 `open -g -j`，不持有关闭 App 的权限。Windows 首期仅连接已开启端口的 App；冷启动隐藏必须另经真实环境验收。

### 2.2 CDP 窄桥

每轮独立 WebSocket、独立随机运行标识；CDP 请求具有超时、断线拒绝、事件监听清理。读取器驻留原生后台页，通过显式 pull 读取原始字节，构造成 Host Response 的 ReadableStream，交给现有 HttpSseClient。pull 提供背压，避免无界事件队列。该桥只允许固定豆包接口，不是通用浏览器控制器。

通过 Webpack factory 的结构特征定位配置、请求封装、枚举和默认 bot；验证唯一性及出口形状，不持久化模块编号，不遍历用户历史。失败即停止。每轮注入的 Map/reader 状态在 finally 清理。

### 2.3 Driver

`detect/listModels/probeSession/executeTurn/interrupt/dispose` 对齐现有契约。模式 id：`doubao-fast`、`doubao-expert`、`doubao-work`。目录是已验证产品档位的静态回退，不冒充实时底层模型目录。

选择器会用 `effortId: default` 和 `serviceTierId: default` 清除旧档位。豆包边界将空值及 default 视作不覆盖，不向 App 请求传递；非默认档位和 runtimeEnv 分别报错。不能全局删除 default，否则会破坏其他适配器的清空语义。

绑定持久化只使用 providerSessionId。每次续聊重新读取最近消息确定 section/index。并发表键为 DSH sessionId，云端 conversationId 另做互斥。新会话先调用 create，再发 session-binding，然后发送 prompt；断线不自动创建或重发。

Registry 手动调用驱动迭代器的 next，必须在本轮 finally 中转发 return，等待清理完成后再撤销 executingSessions。自然耗尽时清空本轮句柄；工具分段时将句柄显式移交 segmentedTurns，再清空本轮句柄。这样既能释放收到 finish 后不再读取的驱动，也不会关闭下个 step 仍需续读的流。

### 2.4 SSE 投影

按 blockId 保存类型、parentId、正文及工具状态；10040 是思考容器，子文本投影 reasoning。首包 STREAM_MSG_NOTIFY、STREAM_CHUNK patch、CHUNK_DELTA 共用 block 状态。替换用 snapshot，追加用 delta；不把 FULL_MSG_NOTIFY 的用户回显当回答。ACK 必须校验 conversationId。终态结合回复结束事件和流关闭，空流/异常关闭不当作成功。

工具事件使用稳定 callId，只陈述云端执行状态。首版文件块展示产物名称并提示前往豆包会话查看，不将签名下载链接、凭据和原始响应落入 DSH 工具记录；自动下载作为后续扩展。工作任务回答内提供的普通文本链接按回答本身处理。

工具白名单和块生命周期独立放在 `doubao-tools.ts`，正文投影保持原路径。当前按 App 2.12.8 的实际字段支持：

| 块类型 | 工具卡片 | 采集字段 |
| --- | --- | --- |
| 10025 | 豆包联网搜索 | queries、summary、results.text_card 的标题和普通网页 URL |
| 10006 | 豆包网页读取 | summary、description、items 的标题、摘要和普通网页 URL |
| 10101 | 豆包处理进度 | text_loading.text；标记为进度观察，不冒充具体执行工具 |
| 10019 | 豆包云端文件操作 | header.summary、file_name、content；包括实际承载于此块的云端代码执行输出 |
| 10020 | 豆包云端产物 | name、type、size；不采集下载 URL 或文件原始对象 |
| 10024 | 豆包云端工具 | tool_name、title、summary、明确的字符串失败状态 |

公共工具卡片读取 input/output，不读取驱动的 detail 作为参数，因此每个工具同时输出有界 input 和 snapshot output。原生桥负责唯一的工具声明、call/result，不修改客户端也不触发 DSH 工具执行器。开始显示运行中卡片，结果由结束事件写入；中途工具快照保留在聚合层，无需为每个补丁新增卡片。

按 blockId 保存白名单字段。追加文本保留换行，替换块清除旧内容，独立 is_finish 保留最终快照，重复快照和重复终态不重复显示；未完成块被撤回时写失败事件。回合取消/错误由现有公共聚合层补齐未结束记录的失败结果。只处理明确的字符串失败状态，不猜测数字状态，10008 普通代码块不当作已执行代码。

最多保存 256 个工具状态，最多 20 个查询和 20 个来源；工具正文最多 8192 字符，单次输出最多 24000 字符并标记截断。公开网页 URL 只接受 HTTP(S)，拒绝内嵌用户名密码或 token/signature 等鉴权参数；产物下载地址始终不采集。这是展示字段过滤，不把未经验证的私有协议字段自动展开成日志。

## 3. 不变量与失败处理

1. 任何请求都不通过前台输入框，不创建额外可见窗口。
2. create 返回的 ID、绑定 ID、ACK ID 必须一致。
3. 一个运行只有一个终态；没有真实 token 计数则不产生 usage。
4. 单个连接释放不关闭 App、调试监听和别的运行。
5. 普通取消必须拿到目标 replyId 并确认原生接口成功；工作模式不声称已停止所有云端工具。
6. 网络/协议错误返回脱敏固定描述及必要状态码，不输出原始请求和敏感 URL。
7. App 升级导致结构变化时失败关闭，不退回前台自动化或猜测参数。

## 4. 检验计划

单测覆盖后台目标校验、CDP 超时/断连、流读取及清理、模式参数、ACK 错配、正文/思考补丁、工具事件、取消隔离、续聊与不重发。正式驱动 macOS 实测快速及续聊、专家、工作任务；只使用合成内容与独立会话。Windows 及退出状态冷启动另列待验收，不自动重启当前用户 App。

验证命令使用 `node --import ./tests/register-source-loader.mjs --test ...`，类型检查使用 `pnpm run typecheck`；执行版本、能力和国际化静态检查，不执行含构建的 `pnpm test`。

## 5. 回滚

关闭 agentAdapters.doubao 即停止新增调用。删除驱动登记可撤回功能，不迁移旧适配器数据、不修改公共 schema。已创建豆包会话归用户保留，不自动删除。调试端口随 App 生命周期存在，断开 CDP 不等于关闭端口。

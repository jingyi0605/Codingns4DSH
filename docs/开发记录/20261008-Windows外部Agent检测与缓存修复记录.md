# Windows 外部 Agent 检测与缓存修复记录

日期：2026-10-08

## 核心判断

这是实际的兼容性回归。beta.5 的异步命令执行改变了 Windows 参数传递方式，检测失败又被归类为“未安装”，缓存使误判持续存在。旧 Host 环境缺少用户 PATH 是另一种独立诱因，不能解释截图中 PATH 完整而命令仍检测失败的情况。

本次只修改仓库源码、测试和记录，保留工作区已有改动；没有构建、发布，也没有操作 Desktop、dsh-web 或 Stage0 进程及配置。完成验证后，按用户要求仅将本会话相关改动按功能分批提交。

## 根因与证据

1. `v0.2.1-beta.4` 到 `v0.2.1-beta.5` 之间，提交 `025b687` 将同步探测改为 `execFile` 异步探测。Windows 分支已自行拼接 `cmd.exe /d /s /c` 参数，却没有传 `windowsVerbatimArguments: true`，导致参数再次经过普通 argv 转义。这解释了手工 `cmd /c CLI --version` 成功而插件探测失败的差异。
2. `2ca553d` 将启动检测改为延迟后台执行，列表只读缓存，驱动内部自检也经注册表缓存。beta.4 已有缓存，不能把问题简单描述为 beta.5 “首次引入缓存”。真正的问题是探测失败返回 `installed: false` 后被当成正常结果缓存。
3. Windows 的路径查找原来只依赖 Host 继承的 PATH，没有补充注册表中新加入的机器和用户目录。重启应用仍可能继承旧启动进程环境。
4. StandardStreamDriver 和 CodeBuddy 原来仅在退出码为 `null` 时查找备用路径；Windows shell 的非零退出码（包括 `1`、`9009`）可能直接绕过兜底。
5. Qoder 原本已登记 `qodercli` 等别名，截图中“只找 qoder”的判断不适用于当前源码；实际缺口是 Windows `.cmd` 版本和模型探测没有使用 shell，并且驱动保存了构造时的环境。
6. 启动错误、超时、无法识别版本与真实未安装没有清晰区分。部分选择器也把尚未完成的检测显示成未安装。

Node 自身使用 cmd shell 时同样启用原样参数传递，见 [Node v22.22.0 child_process 实现](https://github.com/nodejs/node/blob/v22.22.0/lib/child_process.js#L600-L612)。新增测试保留真实 `execFile` 和 Node 参数归一化过程，仅拦截最终系统进程创建；直接断言进入系统边界的参数，避免旧 `spawnSync` 测试替身跳过缺陷。

## 实现

### 命令执行和环境

- 显式 Windows shell 调用设置 `windowsVerbatimArguments: true`；普通可执行文件维持原参数处理。
- 首次 Windows 探测通过绝对系统路径启动 PowerShell，只读 HKLM/HKCU 环境注册表。读取原始可展开字符串，避免 PowerShell 使用继承来的旧变量提前展开。
- 所有 CLI 共用一次异步注册表快照；手动重新检测会失效快照。修复刷新期间旧查询迟到覆盖新环境的竞态。
- PATH 按“调用方原路径、机器路径、用户路径”补充，展开 `%变量%`，按 Windows 路径规则去重，只输出一个 PATH 键。明确传入的 `Path` 覆盖同一对象中较早的 `PATH`。
- 仅补 PATH，不用注册表值覆盖 Host 的票据和应用变量，不修改 `process.env` 或注册表。完整子进程环境中已删除的变量不会被重新补入。
- PowerShell 不可用或读取失败时继续使用已有环境。原有两路短命令并发限制、取消和超时保留。
- `where.exe` 使用绝对系统路径和同一补充环境，按 PATH 顺序选择可执行入口，跳过 npm 无后缀 POSIX 包装文件。
- JSON-RPC、Qoder 以及保留旧成功检测结果后的执行路径继续使用补充环境。Qoder 两区域登录变量保持隔离。

### 检测结果和缓存

- 公共 `detectBinary` 统一名称探测、路径兜底、版本解析和错误分类。Command Code、StandardStreamDriver、Qoder、OpenCode 复用此实现；原本使用 RPC 探测助手的驱动自动获得修复。
- CodeBuddy 保留 ACP 能力验证；WorkBuddy 保留只能使用应用内置入口的限制，不回退到其他 CodeBuddy CLI。
- 真正未找到入口：`installed: false`、`detectionState: ready`。
- 启动失败、超时、版本无法解析或协议不支持：提供 `detectionFailure` 和脱敏诊断，注册表标记 `error`。
- 瞬时失败保留上次成功的入口和版本，同时明确显示本次检测失败。明确卸载仍更新为未安装。
- 错误状态超过 30 秒后，在实际使用时允许重试；普通目录读取不启动命令，不恢复周期性后台扫描。手动检测仍可立即重试。
- 设置页和选择器共用状态文案，区分检测中、检测失败、已安装、未安装；兼容缺少新可选字段的旧 Host。

### 截图中需要保留的正确边界

- 未安装 OpenCode、Command Code 或 MiniMax CLI 时仍显示未安装；配置目录或日志不能证明 CLI 存在。
- ZCode 原有应用内置 CLI 发现逻辑保留，仅有 `.zcode` 运行数据不能判定安装可用。
- Antigravity 适配器接入 `agy` 的 stream-json 协议，普通 `Antigravity.exe` 桌面入口不能直接冒充该 CLI。
- 不以“所有 Agent 都变绿”为验收标准，以实际可运行入口和协议为准。

## 验证

使用 `tests/register-source-loader.mjs` 在内存中直接加载源码，不执行 `pnpm test` 自带的构建。

新增回归覆盖：

1. 真实异步执行器进入 Node 系统边界时的 Windows 原样参数、中文/空格/`&` 路径。
2. 注册表 PATH 补充、变量展开、大小写键、调用方优先级、去重、快照并发与刷新竞态。
3. 系统环境读取不可用时的降级；产品部分覆盖保留 Host 环境；完整环境不恢复已过滤变量。
4. Windows 非零退出码的路径兜底、Qoder 别名和 `.cmd` 探测、产品登录变量隔离。
5. 未安装、启动失败、超时、版本不匹配、协议错误和备用别名恢复。
6. 缓存错误重试、上次成功结果保留、明确卸载、刷新后错误清除、实际执行继续带有补充 PATH。
7. 前端状态文案与旧 Host 数据兼容。

同时提供 `tests/cli-windows-native.spec.ts`：在 Windows 上创建临时假 `.cmd` CLI，真实执行中文/空格/`&` 路径和带空格参数，不访问任何安装或 Desktop Profile。当前 macOS 环境会跳过此测试，因此本轮不能宣称已完成 Windows 实机验证。

最终验证结果：

| 检查 | 结果 |
| --- | --- |
| `pnpm exec tsc -p tsconfig.json --noEmit` | 通过 |
| Windows 分支模拟与真实 Node 参数边界测试 | 11 项全部通过 |
| 37 个文件的适配器、模型、会话、缓存、委派和性能回归 | 共 509 项；506 通过、2 跳过、1 项现有产物断言失败 |
| `git diff --check` | 通过 |

扩展回归使用 `node --import ./tests/register-source-loader.mjs --test --test-reporter=spec`，覆盖全部 `tests/cli-adapters*.spec.ts`（不运行豆包真实应用测试），以及缓存、目录刷新、会话存储、客户端模型目录、子代理桥接与委派、性能和本次 Windows 测试。最后一次运行前后，对这些测试及 `src/host/cli-adapters/*.ts` 计算哈希，确认运行期间没有文件变化。

两个跳过项分别是 Windows 原生测试和未启用的 OpenCode V2 真实 CLI 冒烟。Windows 环境可独立执行：

```sh
node --import ./tests/register-source-loader.mjs --test tests/cli-windows-native.spec.ts
```

已发现一项与本次修改无关的现有断言：`tests/subagent-delegate.spec.ts` 要求 `DELEGATE_COMMAND_NAME` 等文本直接出现在 `data/build/dist/client/bundle.js`，而工作区已有拆包产物将这些文本放在 `client.delegate-command.js`。该测试文件与 HEAD 完全一致，四个产物断言均能在现有分块中找到对应内容。本次不修改其他任务的拆包实现或以构建重写产物。

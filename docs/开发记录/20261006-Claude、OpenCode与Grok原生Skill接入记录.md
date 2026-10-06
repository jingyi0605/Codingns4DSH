# Claude、OpenCode 与 Grok 原生 Skill 接入记录

## 核心判断

值得做。此前的错误只说明适配器没有实现 Skill 目录契约，不能据此判断 Provider（外部 Agent 提供方）没有 Skill 能力。修复必须同时接通目录发现和实际调用，单独增加 `skills` 能力标记没有意义。

## 目录与调用

| 适配器 | 目录来源 | 显式调用 |
| --- | --- | --- |
| Codex | 原生 `skills/list` | `turn/start` 的结构化 `skill` 输入 |
| Command Code | 原生兼容目录与设置额外目录，完整 YAML 校验 | `--skill <directory>` |
| Claude Code | 企业、用户、项目 `.claude/skills` | stream-json 的原生 `/name 参数` 用户消息 |
| OpenCode | 运行中 Server 的 `GET /skill`；不可用时 `opencode debug skill` | `POST /session/{id}/command`，保留参数、模型、思考强度和附件 |
| Grok Build | `grok inspect --json` | ACP（Agent 客户端协议）的原生 `/name 参数` 文本 |

Claude 目录保留企业高于用户、用户高于项目的规则；项目祖先搜索在仓库根目录停止。支持符号链接和真实路径去重、折叠 YAML 描述、可选名称和正文描述回退。`user-invocable: false` 与 `skillOverrides: off` 禁用用户菜单调用，企业 `strictPluginOnlyCustomization` 策略生效时不提供普通目录 Skill。`.agents/skills` 不作为 Claude 的独立原生目录；用户可自行通过 Claude 目录中的符号链接复用已有内容。

OpenCode 使用原生目录服务，保留 Provider 的额外目录和发现规则。原生 command 模板优先于同名 Skill，因此通过 `GET /command` 检查冲突并禁用对应菜单项。已匹配的行首 `/name` 或 `$name` 走 command API；未知名称和禁用条目保持普通消息。原生命令失败直接透传，不自动换成普通消息重试。等待 command 响应后才结束轮次，避免全局 SSE（服务器推送事件流）提前报告 `idle` 时吞掉命令错误。

Grok 采用 `inspect` 已经应用过的项目信任、配置禁用、兼容性和插件结果，保留 `invocableAs` 中的限定名称。原生读取失败返回空目录，不用独立文件扫描绕过这些规则。显式斜杠命令前不再插入提问提示，以保留原生解析入口。

全部目录只返回 `id/name/description/enabled/displayName` 摘要；路径和正文留在 Host。读取目录不创建用户文件夹、不启动 OpenCode Server，也不创建 Grok ACP 会话。

## 前端复用和其他适配器

DSH 0.2.1-alpha.1 的原生 Skill 前端提供会话内 `/` 菜单、引用和工具展示，本插件复用同一个输入触发入口为外部适配器提供目录。引用支持 `local:name` 等 Provider 限定名称。

目前已实现目录契约的外部适配器是 Codex、Command Code、Claude Code、OpenCode 和 Grok。其余适配器未声明 `skills`；Client 不主动请求目录，旧 Client 误请求时 Registry 返回空目录，避免重复打印“不支持 Skill”错误。这表示尚未在本插件接入，不能推断其上游 Agent 不支持 Skill。

现有界面可以统一发现和调用多个适配器的 Skill，但没有跨适配器的创建、编辑、删除管理界面。本轮复用现有入口，未新增跨 Provider CRUD（创建、读取、更新、删除）管理器，也未自动改写各 Agent 的个人配置。

## 边界

- Claude 菜单当前覆盖普通企业、用户和项目 Skill 目录，未枚举插件、账号同步 Skill、旧 `.claude/commands` 或会话运行后动态加载的附加目录；这些能力仍由 Claude 原生处理。企业远端/系统策略与工作树替代目录的完整投影不在本轮目录实现范围内。
- Claude 与 Grok 的显式 Skill 命令应放在输入开头；OpenCode 只将行首显式 Skill 转换为 command 请求。正文中的普通提及保持文本，由 Provider 的原生 Skill 工具决定是否加载。
- 旧 CLI 没有原生目录命令时保持空菜单，不伪造目录支持。

## 来源与验证

- [Claude Code 官方 Skill 文档](https://code.claude.com/docs/en/skills)与 [设置优先级文档](https://code.claude.com/docs/en/settings)。
- [OpenCode 官方 Skill 文档](https://opencode.ai/docs/skills/)与本机 1.18.34 对应的 [command 注册源码](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/command/index.ts)、[session command 源码](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/prompt.ts)。
- 本机 Grok 1.0.46 自带 `docs/user-guide/08-skills.md`、`14-headless-mode.md` 与 `grok inspect --json`。

类型、版本和能力退休检查通过。提交前导出仅含本轮变更的暂存区快照，六个受影响测试文件共 129 个用例通过，另有 Grok/Codex Skill 的 11 个 RPC 回归通过，共 140 个；其他会话尚未提交的 ACP 改造未参与验证。覆盖目录优先级、YAML、符号链接、可见性配置、响应脱敏、原生命令下发、冲突和失败传播。两处 OpenCode 旧断言同步补齐源码原已返回的 `messageId`，未改变对应正文投影行为。测试加载器仅在内存转换源码，不写构建产物，以免受现有 dist 更新影响。

本机只读验收实际返回：Claude 2 个、OpenCode 4 个、Grok 3 个 Skill；未发起模型请求。

```bash
pnpm typecheck
node --import ./tests/register-source-loader.mjs --test tests/cli-adapters-skills.spec.ts tests/skill-reference-dom.spec.ts
```

本轮源码、测试和文档已按功能分批提交；未执行项目构建、开发服务器启停、Stage0 重启、Desktop 操作、真实模型付费请求、推送或发布。

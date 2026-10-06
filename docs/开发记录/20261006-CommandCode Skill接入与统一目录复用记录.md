# Command Code Skill 接入与统一目录复用记录

## 目标

让 Command Code 适配器复用现有 Codex Skill 契约：扫描项目与用户 Skill 目录，校验 `SKILL.md`，向 Client 返回脱敏摘要，并在用户显式输入 `/skill-name` 或 `$skill-name` 时向 Command Code 下发 `--skill`。

## 实现

- `CommandCodeDriver` 声明 `skills` 能力并实现 `listSkills()`。
- 扫描顺序与 Command Code 兼容目录一致：项目 `.commandcode/skills`、从当前目录向上查找的项目 `.agents/skills`、用户 `~/.commandcode/skills`、用户 `~/.agents/skills`，最后读取最高优先级 `settings.json` 中的额外 Skill 根目录；支持 `~/` 展开和 `disabledSkills`。
- 只接受目录名与 frontmatter `name` 一致、且名称符合 kebab-case、`description` 非空的 `SKILL.md`。`user-invocable: false` 保留在目录中，但标记为不可由用户菜单调用。
- 重名 Skill 按扫描顺序保留高优先级目录；路径只在 Host 内部保留，Client 只收到 `id/name/description/enabled`。
- Command Code 运行前解析显式 Skill mention，只把匹配且启用的 Skill 目录作为 `--skill <directory>` 参数传入；没有显式 mention 时不增加参数。
- Client 读取当前会话的适配器能力。`dsh` 会话交给 DSH 原生 Skill UI，插件目录 RPC 只对声明 `skills` 的外部适配器发起，避免不支持适配器反复打印错误。
- Registry 也做第二层能力兜底：旧版 Client 直接请求未声明 `skills` 的适配器时返回空目录，不再抛出 `CODINGNS_CLI_UNSUPPORTED`。
- Claude Code、OpenCode 和 Grok 已补齐原生 Skill 接入，目录与调用规则见 [Claude、OpenCode 与 Grok 原生 Skill 接入记录](20261006-Claude、OpenCode与Grok原生Skill接入记录.md)。Claude 使用 `.claude/skills`；OpenCode 使用原生 API 或 CLI；Grok 使用 `inspect`，不自行扫描以绕过信任配置。
- 三个适配器都只向 Client 返回脱敏摘要，Skill 正文和绝对路径留在 Host；统一 `/` 菜单插入的 `/name` 因而可以复用 Provider 自己的真实 Skill 加载逻辑。

## DSH 统一前端现状

DSH 0.2.1-alpha.1 已提供 `@deepseek-ai/dsh-client-ui-skill`。它注册统一的 `/` Skill 触发源，调用 `sessionSkillCatalog` 的 `skills/list`，支持 Skill 引用预览和 Skill 工具行展示。

这个界面是会话内的 Skill 发现与调用入口，不是跨 Provider 的 Skill CRUD 管理器。外部适配器的 Skill 目录仍由适配器负责发现；本插件通过同一个 `/` 菜单在当前会话切换到支持 Skill 的适配器时复用入口。Claude Code、OpenCode、Grok Build、Codex 和 Command Code 现在都可以复用这一入口，但目录优先级、禁用配置和正文注入仍以各 Provider 的原生规则为准。

## 验证

- `pnpm typecheck` 通过。
- 新增 Command Code Skill 目录扫描、frontmatter 校验、目录优先级、禁用用户调用和 `--skill` 下发测试。
- `claude --help`、OpenCode 官方 API/源码和 `grok inspect --json` 已核对三个 Provider 的真实 Skill 入口；三者均不通过伪造的通用 `--skill` 参数运行。
- 未启动开发服务器，未操作 Desktop、Stage0，也未执行构建、发布或推送。

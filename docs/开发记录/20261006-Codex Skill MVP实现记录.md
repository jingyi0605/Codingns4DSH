# Codex Skill MVP 实现记录

## 目标

让 DSH 在当前会话绑定 Codex 适配器时读取 Codex 的 Skill 目录，并把用户从 `/` 菜单选择的 Skill 以 Codex 原生 `skill` 输入项传入 `turn/start`。Skill 路径和内容只在 Host 侧处理，Client 只接收可展示摘要。

## 改动

- 共享 CLI 契约新增 `skills` 能力、Skill 摘要和目录读取请求。
- Codex app-server 驱动新增 `skills/list` 调用、按工作目录缓存、`skills/changed` 缓存失效和显式 `$skill-name` 解析。
- `turn/start` 在 Skill 目录返回路径时追加 `{ type: 'skill', name, path }`；旧版 app-server 不支持 `skills/list` 时保留 `$skill-name` 文本并继续执行，避免破坏旧 Codex。
- Host CLI Registry 新增 `cli/skills` RPC，响应会剥离 Host-only 路径字段。
- Client 新增 `/skills` 菜单命令。选择条目后把命令替换成 `$skill-name`，提交时由 Codex 驱动完成原生输入转换；直接输入 `$skill-name` 也支持。
- 其他 Agent 暂不声明 `skills` 能力，因此不会出现错误的 Skill 菜单。后续 Agent 只需实现同一 `listSkills` 契约，并在自身协议中完成输入映射。

## 数据边界

```text
DSH / 菜单
  -> cli/skills(sessionId)
  -> Host Registry
  -> Codex skills/list(cwds)
  -> Client 仅收到 id/name/description/enabled/displayName

用户提交 $name
  -> Host 读取已缓存目录
  -> Codex turn/start(input: [{ type: "skill", name, path }])
```

路径不会进入 Client RPC 响应，也不会持久化到 DSH 会话配置。

## 验证

- `pnpm run typecheck` 通过。
- `pnpm run build` 通过。
- `node --test tests/cli-adapters-rpc.spec.ts` 通过，覆盖目录读取、禁用 Skill 过滤和原生 `skill` 输入项。
- `node --test tests/cli-adapters.spec.ts` 通过，覆盖 Registry 路由和 DSH 会话拒绝。
- `pnpm test` 共 1411 个用例，1407 个通过；剩余 4 个失败均来自本次改造前已存在的工作区问题：`xterm-view.ts` 国际化阻断、voice profile manifest 期望和 terminal lifecycle 时序。
- `pnpm run i18n:check` 同样被已有 `src/client/terminal/xterm-view.ts:813` 的内联样式误报阻断；本次新增 Skill 文案已补齐中英文词条。

未启动开发服务器，未操作 Desktop、Stage0 或发布流程。

## MVP 限制

- 当前只接入 Codex 原生 Skill；其他 Agent 仍按原有路径运行。
- 菜单选择使用可回退的 `$skill-name` 草稿文本，不改变 DSH 输入组件的内部结构。
- Codex app-server 必须返回 Skill 路径才能追加结构化输入项；若只返回摘要，仍保留文本 mention，由 Codex 自己处理。

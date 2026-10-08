# PeerHost 远程工作区 Git 面板修复记录

日期：2026-10-08。

## 问题与根因

通过 PeerHost（远程宿主聚合）打开远程工作区后，Git 面板提示“当前没有可用的工作区”，随后停留在读取状态。

源码中存在两处接线缺口：

1. Git 面板直接订阅原生 `workspace/follow`。PeerHost 工作区实际投影在 `workspaces.list` Store（共享状态容器）中，原生工作区流不包含这份投影；远程会话因而无法找到对应工作区。原有唯一工作区回退还可能把它错误关联到本机。
2. Git 面板使用插件 `git/*` RPC（远程过程调用），既有 PeerHost 路由没有覆盖这组接口，代理白名单也只有旧的 `/api/git`，缺少实际使用的 `/api/codingns/git`。

## 修复

- 工作区解析、标签恢复和关闭统一读取侧栏使用的聚合 Store；缺少 Store 的旧宿主继续使用原有 Remote 接口。
- 面板订阅工作区列表，聚合摘要晚到后自动重新解析归属。仅归属变化触发重新加载，普通摘要更新不会清空已展开的 Git 历史。
- 虚拟会话必须有明确的聚合归属；本机会话的目录匹配和唯一工作区回退只考虑本机条目。
- Web 页面与原生连接统一转发 `git/*` 和 `/api` 兼容通道的 `codingns/git/*` 请求。转发只依据顶层 `workspaceId`，提交正文、文件路径等内容不参与 Host 选择。
- 出站请求使用远端真实工作区 ID；响应中的工作区 ID 恢复为虚拟 ID，继续隔离不同 Host 的面板与缓存。
- 聚合作用域失效时明确返回错误，不将远程 Git 请求转到本机；远端业务错误保持原样。
- 代理允许 `/api/codingns/git` 的 POST 请求，保留相邻路径及其他方法的拒绝规则。

## 首轮验证

使用仓库已有的源码加载器，直接在内存转换 TypeScript，未执行构建。

```bash
node --import ./tests/register-source-loader.mjs --test tests/peer-host-git.spec.ts tests/git-management.spec.ts tests/peer-host-http-proxy.spec.ts tests/peer-host-desktop-transport.spec.ts tests/peer-host-model-navigation.spec.ts
pnpm run typecheck
git diff --check
```

首轮 41 项测试全部通过，类型检查通过。新增回归覆盖同 ID 多 Host、归档会话、聚合摘要晚到及移除、缺失归属不回退本机、两种连接及两种 RPC 通道的全部 Git 操作、请求正文保真、响应 ID 投影与代理白名单。

共享路由同时存在其他会话的调试功能改动，已保留并追加 `tests/peer-host-debug.spec.ts` 相邻回归；与 Git、代理测试一起复核的 14 项测试全部通过，再次类型检查和差异检查均通过。验证使用模拟连接及临时 Git 仓库，没有访问真实远端仓库，也没有运行实际界面回放。

首轮仅更新仓库源码、测试与开发记录；没有构建、启动或重启服务，没有操作 Stage0、dsh-web 或 Desktop，没有提交、推送或发布。

## 国际化门禁修复与完整打包复验

用户后续执行 npm 打包时，完整测试暴露两条未接入词典的提示：本次 Git 作用域错误，以及同期调试功能的作用域错误。首轮定向验证未覆盖国际化守卫，这是验证遗漏。

将两条提示迁入 `src/client/locales/peerHost.ts` 的中英文词典。PeerHost 功能启动时向页面 Transport（传输层）注入 DSH locale（语言服务），通过统一翻译函数取词；错误码和路由行为保持不变。新增回归验证同一连接在中英文切换后输出相应语言。

用户明确要求修复并重新测试打包后，执行：

```bash
node --import ./tests/register-source-loader.mjs --test --test-reporter=spec tests/client-i18n.spec.ts tests/peer-host-git.spec.ts tests/peer-host-debug.spec.ts
NPM_PACKAGE_OUTPUT_DIR="$PWD/data/build/npm/peerhost-i18n.HdTw2s" bash scripts/publish-npm-package.sh --mode pack
git diff --check
```

- 国际化与相关定向回归：11 项全部通过。
- 打包脚本中的版本检查、类型检查、完整构建通过。
- 全量测试：2268 项，2266 通过、0 失败、2 跳过。跳过项为需要单独启用的 OpenCode 真实 CLI 冒烟和真实浏览器布局验证。
- npm 安装包：`data/build/npm/peerhost-i18n.HdTw2s/jingyi0605-codingns4dsh-0.2.1-beta.5.tgz`，10446514 字节，1985 个条目。
- 包内 1927 个 dist 文件与当前构建产物逐文件 SHA-256 一致。
- 完整日志：`data/build/npm/peerhost-i18n.HdTw2s/打包验证.log`。

本次产物使用独立目录，保留旧安装包与其他会话改动。仅完成本地构建、测试与打包，没有安装插件、操作 Desktop、启动或重启 DSH 服务，也没有提交、推送或发布 npm。

## 分批提交前复核

后续用户授权仅提交本会话相关变更。同期调试与鉴权改造已经独立提交，共用语言服务已进入基线；本次仅保留 Git 工作区解析、请求转发、Git 国际化词条及其回归与记录。

HTTP 白名单已由同期改造集中到 `src/shared/peer-host-http-routes.ts`，因此本次 Git 条目登记在该文件，同时供发送端代理和目标 LAN（局域网）票据校验使用。`tests/lan-access-dsh.spec.ts` 中新增的 Git 路由检查随本次测试一起提交。

在该最新基线上重新执行类型检查，以及国际化、Git、PeerHost 代理、LAN 鉴权、原生连接与远端调试的源码回归：68 项全部通过。提交按近期历史习惯拆为“修复、测试、文档”三批；`AGENTS.md` 继续保持本机忽略，不纳入提交。此前安装包与日志保持原样，本轮不重新打包或推送。

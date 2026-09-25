# README 截图素材

本目录保存 README（中文 [../../README.md](../../README.md)、英文 [../../README.en.md](../../README.en.md)）使用的截图，两个语言版本共用同一批图片。文件名统一使用英文 kebab-case，README 里用 HTML `<img>` 引用以便控制宽度。

## 已收录截图

| 文件 | 原始文件名 | 内容 | 尺寸 | README 位置 |
| --- | --- | --- | --- | --- |
| `agent-picker.jpg` | 新建会话.png | 输入框 Agent 选择器展开，同时可见带 Agent Logo 的会话列表与归档会话入口 | 1650×958 | `界面预览` 首图 |
| `model-picker.jpg` | 模型选择.png | Codex 模型列表（GPT-6 / GPT-5.6 / GPT-5.5 等）与当前模型、思考强度 | 924×536 | `功能详解 → 外部 Agent 集成` |
| `subscription-usage.jpg` | 订阅信息.png | 上游用量弹层：今日请求与 Token、费用、缓存命中率、按模型统计 | 1028×627 | `功能详解 → 会话增强与订阅用量` |
| `workspace-debug.jpg` | 调试界面.png | 工作区调试面板：Backend 未运行、Frontend 运行中（端口 4174、PID），启动／检查端口／结束进程／停止 | 1305×966 | `功能详解 → 工作区调试` |
| `settings-overview.jpg` | 设置菜单01.png | 设置 → CodingNS：局域网访问 DSH、登录保护、中转访问服务、外部Agent集成 | 995×646 | `功能详解 → 模块与设置` |
| `settings-modules.jpg` | 设置菜单02.png | 七个模块开关全貌与底部版本信息 `DSH-CodingNS v0.1.1` | 993×839 | `功能详解 → 模块与设置` |
| `login-protection.jpg` | 本地保护.png | 本地账号登录页（LOCAL ACCESS）：用户名、密码、登录 DSH Web | 1593×948 | `功能详解 → 登录保护` |
| `relay-service.jpg` | 中转服务.png | 中转访问服务卡片：服务地址、账号、H5 登录页面地址、设备在线状态 | 626×660 | `功能详解 → 远程访问` |
| `relay-h5-login.jpg` | 中转服务登录.png | H5 登录页选择 DSH Host 并连接（`https://dsh.codingns.com`） | 1559×943 | `功能详解 → 远程访问` |
| `relay-status.jpg` | 中转服务状态.png | 账户状态弹层：访问路径（中转 · 21 ms）、CPU、内存与注销登录 | 794×419 | `功能详解 → 远程访问` |

以上均为 JPEG 截图，单张 23–168 KB，无需再压缩。

## 可选补充

| 文件名 | 内容 |
| --- | --- |
| `terminal-persistent.png` | 侧栏终端多个标签，以及「重启 DSH 后终端恢复」的场景 |
| `lan-access.png` | 局域网访问卡片：监听网卡、端口、自动探测到的 DSH 端口与转发状态 |
| `tmux-restore.gif` | 关闭 DSH → 重新启动 → 终端内容仍在的连续过程（GIF，≤5 MB） |
| `agent-stream.gif` | 外部 Agent 流式输出 + 工具调用 + 权限确认在一个回合内出现的过程 |

## 规范

- **命名**：英文 kebab-case，按「功能-对象」命名（如 `relay-h5-login.jpg`），不使用中文文件名。
- **目录**：只放在本目录，不要放进 `docs/配图/`（该目录已被 `.gitignore` 排除，图片无法入库）。
- **尺寸**：宽度 600–1700 px；横图保持原窗口比例，竖图仅用于手机端截图。
- **格式**：JPEG / PNG / WebP 均可，单张 ≤ 500 KB；过程型能力优先用 GIF 或短视频。
- **隐私**：使用演示工作区；避免真实项目名、客户名、内网 IP、token、Cookie、邮箱与真实流量数字，必要时用纯色块遮挡；不要暴露 `~/.config/dsh-codingns/` 下的凭据文件。
- **一致性**：同一批截图使用同一台机器、同一主题与相近窗口宽度。
- **同步**：新增或替换图片后，同时更新 README 的引用和本表。

## 备注

- `assets/provider-icons/**` 已包含在 npm `files` 列表中，本目录未包含，因此截图不会进入 npm 包体积；若希望 npm 页面也显示图片，需要把 `assets/screenshots/**` 加入 `files` 并补上 `package.json` 的 `repository` 字段。

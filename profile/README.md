# Codingns4DSH Profile

这是独立的 Codingns4DSH Profile，插件版本为 `0.2.1-rc.5`，最低支持 DSH `0.2.0-rc.2`，已验证 `0.2.1-rc.3`。更新的 DSH 版本会显示未验证警告，但不会阻止安装或启用。

Profile 选择 `dsh-multi-model-provider` 和 `codingns4dsh` Bundle。
全局语音助理由 CodingNS 自己负责 Host 租约、浏览器设备、PCM 数据面、摘要和动作闭环，
通过插件的可选依赖按需加载 `sherpa-onnx-node@1.13.8`。语音模型仍由用户单独配置，
不进入插件包，也不会在没有模型时伪装成可用能力。
`cordis.patch.yml` 仍只登记 Bundle 级补丁；启动期 Transport 由外部 pre-Cordis
启动胶水在 DSH Client/Cordis 创建前登记。

发布后，在 DSH 的 Profile 中安装精确版本的插件 Bundle：

```bash
dsh plugin --profile codingns4dsh add @jingyi0605/codingns4dsh@0.2.1-rc.5
```

Profile 安装完成后，使用 DSH 官方启动器启动：

```bash
dsh --profile codingns4dsh --dump-config
```

Profile 安装前会读取当前 DSH 运行时版本；低于最低支持版本时安装失败，高于最新验证版本时只告警。
探测顺序与「能否阻断」的对应关系如下：

| 优先级 | 来源 | 是否阻断 |
| --- | --- | --- |
| 1 | `DSH_RUNTIME_VERSION` / `DSH_VERSION`（宿主注入） | 是 |
| 2 | Desktop Runtime 根（`app.asar` 内真实加载的 `@deepseek-ai/dsh`） | 是 |
| 3 | Profile 目录内可解析到的 `@deepseek-ai/dsh` | 是 |
| 4 | `PATH` 上的 `dsh --version` | 否，只告警 |

第 4 项不阻断是刻意的：桌面宿主经 `scrubbedParentEnv()` 派生 pnpm 子进程时会剥离全部
`DSH_*` 变量，命令行启动脚本也可能用绝对路径调用 0.2.x 启动器、同时把旧版 `dsh` 留在
`PATH` 上。`PATH` 上的 `dsh` 只能证明机器上装了某个 DSH，不能证明它就是本次安装所使用的
运行时，因此它只用于提示；否则会把正常安装误判为不兼容。

启动时 Host、Client 和 Bootstrap 还会再次校验最低版本；新版本会告警，但仍然启用插件。

真实 Transport 工厂完成后，桌面壳或页面应先调用 `codingns4dsh/bootstrap` 的
`bootWithPreCordisTransport()`，再启动 DSH Client。DSH 升级后必须先发布匹配的新
Profile 和启动胶水版本。高于当前已验证版本的 DSH 仍可尝试运行；设置页会显示兼容性未验证提示。

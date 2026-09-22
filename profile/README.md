# CodingNS DSH Profile

这是独立的 CodingNS Profile，目标 DSH 版本固定为 `0.1.6-alpha.2`。

Profile 只选择 `dsh-codingns` Bundle。`cordis.patch.yml` 保持 `[]`，因为启动期
Transport 必须由外部 pre-Cordis 启动胶水在 DSH Client/Cordis 创建前登记，不能由
普通动态插件覆盖默认 `connection`。

发布后，在 DSH 的 Profile 中安装精确版本的 Bundle：

```bash
dsh plugin --profile dsh-codingns add dsh-codingns@0.1.0
```

Profile 安装完成后，使用 DSH 官方启动器启动：

```bash
dsh --profile dsh-codingns --dump-config
```

真实 Transport 工厂完成后，桌面壳或页面应先调用 `dsh-codingns/bootstrap` 的
`bootWithPreCordisTransport()`，再启动 DSH Client。DSH 升级后必须先发布匹配的新
Profile 和启动胶水版本。

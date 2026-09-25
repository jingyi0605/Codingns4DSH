# CodingNS DSH Profile

这是独立的 CodingNS Profile，插件版本为 `0.1.0`，兼容 DSH `>=0.1.5-rc.3 <0.1.7-0`，当前测试版本为 `0.1.6-alpha.2`。

Profile 只选择 `dsh-codingns` Bundle。`cordis.patch.yml` 保持 `[]`，因为启动期
Transport 必须由外部 pre-Cordis 启动胶水在 DSH Client/Cordis 创建前登记，不能由
普通动态插件覆盖默认 `connection`。

发布后，在 DSH 的 Profile 中安装精确版本的插件 Bundle：

```bash
dsh plugin --profile dsh-codingns add dsh-codingns@0.1.0
```

Profile 安装完成后，使用 DSH 官方启动器启动：

```bash
dsh --profile dsh-codingns --dump-config
```

Profile 和插件安装前都会读取当前 `dsh --version`；版本不在 Profile 的 `engines.dsh`
范围内时，安装直接失败。启动时 Host、Client 和 Bootstrap 还会再次校验实际 DSH 版本，
不兼容版本不会启用插件。

真实 Transport 工厂完成后，桌面壳或页面应先调用 `dsh-codingns/bootstrap` 的
`bootWithPreCordisTransport()`，再启动 DSH Client。DSH 升级后必须先发布匹配的新
Profile 和启动胶水版本。

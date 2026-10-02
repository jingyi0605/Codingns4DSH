# spec010：终端工作区聚合与内置列表

状态：实施中。

## 这份 Spec 解决什么问题

当前终端把一个 Host 终端映射成一个 DSH Sidebar 标签。DSH 的标签布局按会话保存，Host 终端却按工作区共享，两个生命周期边界不一致，导致以下问题：

1. 同一工作区的新会话会复制终端标签。
2. 关闭一个会话里的终端后，其他会话仍保留已关闭标签。
3. DSH 侧栏的 `multiple`、导航参数和恢复时序会影响终端身份，造成重复终端或残留错误页。

本 Spec 将数据结构改为“每个会话最多一个终端聚合页 + 页内终端列表”，让 Sidebar 只承载面板入口，Host 终端身份由插件内部管理。

## 阅读顺序

1. `requirements.md`：用户可见行为和验收标准。
2. `design.md`：聚合页、终端库存、恢复迁移和生命周期设计。
3. `tasks.md`：按阶段执行的任务以及每完成一项的验证记录。

## 范围

覆盖 `src/client/terminal/model.ts`、`src/client/terminal/recovery.ts`、`src/client/terminal/ui.ts`、`src/client/terminal/xterm-view.ts`、`src/client/terminal/styles.ts` 及对应测试。

不修改 DSH Host、dsh-web 或 Desktop Profile；只更新插件源码和 dsh-stage0 配置/产物。

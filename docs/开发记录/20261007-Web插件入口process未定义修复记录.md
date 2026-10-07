# Web 插件入口 process 未定义修复记录

## 问题与原因

Web 启动报告 `@jingyi0605/codingns4dsh: import failed: process is not defined`，插件在导入阶段失败，尚未进入功能模块激活流程。

终端日志分享弹窗 `src/client/terminal/share-dialog.ts` 新增了 `react-dom` 的 `createPortal` 导入。Web 配置将这项依赖及其 `scheduler` 调度器打进 Client Bundle（客户端打包产物），但没有在编译期替换 `process.env.NODE_ENV`。原产物执行 React DOM 的环境选择分支时直接读取 `process`，浏览器没有这个 Node 全局对象，因此整个插件导入失败。

原有入口测试只检查产物字符串和 Node 专属模块名称，没有实际在浏览器全局条件下执行模块工厂；源码测试则运行在自带 `process` 的 Node 环境，无法发现这个错误。

## 修复

- 在 `tsdown.config.ts` 中将 `process.env.NODE_ENV` 定义为编译期字符串 `"production"`，消除依赖的环境选择分支与开发版代码。
- 保留现有宿主模块加载方式和终端分享行为，不增加运行时全局对象。只替换 `NODE_ENV`，共享调试模块仍可在 Host 中受控读取自己的环境变量。
- 在 `tests/client-entry.spec.ts` 中加入实际执行 DSH Loader（模块加载器）工厂的测试。隔离上下文只提供宿主公开模块和导入阶段所需的浏览器接口，明确检查 `process` 与 `Buffer` 均不存在，并验证插件的 `apply` 与 `inject` 导出。

## 验证

首先在隔离上下文执行原仓库产物，复现 `process is not defined`，堆栈指向 React DOM 环境选择分支。在内存中替换该常量后，同一上下文成功导入插件，验证了原因和修复方向。

修改配置后观察到仓库内现有 `bundle.js` 已更新；直接读取该产物验证，不执行构建命令。产物中已没有 `process.env.NODE_ENV`，也不再包含 React DOM 与 scheduler 的开发版实现。

- Client 入口测试：23 项通过，包含新增的无 Node 全局导入测试。
- 直接加载源码的终端分享、终端 UI、调试日志和包清单测试：56 项通过。
- `pnpm run typecheck` 和 `git diff --check` 通过。

修复验证时未执行构建、安装、启动或重启命令，未操作 dsh-web 或 Desktop。验证覆盖导入阶段和相关回归行为，未进行真实页面的交互与完整激活回放。正在运行的页面需要重新加载实际提供修复产物的 Web 入口；独立部署仍需更新其产物。

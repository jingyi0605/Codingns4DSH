# Quick Apps and controlled static HTTP hosting

Status: Core implementation includes same-address Host previews, PeerHost resource routing, the inline frontend launcher and native document editing, with passing local HTTP/HTTPS/browser checks. Production/platform acceptance and full legacy grant-service consolidation remain blocked. See tasks and acceptance evidence below.

Current default (2026-10-16): user-selected sandboxed HTML preview through the existing DSH Host address. No app domain, certificate or additional port is required. Workspace access remains simple; browser storage and root-relative URLs have sandbox/path compatibility limits. Earlier HTTPS-provider instructions are retained for compatibility, not required setup.

Browser storage (2026-10-17): new sandbox viewers provide the asynchronous `appStorage` API and LocalStorage/SessionStorage compatibility through an application-scoped browser broker. IndexedDB is excluded. API examples, limits and lifecycle details: `docs/开发规范/20261017-快捷应用浏览器存储接口规范.md`.

Stage0 runtime acceptance (2026-10-17, explicitly authorized): the running Stage0 UI in installed Edge on macOS passed persistence, shortcut isolation, tab-session isolation, quota and sandbox checks. Physical-phone and other platform acceptance remain open. See the Stage0 evidence below.

Open HTML applications and text documents from managed workspaces through a lower-left Quick Apps entry. HTML applications receive real HTTP(S) resource URLs so ordinary scripts, modules, styles, images, and `fetch()` calls work without a mandatory CodingNS SDK. Optional workspace writes use a separate, Host-authorized file API.

This specification records the implementation, its changes from the original plan, and acceptance evidence. Repository commits do not deploy the plugin or change running Desktop, Web, or Stage0 instances. The original uncommitted-change review remains a dated historical inventory.

- [Requirements](requirements.md): supported behavior and acceptance criteria.
- [Design](design.md): HTTP hosting, origin isolation, grants, and integration boundaries.
- [Tasks](tasks.md): dependencies, verification, and current progress.
- [Review](docs/20261015-未提交改动归属与方案符合性评审.md): attribution of existing changes and their fit with this plan.
- [Development prompts](docs/20261015-新会话开发提示词.md): copy-ready implementation, continuation, and acceptance prompts for a new session in this repository.
- [Transport evidence](docs/20261015-隔离传输接口调查与阻塞项.md): production prerequisite, local proof and enforced limits.
- [Optional file API](docs/20261015-受控文件HTTP接口说明.md): operation permissions, preconditions and failure handling.
- [Frontend and HTTPS configuration](docs/20261015-独立HTTPS配置与前端入口.md): implemented lower-left entry, operator configuration, credential bootstrap and connection requirements.
- [Parent frontend alignment](docs/20261016-快捷应用前端对齐父仓库.md): inline icon grid above Settings, edit mode, shared form conventions, mobile/full-size viewing and verification.
- [Workspace and file selection](docs/20261016-快捷应用工作区与文件选择.md): native dropdown and visual file selection on the owning Host without a conversation.
- [Native document experience](docs/20261016-快捷应用原生文档体验.md): shared DSH Markdown rendering, CodeMirror editing, scoped saves, draft protection and text/HTML maximize controls.
- [Simplified workspace access](docs/20261016-快捷应用工作区权限简化.md): user-selected HTML read/write/create/delete default, explicit legacy migration, persistent revocation and verification.
- [LAN address and separate ports](docs/20261016-局域网地址与独立端口托管.md): reuse an existing hostname or IP without wildcard DNS; HTTPS configuration, proxy guard, durable port reservations and verification.
- [Acceptance matrix](docs/20261015-实现验收矩阵与剩余条件.md): actual verification, review scope and explicit remaining gaps.
- [Host proxy and LAN recovery](docs/20261016-主机代理预览与局域网回归修复.md): current default, workspace boundary, sandbox compatibility limits, normal LAN recovery and actual verification.
- [Stage0 browser-storage acceptance](docs/20261017-Stage0浏览器存储实机验收.md): actual Mac/Edge launcher and viewer results, captured evidence, probe cleanup and remaining platform limits.

The standard filenames follow `specs/000-Spec规范/Spec模板/`. Supplementary documents use dated Chinese filenames; their contents are English.

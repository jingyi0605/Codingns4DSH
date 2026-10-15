# Quick Apps and controlled static HTTP hosting

Status: Draft. Spec workflow requested on 2026-10-15; implementation has not started.

Open HTML applications and text documents from managed workspaces through a lower-left Quick Apps entry. HTML applications receive real HTTP(S) resource URLs so ordinary scripts, modules, styles, images, and `fetch()` calls work without a mandatory CodingNS SDK. Optional workspace writes use a separate, Host-authorized file API.

This specification records the plan and a review of existing uncommitted changes. It does not deploy the earlier preview connector or change running Desktop, Web, or Stage0 instances.

- [Requirements](requirements.md): supported behavior and acceptance criteria.
- [Design](design.md): HTTP hosting, origin isolation, grants, and integration boundaries.
- [Tasks](tasks.md): dependencies, verification, and current progress.
- [Review](docs/20261015-未提交改动归属与方案符合性评审.md): attribution of existing changes and their fit with this plan.
- [Development prompts](docs/20261015-新会话开发提示词.md): copy-ready implementation, continuation, and acceptance prompts for a new session in this repository.

The standard filenames follow `specs/000-Spec规范/Spec模板/`. Supplementary documents use dated Chinese filenames; their contents are English.

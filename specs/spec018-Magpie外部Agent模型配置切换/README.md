# Spec018: Read-only Magpie model metadata, usage, and route integration

Status: Complete. This Spec adds read-only Magpie model metadata to mapped Agent catalogs, makes exact Magpie Codex models selectable when Codex `model/list` omits them, and corrects Codex's context window for `auto/gpt-6.1-sol` before usage stabilization. The ordinary Agent model picker remains the only model-selection path.

Magpie already integrates its configured provider/model choices into each Agent. CodingNS therefore does not switch, persist, restore, or otherwise write Magpie model configuration. No `cli/magpie/models` or `cli/magpie/set-model` RPC exists in the current implementation, and no Client model provenance is persisted.

- Requirements: `specs/spec018-Magpie外部Agent模型配置切换/requirements.md`
- Design and integration boundaries: `specs/spec018-Magpie外部Agent模型配置切换/design.md`
- Tasks and verification: `specs/spec018-Magpie外部Agent模型配置切换/tasks.md`
- Scope-change record: `specs/spec018-Magpie外部Agent模型配置切换/docs/20261021-Magpie范围调整与代码清理.md`
- Live model metadata and Codex context evidence: `specs/spec018-Magpie外部Agent模型配置切换/docs/20261021-Magpie模型元数据实机读取与上下文纠正验证.md`
- Historical CLI feasibility evidence: `specs/spec018-Magpie外部Agent模型配置切换/docs/20261019-MagpieCLI切换可行性验证.md`
- Historical selector implementation evidence: `specs/spec018-Magpie外部Agent模型配置切换/docs/20261020-Magpie模型选择实现与验证.md`
- Usage implementation evidence: `specs/spec018-Magpie外部Agent模型配置切换/docs/20261020-Magpie用量读取实现与验证.md`
- Official Magpie overview: https://github.com/yetone/magpie/blob/main/README.zh-CN.md
- Official Magpie reference: https://github.com/yetone/magpie/blob/main/docs/reference.md

For model metadata and usage, the Host checks exact membership in the mapped Magpie Agent catalog and reads only bounded, sanitized fields from the local Gateway. Missing or unlinked data preserves the Agent's existing metadata and ordinary provider usage. CodingNS never starts Magpie, performs inference, or writes Magpie/Agent configuration.

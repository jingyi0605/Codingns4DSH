# Spec019: Global Assistant Extraction and Performance Governance

Status: Approved for implementation by the user on 2026-10-29. Performance/lifecycle fixes are in progress; independent package extraction is blocked on a neutral Host/Client/settings contract. No commit, push, release, package publication, or Desktop operation is authorized.

This Spec proposes extracting the global intelligent assistant from CodingNS4DSH into an independently installable DSH plugin, then removing the assistant-specific runtime and UI from the base plugin. It also treats the reported idle-performance impact as a first-class acceptance requirement: extraction alone is not a performance fix unless the remaining plugin and the new assistant plugin pass explicit idle and active-workload checks.

## Documents

- [Requirements](requirements.md): extraction goals, compatibility, and acceptance criteria.
- [Design](design.md): ownership boundaries, migration strategy, and performance model.
- [Tasks](tasks.md): implementation phases and verification requirements.
- [Current-state and performance hotspot review](docs/20261029-助理模块现状与性能热点.md): source-based observations; not a machine benchmark.
- [Implementation progress](../../docs/开发记录/20261029-全局助理空闲性能治理与独立化阶段记录.md): completed performance changes, verification, and remaining extraction work.
- [Supporting material index](docs/README.md).

## Existing assistant Specs

This Spec coordinates, but does not silently rewrite or mark complete, the existing assistant work:

- [Spec013: Programming assistant voice aggregation and real-time conversation](../spec013-编程助理语音汇聚与实时对话/README.md)
- [Spec013.1: Assistant lifecycle integration](../spec013.1-智能助理生命周期集成/README.md)
- [Spec014: Global assistant avatar slot](../spec014-全局助理统一形象插槽/README.md)
- [Spec014.1: Assistant session notifications and emotional feedback](../spec014.1-全局助理会话提醒与情绪反馈/README.md)

Their feature contracts and historical acceptance evidence remain authoritative until each migration task is explicitly completed and cross-referenced here. This Spec owns the extraction boundary, compatibility plan, and cross-cutting performance acceptance.

## Guardrails

- Keep the base plugin useful and installable without the assistant plugin or assistant-only dependencies.
- Preserve existing assistant data and settings through an explicit, reversible migration; never silently start background work during migration.
- No Desktop profile, process, installation, or running plugin operation is authorized by this Spec.
- The standalone project target is `/Users/jackson/Code/CodingNS/data/dsh-global-assistant`, selected by the user. Keep it separate from the existing `dsh-codingns` checkout.
- Source changes, tests, and local packaging are authorized. Commit, push, release, package publication, and Desktop installation remain unauthorized.
- Shared package/version/lockfile changes appeared during this task and were left untouched. Full build/package checks were not run against the concurrently changing manifest.

# Supporting material: Spec007.4

The canonical source investigation is `docs/调查报告/20261017-外部Agent团队协作与管理兼容性调查.md`. That directory is local under the repository's existing `.gitignore`; core findings and policy are included in the main Spec documents so the plan remains understandable without the local report.

Implementation decisions and acceptance results are in `docs/开发记录/20261017-外部Agent团队协作与管理开发记录.md`; tracked findings and validation limits are also recorded in the Spec README and task list. Native/external and mixed Codex/Claude reference acceptance passed on alpha.2 and alpha.3. Interface/version investigations belong under `docs/调查报告/`; reusable rules belong under `docs/开发规范/`.

The [session failure regression record](20261017-团队会话故障回归记录.md) covers the user's subsequent OpenCode/Codex exports and the source fixes, separately from the earlier live reference acceptance.

The [Stage0 translation and Team integration record](20261017-会话翻译与团队协作联调记录.md) covers the explicitly enabled development profile, real configured model calls, initial/follow-up sessions, mixed-input translation/cancellation, and the additional startup/route-synchronization findings.

The [Grok teammate permission regression](20261017-Grok队友权限故障回归记录.md) traces the supplied export's automatic approval-policy rejection and records the scoped Team admission fix and verification.

The [Claude retry notification regression](20261017-Claude重试通知误判故障回归记录.md) connects the exported `server_error` failures to raw HTTP 502 retry records, documents the shared parser correction, and records its protocol verification and upstream availability limits.

The [Stage0 adapter acceptance matrix](20261017-Stage0全适配器团队与委派验收记录.md) records the subsequent `0.2.1-rc.2` Team and ordinary-delegation tests, observed transport/model/permission/reporting failures, test-fixture corrections, and the user's exclusion of Claude Code.

The [Command Code and Grok correction record](20261017-CommandCode与Grok团队故障修复记录.md) follows those failures through actual ACP Mod startup, scoped permission admission, Grok's fetched model catalog, and focused source/live verification.

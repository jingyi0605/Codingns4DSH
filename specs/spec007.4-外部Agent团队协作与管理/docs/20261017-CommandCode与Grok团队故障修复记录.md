# Command Code and Grok Team workflow corrections

## Evidence and scope

The user requested fixes for Command Code and Grok after the Stage0 adapter matrix. This follow-up remains in Spec007.4 and addresses their observed Team transport and permission failures. Claude Code remains excluded from live tests. Unrelated pending source changes are preserved; no installation, Desktop operation, commit, push, or release is part of this work.

The initial evidence is `specs/spec007.4-外部Agent团队协作与管理/docs/20261017-Stage0全适配器团队与委派验收记录.md`. The target remains the ownership-checked Stage0 PID `79487`, DSH `0.2.1-rc.2`, profile `stage0`, home `/Users/jackson/.dsh-stage0-020`, port `17891`. Retests use temporary workspaces and actual injected/native tools through that endpoint, preserving saved model, effort, translation, and permission choices.

## Command Code: apply the managed Mod in ACP startup

The installed Command Code 1.82.5 bundle's ordinary CLI action calls `setModPathsOverride()` for `--mod`, but its ACP subcommand calls `runAcp()` directly. That entrypoint loads the Mod host without applying those overrides. Passing the documented global argument before `acp` therefore did not load CodingNS's Mod in the observed runtime.

This explains why source fixtures that invoked `codingNsSubagentMod()` directly passed while the actual Team tool was unavailable. The ordinary ACP MCP bridge still worked, masking the missing Mod in basic delegation. The Team route deliberately uses the local Mod and has no duplicate MCP tool.

`src/host/cli-adapters/command-code-acp-loader.ts` now applies the existing managed Mod path before ACP creates its host. The rewrite requires the known upstream `runAcp` and `setModPathsOverride` declarations and is active only with CodingNS's existing `CODINGNS_DISABLE_NATIVE_AGENT=1` launch marker. It changes the loaded module in memory, retaining the existing question/BYOK compatibility loader and leaving the installed CLI package untouched. Standalone launches and unrecognized entrypoints retain their previous behavior.

The real Mod now supplies the role-specific Team schema and its native-agent blocking hooks. Legacy `-p` behavior is unchanged. A future incompatible upstream entrypoint still requires transport qualification; a passing fixture does not certify an unknown CLI version.

## Grok: preserve already-admitted authority

The driver previously recognized only the exact bound Team coordination tool as already admitted. Every other ACP permission request reached native approval, even for a workspace file write or an ordinary child's report to its parent. Inherited `never` rejected these requests before the intended operation could finish.

`src/host/cli-adapters/grok-driver.ts` now admits only these existing authorities with an offered one-time allow option:

- The exact session-bound `codingns__agent_team` tool with a current Team credential.
- The exact injected ordinary `codingns__agent_subagent` bridge with a current runtime credential, outside a Team tool session. The bridge still enforces caller, parent, and child-operation restrictions.
- Concrete built-in `write`/`edit` targets within the effective file scope. Workspace admission requires a valid absolute cwd and canonical target containment. Full-access file scope remains distinct from automatic shell approval.

The driver correlates file targets and canonical tool identity with their observed tool-call IDs. Real permission requests can replace the name with a display title such as `Write /path`; that label is not used as the tool identity. Explicit conflicting identities still fail admission. Unknown arguments, conflicting path aliases, outside targets, sibling-prefix tricks, broken links, and symlink escapes retain native approval. Canonicalization uses the native realpath implementation so symlink traversal followed by `..` is resolved before containment is checked. New missing path suffixes are resolved from an existing canonical ancestor.

Plan mode, read-only/unknown scope, explicit risk requests, and permanent-only grants are not automatically admitted. Arbitrary shell commands still require native approval. The existing `--always-approve` flag remains restricted to confirmed full-access/never; workspace-write does not enable it. File-inspection guidance directs the model to the built-in file reader rather than unnecessary shell commands. Existing bridge guidance now names the actual injected tool in Grok's model prompt and explains automatic final-result delivery, avoiding searches for unavailable native reporting tools.

The ordinary bridge credential also participates in process reuse. A replaced bridge reopens the transport and restores the existing provider conversation; stale injected credentials are not silently reused. Team identity/role checks remain in the existing bound bridge.

## Grok: use the fetched model list

A fresh Team retest found an additional prerequisite failure: `TEAM_MODEL_UNSUPPORTED` for the saved `grok-4.7-build-fast` selection. The ACP `session/new` probe returned bootstrap IDs `grok-4.6`, `grok-4.5`, and a configured custom model. The installed CLI's native `grok models` command waited for its fetched catalog and correctly listed `grok-4.7` and `grok-4.7-build-fast` as well.

The driver now probes that native command alongside ACP discovery. A recognized successful native list determines selectable IDs; ACP remains the compatibility fallback when the command is unavailable or its output is unrecognized. Optional native cache metadata supplies names and declared reasoning efforts only for IDs in the command's filtered list. Cache-only entries cannot add models. The driver also retains its existing `provider-default` sentinel.

This preserves the user's configured model and does not weaken Team model validation or substitute another model. The corrected live catalog lists `provider-default`, `grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`, and the existing custom route. Only model metadata is projected; cached credential fields are never returned or logged.

## Ordinary follow-up: correlate the accepted message

The ordinary Command Code and Grok controls produced real second-turn ACKs, but repeated read/wait calls still returned their first-turn text. Both complete workflows eventually passed using the native closing notification, exposing a shared status defect rather than another adapter execution failure.

Idle native child sessions can be evicted from the in-memory store. The existing pre-send event cursor is then zero. Sending the follow-up restores the old session history; the observer immediately mistakes its historical first-turn ending for the new turn. Two failing-first cold-eviction regressions reproduce the exact result.

The existing lifecycle observer now receives the native send result's `messageId` through both the Host tool and MCP bridge paths. It ignores historical and unrelated terminal results until the corresponding `user/message` event confirms that input was consumed. The existing sequence cursor remains useful for warm sessions, and callers without a message ID retain their previous behavior. No new task store, provider session, retry, or replay is introduced.

## Verification

Five behavior regressions failed before the implementation: Command Code Mod initialization, new/nested/existing workspace writes, and ordinary parent reporting. The initial log also contained one permanent-grant fixture expectation corrected to the existing cancelled-response contract. A separate catalog regression failed against the old probe. A real-request follow-up added a failing-first formatted permission-title regression, followed by the canonical-identity correction. Negative permission cases passed before and after the change.

Final source verification passed 145 focused tests and 65 additional native-session/delegation compatibility tests, with zero failures/skips. Coverage includes Command Code ACP, Grok catalog/permissions/lifecycles, Team recovery/admission, ordinary bridge behavior, and cold follow-up restoration. Tests include formatted permission labels, outside paths, symlink and dot-segment escapes, missing/correlated inputs, native denial preservation, one-time grants, revoked identities, and exact-session recovery. Typecheck, version synchronization, capability retirement, script syntax, and whitespace checks passed. No DSH compatibility bounds or capability interfaces changed.

Logs:

- `/tmp/codingns-command-grok-regression-before.log`
- `/tmp/codingns-grok-catalog-before.log`
- `/tmp/codingns-grok-display-title-before.log`
- `/tmp/codingns-native-followup-before.log`
- `/tmp/codingns-command-grok-regressions-final.log`
- `/tmp/codingns-command-grok-followup-compatibility.log`
- `/tmp/codingns-command-grok-typecheck.log`
- `/tmp/codingns-command-grok-version.log`
- `/tmp/codingns-command-grok-capability.log`
- `/tmp/codingns-stage0-fix-grok-models.json` and `/tmp/codingns-stage0-fix-grok-models-after.json`

Early development controls confirmed real Command Code Team tool calls and completed worker artifacts, plus successful ordinary Grok reporting. Interrupted controls are retained as development evidence, not passed complete acceptance cases. A later Grok worker exposed the formatted-title failure; that owned case was stopped after its native policy denial and was not bypassed with a different tool. Its replacement validation uses a new workspace after the source correction.

One ordinary Grok control completed its child successfully but the next translated input submission exceeded the runner's 30-second HTTP timeout. The runner now allows 120 seconds for `session/prompt` submission while retaining the separate per-round budget. It does not retry an uncertain submission; final controls use new sessions. This is a fixture deadline correction, not a change to translation settings or approval policy.

## Final Stage0 acceptance

All six required workflows passed both rounds on Stage0 `0.2.1-rc.2`:

| Adapter | Ordinary delegation | Team collaborator | Team Lead |
| --- | --- | --- | --- |
| Command Code 1.82.5 | Passed; read/wait returns the new ACK | Passed | Passed |
| Grok Build 1.0.62 | Passed; read/wait returns the new ACK | Passed | Passed |

Every case retained the same child and provider conversation. Team tasks stayed completed at revision 3, and their artifact hashes were unchanged during follow-up. Command Code used saved `deepseek/deepseek-v4.1-flash`; Grok used saved `grok-4.7-build-fast`; counterpart sessions used saved Codex settings. Actual request headers verified routing. Initial native spawn-response model metadata can still reflect the inherited parent model; it was not treated as execution evidence.

Both final ordinary cases restored cold child sessions. Read/wait directly returned `DELEGATE_ACK 55`; no completed result after send returned the stale `DELEGATE_DONE 55`. The sent message ID matched the child's consumed input record.

| Case | Parent session | Child session | Private log |
| --- | --- | --- | --- |
| Command Code collaborator | `session-3b97abf4-cb44-4e15-b7f6-af5e376fa0e9` | `38b5ab99-32a3-4244-b284-4971772902f6` | `/tmp/codingns-stage0-fix-command-code-member-v2.log` |
| Command Code Lead | `session-97a3294d-4776-4de2-b7e3-ae49a1db298c` | `94f9878a-20a6-47ec-92b3-492cb51b9cc2` | `/tmp/codingns-stage0-fix-command-code-lead-v2.log` |
| Grok collaborator | `session-867ee745-d2ba-4573-b6a0-544442d07740` | `112df811-6e34-43c5-a798-6070623c5c4e` | `/tmp/codingns-stage0-fix-grok-member-v3.log` |
| Grok Lead | `session-741aee2e-b0e6-4798-8734-3eb539914371` | `65bc8d08-c99d-42f3-a781-6f4b8dd3099a` | `/tmp/codingns-stage0-fix-grok-lead-v3.log` |
| Command Code ordinary | `session-3f812e6f-ac8e-46ad-9db0-d26a917277eb` | `0d11e133-f44e-40bb-b84d-f4342e4608b9` | `/tmp/codingns-stage0-fix-command-code-delegate-v4.log` |
| Grok ordinary | `session-390fdee2-b7d4-408a-831f-3f5b0fce7324` | `7c660765-9133-4835-b5da-9252b27d39d5` | `/tmp/codingns-stage0-fix-grok-delegate-v4.log` |

All accepted cases recorded zero native approval requests. Adapter preferences matched preflight exactly, and no approval policy was relaxed. The audit found zero active owned test turns and zero unresolved approvals; Stage0 remained running. No Claude live tests or Desktop operations occurred in this follow-up.

Final evidence is `/tmp/codingns-stage0-command-grok-final-audit.json`, including per-case workspace paths, selected models, conversation identity, direct ACK checks, cold restoration, and settings/cleanup checks. Interrupted controls remain separate. No commit, push, release, or publication was performed.

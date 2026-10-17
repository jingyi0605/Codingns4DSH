# Requirements: External Agent Team collaboration and management

Status: Implemented and verified on 2026-10-17, with DSH `0.2.1-alpha.2` as the full-Team minimum. Reference acceptance uses Codex/Claude and a deterministic native model fixture; other adapter eligibility and validation limits are recorded in the Spec README and tasks.

## Terminology and scope

- **Lead:** the exact live DSH Agent executing the Team root session. Its execution backend may be native DSH or an eligible external adapter.
- **Teammate:** a named direct child created and recorded by native TeamService.
- **External participant:** a real DSH Agent/Session whose execution is routed through a CodingNS adapter.
- **Full Team support:** roster membership, peer input/output, shared tasks, lifecycle handling, and role-appropriate tools have passed the advertised version/adapter checks.
- **Ordinary subagent:** a child created through existing delegation, without native Team roster membership.

The scope covers native, external, and mixed Teams on the same Host. It excludes a separate orchestration authority, standalone CLI managers, multiple Leads, promotion, nested Teams, remote membership, worktree isolation, external history forks, and new Agent adapters. Installation alone does not establish Team eligibility.

## R1: DSH remains the authority

As a user, I want external participants to use the existing Team roster and task board.

1. WHEN a teammate is requested, the system SHALL use native `spawnTeammate()` and the registered continuable provider; it SHALL NOT substitute an ordinary child or fabricate projection records.
2. WHEN participants query or mutate membership and tasks, the system SHALL use native TeamService and its revision/authorization checks. CodingNS SHALL NOT maintain a competing authoritative task board.
3. WHEN an external session is the ordinary runtime root, it SHALL be eligible for Lead tools after its exact live identity and native membership are verified.
4. WHEN a teammate requests Lead-only operations, the system SHALL reject them. Changing backend SHALL NOT promote a teammate or change task authority.

## R2: Collaborator and Lead tools

As an external participant, I want to collaborate without using a separate provider-owned agent team.

1. WHEN Team mode is active, participants SHALL receive a canonical CodingNS Team tool with membership, roster, peer messaging, task create/list/get/update, and bounded-wait actions.
2. WHEN the caller is Lead, its tool contract SHALL additionally expose teammate creation and interruption; native Team rules SHALL govern task reassignment.
3. WHEN exposing tools, the system SHALL provide the caller's actual Team role/name and the exact transport-specific tool identifier. Model text SHALL NOT be trusted as an authority claim.
4. WHEN Team mode is inactive or unsupported, existing `agent_subagent`/delegation contracts and guidance SHALL remain compatible. A Team teammate SHALL NOT gain nested ordinary-subagent creation.
5. WHEN a native DSH Lead selects an external teammate, a plugin tool SHALL provide adapter/model selection without replacing official Team tool registrations.
6. WHEN Team tools are available, teammate creation SHALL still follow the native policy requiring the user's explicit request to use Teams/teammates; tool availability alone SHALL NOT trigger delegation.

## R3: Adapter selection and teammate creation

As a Lead, I want each teammate to use the intended installed Agent and model.

1. WHEN creating an external teammate, the system SHALL check installation, enablement, continuable-provider registration, Team tool transport, and the adapter's verified role support.
2. WHEN model or effort overrides are supplied, the system SHALL validate supported values and apply them to that child only. It SHALL reject unsupported overrides and preserve unrelated session bindings and preferences.
3. WHEN concurrent requests select the same adapter with different models, the system SHALL prevent selection leakage while allowing the created children to execute concurrently.
4. WHEN a native child is requested from an external Lead, the system SHALL explicitly preserve native execution rather than accidentally inherit the external execution route.
5. WHEN external history-fork mode is requested, the system SHALL return an unsupported diagnostic until a separate verified contract exists. Initial external members use fresh history and inherit the effective DSH permission boundary.

## R4: Peer input reaches the external runtime

As a participant, I want a Team message to become actionable input rather than repeat my original task.

1. WHEN native DSH accepts an `agent-message` relay, the system SHALL preserve its sender identity and forward its content to the intended external provider turn.
2. WHEN several peer messages are accepted, the system SHALL preserve inbox order and include each newly accepted input in the appropriate dispatch. It SHALL NOT select only the old human prompt or silently discard sibling messages.
3. WHEN the target is running, forwarding SHALL occur at a supported step/steer boundary; WHEN inactive, native wake-up or cold resume SHALL trigger external execution.
4. WHEN execution is segmented, the system SHALL distinguish internal continuation notices from new human/peer input and avoid resending already-consumed input within the same live execution.
5. WHEN restart or transport failure leaves provider acceptance uncertain, the system SHALL preserve the uncertainty and avoid automatic replay. It SHALL NOT claim cross-process exactly-once delivery.
6. WHEN historical `team-message` input is replayed, its source and sender SHALL remain intact; this SHALL NOT enable new legacy-mailbox Team operations on unsupported DSH versions.

## R5: Shared tasks and truthful results

As a participant, I want task ownership and completion to remain consistent with native Team behavior.

1. WHEN updating a task, the request SHALL include the current `expectedRevision`; stale revisions, ownership violations, blocked claims, and invalid transitions SHALL retain explainable native errors.
2. WHEN spawning succeeds, the result SHALL describe roster provisioning/activity and SHALL NOT report task completion.
3. WHEN a message is accepted, the result SHALL identify inbox acceptance and SHALL NOT imply model processing or completion.
4. WHEN a task becomes ready, the system SHALL NOT claim this automatically schedules its owner. WHEN a member becomes inactive or is interrupted, the system SHALL NOT silently release its task ownership.
5. WHEN waiting, the operation SHALL be bounded and cancellable and SHALL report changes/timeouts without treating inactivity as success.

## R6: Identity, permission, and resource ownership

As a user, I want Team tools to retain the same session and permission boundaries as ordinary execution.

1. WHEN a local external process calls the bridge, the Host SHALL derive its session from a session-bound runtime credential and resolve the exact live Agent. Arbitrary caller IDs, role claims, and browser-peer claims in tool input SHALL be rejected.
2. WHEN routing to another member, native TeamService SHALL authorize the target and actual sender; direct arbitrary-session injection SHALL NOT replace this check.
3. WHEN a child starts, the effective inherited DSH policies SHALL constrain the external driver. Enabling Team tools SHALL NOT elevate filesystem/network access or change approval policy.
4. WHEN cancelled, disposed, or restarted, the system SHALL release its own waiters, listeners, launch credentials, and provider execution resources without stopping unrelated sessions or processes.
5. WHEN restoring a binding, the system SHALL resume the same native and provider sessions where supported. Identity mismatch or unavailable provider state SHALL produce a diagnostic rather than silently create a replacement.

## R7: DSH and adapter compatibility

As a maintainer, I want full Team support to have a clear minimum without dropping existing users.

1. WHEN running DSH alpha.2 or alpha.3, full Team support SHALL require the matching capability route, live Team services, bridge enablement, and an eligible adapter. Future DSH versions SHALL remain unverified until separately reviewed.
2. WHEN running rc.2 or alpha.1, new external Team tools/creation SHALL be unavailable with a version diagnostic; ordinary external sessions, native DSH Team behavior, and existing delegation SHALL remain unchanged.
3. WHEN an earlier historical fixture is probed, it SHALL produce an explainable unsupported result rather than accidentally enable the new feature.
4. WHEN Team services are absent or removed, only the Team integration SHALL degrade. The bridge SHALL follow optional service lifetimes and SHALL NOT automatically install/enable the native Team profile.
5. WHEN reporting adapter support, collaborator and Lead eligibility SHALL be recorded separately and supported by protocol tests and the required acceptance evidence. Codex/Claude are the reference workflows; other registered providers require individual assessment.
6. WHEN opening legacy mailbox history after upgrade, the system SHALL NOT automatically replay historical pending sends or represent them as newly delivered. Runtime support SHALL NOT imply downgrade compatibility for newer session logs.

## R8: Native presentation and verification

As a user, I want one coherent Team view and clear limits.

1. WHEN a real external participant joins, the native Team panel SHALL obtain roster/task state through DSH projections; existing CodingNS conversation rendering SHALL show external tools, permissions, questions, and usage where actually supported.
2. WHEN support is unavailable, existing Agent controls SHALL show a concise reason without exposing credentials or raw protocol payloads. A separate Team dashboard is outside scope.
3. WHEN reporting completion, documentation SHALL distinguish source tests, version fixtures, adapter protocol checks, and real runtime acceptance.
4. WHEN verifying implementation, the system SHALL use repository source tests and static checks first. Builds, servers, live calls, application changes, Desktop operations, and releases require the applicable explicit authorization.

## Success criteria

The three Lead/backend combinations pass on alpha.2 and alpha.3 for the advertised adapters; accepted peer input reaches the correct provider; native task/role checks remain authoritative; old-version ordinary workflows regress cleanly. Implementation is complete only after task evidence and remaining exclusions are recorded.

# Tasks - External Agent Workspace MCP Control

Status: Draft

## Phase 1: Resolve product and capability boundaries

- [x] 1.1 Decide target MCP consumers and transport deployment
  - State: DONE
  - Work: Use a loopback HTTP MCP endpoint. External clients provide the generated Host-private Bearer key; the module settings generate, persist, and rotate it while enabling the listener.
  - Read: `requirements.md`; `design.md` §§4–5; `src/host/cli-bridge/`.
  - Files: `design.md` and, if needed, a dated investigation report under `docs/调查报告/`.
  - Excludes: Operating Desktop or changing dsh-web.
  - Complete when: Transport, startup owner, credential lifetime, revocation, and workspace/tool scoping have explicit decisions.
  - Verify: Review decisions against existing bridge behavior and Host lifecycle.

- [x] 1.2 Map required operations to supported DSH capabilities
  - State: DONE
  - Work: Verify session create/list/continue, question enumeration/answer, approval request/status, workspace authorization, terminal output/read, and terminal input routes for supported DSH versions.
  - Read: `src/host/native-session-bridge.ts`; `src/host/terminal/`; `src/dsh-capabilities/`; current version matrix/routes.
  - Files: `design.md` and a dated investigation report under `docs/调查报告/` if external/version evidence is needed.
  - Excludes: Implementing undocumented private DSH calls or scraping session logs as a substitute for supported APIs.
  - Complete when: Every proposed MCP tool maps to a supported route, fallback/diagnostic, and version fixture.
  - Verify: Capability matrix review and focused fake-context probes.

- [x] 1.3 Finalize access and approval model
  - State: DONE
  - Work: Require a generated Host-private API key, loopback-only binding, live workspace validation, explicit terminal-write tools, and native human-mediated approval. Key generation is owner-authorized and returns the secret only once; no anonymous mode or general settings-document secret storage.
  - Read: `requirements.md` §§2–4; `design.md` §§5–6; existing approval/terminal contracts.
  - Files: `requirements.md`, `design.md`.
  - Excludes: External caller self-approval or broad arbitrary shell execution.
  - Complete when: Negative authorization cases and fail-closed behavior are explicit.
  - Verify: Threat-model review with cross-session/workspace cases.

## Phase 2: Implement isolated Host feature

- [x] 2.1 Add fixed MCP tool contracts and transport
  - State: DONE
  - Work: Implement the selected MCP transport, bounded schemas, authentication, and operation dispatch in a new feature-owned boundary.
  - Depends on: 1.1, 1.3
  - Files: New Host feature/transport files, focused tests, `src/host/features/index.ts` only if required.
  - Excludes: Broadening existing adapter-scoped credentials or generic RPC dispatch.
  - Complete when: Only fixed tools are discoverable and all invalid/unauthenticated calls fail closed.
  - Verify: MCP protocol tests, auth/revocation tests, malformed and size-bound tests.

- [x] 2.2 Implement session and interaction tools
  - State: DONE
  - Work: Implement create/list/continue, pending questions/answer, and permission request/status using verified native routes.
  - Depends on: 1.2, 2.1
  - Files: New feature dispatcher and tests; capability adapters only where required.
  - Excludes: Duplicated session/interaction stores or invented approval outcomes.
  - Complete when: All operations enforce current caller scope and preserve native status/error semantics.
  - Verify: Fake native-service tests for valid, stale, duplicate, unavailable, and cross-scope cases.

- [x] 2.3 Implement terminal tools
  - State: DONE
  - Work: Add bounded terminal output and authorized terminal input through existing terminal services, or explicitly defer either tool if no supported Host API exists.
  - Depends on: 1.2, 1.3, 2.1
  - Files: New feature dispatcher and tests; minimal terminal service additions only if supported by current architecture.
  - Excludes: Starting raw processes or bypassing terminal profiles and policy.
  - Complete when: Unauthorized, stale, oversized, or unavailable terminal operations fail closed.
  - Verify: Ownership, output truncation/cursor, input bound, and service-unavailable tests.

- [x] 2.4 Lifecycle and regression coverage
  - State: DONE
  - Work: Ensure feature stop/restart revokes credentials and settles waiters; prove existing MCP bridge behavior remains unchanged.
  - Depends on: 2.1–2.3
  - Files: New lifecycle/regression tests and feature code.
  - Excludes: Desktop operations, publishing, commit, or release.
  - Complete when: No listener, credential, waiter, or subscription survives feature disposal; existing bridge regressions pass.
  - Verify: Focused suite, typecheck, version/capability checks, full test suite.

## Verification record

- [x] Key management follow-up: generate/rotate a random bearer key from module settings, store it in a Host-private owner-only file, and enable the listener without environment setup.
  - State: DONE
  - Verify: 77 focused Host MCP, transport, capability, settings, and Host reload tests pass; `pnpm run typecheck`, `pnpm run version:check`, `pnpm run capability:check`, `pnpm run i18n:check`, and `git diff --check` pass.

- Focused Workspace MCP transport, tool, and capability tests pass after final lifecycle changes: 45 passed, 0 failed, using the in-memory source loader.
- `pnpm run typecheck`, `pnpm run version:check`, and `pnpm run capability:check` pass after final changes.
- The full source-level repository suite passed before the final opt-in/default-key and open-question-state refinements: 4,090 passed, 16 skipped, 0 failed. The changed paths were re-covered by the final 45-test focused run.
- `pnpm run i18n:check` passed with 0 blocking violations; it reports 201 existing warning-level Chinese exception/log strings.
- No development server, Desktop profile, process, or dsh-web instance was started or operated.

# Tasks — Quick Apps and controlled static HTTP hosting

Status: Draft. Specification and change review are complete; implementation tasks remain TODO.

States: TODO, IN_PROGRESS, IN_REVIEW, DONE, BLOCKED, CANCELLED. Only DONE tasks may be checked. A blocked/cancelled task must include its reason. Every task below is required unless explicitly identified as outside this Spec.

## Stage 0 — Establish scope and preserve existing work

- [x] T0. Prepare the Spec and classify uncommitted changes
  - Status: DONE
  - Work: record the agreed HTTP hosting plan, inspect each existing diff, and distinguish this session's connector from translation work.
  - Visible result: requirements, design, tasks, and a timestamped file-by-file review.
  - Depends on: none.
  - Read first: `AGENTS.md`; `specs/000-Spec规范/Spec模板/`; the current conversation's latest HTTP plan.
  - Main files: this Spec directory and the two repository README links.
  - Excludes: runtime edits, cleanup/reverts of other work, commits, deployment.
  - Completion/verification: links resolve; all changed files in the review snapshot are classified; targeted legacy tests/typecheck results and their limits are recorded.
  - Trace: R1–R6; design §§1–8.
  - Evidence (2026-10-15): six Spec documents created; local links and all eight task structures checked; 21 targeted legacy tests and TypeScript no-emit check passed; git diff whitespace check passed. The review records snapshot hashes and the limits of source-only verification.
  - Handoff (2026-10-15): added copy-ready development prompts and documentation links at the user's request. T1–T7 remain TODO; this documentation submission does not complete implementation or runtime acceptance.

## Stage 1 — Prove the HTTP delivery boundary

- [ ] T1. Resolve isolated origins and reachable routes
  - Status: TODO
  - Work: select and verify the origin/routing/credential composition for Desktop remote access, Web and PeerHost; add capability adapters and diagnostics.
  - Visible result: a concrete app URL reaches the correct Host while its origin is separate from DSH; unsupported compositions explain why.
  - Depends on: T0.
  - Read first: design §§1.2, 3.1; `docs/开发规范/20260922-功能模块开发规则.md`; existing DSH/PeerHost adapters and current dependency contracts.
  - Main files: proposed `src/dsh-capabilities/host/quick-app-origin-adapter.ts`, client footer/document adapters, `types.ts`, `matrix.ts`, `routes.ts`; a dated interface report in this Spec's docs.
  - Excludes: arbitrary proxying, weakening same-origin isolation, automatically starting/reconfiguring servers or Desktop.
  - Completion/verification: source fixtures cover supported/unavailable capabilities, including required legacy versions; transport evidence resolves TLS, root-relative URLs and embedded app credentials. Runtime checks require applicable authorization.
  - Trace: R2.3, R3, R5, R6.3; design §§3.1, 8.

- [ ] T2. Implement app metadata and Host-owned launch grants
  - Status: TODO
  - Work: persist shortcut records with revisions and implement launch/grant/revoke lifecycle using exact workspace identity.
  - Visible result: an app can be listed and launched without a conversation, and its permissions cannot be enlarged by request payloads.
  - Depends on: T1.
  - Read first: requirements R1/R3; design §§2.3, 3.2, 4; existing settings bridge and Host feature registration.
  - Main files: proposed `src/shared/contracts/quick-apps.ts`, `src/host/features/quick-apps.ts`, `src/host/modules/quick-apps/registry.ts`, `launches.ts`, feature registries and focused tests.
  - Excludes: copying source files or storing launch credentials in shared settings.
  - Completion/verification: tests for revision conflicts, restart behavior, disconnected Hosts, exact workspace lookup, expiry/revoke and module disposal; capability/version checks as required by repository rules.
  - Trace: R1/R3/R5/R6; design §§2–4.

## Stage 2 — Deliver resources and optional data writes

- [ ] T3. Serve standard HTTP application resources
  - Status: TODO
  - Work: implement scoped static GET/HEAD, correct MIME/binary responses, indexes, queries and optional navigation-only SPA fallback.
  - Visible result: a multi-file app runs unchanged using standard URLs and fetch calls.
  - Depends on: T2.
  - Read first: requirements R2/R3; design §§3.1, 3.4, 6.
  - Main files: proposed `src/host/modules/quick-apps/static-handler.ts`, path resolver, fixtures and HTTP/browser tests.
  - Excludes: required SDK injection, Blob rewriting, backend execution, service workers and a general reverse proxy.
  - Completion/verification: modules/dynamic imports/CSS/images/fonts/data fixtures pass; missing assets stay 404; traversal and cross-app requests fail; GET/HEAD do not write files. Real HTTP tests await server authorization where required.
  - Trace: R2/R3/R5; design §§3.1, 3.4, 7.

- [ ] T4. Implement the optional scoped text-file API
  - Status: TODO
  - Work: extract useful filesystem logic from the earlier connector and add operation-specific grants, API methods and create/update/delete preconditions.
  - Visible result: an authorized app saves to its Host while a read-only app cannot modify files.
  - Depends on: T2, T3.
  - Read first: requirements R4; design §§3.3, 4.3; this Spec's change review and current helper/tests.
  - Main files: proposed `src/host/modules/quick-apps/file-api.ts`, shared path/write helpers, focused tests; existing `src/host/html-workspace-files.ts` only through an explicit migration.
  - Excludes: wholesale reuse of client-supplied grants, arbitrary absolute paths, directory deletion and broad resets of legacy code.
  - Completion/verification: read-only denial; stale write/delete rejection; create-only safety; execution-time path/grant validation; queue cleanup, size limits, correct owning Host and failure content preservation.
  - Trace: R3/R4/R5; design §§3.3, 4.3, 6.

## Stage 3 — Launcher, migration and acceptance

- [ ] T5. Add Quick Apps UI and document opening
  - Status: TODO
  - Work: register the footer entry, shortcut management, origin-backed HTML view, text view and permission controls with responsive layout.
  - Visible result: desktop and narrow-screen users can add/open/edit/remove shortcuts and see unavailable/save states.
  - Depends on: T3, T4.
  - Read first: requirements R1/R6; design §2; repository module, settings-form and i18n rules plus applicable parent UI/modal rules.
  - Main files: proposed `src/client/features/quick-apps.ts`, `src/client/quick-apps/`, localization, feature registry, UI tests.
  - Excludes: replacing the native sidebar, creating synthetic conversations, rewriting unrelated file-management UI.
  - Completion/verification: slot lifecycle and narrow-screen checks; no active-session dependency; correct HTML/text dispatch; removal leaves source files intact; persistence across client reload.
  - Trace: R1/R5/R6; design §§2–4, 7.

- [ ] T6. Migrate the legacy connector without broad cleanup
  - Status: TODO
  - Work: decide which old entry points remain as compatibility adapters and which are retired after the new runtime passes; keep the membership page functional.
  - Visible result: one authoritative grant/file service with documented compatibility behavior, and no claim that the old connector implements HTTP hosting.
  - Depends on: T4, T5.
  - Read first: design §8 and the file-by-file review; current member page adapter and its backup before modifying that separate workspace.
  - Main files: the seven session-related connector files listed in the review; member-page integration only if separately included in the implementation scope.
  - Excludes: deleting unrelated translation work, silently removing an existing page protocol, committing all dirty files together.
  - Completion/verification: old behavior is preserved or a tested replacement is documented; regression tests remain; all removals have an explicit replacement and retirement note.
  - Trace: R6.4; design §8.

- [ ] T7. Complete acceptance and record actual runtime coverage
  - Status: TODO
  - Work: verify R1–R6 and record source, HTTP browser, mobile and PeerHost results separately.
  - Visible result: an acceptance matrix with evidence and explicit remaining gaps.
  - Depends on: T6.
  - Read first: all three Spec documents and the completed T1 transport report.
  - Main files: tests and a dated acceptance report under this Spec's docs; tasks.md status updates.
  - Excludes: new features, automatic build/install/restart/release, representing source tests as phone verification.
  - Completion/verification: targeted tests, typecheck, version/capability/i18n checks; authorized HTTP/phone tests for ordinary app loading, exact Host writes, origin isolation, stale saves and revocation. Unrun runtime checks remain incomplete.
  - Trace: R1–R6; design §§6–7.

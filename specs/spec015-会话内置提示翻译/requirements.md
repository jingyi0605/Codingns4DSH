# Requirements

1. When session translation is enabled, attachment instructions use the configured input language, including file-only messages and instructions appended by external drivers. Disabled sessions retain existing wording.
2. Filenames, resolved paths, attachment payloads, skill/tool names, schema keys, enum values, and interpolation variables remain exact. Chinese path components are data, not untranslated prose.
3. Translate injected skill-catalog and workspace-instruction prose through the existing input translator, preserving message provenance and retaining original translation audit records.
4. Translate assembled system sections and tool descriptions through a structurally checked, version-bounded capability. Do not mutate shared tool registrations, frozen requests, runtime policy providers, or DSH complete-prompt enforcement.
5. Respect session/global switches and existing exclusions for assistant and subagent sessions. Cache only successful context translations with bounded storage and settings/model invalidation; cancellation and translation recovery remain effective.
6. Explicitly truncated translation streams must not be reported as successful. Missing or damaged protected literals invalidate translation.
7. Verify source behavior with fake DSH contexts, actual prompt-assembly code where available, all supported target languages, path edge cases, failures, and lifecycle cleanup. No server or Desktop operation is needed.

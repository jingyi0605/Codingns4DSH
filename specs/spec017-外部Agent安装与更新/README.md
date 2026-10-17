# Spec017: External Agent installation and updates

Status: Implemented and verified, including duplicate-row prevention, automatic installation ownership without a method chooser, terminal progress, automatic list refresh, restored delegation settings, and the independent Agent-list modal

Add installation and update actions to the existing external Agent settings. The user approved the Spec workflow on 2026-10-16.

- Requirements: `specs/spec017-外部Agent安装与更新/requirements.md`
- Design: `specs/spec017-外部Agent安装与更新/design.md`
- Tasks and verification: `specs/spec017-外部Agent安装与更新/tasks.md`
- ZCode desktop updater: design §8 and task 27 cover Windows/macOS package verification, in-place updates, and installed-version re-detection.
- Official sources: `docs/调查报告/20261016-外部Agent官方安装与更新方式.md`
- Live release audit: `docs/调查报告/20261016-外部Agent版本逐项核验与运行态差异.md`
- Update channel and manual-check follow-up: `docs/调查报告/20261016-外部Agent更新通道与手动检查边界.md`

The earlier verification below used source tests without a build or server startup. On 2026-10-17 the user additionally authorized isolated Stage0 verification: task 28 records the build, startup, real Chrome detection, official downloads, cancellation, cleanup, and retry. The user then authorized actual machine installation: task 29 records the initial Windows failure, installer filename/path fixes, successful recovery to ZCode 3.15.3, and final Stage0 detection. macOS replacement remains unverified. No DSH Desktop operation or release was performed.

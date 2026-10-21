# Magpie CLI switching feasibility check

Date: 2026-10-19

## Result

Magpie CLI is a viable path for changing the saved model selection of the two tested external Agents. The supported commands were exercised against copies of the local Agent configuration files in a temporary HOME:

- Magpie installed as version `0.1.1290` using its official installer. The application bundle was installed, but the Magpie GUI was not opened.
- `magpie claude --help` documented the `magpie claude <model>` setter; `magpie codex --help` documented the corresponding Codex setter.
- `magpie models claude` and `magpie models codex` listed the model available from the temporary Magpie provider.
- `magpie claude codingns-test/probe-model` and `magpie codex codingns-test/probe-model` both changed the copied Agent configuration. Reading each Agent back through the CLI showed the selected model.
- `magpie claude default` and `magpie codex default` restored the saved settings in the copies. The copied Codex model returned to `gpt-6.1-sol` with effort `xhigh`; Claude Code returned to its prior unset model.
- A final read-only CLI check of the real files still showed Claude Code with no selected model and Codex on `gpt-6.1-sol` with effort `xhigh`.
- All Magpie commands ran with `MAGPIE_NO_ACCOUNTS=1`. No real provider key, subscription credential, model request, or live inference was used; the isolated fake provider had a dummy key value.

## How the test was isolated

The existing `~/.claude/settings.json` and `~/.codex/config.toml` files were copied with their permissions into a temporary directory. Magpie received that directory through a temporary `HOME`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME`. The test added a dummy provider named `CodingNS Test`, with the unreachable local URL `http://127.0.0.1:1/v1`, a dummy key, and the single model `probe-model`. Its model-list request correctly failed to connect; the explicitly supplied dummy model was still available for testing configuration switching. Magpie wrote only inside the temporary HOME, which was removed after testing.

## Limits

- The machine's Magpie provider list was empty before the test. No actual provider configuration was imported from Claude Code or Codex into Magpie.
- Magpie's documentation says it can import provider settings from other tools through its app, but this check intentionally did not use the GUI. Provider-file import remains unverified in the CLI-only workflow and is out of scope for the proposed CodingNS integration.
- The test changed and restored Agent model configuration only. It did not run Claude Code or Codex with the dummy provider and did not verify a live model response.
- The test did not exercise CodingNS's Agent drivers with a Magpie model ID. Each mapping needs a focused fake-runtime test before being enabled in the plugin.
- `magpie models <agent>` currently prints human-readable output; its CLI help did not document a JSON output mode for this command. A strict, version-tested parser or a future documented machine-readable interface is required.
- The test did not start Magpie's GUI, `magpie web`, or its gateway. An accidentally started local web test process was stopped, and its test port was confirmed closed.
- DSH Desktop, its profile, configuration, and processes were not accessed or changed.

## Public references

- Magpie Chinese README: https://github.com/yetone/magpie/blob/main/README.zh-CN.md
- Magpie reference: https://github.com/yetone/magpie/blob/main/docs/reference.md
- Official installer: https://usemagpie.ai/install.sh

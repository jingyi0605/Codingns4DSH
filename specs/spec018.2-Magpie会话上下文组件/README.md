# Spec018.2: Magpie Session Context Component

Status: Complete

This Spec integrates Magpie's context inspection data into the native DSH session context control. The visual target is the supplied Context window screenshot: a compact percentage trigger, an anchored context panel, six prompt categories, cache information, per-request points, and session content rows.

The replacement is session-scoped. It is shown only after the Host confirms that the current session is using a Magpie-backed model. Other sessions continue using DSH's native context meter and breakdown without visual or data changes.

## Documents

- [Requirements](requirements.md)
- [Design](design.md)
- [Tasks](tasks.md)
- [Supplementary documents](docs/README.md)

## Scope

- Read Magpie's authenticated `/api/context` Web API through the Host.
- Match the returned Magpie session to the current DSH session and Agent identity.
- Render Magpie's six prompt categories and request/item details in the session context control.
- Preserve the native DSH context meter for non-Magpie sessions and for unavailable Magpie data.
- Keep prompt text and credentials out of the RPC boundary; expose bounded metadata and token counts only.

## Out of scope

- Changing Magpie configuration, routing, accounts, providers, or models.
- Replacing DSH's native context projection for non-Magpie sessions.
- Operating DSH Desktop, installing Magpie, or starting a development server.
- Persisting raw prompt or tool-result text in CodingNS state.

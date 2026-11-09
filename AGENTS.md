# Fleet Control

## New session entry point

Read `docs/HANDOFF.md` before planning or changing this project. Then read `docs/README.md` and the documents for the part you are working on.

Selected implementation baseline: `docs/design/terminal-deck.html`. Screenshots and the source-linked checksum manifest are alongside it. Design history is under `.design/`; visual tokens are in `.design/design-system.md`.

The baseline is a synthetic interactive mockup, not a connected application. The latest requested model-label feature is documented in `docs/model-observability.md` and is not implemented in the baseline.

## Constraints

- Use Bun. Do not introduce a different runtime or package manager.
- Preserve the remote-supervisor architecture: workstation owns execution and durable state; MacBook is a client.
- Preserve the selected full-window Terminal Deck layout, host-grouped left navigation and right supervisor panel. Do not restore duplicate top navigation, an outer rounded frame or the rejected bottom tray.
- Read the relevant `apple-his@1.0.0` guidance through Docify for UI work. Use the selected design tokens; do not claim native HIG compliance from the web mockup.
- Reuse agent-fleet CLI where applicable. phased-delivery's inspected workers/reviewers are Agent calls, not inherently independent tmux terminals.
- Keep worker claims, verification, review, human approval and execution acknowledgement separate.
- Read `docs/implementation-status.md` before making implementation or completion claims.
- Host access, live terminal input, credentials, dependencies, spending and deployment require their own authorization.
- Recheck repository and worktree state before implementation. The design pass began before Git initialization; the user later authorized an initial local snapshot on main. Use an isolated worktree for subsequent code changes.

## Local commands

```bash
bun run design:check
open docs/design/terminal-deck.html
```

The check runs draft event handlers in a minimal DOM fixture. It is not a live browser, API or terminal integration test. The `open` command is macOS-specific; the HTML can be opened directly in another browser.

Do not treat the Bun starter examples in `CLAUDE.md` as implemented product endpoints. `index.ts` is still a greeting.

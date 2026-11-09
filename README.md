# Fleet Control

A terminal-first console for remote agent work. The supervisor and execution belong on the workstation; the MacBook is a client.

**Current stage: selected interactive design and documented architecture. No live backend or terminal transport yet.**

## Continue in a new session

Start with [docs/HANDOFF.md](docs/HANDOFF.md), then the [documentation index](docs/README.md). `AGENTS.md` and `CLAUDE.md` point new coding sessions to the same starting point.

## Selected design

[Open Terminal Deck](docs/design/terminal-deck.html)

- [Desktop dark](docs/design/desktop-dark.png)
- [Desktop light](docs/design/desktop-light.png)
- [Phone dark](docs/design/phone-dark.png)
- [Phone light](docs/design/phone-light.png)

The HTML is self-contained and works without the design-studio server. It is the preserved v4 design baseline, not a connected app. Model identity display is requested and documented, but is not in v4.

On macOS:

```bash
open docs/design/terminal-deck.html
```

## Check the design fixture

With Bun available:

```bash
bun run design:check
```

This runs mockup handlers against a minimal DOM fixture. It does not verify a live agent, browser terminal, remote MCP endpoint or production service.

## Development state

The project was initialized with Bun. `index.ts` still prints a greeting; `bun run index.ts` does not start Fleet Control.

Dependencies can be installed with `bun install` when needed and authorized. The existing `typecheck` script runs `bun check`; a successful full-project typecheck is not claimed by this handoff.

Older mockups and rendering tools are under `.design/`. Follow the handoff before implementing or deploying anything, and keep the selected visual direction rather than restarting the design exercise.

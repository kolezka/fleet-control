# Next-session metaprompt

Historical (written 2026-11-09, before any implementation). Its statement that nothing is connected is out of date: the host service, cooperative central and adapter, and the installer exist on `main`. Start a new session from [HANDOFF.md](HANDOFF.md) and [implementation status](implementation-status.md) instead. The decisions and authorization limits below still apply.

Copy the following into a new coding session opened in the Fleet Control project directory.

```text
Take over Fleet Control. Start in the fleet-control project directory,
not in ai-docify, where the original conversation began.

Read in order:
1. AGENTS.md
2. docs/HANDOFF.md
3. docs/README.md
4. docs/architecture.md
5. docs/control-protocol.md
6. docs/installation.md
7. docs/model-observability.md
8. docs/implementation-status.md

Open docs/design/terminal-deck.html and inspect the saved previews.
Use .design/design-system.md for visual tokens and the relevant
apple-his@1.0.0 documentation through Docify for UI decisions.

Preserve these decisions:
- Terminal Deck fills the window, without an outer frame or rounded shell.
- Host/session navigation appears only on the left.
- Session terminals occupy the center.
- Supervisor requests, workflow, evidence and command history appear
  in the right sidebar, with an accessible instruction composer.
- The supervisor, execution and durable state live on the workstation.
  The MacBook is a client and does not need to remain online.
- Reuse agent-fleet CLI behavior. Extend phased-delivery only where
  structured state, command acknowledgement and scoped decisions need it.
- Queued, delivered, accepted and completed are different states.
- Keep human approvals bound to their request, phase and revision.
- A configured model is not proof of the model used by a running session.
  Model identity display is requested but absent from the current mockup.

Do not restart discovery or invent another visual direction.
Do not treat the mockup as a connected backend: API, remote MCP,
persistent command storage, terminal transport and model telemetry
still need implementation. Agent subagents are not automatically
separate tmux sessions.

First:
- Inspect the current Git branch, log, status and worktrees.
- Run bun run design:check and report its actual result and limitations.
- Confirm the target workstation, OS, execution user and access method
  with me. runner-01 is only a fixture, not an authorized host.
- Propose a bounded, phased implementation plan with observable checks.
  Start with one isolated test session and the existing fleet CLI.
- After plan approval, make code changes in an isolated worktree.

Do not access the workstation, expose a real shell, install dependencies,
change credentials, spend on models, deploy, push or merge without the
appropriate explicit authorization. Do not retry the blocked external
Hindsight write merely because the project has a new session.

Keep docs and implementation status current. Report tested behavior,
not assumptions or another agent's unverified claims.
```

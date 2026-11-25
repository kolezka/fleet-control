# Workstation onboarding implementation plan

> For agentic workers: use executing-plans for inline work or subagent-driven-development for per-task review. Track each step below.

**Goal:** Deliver a safe first product slice of the v21 workstation design: preview what preparing a machine entails before beginning enrollment.

**Architecture:** Extend the existing gateway web page. Keep the preview local and read-only. Retain the existing gateway enrollment flow for generation of credentials and commands. Do not treat pending enrollment as registered inventory.

**Tech stack:** Bun, TypeScript, HTML; existing in-memory page fixture.

**Spec:** Terminal Studio v21, `workspace/terminal-studio/v21.html` in the `operator-workspace-nov24` brief. The prototype uses synthetic enrollment; it does not replace the production identity check.

## Global constraints

No host access, SSH, deployment, credentials, dependency installation or changes to running sessions during development. Do not duplicate the gateway's command generator or put token material in previews. Do not change backend enrollment permissions. A saved installation plan and a verified host must remain separate states.

## Review focus

- Submitting fresh details once produces a preview, not a POST.
- Editing a field or switching mode invalidates the preview before a subsequent begin.
- The preview identifies the machine, service and intended effects; user-provided values are text, not HTML.
- Existing-host enrollment retains its explicit token creation step and operator identity check.
- An unknown network outcome is not presented as successful registration.

## First independently testable slice

- [x] Extend `web/add-host.test.ts` at the page boundary: submit valid fresh-mode fields; assert `posts().length === 0` and that visible preview includes the proposed host and service. Test changing the host address after preview, switching to connect mode, and beginning only from a current preview. Run `bun test web/add-host.test.ts` and capture failures at the behavioral assertions.
- [x] Update `web/add-host.html` with distinct registration and preparation labels, an accessible inline preview and a separate explicit enrollment action. In `web/add-host.ts`, construct preview from `form()` and `payload(f)`, use `textContent`, invalidate on field or mode change, and use the existing `begin()` only for explicit enrollment. Do not send a request when previewing.
- [x] Re-run the same tests; inspect the rendered gateway page with synthetic responses. Check that preview, cancellation and editing do not create credentials or contact a host. Report exactly which UI and build checks ran.

## Remaining goal slices

1. Durable plan-only storage, separate from enrollment and registered hosts. Inspect gateway stores and the write authorization boundary before selecting storage; verify reload, concurrent updates and no implicit enrollment.
2. Host configuration: add identity/group/description and the default harness for new sessions, with a change summary. Keep observed runtime distinct; never repoint a credential to a new address merely by editing display metadata. Verify metadata round-trip and rejection of unsafe credential reuse.
3. Machine overview and project decisions: route users to the owning project/task from a machine, preserve terminal focus and bind approvals to the authoritative request and revision. Inspect project identity contracts before introducing links or migration; never guess ownership from a session label.

Status 2026-11-25: the first slice and slices 1 to 3 are implemented and merged to `main` in PR #222. What was built, its limits and the checks that ran are in `docs/implementation-status.md` under "Workstation onboarding, configuration and project-owned decisions". Slice 1 was not checked under concurrent writers beyond the duplicate-id refusal.

The branch baseline is `5577805a9391b432d990767ccd5e838a6f3644f5`; the existing enrollment page fixture passed 6 tests with 38 assertions before changes. No deployment or operational approval is part of this goal.

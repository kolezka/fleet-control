Status: proposal, 2026-11-16. Nothing changes. It answers open decision 9 in [implementation-status.md](implementation-status.md): stay with plain TypeScript and the deck CSS, or adopt a framework when the page grows.

## Size today (main at 9768576)

- `web/app.ts` 628 lines, `web/host-state.ts` 413, installer page `web/install.ts` and `web/install-view.ts` 197. About 2,200 lines with HTML, CSS and tests.
- Tests: `web/host-state.test.ts` (21), `web/app.test.ts` (13), `web/install.test.ts` (8). `web/app.test.ts` runs the real page module through `Bun.Transpiler` with a fake document, fetch, WebSocket and timers.
- Rendering is template strings into `innerHTML`, with `esc()` around every interpolated value (28 calls in `web/app.ts`). State that matters (host list, send gate, intent kept across a retry) lives in `web/host-state.ts` as plain functions, which is why it is easy to test.
- Runtime dependencies: `@modelcontextprotocol/sdk`, `ghostty-web` (terminal), `hono`, `zod`. None is a UI framework. Bun bundles the page from the HTML import.

## Trade-off

| | Stay plain | Adopt React (or similar) |
| --- | --- | --- |
| New dependency | none | yes, needs owner approval |
| Escaping | manual `esc()`, one missed call is an XSS hole | automatic for text |
| Tests | current harness works | rewrite of `web/app.test.ts` |
| Bundle | small | larger |
| Fits growth | gets harder past a few more panels (input lease UI, withdraw button, settlements) | easier |

The real risk in the plain version is a missed `esc()`. That can be checked without a framework.

## Proposal

1. **Stay plain for now.** The page is small, the state logic is already separate and tested, and adding a framework is a dependency decision.
2. **Add a guard test:** every `${...}` inside a template written to `innerHTML` must be wrapped in `esc()` or be a value from a short allow list (numbers, fixed class names). This is local work and needs no approval.
3. **Revisit** when a second page beyond the installer grows past about 1,000 lines, or when the input lease UI is built, whichever comes first.

## Question for the owner

1. Stay with plain TypeScript and add the escaping guard test? Recommended: yes.

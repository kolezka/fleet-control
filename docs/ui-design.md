# Interface design

Status: Terminal Deck is the selected visual direction. Use the [preserved implementation baseline](design/terminal-deck.html) for handoff; its source is [v4](../.design/drafts/console/terminal-deck/v4.html). The [design system](../.design/design-system.md) contains its exact color and typography tokens. [HANDOFF.md](HANDOFF.md) describes verification, remaining requests and how to continue.

## Layout decisions

The application fills the window. There is no outer margin, border or rounded application shell. Inner regions still use padding and separators to keep content readable.

The left sidebar is the only host/session navigation. Each host has a distinct name, a restrained machine icon, a Local/Remote label and a session count. Sessions are indented under their host. Host selection and active-session emphasis are different states.

Selecting a host displays all of its available session views. Selecting a session within the host highlights it without removing the others. Do not duplicate those session links in a top tab bar.

The terminal workspace takes the central area. In the current draft, three panes use equal columns and four use a 2x2 grid. The remote-supervisor decision moved the supervisor under runner-01 alongside the three other illustrative roles. Avoid permanently allocating an empty local-execution group merely because the browser runs on a MacBook.

The right sidebar replaces the rejected bottom tray. Its order is:

1. Pending supervisor request and decision controls.
2. Workflow and current phase state.
3. Expandable command/response history.
4. Instruction composer anchored at the bottom.

The content region scrolls independently so the composer remains accessible. Evidence and detailed scope are behind a disclosure control. The history names both the actor and receipt state.

## Toolbar

Keep one compact titlebar. Use an accessible icon button to show or hide the right sidebar. Terminal text settings and demo input ownership are under View options.

Do not restore the persistent `Text` and `State` select fields rejected by the user. The mockup's state examples are available through query parameters, not production chrome. Keep a small visible sample-data notice until real runtime data is connected.

## Interaction and wording

Use ordinary action labels: approve, decline, ask a question, send. A request must show its scope and phase revision before the user decides.

A newly queued command is not accepted or completed. A submitted approval is not proof of phase execution. The workflow must keep the next phase not started until a corresponding host event arrives.

The terminal and command composer are separate channels. Sending a task instruction does not grant a shell input lease. Closing a terminal pane must not terminate the host session.

The requested model display belongs near the session name in the pane header, with full identity and provenance available in details. It is not another top-level model selector. This display is not present in v4 yet; see [model visibility](model-observability.md).

## Responsive behavior

The current draft uses a 220px desktop navigation sidebar. At narrower desktop widths it reduces to 195px. The right coordination panel is 330px, reducing to 300px at the narrower breakpoint.

At 900px and below, the inspector becomes a right overlay and starts hidden. At 600px and below, host navigation becomes a compact top section and terminal panes stack. This is still one navigation structure, not duplicated navigation. Breakpoints are mockup values to validate against real terminal sizing, not a guarantee of runtime usability.

## Typography, color and accessibility

Use system sans-serif for application chrome and system monospace for terminal output and technical IDs. Terminal text defaults to 13 CSS pixels in the draft, with scaling up to 200 percent. CSS pixels are not a claim of equivalence to native macOS point sizes.

Keep the graphite/porcelain palette and muted selection accent from the selected design system. Use color sparingly for selection, primary actions and status, always with text or another non-color signal. The shell and terminal panes have zero outer radius; small controls can retain their selected 4px or 5px radius.

Preserve visible keyboard focus and labels on icon controls. Real terminal accessibility, focus navigation, keyboard shortcuts, contrast and zoom behavior still require testing. Do not claim native Liquid Glass or native accessibility behavior from this HTML prototype.

## Apple HIG through Docify

The user explicitly requested Apple Human Interface Guidelines through Docify. The registered source is `apple-his@1.0.0`; this is the local source version, not a macOS release number.

Applied sources:

- `apple-his@1.0.0`, [Layout > Visual hierarchy](https://developer.apple.com/design/human-interface-guidelines/layout#Visual-hierarchy), `p_28f2e1d117a0deb3a407`: importance ordering, alignment and indentation, grouping and progressive disclosure. Applied to host hierarchy and the request-first inspector.
- `apple-his@1.0.0`, [Typography > Using system fonts](https://developer.apple.com/design/human-interface-guidelines/typography#Using-system-fonts), `p_40ab8ffbd38705ce55d5`: consistent system typography and hierarchy. Applied to system sans and monospace rather than embedded Apple font files.
- `apple-his@1.0.0`, [Color > Liquid Glass color](https://developer.apple.com/design/human-interface-guidelines/color#Liquid-Glass-color), `p_64aa889fd38a29d73e40`: restrained color and separation from content. Applied as a web interpretation, not simulated native glass.

The earlier feedback/progress search returned `weak_match`; no notification-specific rule is attributed to it. A dedicated sidebar/inspector section was not established by those search results. This is HIG-informed design, not a completed HIG compliance audit.

## Design history

- Initial playground: Mission Board, Decision Desk, Fleet Operations and API First.
- Console prototype: terminal-centered views, then host-wide selection and removal of duplicate navigation.
- Design Studio: Current baseline, Workbench and Terminal Deck.
- Terminal Deck v1: selected structure, originally with bottom details.
- v2: distinct host headers and nested sessions.
- v3: full-window layout, right inspector, compact toolbar and remote supervisor.
- v4: supervisor requests, workflow, command receipts and a demo instruction composer.

Older versions remain historical. Current decisions override their layouts. A live production terminal renderer has not been installed or integrated by these design iterations.

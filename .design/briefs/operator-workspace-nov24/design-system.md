# Fleet Control design system

Selected direction: Terminal Deck. The user selected this direction and requested clearer host grouping in the sidebar. The selection establishes this visual foundation, not approval of live terminal access or the production architecture.

## Layout

- One left sidebar, 220 CSS px on desktop. Hosts are parent groups, sessions are indented children.
- Host header: restrained machine icon, 13px semibold host name, Local/Remote label and session count below it. Do not invent an address, operating system or connection status.
- Session rows: 12px regular label, secondary 10px status, subtle selected background. Host selection is distinct from the selected session.
- Selecting a host shows all of its terminal panes. Selecting a child changes emphasis, not membership of that host's visible panes.
- The app fills the viewport with no outer gutter, frame or rounded shell. Keep padding inside content regions and respect safe-area insets.
- Equal terminal panes share the remaining width: three use columns, four use a 2x2 grid. Pane labels identify content but do not repeat the sidebar navigation.
- Supervisor requests, workflow state, evidence, scoped decisions and command receipts live in a hideable right sidebar, replacing the former bottom tray at the user's request.
- Put the pending request first. Keep evidence and command history behind disclosures. The instruction composer remains accessible at the bottom while the request/history region scrolls.
- Every exchange names the actor. Queued, delivered, accepted and completed are separate states. An approval awaiting supervisor acknowledgement does not mark the next phase running.
- One compact titlebar. Inspector visibility uses a labelled icon button. Terminal text scaling and demo input ownership are behind View options, not persistent select fields. State previews use a query parameter rather than application chrome.
- A small read-only/connection status footer retains the sample-data disclosure. No decorative hero, pseudo-window traffic lights or oversized wordmark.
- At 900px and below, the inspector becomes a right overlay, hidden initially. At 600px and below, host navigation becomes a compact top section and terminal panes stack. Keep one navigation structure.

## Typography

- Interface: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif.
- Terminal and technical values: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace.
- Body base: 13 CSS px. Titles use weight rather than a large size jump.
- Terminal default: 13 CSS px. Text scale choices: 100, 125, 150 and 200 percent.
- Do not embed Apple's font files. Native point-size equivalence and accessibility conformance are not assumed from a CSS mockup.

## Color tokens

| Token | Light | Dark |
| --- | --- | --- |
| bg | #f4f5f6 | #17191c |
| surface | #ffffff | #1d2024 |
| sidebar | #f0f1f3 | #1a1d21 |
| terminal | #fcfcfd | #181b1f |
| ink | #20252b | #d9dde4 |
| muted | #646d78 | #959da9 |
| line | #dde1e6 | #32363d |
| subtle | #edf0f4 | #252a31 |
| accent | #435d87 | #a8bcda |
| selected | #e5ebf4 | #2b3442 |
| good | #386b58 | #98bba9 |
| warn | #865d29 | #d2b38a |
| bad | #a24d57 | #d2a0a8 |
| active-line | #9aabc4 | #697b96 |

Use these tokens in later screens. Accent is for selection and actions, not decoration. Status colors accompany explicit status text; they are not the only signal. Surfaces and borders are opaque and quiet, without pretending to implement native Liquid Glass.

## Controls and rhythm

- Base spacing scale: 4px with optical adjustments for small labels and icons.
- Small controls and host icons may use a 4px or 5px radius. The app shell and terminal panes have zero outer radius.
- One prominent approval action per decision area. Other controls remain quiet.
- Keyboard focus gets a visible accent outline.
- Host icon represents machine type, not an unverified health state.

## Safety and fixture disclosure

- Drafts retain a visible sample-data notice and no-process-attached state.
- Input ownership and phase approval remain separate controls.
- Disconnection means execution state unknown, not stopped.
- All runtime values in these drafts are examples. Worker/reviewer panes do not establish that Agent subagents have standalone tmux terminals.

## HIG sources

Docify apple-his@1.0.0: Layout > Visual hierarchy (p_28f2e1d117a0deb3a407), Typography > Using system fonts (p_40ab8ffbd38705ce55d5), Accessibility > Vision (p_c0fddc877c056647381b), Color > Liquid Glass color (p_64aa889fd38a29d73e40). Application of these principles is documented in context.md; this is not a native HIG compliance certification.

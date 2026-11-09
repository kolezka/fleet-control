# First design round

## Scope

Two candidates and a baseline, with the runner-01 group selected. All data is synthetic. The original console.html is unchanged. The user has not selected a direction.

## Observed renders

Ran the installed design-studio shot.ts with --all for 1440x900 and 390x844, in light and dark. Both commands completed successfully without reported page errors. Opened all four contact sheets, plus the full-size Workbench dark desktop screenshot.

- Both candidates remove the decorative logo, duplicated explanatory framing and large playground header from the working surface.
- Workbench puts the worker in a large pane, reviewer and watchdog in two smaller panes, and phase evidence in a right inspector.
- Terminal Deck gives the three sessions equal columns and moves evidence and decisions to a bottom tray.
- Both candidates retain one sidebar for host and session navigation. Pane headings identify content but are not duplicate navigation controls.
- Light and dark screenshots show distinct application surfaces and readable terminal content.
- At 390px, controls wrap and session navigation becomes a compact section above vertically stacked terminals. The inspected viewport shows no clipped horizontal page edges. Lower content still requires scrolling; this is not an exhaustive overflow audit.
- Longer terminal transcripts scroll inside their panes on desktop. The split Workbench reviewer and watchdog panes show only the first portion of their output at rest.

## Interactions and limits

The drafts include host/session selection, hide/show phase context, demo input ownership, phase approval, text scaling and working/disconnected/empty state previews. Screenshots establish that initial rendering runs without reported JavaScript exceptions, not that every interaction has been exercised.

No live Ghostty, PTY, SSH, fleet command or MCP transport was started. No native HIG or accessibility compliance is claimed. Typography, restrained color and content hierarchy were informed by the Docify passages cited in context.md.

## Next step

Compare candidates on the local canvas. Ask the user which structure to continue. Lock design-system.md only after that choice.

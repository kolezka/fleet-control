// Browser half: Fleet Control as a conversation view tab and as a right sidebar tab.
// Hand-written in the bundle form DSH loads, so the adapter needs no build step.
window.__ModuleLoader__.load({
  id: '@kolezka/fleet-control-dsh',
  factory: (require) => {
    const { jsx } = require('react/jsx-runtime')

    const TAB_ID = '@kolezka/fleet-control-dsh'
    const TAB_KIND = 'fleet-control'
    const TITLE = 'Fleet Control'
    // No leading slash: the address follows the DSH page, also behind a path prefix.
    const ADDRESS = 'fleet-control/'
    const FRAME_STYLE = { border: 0, width: '100%', height: '100%', display: 'block', flex: '1 1 auto', minHeight: 0 }

    const inject = ['slots', 'sidebarRightTabs']

    function Panel({ address }) {
      return jsx('iframe', { src: address, title: TITLE, style: FRAME_STYLE })
    }

    function apply(ctx) {
      // The fleet is one per machine, not per session, so both places show the same page.
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => TITLE,
            keepMounted: true,
            guide: [{ id: 'open', order: 46, title: () => TITLE, description: () => 'Agent terminals, commands and requests' }],
          }),
        'fleet-control: sidebar tab type',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, inject: () => ({ address: ADDRESS }) }, Panel),
          ),
        'fleet-control: sidebar tab body',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.view', () =>
            ctx.slots.register({ name: 'conversation.view', id: 'fleet-control', order: 60, label: () => TITLE, inject: () => ({ address: ADDRESS }) }, Panel),
          ),
        'fleet-control: conversation view',
      )
    }

    return { apply, inject }
  },
})

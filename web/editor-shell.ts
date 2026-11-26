import { parseHostList, type HostInfo } from './host-state.ts';
import { navigationMarkup } from './studio-navigation.ts';
import { applyAppearance, readPreferences } from './studio-prefs.ts';

const prefs = readPreferences();
applyAppearance(document.documentElement, prefs);
const nav = document.getElementById('studioNavigation')!;
nav.innerHTML = navigationMarkup;
const link = (text: string, href: string, cls = '') => {
  const a = document.createElement('a'); a.textContent = text; a.href = href; a.className = cls; return a;
};
const route = (view: string, host?: string, session?: string) => './?' + new URLSearchParams({ view, ...(host ? { host } : {}), ...(session ? { session } : {}) });
for (const button of nav.querySelectorAll<HTMLButtonElement>('button[data-view]')) {
  const view = button.dataset.view!;
  const a = link('', route(view)); a.dataset.view = view; a.replaceChildren(...button.childNodes); button.replaceWith(a);
}
// Editors concern the gateway, not a project. Do not invent a project catalog here.
nav.querySelector('.project-picker')!.replaceChildren(Object.assign(document.createElement('small'), {textContent:'Project scope'}), link('All projects', route('workspaces')));
const toggle = document.getElementById('navigationToggle')!;
function setNavigation(open: boolean) {
  document.getElementById('app')!.classList.toggle('navigation-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  if (open) nav.querySelector('a')?.focus(); else toggle.focus();
}
toggle.addEventListener('click', () => setNavigation(toggle.getAttribute('aria-expanded') !== 'true'));
nav.addEventListener('keydown', e => { if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') setNavigation(false); });
const tree = document.getElementById('sidebar')!;
const status = document.getElementById('editorStatus')!;
async function get(path: string) {
  const response = await fetch(path, { signal:AbortSignal.timeout(8000) });
  if (!response.ok) throw Error();
  return response.json();
}
function hostRow(host: HostInfo, selected: boolean) {
  const row = document.createElement('section'); row.className = 'hostgroup';
  const heading = document.createElement('div'); heading.className = 'studio-host-row';
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'host-disclosure';
  const a = link('', route('machine',host.id), 'hostbutton');
  a.innerHTML = '<svg class="hosticon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v12H3z M8 21h8m-4-4v4"/></svg><span class="hostidentity"><strong></strong></span><small>?</small>';
  a.querySelector('strong')!.textContent = host.name;
  const count = a.querySelector('small')!; count.title = 'Session count not read';
  const sessions = document.createElement('div'); sessions.className = 'host-sessions';
  let read = false, loading = false;
  async function expand(open: boolean) {
    toggle.textContent = open ? '▾' : '▸'; toggle.setAttribute('aria-label',(open ? 'Collapse ' : 'Expand ') + host.name); toggle.setAttribute('aria-expanded',String(open)); sessions.hidden = !open;
    if (!open || loading || read) return;
    loading = true; sessions.textContent = 'Reading sessions…';
    try {
      const result = await get(host.apiBase + '/sessions');
      if (!Array.isArray(result?.sessions) || !result.sessions.every((s: {name?: unknown} | null) => typeof s?.name === 'string' && s.name)) throw Error();
      sessions.replaceChildren(...result.sessions.map((s: {name:string}) => link(s.name,route('terminals',host.id,s.name))));
      if (!result.sessions.length) sessions.textContent = 'No sessions';
      count.textContent = String(result.sessions.length); count.title = 'Sessions reported'; read = true;
    } catch { sessions.textContent = 'Session list unavailable'; } finally { loading = false; }
  }
  heading.append(toggle,a); row.append(heading,sessions); toggle.onclick = () => void expand(sessions.hidden === true); void expand(selected && prefs.groups !== 'collapsed'); return row;
}
async function loadInventory() {
  const head = document.createElement('div'); head.className = 'sidebarhead'; head.innerHTML = '<span>Host tree</span>'; tree.append(head);
  try {
    const raw = await get('./api/hosts'), list = parseHostList(raw);
    if (!list || list.mode !== 'gateway') throw Error();
    const selected = list.hosts.find(h => h.id === new URLSearchParams(location.search).get('host'));
    if (raw.enroll === true) { const a = link('+','./add-host','tree-action'); a.setAttribute('aria-label','Add a host'); head.append(a); }
    if (raw.manage === true && selected) { const a = link('','./workstation?host='+encodeURIComponent(selected.id),'tree-action'); a.setAttribute('aria-label','Edit selected workstation'); a.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16l11-11 4 4L8 20H4z M13 7l4 4"/></svg>'; head.append(a); }
    const groups = new Map<string,HostInfo[]>();
    for (const h of list.hosts) { const key = h.group ?? 'Ungrouped'; if (!groups.has(key)) groups.set(key,[]); groups.get(key)!.push(h); }
    for (const [name, hosts] of groups) {
      const group = document.createElement('details'); group.open = true; group.className = 'studio-host-group';
      const summary = document.createElement('summary'); summary.textContent = `${name} (${hosts.length})`;
      group.append(summary,...hosts.map(h => hostRow(h,h === selected))); tree.append(group);
    }
    if (raw.installer === true) tree.append(link('Install on this machine','./install','footlink'));
    if (!list.hosts.length) tree.append('No workstations registered.');
    status.textContent = `${list.hosts.length} registered ${list.hosts.length === 1 ? 'workstation' : 'workstations'}${selected ? ' · ' + selected.name : ''}`;
  } catch { tree.append('Inventory unavailable'); status.textContent = 'Cannot read gateway inventory'; }
}
void loadInventory();

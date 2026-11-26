export const preferenceOptions = {
  theme: { light: 'Light', dark: 'Dark', system: 'System' }, byline: { show: 'Show', hide: 'Hide' },
  font: { '12': '12', '13': '13', '15': '15', '17': '17' }, layout: { grid: 'Side by side', stacked: 'Stacked' },
  evidence: { collapsed: 'Collapsed', expanded: 'Expanded' }, groups: { expanded: 'Expanded', collapsed: 'Collapsed' },
};
export type Preference = keyof typeof preferenceOptions;
const defaults: Record<Preference, string> = { theme: 'light', byline: 'show', font: '13', layout: 'grid', evidence: 'collapsed', groups: 'expanded' };
const key = 'fleet-control:studio:display:v1';
function displayOnly(raw: unknown) {
  const prefs = { ...defaults };
  if (raw && typeof raw === 'object') for (const name of Object.keys(defaults) as Preference[]) {
    const value = (raw as Record<string, unknown>)[name];
    if (typeof value === 'string' && Object.hasOwn(preferenceOptions[name], value)) prefs[name] = value;
  }
  return prefs;
}
export function readPreferences() {
  try { return displayOnly(JSON.parse(sessionStorage.getItem(key) ?? 'null')); }
  catch { return { ...defaults }; } // Storage can be disabled or contain an old, malformed value.
}
export function savePreferences(prefs: Record<Preference, string>) {
  try { sessionStorage.setItem(key, JSON.stringify(displayOnly(prefs))); return true; }
  catch { return false; }
}
export function applyAppearance(root: HTMLElement, prefs: Record<Preference, string>) {
  if (prefs.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
  root.dataset.descriptions = prefs.byline;
}

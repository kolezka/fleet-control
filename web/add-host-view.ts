// Pure view logic for the add-host page: form payloads, reply parsing and markup.
import { parseWorkstationProfile, type WorkstationProfile } from "../src/domain/workstation-profile.ts";
import { parseHostList } from "./host-state.ts";
import { HOST_ID } from "../src/domain/enrollment.ts";

export function inventoryGroups(body: unknown): string[] | null {
  const inventory = parseHostList(body);
  return inventory?.mode === "gateway" ? [...new Set(inventory.hosts.flatMap(h => h.group ? [h.group] : []))].sort() : null;
}
export function profileSummary(p: WorkstationProfile): string {
  return `Group: ${p.group} · Role / description: ${p.description || 'Not set'} · New-session harness: ${p.defaultHarness ?? 'No preference'}`;
}
export { parseWorkstationProfile };
export type Mode = "connect" | "fresh";
export type Form = {
  mode: Mode; id: string; name: string; url: string; principal: string; dir: string;
  ref: string; port: string; label: string; fleet: string; tlsCert: string; tlsKey: string;
  ssh: string; sshPort: string;
  group?: string; description?: string; defaultHarness?: string;
};
export type Pending = { profile?: WorkstationProfile; id: string; name: string; url: string; mode: Mode; principal: string; command: string; ssh: string | null; createdAt: string };

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const text = (v: unknown): v is string => typeof v === "string";
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const num = (s: string) => (/^[0-9]{1,5}$/.test(s) ? Number(s) : s);

// Only the fields of the chosen mode are sent, so a hidden field cannot change the command.
export function payload(f: Form): Record<string, unknown> {
  const out: Record<string, unknown> = { id: f.id.trim(), name: f.name.trim(), url: f.url.trim(), mode: f.mode, principal: f.principal.trim(), dir: f.dir.trim() };
  if (f.mode === "fresh") {
    Object.assign(out, { ref: f.ref.trim(), port: num(f.port.trim()), label: f.label.trim(), fleet: f.fleet.trim(), tlsCert: f.tlsCert.trim(), tlsKey: f.tlsKey.trim() });
  }
  if (f.ssh.trim()) {
    out.ssh = f.ssh.trim();
    if (f.sshPort.trim()) out.sshPort = num(f.sshPort.trim());
  }
  if (f.group || f.description || f.defaultHarness) out.profile = { group: f.group ?? "", description: f.description ?? "", defaultHarness: f.defaultHarness || null };
  return out;
}

export function parsePending(v: unknown): Pending | null {
  const p = record(v);
  if (!p || ![p.id, p.name, p.url, p.principal, p.command, p.createdAt].every(text)) return null;
  if (p.mode !== "connect" && p.mode !== "fresh") return null;
  if (p.ssh !== null && !text(p.ssh)) return null;
  const profile = parseWorkstationProfile(p.profile);
  if (p.profile !== undefined && !profile) return null;
  return { ...(profile ? { profile } : {}), id: p.id as string, name: p.name as string, url: p.url as string, mode: p.mode, principal: p.principal as string, command: p.command as string, ssh: p.ssh as string | null, createdAt: p.createdAt as string };
}
export function parsePendingList(body: unknown): Pending[] | null {
  const list = record(body)?.pending;
  if (!Array.isArray(list)) return null;
  const out = list.map(parsePending);
  return out.every((p) => p !== null) ? out as Pending[] : null;
}
export function parseCheck(body: unknown): { added: boolean; reason: string | null } | null {
  const b = record(body);
  if (!b || typeof b.added !== "boolean" || (b.reason !== null && !text(b.reason))) return null;
  return { added: b.added, reason: b.reason as string | null };
}
export function parseSsh(body: unknown): { code: number; output: string } | null {
  const b = record(body);
  return b && Number.isInteger(b.code) && text(b.output) ? { code: b.code as number, output: b.output } : null;
}
export function errorText(body: unknown, status: number | null): string {
  if (status === null) return "No answer from the gateway.";
  const message = record(record(body)?.error)?.message;
  return text(message) ? message : "Request failed (" + status + ").";
}

// Each step names who acts: the gateway made a token, the host must run the command, then Check.
export function pendingHtml(p: Pending, note: string): string {
  const where = p.mode === "connect" ? "in a terminal on that host" : "in a terminal on that host, as the user who will run the service";
  const ssh = p.ssh ? "<button type=\"button\" data-act=\"ssh\" data-id=\"" + esc(p.id) + "\">Run over SSH as " + esc(p.ssh) + "</button>" : "";
  return "<li class=\"pending\"><h3>" + esc(p.name) + " <small>" + esc(p.id) + " · " + esc(p.url) + "</small></h3>"
    + "<p class=\"phase-note\">The gateway made a token and kept it. The command below carries only its hash. Run it " + where + ", then press Check. The host is added only when it answers as " + esc(p.principal) + " with the operator role.</p>"
    + (p.profile ? "<p>" + esc(profileSummary(p.profile)) + "</p>" : "")
    + "<pre class=\"command\">" + esc(p.command) + "</pre>"
    + "<div class=\"formactions\"><button type=\"button\" data-act=\"copy\" data-id=\"" + esc(p.id) + "\">Copy command</button>" + ssh
    + "<button type=\"button\" data-act=\"check\" data-id=\"" + esc(p.id) + "\" class=\"primary\">Check</button>"
    + "<button type=\"button\" data-act=\"cancel\" data-id=\"" + esc(p.id) + "\" class=\"destructive\">Cancel</button></div>"
    + (note ? "<p class=\"note\" role=\"status\">" + esc(note) + "</p>" : "") + "</li>";
}

export function formGate(f: Form, busy: boolean): { enabled: boolean; reason: string } {
  if (busy) return { enabled: false, reason: "Working." };
  for (const [k, what] of [["id", "host id"], ["name", "name"], ["url", "address"], ["principal", "gateway name"], ["dir", "folder"]] as const) {
    if (!f[k].trim()) return { enabled: false, reason: "Enter the " + what + "." };
  }
  if (!HOST_ID.test(f.id.trim())) return { enabled: false, reason: 'Use a host id of up to 32 lowercase letters, digits, hyphens or underscores. Start with a letter or digit.' };
  if (f.mode === "fresh") {
    for (const [k, what] of [["ref", "git ref"], ["port", "port"], ["label", "service name"], ["fleet", "fleet name"], ["tlsCert", "certificate path"], ["tlsKey", "key path"]] as const) {
      if (!f[k].trim()) return { enabled: false, reason: "Enter the " + what + "." };
    }
  }
  const { profile } = payload(f);
  if (profile && !parseWorkstationProfile(profile)) return { enabled: false, reason: f.group?.trim() ? "Check the group, role / description and harness preference." : "Select or enter a group for this profile." };
  return { enabled: true, reason: "Makes a token here and shows the command. Nothing runs on the host yet." };
}

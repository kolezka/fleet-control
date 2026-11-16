// Pure view logic for the installer page: request payloads, reply parsing and markup.
export type Role = "central" | "adapter" | "client" | "waker";
export type Form = { role: Role; config: string; state: string; hostId: string; port: string };
export type PlanView = { role: string; port: number | null; notes: string[]; commands: { argv: string[]; inspect: boolean }[]; unit: { path: string; content: string } | null };
export type Job = { state: "idle" } | { state: "running" | "succeeded" | "failed"; role: string; digest: string; startedAt: string; finishedAt?: string; message?: string };
export type Info = { platform: string; code: string; bun: string; prerequisites: string };

export const roles: { id: Role; name: string; detail: string }[] = [
  { id: "client", name: "Client", detail: "Gateway user service" },
  { id: "adapter", name: "Adapter", detail: "Host adapter user service" },
  { id: "central", name: "Central", detail: "Fresh Compose setup" },
  { id: "waker", name: "Waker", detail: "Starts the agent when work waits" },
];
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const text = (v: unknown): v is string => typeof v === "string";
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

// Only the fields the chosen role accepts are sent, so a hidden field cannot change the plan.
export function payload(form: Form): Record<string, unknown> {
  const out: Record<string, unknown> = { role: form.role };
  if (form.role === "central") { out.state = form.state.trim(); out.hostId = form.hostId.trim(); }
  else out.config = form.config.trim();
  // The waker has no listener, so it never sends a port.
  const port = form.role === "waker" ? "" : form.port.trim();
  if (port) out.port = /^[0-9]{1,5}$/.test(port) ? Number(port) : port;
  return out;
}
export function parseInfo(body: unknown): { info: Info; job: Job } | null {
  const i = record(record(body)?.installer), job = parseJob(body);
  if (!i || !job || ![i.platform, i.code, i.bun, i.prerequisites].every(text)) return null;
  return { info: i as unknown as Info, job };
}
export function parseJob(body: unknown): Job | null {
  const j = record(record(body)?.job);
  if (!j) return null;
  if (j.state === "idle") return { state: "idle" };
  if (!["running", "succeeded", "failed"].includes(j.state as string) || ![j.role, j.digest, j.startedAt].every(text)) return null;
  return { state: j.state as "running", role: j.role as string, digest: j.digest as string, startedAt: j.startedAt as string, ...(text(j.finishedAt) ? { finishedAt: j.finishedAt } : {}), ...(text(j.message) ? { message: j.message } : {}) };
}
export function parsePlan(body: unknown): { plan: PlanView; digest: string } | null {
  const b = record(body), p = record(b?.plan), o = record(p?.options);
  if (!b || !p || !o || !text(b.digest) || !/^[0-9a-f]{64}$/.test(b.digest) || !text(o.role) || !Array.isArray(p.notes) || !p.notes.every(text) || !Array.isArray(p.commands)) return null;
  const commands: PlanView["commands"] = [];
  for (const raw of p.commands) {
    const c = record(raw);
    if (!c || !Array.isArray(c.argv) || !c.argv.length || !c.argv.every(text)) return null;
    commands.push({ argv: c.argv as string[], inspect: text(c.inspect) });
  }
  const u = p.unit === undefined ? null : record(p.unit);
  if (p.unit !== undefined && (!u || !text(u.path) || !text(u.content))) return null;
  return { digest: b.digest, plan: { role: o.role, port: typeof o.port === "number" ? o.port : null, notes: p.notes as string[], commands, unit: u ? { path: u.path as string, content: u.content as string } : null } };
}
export function errorText(body: unknown, status: number | null): string {
  if (status === null) return "No answer from the gateway.";
  const message = record(record(body)?.error)?.message;
  return text(message) ? message : "Request failed (" + status + ").";
}
const word = (arg: string) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'";
export function planHtml(plan: PlanView): string {
  const notes = plan.notes.map((n) => "<li>" + esc(n) + "</li>").join("");
  const commands = plan.commands.map((c) => "<li><code>" + esc(c.argv.map(word).join(" ")) + "</code><span class=\"tag\">" + (c.inspect ? "read-only check" : "changes this machine") + "</span></li>").join("");
  const unit = plan.unit ? "<div><h3>Service definition to create</h3><p><code>" + esc(plan.unit.path) + "</code></p><pre>" + esc(plan.unit.content) + "</pre></div>" : "";
  return "<div class=\"plan\"><div><h3>Plan for " + esc(plan.role) + (plan.port === null ? "" : " on port " + plan.port) + "</h3><p class=\"phase-note\">Preview only. Nothing has been checked or changed on this machine.</p></div><div><h3>Conditions</h3><ul>" + notes + "</ul></div><div><h3>Commands, in order</h3><ol>" + commands + "</ol></div>" + unit + "</div>";
}
// Status text carries the meaning; tone only adds colour.
export function jobView(job: Job): { tone: "" | "good" | "bad" | "warn"; text: string } {
  if (job.state === "idle") return { tone: "", text: "No apply has run in this gateway process." };
  const what = "Apply for " + job.role;
  if (job.state === "running") return { tone: "warn", text: what + " is running. Started " + job.startedAt + ". Do not close the gateway." };
  if (job.state === "succeeded") return { tone: "good", text: what + " exited successfully. " + (job.message ?? "") };
  return { tone: "bad", text: what + " failed. " + (job.message ?? "") + " Inspect this machine before another attempt." };
}
export function applyGate(s: { previewKey: string | null; currentKey: string; code: string; job: Job; busy: boolean }): { enabled: boolean; reason: string } {
  if (s.job.state === "running") return { enabled: false, reason: "An apply is running." };
  if (s.busy) return { enabled: false, reason: "Working." };
  if (s.previewKey === null) return { enabled: false, reason: "Preview a plan first." };
  if (s.previewKey !== s.currentKey) return { enabled: false, reason: "Options changed. Preview again." };
  if (!s.code.trim()) return { enabled: false, reason: "Enter the apply code." };
  return { enabled: true, reason: "Applies exactly the previewed plan." };
}

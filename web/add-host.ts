// Add-host page. Begin makes the token on the gateway and shows the command; the operator (or SSH)
// runs it on the host; Check adds the host only after the host answers with the right identity.
import { esc, inventoryGroups, parseWorkstationProfile, profileSummary, errorText, formGate, parseCheck, parsePending, parsePendingList, parseSsh, payload, pendingHtml, type Form, type Mode, type Pending } from "./add-host-view.ts";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const TIMEOUT_MS = 15000;
// SSH runs clone and install for a fresh host, which takes minutes.
const SSH_TIMEOUT_MS = 11 * 60_000;
const FIELDS = ["hostName", "hostId", "hostUrl", "principal", "dir", "ref", "port", "label", "fleet", "tlsCert", "tlsKey", "ssh", "sshPort", "group", "description", "defaultHarness"];
const titles: Record<Mode, [string, string, string, string]> = {
  connect: ["Connect a running host service", "Use this for a host whose service already runs. The command adds the gateway's token hash to that service's tokens file and asks it to reread the file. Nothing restarts. The host must run a release that has scripts/enroll.ts; on an older one the command says so and changes nothing.", "Service folder on that host", "The folder the running service starts in, absolute or ~/..."],
  fresh: ["Plan a new host service", "Preview and save a plan without installing anything. Enrollment is a separate step. Use this for a machine without Fleet Control. The command clones the code, installs it, makes an empty fleet and starts a new service on its own port. Existing services, folders and sessions are refused, never changed.", "New code folder on that host", "Must not exist yet. Absolute, or ~/..."],
};

let mode: Mode = "connect";
let preview: string | null = null;
let pending: Pending[] = [];
const notes = new Map<string, string>();
let busy = false;
let notice = "";
let alertText = "";

const form = (): Form => ({
  mode, id: $("hostId").value, name: $("hostName").value, url: $("hostUrl").value, principal: $("principal").value, dir: $("dir").value,
  ref: $("ref").value, port: $("port").value, label: $("label").value, fleet: $("fleet").value, tlsCert: $("tlsCert").value, tlsKey: $("tlsKey").value,
  group: $("group").value, description: $("description").value, defaultHarness: $("defaultHarness").value,
  ssh: $("ssh").value, sshPort: $("sshPort").value,
});

async function call(path: string, body?: unknown, timeout = TIMEOUT_MS): Promise<{ status: number | null; body: unknown }> {
  try {
    const res = await fetch("./api/enroll" + path, { signal: AbortSignal.timeout(timeout), ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: null, body: null };
  }
}

function render() {
  for (const m of ["connect", "fresh"] as const) $("mode-" + m).setAttribute("aria-pressed", String(m === mode));
  const [title, note, dirLabel, dirNote] = titles[mode];
  $("modeTitle").textContent = title;
  $("modeNote").textContent = note;
  $("dirLabel").textContent = dirLabel;
  $("dirNote").textContent = dirNote;
  $("freshFields").hidden = mode !== "fresh";
  const gate = formGate(form(), busy);
  $("begin").disabled = !gate.enabled;
  $("begin").textContent = mode === "fresh" ? "Preview installation plan" : "Make token and command";
  $("planPanel").hidden = preview === null;
  $("startEnrollment").disabled = busy || preview === null;
  $("savePlan").disabled = busy || preview === null;
  $("formStatus").textContent = notice || (mode === "fresh" && gate.enabled ? "Preview locally before starting enrollment." : gate.reason);
  $("pending").innerHTML = pending.length ? pending.map((p) => pendingHtml(p, notes.get(p.id) ?? "")).join("") : '<li class="phase-note">No host is being added.</li>';
  $("pendingCount").textContent = pending.length ? String(pending.length) : "None";
  $("alert").hidden = !alertText;
  $("alert").textContent = alertText;
}

async function loadGroups() {
  let groups: string[] | null = null;
  try {
    const res = await fetch('./api/hosts', { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 200) groups = inventoryGroups(await res.json());
  } catch { /* Group suggestions are optional; manual entry still works. */ }
  $("groupOptions").innerHTML = (groups ?? []).map(g => `<option value="${esc(g)}"></option>`).join('');
  $("groupNote").textContent = groups === null ? 'Cannot read existing groups. You can still enter a group name.' : 'Select an existing group or type a new name. A profile needs a group.';
}

async function loadPlans() {
  const res = await call("/plans");
  const rows = (res.body as { plans?: unknown } | null)?.plans;
  const valid = res.status === 200 && Array.isArray(rows) && rows.every(p => p && p.mode === "fresh" && typeof p.name === "string" && typeof p.url === "string" && typeof p.id === "string" && (p.profile === undefined || parseWorkstationProfile(p.profile)));
  $("savedPlans").textContent = valid ? rows.map(p => `${p.name} (${p.id}) · ${p.url}${p.profile ? '\n' + profileSummary(p.profile) : ''}`).join("\n") || "No saved plans." : "Cannot read saved plans.";
}

async function load() {
  const res = await call("");
  const list = res.status === 200 ? parsePendingList(res.body) : null;
  if (!list) { alertText = res.status === 404 ? "Adding hosts is not enabled in this gateway. Start it with FLEET_CONTROL_ENROLL=1." : "Cannot read the hosts being added. " + errorText(res.body, res.status); render(); return; }
  pending = list;
  await Promise.all([loadGroups(), loadPlans()]);
  alertText = "";
  render();
}

async function work(label: string, action: () => Promise<void>) {
  if (busy) return;
  busy = true; notice = label; render();
  try { await action(); } finally { busy = false; render(); }
}

const begin = () => work("Making the token.", async () => {
  const res = await call("", payload(form()));
  const p = res.status === 201 ? parsePending((res.body as { pending?: unknown } | null)?.pending) : null;
  if (!p) { notice = "Not started: " + errorText(res.body, res.status); return; }
  pending = [...pending.filter((x) => x.id !== p.id), p];
  notes.set(p.id, "Run the command on the host, then press Check.");
  notice = "Token made for " + p.id + ". Nothing ran on the host yet.";
});

const act = (id: string, action: string) => work("Working on " + id + ".", async () => {
  const p = pending.find((x) => x.id === id);
  if (!p) return;
  if (action === "copy") {
    try { await navigator.clipboard.writeText(p.command); notes.set(id, "Command copied. Run it on the host, then press Check."); }
    catch { notes.set(id, "Copy failed; select the command and copy it by hand."); }
    return;
  }
  if (action === "ssh") {
    notes.set(id, "Running over SSH. A fresh install can take a few minutes.");
    render();
    const res = await call("/" + id + "/ssh", {}, SSH_TIMEOUT_MS);
    const r = res.status === 200 ? parseSsh(res.body) : null;
    if (!r) { notes.set(id, res.status === null ? "No answer. Unknown whether the command ran; press Check." : "SSH not run: " + errorText(res.body, res.status)); return; }
    notes.set(id, (r.code === 0 ? "The command exited 0. Press Check to confirm the host. " : "The command exited " + r.code + ". ") + r.output.trim().split("\n").slice(-3).join(" "));
    return;
  }
  if (action === "check") {
    const res = await call("/" + id + "/check", {});
    const r = res.status === 200 ? parseCheck(res.body) : null;
    if (!r) { notes.set(id, "Check failed: " + errorText(res.body, res.status)); return; }
    if (!r.added) { notes.set(id, "Not added: " + (r.reason ?? "no reason given")); return; }
    pending = pending.filter((x) => x.id !== id);
    notes.delete(id);
    if (p.profile) await loadGroups();
    notice = p.name + " was added. It shows on the terminals page.";
    return;
  }
  if (action === "cancel") {
    const res = await call("/" + id + "/cancel", {});
    if (res.status !== 200) { notes.set(id, "Cancel failed: " + errorText(res.body, res.status)); return; }
    pending = pending.filter((x) => x.id !== id);
    notes.delete(id);
    notice = "Cancelled " + id + ". If the command already ran there, revoke " + p.principal + " on that host.";
  }
});

function invalidatePreview() {
  preview = null;
  $("planSummary").textContent = "";
  notice = "";
  render();
}
for (const m of ["connect", "fresh"] as const) $("mode-" + m).addEventListener("click", () => { mode = m; invalidatePreview(); });
for (const id of FIELDS) $(id).addEventListener("input", invalidatePreview);
$("hostForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const fields = form();
  if (!formGate(fields, busy).enabled) return;
  if (mode === "connect") { void begin(); return; }
  const plan = payload(fields);
  preview = JSON.stringify(plan);
  const profile = parseWorkstationProfile(plan.profile);
  $("planSummary").textContent = [
    `Workstation: ${plan.name} (${plan.id}) at ${plan.url}`,
    ...(profile ? [profileSummary(profile)] : []),
    `Checkout: ${plan.ref} into ${plan.dir}`,
    `New service: ${plan.label}, port ${plan.port}, fleet ${plan.fleet}`,
    `Certificate: ${plan.tlsCert}; key path: ${plan.tlsKey}`,
    `Operator identity: ${plan.principal}`,
    plan.ssh ? `Optional SSH target: ${plan.ssh}, port ${plan.sshPort ?? 22}` : "Manual execution on the workstation",
  ].join("\n");
  notice = "Preview ready. Enrollment has not started.";
  render();
});
$("savePlan").addEventListener("click", () => {
  const plan = payload(form());
  if (busy || mode !== "fresh" || preview !== JSON.stringify(plan)) return;
  void work("Saving installation plan.", async () => {
    const res = await call("/plans", plan);
    if (res.status !== 201 || (res.body as { saved?: unknown } | null)?.saved !== true) {
      notice = res.status === null ? "No reply. Check saved plans before retrying." : "Plan save not confirmed: " + errorText(res.body, res.status);
    } else {
      notice = `Plan saved for ${plan.id}. Enrollment has not started.`;
    }
    await loadPlans();
  });
});
$("startEnrollment").addEventListener("click", () => {
  if (busy || mode !== "fresh" || preview === null || preview !== JSON.stringify(payload(form()))) return;
  invalidatePreview();
  void begin();
});
$("pending").addEventListener("click", (e) => {
  const b = (e.target as Element).closest?.("button[data-act]") as HTMLButtonElement | null;
  if (b?.dataset.id && b.dataset.act) void act(b.dataset.id, b.dataset.act);
});
render();
await load();

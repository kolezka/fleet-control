// Installer page. Plan preview is harmless; apply sends exactly the previewed options, the plan
// digest and the apply code, then follows the single server-side job.
import { applyGate, errorText, jobView, parseInfo, parseJob, parsePlan, payload, planHtml, roles, type Form, type Job, type PlanView, type Role } from "./install-view.ts";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const TIMEOUT_MS = 15000;
const defaults: Record<Role, { port: string; config: string }> = { client: { port: "4870", config: "/absolute/private/client.json" }, adapter: { port: "4882", config: "/absolute/private/adapter.json" }, central: { port: "4881", config: "" } };
const managers: Record<string, string> = { darwin: "macOS, launchd user agent", linux: "Linux, systemd user service" };

let role: Role = "client";
let job: Job = { state: "idle" };
let preview: { key: string; digest: string; plan: PlanView } | null = null;
let busy = false;
let notice = "";
let alertText = "";

const form = (): Form => ({ role, config: $("config").value, state: $("state").value, hostId: $("hostId").value, port: $("port").value });
const currentKey = () => JSON.stringify(payload(form()));

async function call(path: string, body?: unknown): Promise<{ status: number | null; body: unknown }> {
  try {
    const res = await fetch("./api/install" + path, { signal: AbortSignal.timeout(TIMEOUT_MS), ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: null, body: null };
  }
}

function render() {
  for (const r of roles) $("role-" + r.id).setAttribute("aria-pressed", String(r.id === role));
  $("roleTitle").textContent = roles.find((r) => r.id === role)!.name;
  $("fieldConfig").hidden = role === "central";
  $("fieldState").hidden = $("fieldHostId").hidden = role !== "central";
  $("config").setAttribute("placeholder", defaults[role].config);
  $("port").setAttribute("placeholder", defaults[role].port);
  const key = currentKey();
  const stale = preview !== null && preview.key !== key;
  $("plan").innerHTML = preview
    ? (stale ? '<p class="phase-note stale">Options changed since this preview. Preview again before applying.</p>' : "") + planHtml(preview.plan)
    : '<p class="phase-note">No plan yet. Fill in the options and preview. A preview does not check or change this machine.</p>';
  $("applyContext").textContent = preview ? (stale ? "Preview out of date" : "Plan for " + preview.plan.role) : "No plan previewed";
  const gate = applyGate({ previewKey: preview?.key ?? null, currentKey: key, code: $("applyCode").value, job, busy });
  $("apply").disabled = !gate.enabled;
  $("applyStatus").textContent = gate.reason;
  $("preview").disabled = $("doctor").disabled = busy;
  const view = jobView(job);
  $("jobText").textContent = view.text;
  $("jobText").dataset.tone = view.tone;
  $("formStatus").textContent = notice;
  $("alert").hidden = !alertText;
  $("alert").textContent = alertText;
}

async function readJob() {
  const res = await call("/job");
  const next = parseJob(res.body);
  if (next) { job = next; alertText = ""; }
  else alertText = "Cannot read the installer state. If an apply was running, its outcome is unknown: inspect this machine.";
  render();
}

async function load() {
  const res = await call("");
  const parsed = parseInfo(res.body);
  if (!parsed) { alertText = res.status === 404 ? "The installer is not enabled in this gateway." : "Cannot read the installer state. " + errorText(res.body, res.status); render(); return; }
  job = parsed.job;
  $("machine").textContent = (managers[parsed.info.platform] ?? parsed.info.platform + ", adapter and client unsupported") + " · " + parsed.info.code;
  // The header cuts long paths, so keep the full text reachable.
  $("machine").setAttribute("title", parsed.info.code);
  $("prerequisites").textContent = parsed.info.prerequisites;
  render();
}

async function work(label: string, action: () => Promise<void>) {
  if (busy) return;
  busy = true; notice = label; render();
  try { await action(); } finally { busy = false; render(); }
}

const previewPlan = () => work("Preparing the plan.", async () => {
  const sent = form();
  const res = await call("/plan", payload(sent));
  const parsed = res.status === 200 ? parsePlan(res.body) : null;
  if (!parsed) { preview = null; notice = "No plan: " + errorText(res.body, res.status); return; }
  preview = { key: JSON.stringify(payload(sent)), ...parsed };
  notice = "Plan ready. Nothing was changed.";
});

const checkPrerequisites = () => work("Checking prepared paths.", async () => {
  const res = await call("/doctor", {});
  const b = res.body as { ok?: unknown; message?: unknown } | null;
  notice = res.status === 200 && b && typeof b.message === "string" ? (b.ok === true ? "" : "Check failed: ") + b.message : "Check failed: " + errorText(res.body, res.status);
});

const applyPlan = () => work("Starting apply.", async () => {
  const key = currentKey();
  if (!preview || preview.key !== key || !applyGate({ previewKey: preview.key, currentKey: key, code: $("applyCode").value, job, busy: false }).enabled) { notice = ""; return; }
  const res = await call("/apply", { ...payload(form()), digest: preview.digest, code: $("applyCode").value.trim() });
  const started = res.status === 202 ? parseJob(res.body) : null;
  if (started) {
    // A second apply needs a fresh preview and the code again.
    job = started; preview = null; $("applyCode").value = ""; notice = "Apply started.";
    return;
  }
  if (res.status === null) { notice = "No answer. Unknown whether the apply started; see Result."; await readJob(); return; }
  notice = "Apply refused: " + errorText(res.body, res.status);
});

for (const r of roles) $("role-" + r.id).addEventListener("click", () => { role = r.id; notice = ""; render(); });
for (const id of ["config", "state", "hostId", "port", "applyCode"]) $(id).addEventListener("input", () => render());
$("optionsForm").addEventListener("submit", (e) => { e.preventDefault(); void previewPlan(); });
$("doctor").addEventListener("click", () => void checkPrerequisites());
$("applyForm").addEventListener("submit", (e) => { e.preventDefault(); void applyPlan(); });
setInterval(() => { if (job.state === "running") void readJob(); }, 2000);
render();
await load();

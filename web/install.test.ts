import { expect, test } from "bun:test";
import * as view from "./install-view.ts";

const digest = "ab".repeat(32);
const planBody = (role = "client") => ({ digest, plan: { options: { role, port: 4870 }, notes: ["Prepared checkout only"], commands: [{ argv: ["launchctl", "list"], inspect: "services" }, { argv: ["launchctl", "bootstrap", "gui/501", "/h/a b.plist"] }], unit: { path: "/h/a b.plist", content: "<plist>" } } });
const info = { installer: { platform: "darwin", code: "/prepared/code", bun: "/tools/bun", prerequisites: "Requires a prepared checkout." }, job: { state: "idle" } };

// Runs the page module against a small DOM and fetch fixture. No browser, no network.
async function page(respond: (path: string, init?: RequestInit) => { status: number; body: unknown } | null) {
  const elements = new Map<string, any>();
  const listeners = new Map<string, (event: any) => unknown>();
  const element = (id: string): any => {
    if (!elements.has(id)) {
      const attributes: Record<string, string> = {};
      elements.set(id, { innerHTML: "", textContent: "", value: "", disabled: false, hidden: false, dataset: {}, attributes, setAttribute: (k: string, v: string) => { attributes[k] = v; }, addEventListener: (kind: string, fn: any) => listeners.set(id + ":" + kind, fn) });
    }
    return elements.get(id);
  };
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const reply = respond(path, init);
    if (!reply) throw new Error("network down");
    return { status: reply.status, json: async () => reply.body };
  };
  let source = await Bun.file(new URL("./install.ts", import.meta.url)).text();
  source = source.replace(/import {([\s\S]*?)} from ".\/install-view.ts";/, (_m, names) => "const {" + names.replace(/type \w+,?/g, "") + "} = view;");
  expect(source).not.toContain("import ");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync("(async () => {" + source + "})()");
  await new Function("view", "document", "fetch", "setInterval", "return " + js)(view, { getElementById: element }, fetch, () => 0);
  // Handlers start async work without returning it, so let it settle before asserting.
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const fire = async (key: string) => { listeners.get(key)!({ preventDefault() {} }); await settle(); };
  await settle();
  const type = async (id: string, value: string) => { element(id).value = value; await fire(id + ":input"); };
  const posts = () => calls.filter(c => c.init?.method === "POST").map(c => ({ path: c.path, body: JSON.parse(c.init!.body as string) }));
  return { element, fire, type, posts, calls };
}
const normal = (path: string, init?: RequestInit) => {
  if (!init) return { status: 200, body: path.endsWith("/job") ? { job: { state: "idle" } } : info };
  if (path.endsWith("/plan")) return { status: 200, body: planBody(JSON.parse(init.body as string).role) };
  if (path.endsWith("/apply")) return { status: 202, body: { job: { state: "running", role: "client", digest, startedAt: "2026-11-14T10:00:00.000Z" } } };
  return { status: 200, body: { ok: true, message: "Prepared local paths present." } };
};

test("payload carries only the fields of the chosen role", () => {
  const form = { role: "client" as const, config: " /p/c.json ", state: "/leftover/state", hostId: "leftover", port: "" };
  expect(view.payload(form)).toEqual({ role: "client", config: "/p/c.json" });
  expect(view.payload({ ...form, role: "central", port: "4881" })).toEqual({ role: "central", state: "/leftover/state", hostId: "leftover", port: 4881 });
  // A malformed port is passed on as text so the server refuses it; it is never guessed.
  expect(view.payload({ ...form, port: "48x" }).port).toBe("48x");
});

test("replies are validated before they are shown", () => {
  expect(view.parsePlan(planBody())!.plan.commands.map(c => c.inspect)).toEqual([true, false]);
  for (const bad of [null, {}, { ...planBody(), digest: "short" }, { digest, plan: { options: { role: "client" }, notes: [1], commands: [] } }, { digest, plan: { options: { role: "client" }, notes: [], commands: [{ argv: [] }] } }, { digest, plan: { options: { role: "client" }, notes: [], commands: [], unit: { path: 1 } } }]) expect(view.parsePlan(bad)).toBeNull();
  expect(view.parseJob({ job: { state: "idle" } })).toEqual({ state: "idle" });
  for (const bad of [null, { job: { state: "done" } }, { job: { state: "running" } }]) expect(view.parseJob(bad)).toBeNull();
  expect(view.parseInfo({ installer: { platform: "linux" }, job: { state: "idle" } })).toBeNull();
  expect(view.errorText({ error: { message: "invalid install role" } }, 400)).toBe("invalid install role");
  expect(view.errorText("<html>", 502)).toBe("Request failed (502).");
  expect(view.errorText(null, null)).toBe("No answer from the gateway.");
});

test("plan markup escapes server text and labels what changes the machine", () => {
  const hostile = { role: "<b>client", port: 4870, notes: ['<img src=x onerror="bad">'], commands: [{ argv: ["sh", "-c", "a'b <script>"], inspect: false }], unit: { path: "/p/<x>", content: "</pre><script>bad()</script>" } };
  const html = view.planHtml(hostile);
  for (const raw of ["<img", "<script>", "<b>client", "</pre><script>"]) expect(html).not.toContain(raw);
  expect(html).toContain("&lt;img src=x onerror=&quot;bad&quot;&gt;");
  expect(html).toContain("changes this machine");
  expect(view.planHtml(view.parsePlan(planBody())!.plan)).toContain("launchctl bootstrap gui/501 &#39;/h/a b.plist&#39;");
});

test("status text separates running, exited and failed without claiming health", () => {
  expect(view.jobView({ state: "idle" }).tone).toBe("");
  const base = { role: "client", digest, startedAt: "t" };
  expect(view.jobView({ state: "running", ...base })).toMatchObject({ tone: "warn" });
  expect(view.jobView({ state: "succeeded", ...base, message: "User service registered. No health verification claimed." }).text).toContain("No health verification claimed");
  expect(view.jobView({ state: "failed", ...base, message: "pre-existing service refused" }).text).toContain("Inspect this machine");
});

test("apply stays disabled until the exact previewed options and a code are present", async () => {
  const p = await page(normal);
  expect(p.element("apply").disabled).toBe(true);
  expect(p.element("applyStatus").textContent).toBe("Preview a plan first.");
  await p.type("applyCode", "code-from-file");
  expect(p.element("apply").disabled).toBe(true);
  // Submitting anyway sends nothing.
  await p.fire("applyForm:submit");
  expect(p.posts()).toHaveLength(0);

  await p.type("config", "/p/client.json");
  await p.fire("optionsForm:submit");
  expect(p.posts()).toEqual([{ path: "./api/install/plan", body: { role: "client", config: "/p/client.json" } }]);
  expect(p.element("plan").innerHTML).toContain("Plan for client");
  expect(p.element("apply").disabled).toBe(false);

  // Any change after the preview makes it stale.
  await p.type("port", "4999");
  expect(p.element("apply").disabled).toBe(true);
  expect(p.element("applyStatus").textContent).toBe("Options changed. Preview again.");
  expect(p.element("plan").innerHTML).toContain("Options changed since this preview");
  await p.fire("applyForm:submit");
  expect(p.posts()).toHaveLength(1);
  await p.fire("role-central:click");
  expect(p.element("apply").disabled).toBe(true);
  expect(p.element("fieldConfig").hidden).toBe(true);
  expect(p.element("fieldState").hidden).toBe(false);
  await p.fire("role-client:click");
  await p.type("port", "");
  expect(p.element("apply").disabled).toBe(false);
});

test("apply sends the previewed options, digest and code once, then needs a new preview", async () => {
  const p = await page(normal);
  await p.type("config", "/p/client.json");
  await p.fire("optionsForm:submit");
  await p.type("applyCode", " code-from-file ");
  await p.fire("applyForm:submit");
  expect(p.posts().at(-1)).toEqual({ path: "./api/install/apply", body: { role: "client", config: "/p/client.json", digest, code: "code-from-file" } });
  expect(p.element("applyCode").value).toBe("");
  expect(p.element("jobText").textContent).toContain("is running");
  expect(p.element("jobText").dataset.tone).toBe("warn");
  expect(p.element("apply").disabled).toBe(true);
  await p.fire("applyForm:submit");
  expect(p.posts().filter(c => c.path.endsWith("/apply"))).toHaveLength(1);
});

test("a refused or unanswered apply is reported, never retried", async () => {
  const refused = await page((path, init) => path.endsWith("/apply") ? { status: 403, body: { error: { kind: "forbidden", message: "apply code required" } } } : normal(path, init));
  await refused.type("config", "/p/client.json");
  await refused.fire("optionsForm:submit");
  await refused.type("applyCode", "wrong");
  await refused.fire("applyForm:submit");
  expect(refused.element("formStatus").textContent).toBe("Apply refused: apply code required");
  expect(refused.element("jobText").textContent).toContain("No apply has run");

  let down = false;
  const lost = await page((path, init) => down ? null : normal(path, init));
  await lost.type("config", "/p/client.json");
  await lost.fire("optionsForm:submit");
  await lost.type("applyCode", "code-from-file");
  down = true;
  await lost.fire("applyForm:submit");
  expect(lost.posts().filter(c => c.path.endsWith("/apply"))).toHaveLength(1);
  expect(lost.element("formStatus").textContent).toContain("Unknown whether the apply started");
  expect(lost.element("alert").hidden).toBe(false);
  expect(lost.element("alert").textContent).toContain("outcome is unknown");
});

test("a server refusal of the plan is shown and leaves nothing to apply", async () => {
  const p = await page((path, init) => path.endsWith("/plan") ? { status: 400, body: { error: { kind: "invalid", message: "paths must be normalized absolute paths without control characters" } } } : normal(path, init));
  await p.type("config", "relative.json");
  await p.fire("optionsForm:submit");
  expect(p.element("formStatus").textContent).toContain("No plan: paths must be normalized");
  await p.type("applyCode", "code-from-file");
  expect(p.element("apply").disabled).toBe(true);

  const off = await page(() => ({ status: 404, body: { error: { kind: "not_found", message: "not found" } } }));
  expect(off.element("alert").textContent).toBe("The installer is not enabled in this gateway.");
});

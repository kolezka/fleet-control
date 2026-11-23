import { expect, test } from "bun:test";
import * as state from "./host-state.ts";

// Execute the browser module against a small DOM/fetch fixture, without terminal or network access.
async function browser(hosts: unknown[], respond: (path: string, init?: RequestInit) => unknown, intervals: (() => void)[] = [], timers: { fn: () => void; ms: number }[] | null = null) {
  const sockets: { url: string; closed: boolean }[] = [];
  class FakeSocket { static OPEN = 1; url: string; closed = false; readyState = 1; sent: unknown[] = []; onopen: any; onmessage: any; onclose: any; constructor(u: URL) { this.url = String(u); sockets.push(this); } close() { this.closed = true; } send(d: unknown) { this.sent.push(d); } }
  // A terminal stand-in that records its options and lets a test press keys.
  const terms: { options: { disableStdin?: boolean }; press(d: string): void }[] = [];
  class FakeTerminal { options: any; keys: ((d: string) => void)[] = []; constructor(o: any) { this.options = { ...o }; terms.push(this); } open() {} write() {} focus() {} dispose() {} onData(f: (d: string) => void) { this.keys.push(f); } press(d: string) { for (const f of this.keys) f(d); } }
  const elements = new Map<string, any>();
  const listeners = new Map<string, (event: any) => unknown>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", value: "", disabled: false, hidden: false, dataset: {}, classList: { toggle() {} }, focus() {}, setAttribute() {}, contains: () => false, querySelector: (sel: string) => element(id + (sel === ".typebtn" ? ":typebtn" : ":child")), closest: () => element(id + ":parent"), replaceChildren() {}, addEventListener: (kind: string, fn: any) => listeners.set(id + ":" + kind, fn) });
    return elements.get(id);
  };
  const document = { hidden: false, getElementById: element, documentElement: element("root"), activeElement: null, addEventListener: (kind: string, fn: any) => listeners.set(kind, fn) };
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    // The gateway refuses any POST that is not JSON (src/client-gateway.ts); answer the page the same way.
    if (init?.method === "POST" && new Headers(init.headers).get("content-type") !== "application/json") {
      return { status: 415, ok: false, json: async () => ({ error: { code: "unsupported_media_type", message: "content-type must be application/json" } }) };
    }
    const value = path === "./api/hosts" ? (Array.isArray(hosts) ? { hosts } : hosts) : respond(path, init);
    const status = (value as { __status?: number } | null)?.__status ?? 200;
    return { status, ok: status < 300, json: async () => value };
  };
  let source = await Bun.file(new URL("./app.ts", import.meta.url)).text();
  source = source.replace(/import { init, Terminal } from "ghostty-web";/, "const init = async () => {}; const Terminal = FakeTerminal;");
  source = source.replace(/import {([\s\S]*?)} from ".\/lease.ts";/, (_m, names) => "const {" + names.replace(/type \w+,?/g, "") + "} = leaseModule;");
  source = source.replace(/import {([\s\S]*?)} from ".\/host-state.ts";/, (_m, names) => "const {" + names.replace(/type \w+,?/g, "") + "} = state;");
  source = source.replace(/import {([\s\S]*?)} from ".\/fleet-admin.ts";/, (_m, names) => "const {" + names.replace(/type \w+,?/g, "") + "} = adminModule;");
  source = source.replace(/import {([\s\S]*?)} from ".\/agents.ts";/, (_m, names) => "const {" + names.replace(/type \w+,?/g, "") + "} = agentsModule;");
  source = source.replace(/export /g, "");
  source += "\nreturn { loadHostList, getFleet: () => fleet };";
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync("(async () => {" + source + "})()");
  const agentsModule = await import("./agents.ts");
  const leaseModule = await import("./lease.ts");
  const adminModule = await import("./fleet-admin.ts");
  const run = new Function("adminModule", "FakeTerminal", "leaseModule", "state", "agentsModule", "document", "window", "fetch", "setInterval", "location", "CSS", "getComputedStyle", "WebSocket", "setTimeout", "clearTimeout", "return " + js);
  const later = timers ? (fn: () => void, ms: number) => { const t = { fn, ms }; timers.push(t); return t; } : setTimeout;
  const cancel = timers ? (t: unknown) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1); } : clearTimeout;
  const app = await run(adminModule, FakeTerminal, leaseModule, state, agentsModule, document, { matchMedia: () => ({ matches: false }) }, fetch, (fn: () => void) => { intervals.push(fn); return 0; }, { assign() {}, href: "http://127.0.0.1:4870/" }, { escape: (s: string) => s }, () => ({ getPropertyValue: () => "" }), FakeSocket, later, cancel);
  await new Promise(resolve => setTimeout(resolve, 0));
  const click = async (dataset: Record<string, string>) => {
    await listeners.get("click")!({ target: { closest: () => ({ dataset }) } });
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { app, element, calls, click, listeners, document, sockets, terms };
}

test("a tab hidden for a minute closes its terminal sockets and reopens them when shown", async () => {
  const timers: { fn: () => void; ms: number }[] = [];
  const legacy = { id: "a", name: "A", apiBase: "/api/hosts/a" };
  const b = await browser([legacy], path => path.endsWith("/sessions") ? { sessions: [{ name: "probe", host: null, role: null, registered: true, running: true, model: { state: "not_applicable" } }] } : path.includes("/requests") ? { requests: [], runs: [] } : { commands: [] }, [], timers);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.sockets.map(s => [s.url, s.closed])).toEqual([["ws://127.0.0.1:4870/api/hosts/a/sessions/probe/terminal?cols=80&rows=24", false]]);

  // Hidden briefly: nothing closes, and showing the tab again cancels the release.
  b.document.hidden = true;
  b.listeners.get("visibilitychange")!({});
  expect(timers.filter(t => t.ms === 60_000)).toHaveLength(1);
  b.document.hidden = false;
  b.listeners.get("visibilitychange")!({});
  expect(timers.filter(t => t.ms === 60_000)).toHaveLength(0);
  expect(b.sockets).toHaveLength(1);

  // Hidden for the full minute: the socket closes; shown again: one new socket.
  b.document.hidden = true;
  b.listeners.get("visibilitychange")!({});
  timers.find(t => t.ms === 60_000)!.fn();
  expect(b.sockets[0]!.closed).toBe(true);
  expect(b.element("terminals").textContent).toBe("Terminals paused while the tab was hidden");
  b.document.hidden = false;
  b.listeners.get("visibilitychange")!({});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.sockets.map(s => s.closed)).toEqual([true, false]);
});

test("browser skips polling while the tab is hidden and refreshes when it is shown", async () => {
  const intervals: (() => void)[] = [];
  const legacy = { id: "a", name: "A", apiBase: "/api/hosts/a" };
  const b = await browser([legacy], path => path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : { commands: [] }, intervals);
  // sessions, commands/requests, agents, host list
  expect(intervals).toHaveLength(4);
  const reads = () => b.calls.length;
  b.document.hidden = true;
  const before = reads();
  for (const tick of intervals) tick();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(reads()).toBe(before);
  b.listeners.get("visibilitychange")!({});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(reads()).toBe(before);
  b.document.hidden = false;
  for (const tick of intervals) tick();
  await new Promise(resolve => setTimeout(resolve, 0));
  const ticked = b.calls.slice(before).map(c => c.path);
  expect(ticked.some(p => p.endsWith("/sessions"))).toBe(true);
  expect(ticked.some(p => p.includes("/commands"))).toBe(true);
  expect(ticked).toContain("./api/hosts");
  const shown = reads();
  b.listeners.get("visibilitychange")!({});
  await new Promise(resolve => setTimeout(resolve, 0));
  const refreshed = b.calls.slice(shown).map(c => c.path);
  expect(refreshed.some(p => p.endsWith("/sessions"))).toBe(true);
  expect(refreshed.some(p => p.includes("/commands"))).toBe(true);
});
for (const mismatch of ["text", "idempotencyKey"] as const) {
  test("browser rejects same-destination acknowledgement with mismatched " + mismatch, async () => {
    const b = await browser([host], (path, init) => {
      if (init?.method === "POST") {
        const sent = JSON.parse(init.body as string);
        return { command: { ...command, text: sent.text, idempotencyKey: sent.idempotencyKey, [mismatch]: "different" } };
      }
      return path.endsWith("/sessions") ? { sessions: [] } : { commands: [], nextCursor: null };
    });
    b.element("instruction").value = "intended task";
    await b.listeners.get("instruction:input")!({});
    await b.listeners.get("instructionForm:submit")!({ preventDefault() {} });
    const pending = b.app.getFleet().hosts.a;
    expect(pending.draft).toBe("intended task");
    expect(pending.intent).not.toBeNull();
    expect(pending.notice).toContain("Unknown whether");
    await b.listeners.get("instructionForm:submit")!({ preventDefault() {} });
    const posts = b.calls.filter(c => c.init?.method === "POST");
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[1]!.init!.body as string).idempotencyKey).toBe(JSON.parse(posts[0]!.init!.body as string).idempotencyKey);
  });
}

const host = { id: "a", name: "A", apiBase: "/api/hosts/a", supervisor: { hostId: "central-a", session: "supervisor" } };
const command = { id: "cmd-1", hostId: "central-a", target: "supervisor", actor: "<operator>", text: '<img src=x onerror="bad">', status: "claimed", createdAt: "t", updatedAt: "t" };
test("browser mapped panel reads commands without approvals, escapes content, and only loads requested pages", async () => {
  const b = await browser([host], path => path.endsWith("/sessions") ? { nope: true }
    : path.includes("/cooperative") ? { command, claim: { incarnationId: "<inc>", incarnationActive: false, settled: true, requestId: "r", createdAt: "t" }, events: [{ seq: "1", requestId: "r", status: "completed", detail: "<done>", at: "t" }], nextCursor: "1" }
    : { commands: [command], nextCursor: "next" });
  expect(b.calls.some(c => c.path.includes("/requests"))).toBe(false);
  expect(b.calls.filter(c => c.path.endsWith("/commands"))).toHaveLength(1);
  expect(b.element("requests").innerHTML).toContain("Approvals unavailable");
  expect(b.element("phaseState").textContent).toContain("Workflow unavailable");
  expect(b.element("composerTarget").textContent).toContain("cooperative pull, no wakeup");
  expect(b.element("exchangeRows").innerHTML).toContain("&lt;img");
  expect(b.element("exchangeRows").innerHTML).not.toContain('<img src');
  expect(b.element("eventText").textContent).toContain("not complete history");
  // No agent routes through the central supervisor: the box is hidden and never read.
  expect(b.element("agentsBox").hidden).toBe(true);
  expect(b.calls.some(c => c.path.endsWith("/agents"))).toBe(false);
  await b.click({ page: "commands", host: "a" });
  expect(b.calls.some(c => c.path.endsWith("/commands?cursor=next"))).toBe(true);
  expect(b.calls.some(c => c.path.includes("/cooperative"))).toBe(false);
  await b.click({ page: "select", host: "a", command: "cmd-1" });
  const html = b.element("exchangeRows").innerHTML;
  expect(html).toContain("reservation only, not acceptance or execution");
  expect(html).toContain("Lifecycle reports, separate from command row");
  expect(html).toContain("incarnationActive: false · settled: true");
  expect(html).toContain("&lt;done&gt;");
  expect(html).toContain("More lifecycle events available");
  expect(b.calls.filter(c => c.path.includes("/cooperative"))).toHaveLength(1);
  await b.click({ page: "events", host: "a" });
  expect(b.calls.some(c => c.path.endsWith("/cooperative?cursor=1"))).toBe(true);
  expect(b.element("exchangeRows").innerHTML).toContain("Inspection unknown");
});
test("browser pins submitted command inspection outside the first history page", async () => {
  let key = "";
  const b = await browser([host], (path, init) => {
    if (init?.method === "POST") {
      const sent = JSON.parse(init.body as string);
      key = sent.idempotencyKey;
      return { command: { ...command, id: "new-command", text: sent.text, idempotencyKey: key } };
    }
    if (path.includes("/cooperative")) return { command: { ...command, id: "new-command" }, claim: null, events: [], nextCursor: null };
    return path.endsWith("/sessions") ? { sessions: [] } : { commands: [], nextCursor: null };
  });
  b.element("instruction").value = "new work";
  await b.listeners.get("instruction:input")!({});
  await b.listeners.get("instructionForm:submit")!({ preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.app.getFleet().hosts.a.selectedCommand).toBe("new-command");
  expect(b.calls.some(c => c.path.includes("/commands/new-command/cooperative"))).toBe(true);
  expect(b.element("exchangeRows").innerHTML).toContain("Inspection: new-command");
});

test("browser unmapped host keeps legacy requests and command reads", async () => {
  const { supervisor, ...legacy } = host;
  const b = await browser([legacy], path => path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : { commands: [] });
  expect(b.calls.some(c => c.path.endsWith("/requests?view=current"))).toBe(true);
  expect(b.element("phaseState").textContent).toContain("No run registered");
});
test("browser preserves unknown send key on malformed success and mapping replacement rejects late inspection", async () => {
  const hosts = [{ ...host }];
  let inspectResolve: ((value: unknown) => void) | undefined;
  let delayInspection = false;
  const b = await browser(hosts, (path, init) => {
    if (init?.method === "POST") return { command: { id: 9 } };
    if (path.includes("/cooperative") && delayInspection) return new Promise(resolve => { inspectResolve = resolve; });
    if (path.endsWith("/sessions")) return { sessions: [] };
    return { commands: [command], nextCursor: null };
  });
  b.element("instruction").value = "work";
  await b.listeners.get("instruction:input")!({});
  await b.listeners.get("instructionForm:submit")!({ preventDefault() {} });
  expect(b.app.getFleet().hosts.a.intent).not.toBeNull();
  const first = JSON.parse(b.calls.find(c => c.init?.method === "POST")!.init!.body as string);
  await b.listeners.get("instructionForm:submit")!({ preventDefault() {} });
  const posts = b.calls.filter(c => c.init?.method === "POST");
  expect(posts).toHaveLength(2);
  expect(JSON.parse(posts[1]!.init!.body as string).idempotencyKey).toBe(first.idempotencyKey);
  expect(first.target).toBe("supervisor");
  delayInspection = true;
  await b.click({ page: "select", host: "a", command: "cmd-1" });
  const gen = b.app.getFleet().hosts.a.gen;
  hosts[0] = { ...host, supervisor: { hostId: "replacement", session: "new-session" } };
  await b.app.loadHostList();
  inspectResolve!({ command, claim: null, events: [], nextCursor: null });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.app.getFleet().hosts.a.gen).not.toBe(gen);
  expect(b.app.getFleet().hosts.a.intent).toBeNull();
  expect(b.app.getFleet().hosts.a.inspection).toBeNull();
  expect(b.element("composerTarget").textContent).toContain("new-session");
});

test("browser header carries the full host name for a clipped title", async () => {
  const name = "build-workstation-04.example-tailnet.ts.net";
  const b = await browser([{ ...host, name }], path => path.endsWith("/sessions") ? { sessions: [] } : { commands: [], nextCursor: null });
  expect(b.element("hostTitle").textContent).toBe(name);
  expect(b.element("hostTitle").title).toBe(name);
});

// The shell is a one-column grid. Without a bounded column, nowrap header text widens the whole page.
test("page styles bound the shell column and clip the header host name", async () => {
  const css = (await Bun.file(new URL("./live.css", import.meta.url)).text()).replace(/\s+/g, "");
  expect(css).toContain(".shell{grid-template-columns:minmax(0,1fr)}");
  expect(css).toMatch(/\.hostcontextstrong\{[^}]*min-width:0[^}]*overflow:hidden[^}]*text-overflow:ellipsis[^}]*white-space:nowrap[^}]*\}/);
});

// The supervisor panel is also a one-column grid and repeats the host name in three places.
test("page styles bound the supervisor panel column and keep Send inside it", async () => {
  const css = (await Bun.file(new URL("./live.css", import.meta.url)).text()).replace(/\s+/g, "");
  expect(css).toContain(".coordination{grid-template-columns:minmax(0,1fr);overflow-wrap:anywhere}");
  expect(css).toContain(".coordinationheadh2,.composerfooterbutton{flex-shrink:0}");
});

const direct = { id: "h", name: "H", apiBase: "/api/hosts/h" };
const many = Array.from({ length: 6 }, (_, i) => ({ id: "c" + i, target: "main", actor: "web-ui", text: "t" + i, status: "queued", createdAt: "t", updatedAt: "t" }));
test("browser polls only the newest commands it shows", async () => {
  const b = await browser([direct], path => path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { runs: [], requests: [] } : { commands: many });
  const reads = b.calls.filter(c => c.path.includes("/commands")).map(c => c.path);
  expect(reads).toEqual(["/api/hosts/h/commands?latest=6"]);
  expect(b.element("exchangeRows").innerHTML).toContain("t5");
});
test("browser falls back to the full list when an older host refuses latest", async () => {
  const b = await browser([direct], path => path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { runs: [], requests: [] }
    : path.includes("latest=") ? { __status: 400, error: { kind: "invalid", message: "unknown query parameter latest" } } : { commands: many });
  const reads = b.calls.filter(c => c.path.includes("/commands")).map(c => c.path);
  expect(reads).toEqual(["/api/hosts/h/commands?latest=6", "/api/hosts/h/commands"]);
  expect(b.element("exchangeRows").innerHTML).toContain("t5");
});
test("browser reads the current request view and falls back to the full list on 400", async () => {
  const run = { id: "run-1", orchestrator: "orch", phase: "one", revision: 1, phaseStatus: "working", updatedAt: "t" };
  for (const old of [false, true]) {
    const b = await browser([direct], path => path.endsWith("/sessions") ? { sessions: [] } : path.includes("/commands") ? { commands: [] }
      : old && path.includes("view=") ? { __status: 400, error: { kind: "invalid", message: "unknown query parameter view" } } : { runs: [run], requests: [] });
    const reads = b.calls.filter(c => c.path.includes("/requests")).map(c => c.path);
    expect(reads).toEqual(old ? ["/api/hosts/h/requests?view=current", "/api/hosts/h/requests"] : ["/api/hosts/h/requests?view=current"]);
    expect(b.element("phaseState").textContent).toContain("one · revision 1");
  }
});
test("the workflow panel shows the run updated last even when an older run sorts after it by id", async () => {
  const fresh = { id: "gw-run", orchestrator: "fc-gwrun", phase: "phase-2", revision: 2, phaseStatus: "review", updatedAt: "2026-11-22T14:09:54.192Z" };
  const old = { id: "ping-1", orchestrator: "fc-chum", phase: "ping", revision: 1, phaseStatus: "done", updatedAt: "2026-11-21T02:12:14.770Z" };
  // An older host answers the full list, sorted by id.
  const b = await browser([direct], path => path.endsWith("/sessions") ? { sessions: [] } : path.includes("/commands") ? { commands: [] }
    : path.includes("view=") ? { __status: 400, error: { kind: "invalid", message: "unknown query parameter view" } } : { runs: [fresh, old], requests: [] });
  expect(b.element("runName").textContent).toBe("gw-run");
  expect(b.element("phaseState").textContent).toContain("phase-2 · revision 2");
});

// Every value a host or gateway sends can be hostile. None may become markup or break out of an attribute.
test("host-provided strings never become markup anywhere on the page", async () => {
  const evil = (tag: string) => `<x-evil-${tag}>"x-evil-${tag}="1'`;
  const hostile = { id: "a", name: evil("hostname"), apiBase: "/api/hosts/a" };
  const session = { name: evil("session"), host: evil("sessionhost"), role: evil("role"), registered: true, running: true, model: { state: "observed", model: evil("model"), source: evil("source"), observedAt: "2026-11-16T08:00:00Z" } };
  const run = { id: evil("run"), orchestrator: evil("orch"), phase: evil("phase"), revision: 1, phaseStatus: evil("phasestatus"), updatedAt: "t" };
  const request = { id: evil("req"), runId: run.id, phase: run.phase, revision: 1, kind: "approval", question: evil("question"), proposedAction: evil("action"), scope: evil("scope"),
    evidence: [evil("evidence")], allowedResponses: [evil("answer")], status: "open", response: evil("response"), resolvedBy: evil("resolver"), resolutionNote: evil("note") };
  const cmd = { id: evil("cmd"), target: evil("target"), actor: evil("actor"), text: evil("text"), status: evil("status"), response: evil("cmdresponse"), createdAt: "t", updatedAt: "t" };
  const agent = { name: evil("agent"), cwd: evil("cwd"), model: evil("agentmodel"), state: "failed", error: evil("agenterror"), createdBy: "x", updatedAt: "t", alive: false };
  const b = await browser([hostile], path => path.endsWith("/agents") ? { agents: [agent], models: [evil("modelopt")], folders: [evil("folder")] } : path.endsWith("/sessions") ? { sessions: [session] } : path.includes("/requests") ? { runs: [run], requests: [request] } : { commands: [cmd] });
  await new Promise(resolve => setTimeout(resolve, 0));
  const html = ["sidebar", "requests", "workflowSteps", "exchangeRows", "agentRows", "agentFolder", "agentModel"].map(id => b.element(id).innerHTML).join("\n");
  // The fixture must reach every panel, or the check below proves nothing.
  for (const tag of ["hostname", "session", "model", "question", "evidence", "answer", "text", "actor", "status", "phase", "agent", "cwd", "agenterror", "modelopt", "folder"]) expect(html).toContain("x-evil-" + tag);
  expect(html).not.toMatch(/<x-evil/);
  expect(html).not.toMatch(/"x-evil-[a-z]+=/);
});

test("a pane says live only after output, so a busy host never flashes live", async () => {
  const timers: { fn: () => void; ms: number }[] = [];
  const legacy = { id: "a", name: "A", apiBase: "/api/hosts/a" };
  const b = await browser([legacy], path => path.endsWith("/sessions") ? { sessions: [{ name: "probe", host: null, role: null, registered: true, running: true, model: { state: "not_applicable" } }] } : path.includes("/requests") ? { requests: [], runs: [] } : { commands: [] }, [], timers);
  await new Promise(resolve => setTimeout(resolve, 0));
  const status = () => b.element("terminals:child:parent:child").textContent as string;
  const sock = b.sockets[0] as any;
  sock.onopen();
  expect(status()).not.toContain("live");
  sock.onclose({ code: 1013, reason: "too many open terminal viewers" });
  expect(status()).toContain("too many open viewers");
  expect(status()).not.toContain("live");
  timers.find(t => t.ms === 30_000)!.fn();
  const next = b.sockets[1] as any;
  next.onopen();
  expect(status()).not.toContain("live");
  next.onmessage({ data: new TextEncoder().encode("x").buffer });
  expect(status()).toBe("Read-only · live");
});

test("agent form starts only after the name is typed again, and Stop posts to that agent", async () => {
  const host = { id: "a", name: "A", apiBase: "/api/hosts/a" };
  const agents: any[] = [{ name: "fc-old", cwd: "/r/sandbox", model: "haiku", state: "running", error: null, createdBy: "gw", updatedAt: "2026-11-19T16:00:00Z", alive: true }];
  const b = await browser([host], (path, init) => {
    if (path.endsWith("/agents") && init?.method === "POST") return { __status: 202, agent: { ...JSON.parse(String(init.body)), state: "starting" } };
    if (path.endsWith("/agents/fc-old/stop")) return { agent: { ...agents[0], state: "stopped" } };
    if (path.endsWith("/agents")) return { agents, models: ["sonnet", "haiku"], folders: ["/r/sandbox", "/r/other"] };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : { commands: [] };
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("agentRows").innerHTML).toContain("Stop fc-old");
  const type = async (id: string, value: string) => { b.element(id).value = value; await b.listeners.get(id + ":input")!({}); };
  await type("agentName", "fc-new");
  await type("agentFolder", "/r/other");
  await type("agentModel", "haiku");
  await type("agentPrompt", "Say hi");
  expect(b.element("agentStart").disabled).toBe(true);
  expect(b.element("agentGate").textContent).toBe("Type fc-new to confirm");
  await type("agentConfirm", "fc-ne");
  expect(b.element("agentStart").disabled).toBe(true);
  await type("agentConfirm", "fc-new");
  expect(b.element("agentStart").disabled).toBe(false);
  await b.listeners.get("agentForm:submit")!({ preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  const post = b.calls.find(c => c.path === "/api/hosts/a/agents" && c.init?.method === "POST")!;
  expect(JSON.parse(String(post.init!.body))).toEqual({ name: "fc-new", kind: "claude", cwd: "/r/other", model: "haiku", prompt: "Say hi", confirm: "fc-new", orchestrator: false });
  // An older host offers only Claude Code: no kind picker.
  expect(b.element("agentKind").hidden).toBe(true);
  expect(b.element("agentStatus").textContent).toContain("fc-new accepted, starting");
  expect(b.element("agentConfirm").value).toBe("");
  await b.click({ stop: "fc-old", host: "a" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.calls.some(c => c.path === "/api/hosts/a/agents/fc-old/stop" && c.init?.method === "POST")).toBe(true);
  expect(b.element("agentStatus").textContent).toContain("fc-old stopped, session closed");
});

test("a refused start shows the host's reason and a host without agents hides the form", async () => {
  const hosts = [{ id: "a", name: "A", apiBase: "/api/hosts/a" }, { id: "b", name: "B", apiBase: "/api/hosts/b" }];
  const b = await browser(hosts, (path, init) => {
    if (path === "/api/hosts/b/agents") return { __status: 503, error: { kind: "unavailable", message: "managed agents not configured on this host" } };
    if (path.endsWith("/agents") && init?.method === "POST") return { __status: 400, error: { kind: "invalid", message: "cwd must be a folder inside /r" } };
    if (path.endsWith("/agents")) return { agents: [], models: ["haiku"], folders: ["/r/s"] };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : { commands: [] };
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  for (const [id, v] of [["agentName", "fc-x"], ["agentPrompt", "t"], ["agentConfirm", "fc-x"]] as const) { b.element(id).value = v; await b.listeners.get(id + ":input")!({}); }
  expect(b.element("agentStart").disabled).toBe(false);
  await b.listeners.get("agentForm:submit")!({ preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("agentStatus").textContent).toBe("A: fc-x not started: cwd must be a folder inside /r");
  await b.click({ host: "b" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("agentForm").hidden).toBe(true);
  expect(b.element("agentListStatus").textContent).toBe("Managed agents are not configured on B.");
});

test("a host offering DSH shows a kind picker; picking DSH swaps the model list and posts kind dsh", async () => {
  const host = { id: "a", name: "A", apiBase: "/api/hosts/a" };
  const agents = [{ name: "fc-deep", kind: "dsh", cwd: "/r/s", model: "deepseek-official/deepseek-flash", state: "running", error: null, createdBy: "gw", updatedAt: "2026-11-20T16:00:00Z", alive: true }];
  const b = await browser([host], (path, init) => {
    if (path.endsWith("/agents") && init?.method === "POST") return { __status: 202, agent: { ...JSON.parse(String(init.body)), state: "starting" } };
    if (path.endsWith("/agents")) return { agents, models: ["haiku"], kinds: { claude: ["haiku"], dsh: ["deepseek-official/deepseek-flash", "cliproxyapi/claude-haiku-5-5"], codex: ["x"] }, folders: ["/r/s"] };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : { commands: [] };
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("agentRows").innerHTML).toContain("DSH deepseek-official/deepseek-flash");
  expect(b.element("agentKind").hidden).toBe(false);
  // Only kinds this panel knows are offered.
  expect(b.element("agentKind").innerHTML).toBe('<option value="claude">Claude Code</option><option value="dsh">DSH</option>');
  expect(b.element("agentModel").innerHTML).not.toContain("deepseek");
  const type = async (id: string, value: string) => { b.element(id).value = value; await b.listeners.get(id + ":input")!({}); };
  await type("agentKind", "dsh");
  expect(b.element("agentModel").innerHTML).toContain("cliproxyapi/claude-haiku-5-5");
  expect(b.element("agentModel").innerHTML).not.toContain(">haiku<");
  expect(b.element("agentRisk").textContent).toContain("DSH headless");
  for (const [id, v] of [["agentName", "fc-d2"], ["agentPrompt", "Say READY"], ["agentConfirm", "fc-d2"]] as const) await type(id, v);
  await type("agentModel", "cliproxyapi/claude-haiku-5-5");
  expect(b.element("agentStart").disabled).toBe(false);
  await b.listeners.get("agentForm:submit")!({ preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  const post = b.calls.find(c => c.path === "/api/hosts/a/agents" && c.init?.method === "POST")!;
  expect(JSON.parse(String(post.init!.body))).toMatchObject({ name: "fc-d2", kind: "dsh", model: "cliproxyapi/claude-haiku-5-5" });
  // Back to Claude Code: the DSH model is not kept.
  await type("agentKind", "claude");
  expect(b.element("agentModel").value).toBe("haiku");
});

test("the sidebar links to the add-host page only when the gateway offers it", async () => {
  const host = { id: "mini", name: "Mini", apiBase: "/api/hosts/mini" };
  const reply = (path: string) => (path.endsWith("/sessions") ? { sessions: [] } : path.endsWith("/agents") ? { agents: [], models: [] } : { requests: [], commands: [] });
  const off = await browser([host], reply);
  expect(off.element("sidebar").innerHTML).not.toContain("./add-host");
  const on = await browser({ hosts: [host], enroll: true } as never, reply);
  expect(on.element("sidebar").innerHTML).toContain('<a class="footlink" href="./add-host">Add a host</a>');
});

test("an empty gateway that can add hosts points at Add a host instead of a dead end", async () => {
  const reply = () => ({});
  const empty = await browser({ hosts: [], enroll: true } as never, reply);
  expect(empty.element("sidebar").innerHTML).toContain('href="./add-host">Add a host</a>');
  expect(empty.element("hostSubtitle").textContent).toBe("No hosts yet. Use Add a host at the bottom of the host list.");
  expect(empty.element("terminals").innerHTML).toContain("<span>No hosts yet</span>");
  const closed = await browser({ hosts: [] } as never, reply);
  expect(closed.element("hostSubtitle").textContent).toBe("The gateway lists no hosts.");
  expect(closed.element("terminals").innerHTML).toContain("<span>No host list</span>");
});

test("a pane types only after a confirmed lease the host granted, sends keys as binary, and goes read-only on any end", async () => {
  const host = { id: "a", name: "A", apiBase: "/api/hosts/a" };
  const b = await browser([host], (path, init) => {
    if (path.endsWith("/lease") && init?.method === "POST") return { __status: 201, lease: { expiresAt: new Date(Date.now() + 300_000).toISOString() } };
    if (path.endsWith("/lease")) return { ended: true };
    return path.endsWith("/sessions") ? { sessions: [{ name: "probe", host: null, role: null, registered: true, running: true, model: { state: "not_applicable" } }] } : path.includes("/requests") ? { requests: [], runs: [] } : { commands: [] };
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const button = b.element("terminals:child:parent:typebtn");
  const sock = b.sockets[0] as any;
  sock.onopen();
  expect(button.hidden).toBe(true);
  sock.onmessage({ data: JSON.stringify({ type: "socket", id: "sock-1", session: "probe" }) });
  // Output with a size hint builds the terminal, read-only.
  sock.onmessage({ data: new TextEncoder().encode("\x1b]777;fleet-size;80;24\x07" + "x".repeat(70)).buffer });
  expect(button.hidden).toBe(false);
  const term = b.terms.at(-1)!;
  expect(term.options.disableStdin).toBe(true);
  term.press("ls\r");
  expect(sock.sent).toEqual([]);

  // First click only asks for confirmation; nothing is sent to the host.
  button.onclick();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.calls.filter(c => c.path.endsWith("/lease"))).toEqual([]);
  expect(button.textContent).toBe("Confirm: type into probe for 5 min");
  button.onclick();
  await new Promise(resolve => setTimeout(resolve, 0));
  const asked = b.calls.filter(c => c.path.endsWith("/lease"));
  expect(asked.map(c => [c.path, c.init?.method, c.init?.body])).toEqual([["/api/hosts/a/sessions/probe/lease", "POST", JSON.stringify({ socket: "sock-1", minutes: 5 })]]);
  expect(term.options.disableStdin).toBe(false);
  term.press("ls\r");
  expect(sock.sent.map((d: Uint8Array) => [...d])).toEqual([[0x6c, 0x73, 0x0d]]);

  // The host ends the lease: keys stop at once.
  sock.onmessage({ data: JSON.stringify({ type: "lease", state: "ended", reason: "lease expired" }) });
  expect(term.options.disableStdin).toBe(true);
  term.press("rm\r");
  expect(sock.sent).toHaveLength(1);
  expect(button.textContent).toBe("Type…");
});

test("the orchestrator option shows only where the host offers it and only for Claude Code, and is posted when ticked", async () => {
  const host = { id: "a", name: "A", apiBase: "/api/hosts/a" };
  const reply = (offer: boolean) => (path: string, init?: RequestInit) => {
    if (path.endsWith("/agents") && init?.method === "POST") return { __status: 202, agent: { ...JSON.parse(String(init.body)), state: "starting" } };
    if (path.endsWith("/agents")) return { agents: [{ name: "fc-run", kind: "claude", cwd: "/r/s", model: "haiku", state: "running", error: null, createdBy: "gw", updatedAt: "2026-11-20T16:00:00Z", alive: true, orchestrator: true }], models: ["haiku"], kinds: { claude: ["haiku"], dsh: ["deepseek-official/deepseek-flash"] }, folders: ["/r/s"], ...(offer ? { orchestrators: true } : {}) };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : { commands: [] };
  };
  const off = await browser([host], reply(false));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(off.element("agentOrchestratorRow").hidden).toBe(true);
  const b = await browser([host], reply(true));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("agentRows").innerHTML).toContain("haiku · orchestrator · /r/s");
  expect(b.element("agentOrchestratorRow").hidden).toBe(false);
  const type = async (id: string, value: string) => { b.element(id).value = value; await b.listeners.get(id + ":input")!({}); };
  for (const [id, v] of [["agentName", "fc-o2"], ["agentPrompt", "Run phases"], ["agentConfirm", "fc-o2"]] as const) await type(id, v);
  b.element("agentOrchestrator").checked = true;
  await b.listeners.get("agentOrchestrator:change")!({});
  expect(b.element("agentRisk").textContent).toContain("never answer for you");
  // DSH cannot be an orchestrator: the option hides and is cleared.
  await type("agentKind", "dsh");
  expect(b.element("agentOrchestratorRow").hidden).toBe(true);
  await type("agentKind", "claude");
  expect(b.element("agentOrchestrator").checked).toBe(false);
  b.element("agentOrchestrator").checked = true;
  await b.listeners.get("agentOrchestrator:change")!({});
  expect(b.element("agentStart").disabled).toBe(false);
  await b.listeners.get("agentForm:submit")!({ preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  const post = b.calls.find(c => c.path === "/api/hosts/a/agents" && c.init?.method === "POST")!;
  expect(JSON.parse(String(post.init!.body))).toMatchObject({ name: "fc-o2", kind: "claude", orchestrator: true });
});

test("the fleet section shows only where the host offers it, saves with the read revision and the typed confirm, and restarts a typed session", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: ["probe-shell", "second", "fc-agent"], loadError: null };
  const plain = { id: "p", name: "Plain", apiBase: "/api/hosts/p" };
  const host = { id: "a", name: "A", apiBase: "/api/hosts/a" };
  const b = await browser([host, plain], (path, init) => {
    if (path.startsWith("/api/hosts/p/fleet/")) return { __status: 404, error: { message: "not found" } };
    if (path.endsWith("/fleet/conf") && init?.method === "PUT") return { path: conf.path, revision: "b".repeat(64), backup: "/f/fleet.conf.bak-1", sessions: conf.sessions };
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.includes("/fleet/logs")) return { source: "watchdog", lines: 200, text: "wd line\n" };
    if (path.endsWith("/restart")) return { session: "second", output: "second: started\n" };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("adminBox").hidden).toBe(false);
  expect(b.element("confText").value).toBe("FLEET=t\n");
  // Managed agents are restarted from the agent list, not here.
  expect(b.element("restartSession").innerHTML).toBe('<option value="probe-shell">probe-shell</option><option value="second">second</option>');
  const type = async (id: string, value: string, kind = "input") => { b.element(id).value = value; await b.listeners.get(id + ":" + kind)!({}); };

  await type("confText", "FLEET=t\nX=1\n");
  expect(b.element("confSave").disabled).toBe(true);
  expect(b.element("confGate").textContent).toBe("Type fleet.conf to confirm");
  await type("confConfirm", "fleet.conf");
  expect(b.element("confSave").disabled).toBe(false);
  await b.listeners.get("confSave:click")!({});
  await new Promise(resolve => setTimeout(resolve, 0));
  const put = b.calls.find(c => c.path === "/api/hosts/a/fleet/conf" && c.init?.method === "PUT")!;
  expect(JSON.parse(String(put.init!.body))).toEqual({ text: "FLEET=t\nX=1\n", revision: "a".repeat(64), confirm: "fleet.conf" });
  expect(b.element("adminStatus").textContent).toContain("/f/fleet.conf.bak-1");

  // A pick reported only as change still counts; the restart needs the name typed in full.
  // "second" is not the default pick, so only the change listener can make it the one posted.
  await type("restartSession", "second", "change");
  await type("restartConfirm", "secon");
  expect(b.element("restartGo").disabled).toBe(true);
  await type("restartConfirm", "second");
  expect(b.element("restartGo").disabled).toBe(false);
  await b.listeners.get("restartGo:click")!({});
  await new Promise(resolve => setTimeout(resolve, 0));
  const restart = b.calls.find(c => c.path.endsWith("/restart"))!;
  expect([restart.path, restart.init?.method, JSON.parse(String(restart.init!.body))]).toEqual(["/api/hosts/a/sessions/second/restart", "POST", { confirm: "second" }]);
  expect(b.element("adminStatus").textContent).toBe("A: second started again.");

  await b.listeners.get("logRead:click")!({});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.calls.some(c => c.path === "/api/hosts/a/fleet/logs?source=watchdog&lines=200")).toBe(true);
  expect(b.element("logText").textContent).toBe("wd line\n");

  // The other host does not offer it: the section hides.
  await b.click({ host: "p" });
  expect(b.element("adminBox").hidden).toBe(true);
});

test("an agent model picked with only a change event is the one posted", async () => {
  const host = { id: "a", name: "A", apiBase: "/api/hosts/a" };
  const b = await browser([host], (path, init) => {
    if (path.endsWith("/agents") && init?.method === "POST") return { __status: 202, agent: { ...JSON.parse(String(init.body)), state: "starting" } };
    if (path.endsWith("/agents")) return { agents: [], models: ["sonnet", "haiku"], folders: ["/r/s"] };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : { commands: [] };
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const type = async (id: string, value: string, kind = "input") => { b.element(id).value = value; await b.listeners.get(id + ":" + kind)!({}); };
  for (const [id, v] of [["agentName", "fc-h"], ["agentPrompt", "Say READY"], ["agentConfirm", "fc-h"]] as const) await type(id, v);
  await type("agentModel", "haiku", "change");
  await b.listeners.get("agentForm:submit")!({ preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  const post = b.calls.find(c => c.path === "/api/hosts/a/agents" && c.init?.method === "POST")!;
  expect(JSON.parse(String(post.init!.body)).model).toBe("haiku");
});

test("after a 409 the unsaved edit keeps its old revision: a background refresh does not make it saveable over the host's change", async () => {
  let hostConf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: ["probe-shell"], loadError: null };
  const host = { id: "a", name: "A", apiBase: "/api/hosts/a" };
  const b = await browser([host], (path, init) => {
    if (path.endsWith("/fleet/conf") && init?.method === "PUT") return { __status: 409, error: { code: "conflict", message: "fleet.conf changed on the host since you read it; reload it and edit again" } };
    if (path.endsWith("/fleet/conf")) return hostConf;
    if (path.endsWith("/restart")) return { __status: 504, error: { message: "host did not answer in time" } };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const type = async (id: string, value: string, kind = "input") => { b.element(id).value = value; await b.listeners.get(id + ":" + kind)!({}); };
  await type("confText", "FLEET=t\nMINE=1\n");
  await type("confConfirm", "fleet.conf");
  // Someone edits the file on the host; the save is refused.
  hostConf = { ...hostConf, text: "FLEET=t\nTHEIRS=1\n", revision: "b".repeat(64) };
  await b.listeners.get("confSave:click")!({});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("confSave").disabled).toBe(true);
  // The 60 s host refresh runs: the draft stays, and Save stays blocked until Reload.
  await b.app.loadHostList();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("confText").value).toBe("FLEET=t\nMINE=1\n");
  expect(b.element("confSave").disabled).toBe(true);
  expect(b.element("confGate").textContent).toBe("fleet.conf changed on the host; copy your edit, then Reload");
  // Any later PUT would still name the revision the draft was made from.
  expect(b.calls.filter(c => c.init?.method === "PUT").map(c => JSON.parse(String(c.init!.body)).revision)).toEqual(["a".repeat(64)]);
  // Reload takes the host's file and lifts the block.
  await b.listeners.get("confReload:click")!({});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("confText").value).toBe("FLEET=t\nTHEIRS=1\n");
  expect(b.element("confGate").textContent).toBe("No changes");

  // A restart the gateway gave up on (504) is reported as unknown, not as not restarted.
  await type("restartSession", "probe-shell", "change");
  await type("restartConfirm", "probe-shell");
  await b.listeners.get("restartGo:click")!({});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("adminStatus").textContent).toBe("A did not answer in time. Unknown whether probe-shell is running; check its terminal.");
});

test("a refresh where the host briefly refuses the section keeps the unsaved edit and the file it was made from", async () => {
  let refuse = false;
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: ["probe-shell"], loadError: null };
  const host = { id: "a", name: "A", apiBase: "/api/hosts/a" };
  const b = await browser([host], (path, init) => {
    if (path.endsWith("/fleet/conf") && !init?.method) return refuse ? { __status: 503, error: { message: "fleet administration is off" } } : conf;
    if (path.endsWith("/fleet/conf")) return conf;
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  b.element("confText").value = "FLEET=t\nMINE=1\n";
  await b.listeners.get("confText:input")!({});
  refuse = true;
  await b.app.loadHostList();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("adminBox").hidden).toBe(true);
  refuse = false;
  await b.app.loadHostList();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("adminBox").hidden).toBe(false);
  expect(b.element("confText").value).toBe("FLEET=t\nMINE=1\n");
});

test("a restart whose start failed says the session is down, not that the outcome is unknown", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: ["probe-shell"], loadError: null };
  const host = { id: "a", name: "A", apiBase: "/api/hosts/a" };
  const b = await browser([host], (path) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/restart")) return { __status: 422, error: { kind: "failed", message: "the old probe-shell session ended, and it did not start again: probe-shell: start FAILED: workspace trust dialog", host: "a" } };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  b.element("restartConfirm").value = "probe-shell";
  await b.listeners.get("restartConfirm:input")!({});
  await b.listeners.get("restartGo:click")!({});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("adminStatus").textContent).toBe("A: the old probe-shell session ended, and it did not start again: probe-shell: start FAILED: workspace trust dialog");
});

test("tokens on a host: the gateway's own and managed lines are listed but not offered, rotate shows the new token once, and the gateway's link is rotated or removed only after the typed id", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const tokens = { tokens: [
    { name: "macbook-gateway", role: "operator", self: true, managed: false },
    { name: "watcher", role: "viewer", self: false, managed: false },
    { name: "fc-run", role: "agent", self: false, managed: true },
    { name: "orch", role: "agent", self: false, managed: false },
  ] };
  const fresh = "N".repeat(43);
  let hostList: unknown = { hosts: [{ id: "a", name: "A", apiBase: "/api/hosts/a" }], enroll: true, manage: true };
  const b = await browser(hostList as never, (path, init) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/tokens/orch/rotate")) return { name: "orch", token: fresh };
    if (path.endsWith("/tokens")) return tokens;
    if (path === "./api/manage/a/rotate") return { id: "a", principal: "macbook-gateway", rotated: true };
    if (path === "./api/manage/a/remove") { hostList = { hosts: [], enroll: true, manage: true }; return { id: "a", removed: true, revokedOnHost: true, principal: "macbook-gateway", tokenFileRemoved: true }; }
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("tokenPart").hidden).toBe(false);
  expect(b.element("tokenRows").innerHTML).toContain("macbook-gateway <small>operator · this gateway</small>");
  expect(b.element("tokenRows").innerHTML).toContain("fc-run <small>agent · managed agent</small>");
  expect(b.element("tokenName").innerHTML).toBe('<option value="watcher">watcher</option><option value="orch">orch</option>');
  const type = async (id: string, value: string, kind = "input") => { b.element(id).value = value; await b.listeners.get(id + ":" + kind)!({}); };

  await type("tokenName", "orch", "change");
  await type("tokenAction", "rotate", "change");
  await type("tokenConfirm", "orc");
  expect(b.element("tokenGo").disabled).toBe(true);
  await type("tokenConfirm", "orch");
  expect(b.element("tokenGo").disabled).toBe(false);
  await b.listeners.get("tokenGo:click")!({});
  await new Promise(resolve => setTimeout(resolve, 0));
  const rot = b.calls.find(c => c.path.endsWith("/tokens/orch/rotate"))!;
  expect([rot.path, rot.init?.method, JSON.parse(String(rot.init!.body))]).toEqual(["/api/hosts/a/tokens/orch/rotate", "POST", { confirm: "orch" }]);
  expect(b.element("newTokenBox").hidden).toBe(false);
  expect(b.element("newTokenText").textContent).toBe(fresh);
  await b.listeners.get("newTokenDone:click")!({});
  expect(b.element("newTokenBox").hidden).toBe(true);
  expect(b.element("newTokenText").textContent).toBe("");

  // The gateway's own link.
  expect(b.element("hostPart").hidden).toBe(false);
  expect(b.element("hostRemove").disabled).toBe(true);
  await type("hostConfirm", "a");
  expect(b.element("hostRotate").disabled).toBe(false);
  await b.listeners.get("hostRotate:click")!({});
  await new Promise(resolve => setTimeout(resolve, 0));
  const hr = b.calls.find(c => c.path === "./api/manage/a/rotate")!;
  expect(JSON.parse(String(hr.init!.body))).toEqual({ confirm: "a" });
  expect(b.element("adminStatus").textContent).toContain("this gateway now uses a new token");

  await type("hostConfirm", "a");
  b.element("hostRevoke").checked = false;
  await b.listeners.get("hostRevoke:change")!({});
  await b.listeners.get("hostRemove:click")!({});
  await new Promise(resolve => setTimeout(resolve, 0));
  const rm = b.calls.find(c => c.path === "./api/manage/a/remove")!;
  expect(JSON.parse(String(rm.init!.body))).toEqual({ confirm: "a", revoke: false });
});

test("a host without the tokens route hides the tokens part, and a gateway without manage hides the link part", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/tokens")) return { __status: 404, error: { message: "not found" } };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("adminBox").hidden).toBe(false);
  expect(b.element("tokenPart").hidden).toBe(true);
  expect(b.element("hostPart").hidden).toBe(true);
});

test("a token refusal the gateway relays as upstream_forbidden reads as not changed, and a shown token is gone after picking another host", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const tokens = { tokens: [{ name: "watcher", role: "viewer", self: false, managed: false }] };
  let refuse = true;
  const b = await browser({ hosts: [{ id: "a", name: "A", apiBase: "/api/hosts/a" }, { id: "c", name: "C", apiBase: "/api/hosts/c" }] } as never, (path) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/tokens/watcher/rotate")) return refuse ? { __status: 502, error: { kind: "upstream_forbidden", message: "host refused the request" } } : { name: "watcher", token: "T".repeat(43) };
    if (path.endsWith("/tokens")) return tokens;
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const type = async (id: string, value: string, kind = "input") => { b.element(id).value = value; await b.listeners.get(id + ":" + kind)!({}); };
  const rotate = async () => {
    await type("tokenAction", "rotate", "change");
    await type("tokenConfirm", "watcher");
    await b.listeners.get("tokenGo:click")!({});
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  await rotate();
  expect(b.element("adminStatus").textContent).toBe("A: watcher not changed: the host refused this gateway (host refused the request).");
  refuse = false;
  await rotate();
  expect(b.element("newTokenText").textContent).toBe("T".repeat(43));
  await b.click({ host: "c" });
  await b.click({ host: "a" });
  expect(b.element("newTokenBox").hidden).toBe(true);
  expect(b.element("newTokenText").textContent).toBe("");
  // Picking a session on the other host also switches host, so it clears the shown token too.
  await rotate();
  expect(b.element("newTokenText").textContent).toBe("T".repeat(43));
  await b.click({ host: "c", session: "s" });
  await b.click({ host: "a", session: "s" });
  expect(b.element("newTokenText").textContent).toBe("");
});

test("a hand-made session is offered for restart only after its start command, pre-filled from tmux, is saved", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: ["probe-shell"], loadError: null };
  const host = { id: "a", name: "A", apiBase: "/api/hosts/a" };
  let saved: { command: string; cwd: string; savedBy: string; savedAt: string } | null = null;
  let stale: { command: string; cwd: string; savedBy: string; savedAt: string } | null = null;
  const rows = () => ({ starts: true, sessions: [
    { session: "hand", inConf: false, running: true, saved, pane: { command: "exec cat", cwd: "/w" } },
    { session: "probe-shell", inConf: true, running: true, saved: stale, pane: { command: "", cwd: "/f" } },
  ] });
  const b = await browser([host], (path, init) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/fleet/sessions")) return rows();
    if (path.endsWith("/sessions/hand/start") && init?.method === "PUT") { const body = JSON.parse(String(init.body)); saved = { command: body.command, cwd: body.cwd, savedBy: "gw", savedAt: "2026-11-23T01:00:00Z" }; return { saved }; }
    if (path.includes("/sessions/hand/start") && init?.method === "DELETE") { saved = null; return { removed: "hand" }; }
    if (path.endsWith("/restart")) return { session: "hand", output: "hand: started with its saved command\n" };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("restartSession").innerHTML).toBe('<option value="hand">hand · no start command</option><option value="probe-shell">probe-shell · fleet.conf</option>');
  const type = async (id: string, value: string, kind = "input") => { b.element(id).value = value; await b.listeners.get(id + ":" + kind)!({}); };
  // A fleet.conf session starts from fleet.conf: no start form for it.
  await type("restartSession", "probe-shell", "change");
  expect(b.element("startPart").hidden).toBe(true);
  // A start saved before probe-shell joined fleet.conf can still be forgotten from the page.
  stale = { command: "exec cat", cwd: "/f", savedBy: "gw", savedAt: "2026-11-22T01:00:00Z" };
  await b.listeners.get("confReload:click")!({});
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  await type("restartSession", "probe-shell", "change");
  expect([b.element("startPart").hidden, b.element("startSave").disabled, b.element("startRemove").disabled]).toEqual([false, true, true]);
  await type("startConfirm", "probe-shell");
  expect(b.element("startRemove").disabled).toBe(false);
  await b.listeners.get("startRemove:click")!({});
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.calls.some(c => c.path === "/api/hosts/a/sessions/probe-shell/start?confirm=probe-shell" && c.init?.method === "DELETE")).toBe(true);
  stale = null;
  await b.listeners.get("confReload:click")!({});
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  await type("restartSession", "hand", "change");
  expect(b.element("startPart").hidden).toBe(false);
  // Filled from tmux, not saved: Restart is blocked until a command is saved.
  expect([b.element("startCommand").value, b.element("startCwd").value]).toEqual(["exec cat", "/w"]);
  await type("restartConfirm", "hand");
  expect([b.element("restartGo").disabled, b.element("restartGate").textContent]).toEqual([true, "Save a start command for hand first"]);
  expect([b.element("startSave").disabled, b.element("startGate").textContent]).toEqual([true, "Type hand to confirm"]);
  await type("startCwd", "w");
  await type("startConfirm", "hand");
  expect([b.element("startSave").disabled, b.element("startGate").textContent]).toEqual([true, "The folder must be an absolute path"]);
  await type("startCwd", "/w");
  expect(b.element("startSave").disabled).toBe(false);
  await b.listeners.get("startSave:click")!({});
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  const put = b.calls.find(c => c.path === "/api/hosts/a/sessions/hand/start" && c.init?.method === "PUT")!;
  expect(JSON.parse(String(put.init!.body))).toEqual({ command: "exec cat", cwd: "/w", confirm: "hand" });
  expect(b.element("adminStatus").textContent).toBe("A: start command for hand saved.");
  expect(b.element("startGate").textContent).toBe("Saved");
  expect(b.element("restartSession").innerHTML).toContain('hand · saved command');
  await type("restartConfirm", "hand");
  expect([b.element("restartGo").disabled, b.element("restartGate").textContent]).toEqual([false, "Ends hand and starts it again with its saved command"]);
  await b.listeners.get("restartGo:click")!({});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.calls.some(c => c.path === "/api/hosts/a/sessions/hand/restart")).toBe(true);
  // Forgetting needs the name typed too.
  expect(b.element("startRemove").disabled).toBe(true);
  await type("startConfirm", "hand");
  expect(b.element("startRemove").disabled).toBe(false);
  await b.listeners.get("startRemove:click")!({});
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.calls.some(c => c.path === "/api/hosts/a/sessions/hand/start?confirm=hand" && c.init?.method === "DELETE")).toBe(true);
  expect(b.element("adminStatus").textContent).toBe("A: saved start command for hand forgotten.");
});

test("service settings: the page shows what the next start uses, saves every setting with the read revision and the typed confirm, and says a restart is needed", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const running = { agentRoots: ["/r"], agentModels: ["sonnet"], agentDshModels: [], agentMcpUrl: null, input: false };
  let settings = { path: "/c/settings.json", revision: "b".repeat(64), saved: {} as Record<string, unknown>, base: running, running, next: running, restartNeeded: [] as string[] };
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path, init) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/settings") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      const next = body.settings;
      settings = { ...settings, revision: "c".repeat(64), saved: { agentModels: next.agentModels, input: next.input }, next, restartNeeded: ["agentModels", "input"] };
      return settings;
    }
    if (path.endsWith("/settings")) return settings;
    if (path.endsWith("/tokens")) return { __status: 503 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("settingsPart").hidden).toBe(false);
  expect([b.element("setRoots").value, b.element("setModels").value, b.element("setMcp").value]).toEqual(["/r", "sonnet", ""]);
  expect(b.element("settingsPending").textContent).toBe("The running service uses these settings.");
  expect([b.element("settingsSave").disabled, b.element("settingsGate").textContent]).toEqual([true, "No changes"]);
  const type = async (id: string, value: string, kind = "input") => { b.element(id).value = value; await b.listeners.get(id + ":" + kind)!({}); };
  await type("setModels", "haiku\nopus");
  b.element("setInput").checked = true;
  await b.listeners.get("setInput:change")!({});
  expect([b.element("settingsSave").disabled, b.element("settingsGate").textContent]).toEqual([true, "Type settings to confirm"]);
  await type("settingsConfirm", "settings");
  expect(b.element("settingsSave").disabled).toBe(false);
  await b.listeners.get("settingsSave:click")!({});
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  const put = b.calls.find(c => c.path === "/api/hosts/a/settings" && c.init?.method === "PUT")!;
  expect(JSON.parse(String(put.init!.body))).toEqual({ settings: { agentRoots: ["/r"], agentModels: ["haiku", "opus"], agentDshModels: [], agentMcpUrl: null, input: true }, revision: "b".repeat(64), confirm: "settings" });
  expect(b.element("adminStatus").textContent).toBe("A: settings saved. They apply when the service restarts.");
  expect(b.element("settingsPending").textContent).toBe("Waiting for a restart of the service: agentModels, input.");
  expect(b.element("settingsGate").textContent).toBe("No changes");
  expect(b.element("settingsSource").textContent).toBe("Set here (over the plist or unit): agentModels, input. Put a value back to the plist's to drop it from the file.");
  // Putting the model list back to the plist's drops it from the file: a save is allowed even if the next start would not change.
  settings = { ...settings, next: { ...settings.next, agentModels: ["sonnet"] }, saved: { agentModels: ["sonnet"], input: true } };
  await b.listeners.get("settingsReload:click")!({});
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  await type("settingsConfirm", "settings");
  expect(b.element("settingsSave").disabled).toBe(false);
});

test("a host without service settings hides the part", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/settings")) return { __status: 404 };
    if (path.endsWith("/tokens")) return { __status: 503 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("adminBox").hidden).toBe(false);
  expect(b.element("settingsPart").hidden).toBe(true);
});

test("service settings review fixes: a broken file is named, a skipped file is named, and a draft whose file changed on the host waits for Reload", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const running = { agentRoots: [], agentModels: ["sonnet", "opus", "haiku"], agentDshModels: [], agentMcpUrl: null, input: false };
  let answer: unknown = { __status: 400, error: { kind: "invalid", message: "the settings file is not JSON; fix or remove it on the host" } };
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path, init) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/settings") && init?.method === "PUT") return { __status: 409, error: { kind: "conflict", message: "the settings file changed on the host since you read it; reload and edit again" } };
    if (path.endsWith("/settings")) return answer;
    if (path.endsWith("/tokens")) return { __status: 503 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  await settle();
  expect([b.element("settingsPart").hidden, b.element("settingsError").hidden, b.element("settingsForm").hidden]).toEqual([false, false, true]);
  expect(b.element("settingsError").textContent).toBe("The settings file cannot be used: the settings file is not JSON; fix or remove it on the host");
  // A file the start skipped (it turns on input the fleet cannot take): named, and no restart promised.
  answer = { path: "/c/settings.json", revision: "b".repeat(64), saved: { input: true }, base: running, running, next: { ...running, input: true }, restartNeeded: ["input"], skipped: "terminal input needs a local fleet (REMOTE_SSH is set)" };
  await b.listeners.get("settingsReload:click")!({});
  await settle();
  expect([b.element("settingsForm").hidden, b.element("settingsError").textContent]).toEqual([false, "At its last start the service skipped the settings file: terminal input needs a local fleet (REMOTE_SSH is set). The file has not changed since; fix it on the host, or save from here to replace it."]);
  expect(b.element("settingsPending").textContent).toBe("The running service uses the plist's or unit's values.");
  expect(b.element("setModels").value).toBe("sonnet\nopus\nhaiku");
  answer = { ...(answer as object), saved: {}, next: running, restartNeeded: [], skipped: null };
  await b.listeners.get("settingsReload:click")!({});
  await settle();
  // An unsaved edit, then the file moves on the host: a background refresh keeps the edit and blocks the save.
  b.element("setInput").checked = true;
  await b.listeners.get("setInput:change")!({});
  answer = { ...(answer as object), revision: "c".repeat(64), skipped: null };
  await b.click({ host: "a" });
  await settle();
  expect([b.element("setInput").checked, b.element("settingsGate").textContent, b.element("settingsSave").disabled]).toEqual([true, "The settings file changed on the host; copy your edit, then Reload the settings", true]);
  // Reloading fleet.conf keeps the settings edit; the settings part's own Reload takes the host's file.
  await b.listeners.get("confReload:click")!({});
  await settle();
  expect(b.element("setInput").checked).toBe(true);
  await b.listeners.get("settingsReload:click")!({});
  await settle();
  expect([b.element("setInput").checked, b.element("settingsGate").textContent]).toEqual([false, "No changes"]);
  // A 409 on save blocks the save too.
  b.element("setInput").checked = true;
  await b.listeners.get("setInput:change")!({});
  b.element("settingsConfirm").value = "settings";
  await b.listeners.get("settingsConfirm:input")!({});
  await b.listeners.get("settingsSave:click")!({});
  await settle();
  expect(b.element("settingsGate").textContent).toBe("The settings file changed on the host; copy your edit, then Reload the settings");
});

test("saving fleet.conf keeps an unsaved settings edit", async () => {
  let conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const running = { agentRoots: [], agentModels: ["sonnet", "opus", "haiku"], agentDshModels: [], agentMcpUrl: null, input: false };
  const settings = { path: "/c/settings.json", revision: "b".repeat(64), saved: {}, base: running, running, next: running, restartNeeded: [], skipped: null };
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path, init) => {
    if (path.endsWith("/fleet/conf") && init?.method === "PUT") { conf = { ...conf, text: JSON.parse(String(init.body)).text, revision: "d".repeat(64) }; return { saved: true, backup: null }; }
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/settings")) return settings;
    if (path.endsWith("/tokens")) return { __status: 503 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  await settle();
  b.element("setInput").checked = true;
  await b.listeners.get("setInput:change")!({});
  b.element("confText").value = "FLEET=t\n# edited\n";
  await b.listeners.get("confText:input")!({});
  b.element("confConfirm").value = "fleet.conf";
  await b.listeners.get("confConfirm:input")!({});
  await b.listeners.get("confSave:click")!({});
  await settle();
  expect(b.element("adminStatus").textContent.startsWith("A: fleet.conf saved")).toBe(true);
  expect([b.element("setInput").checked, b.element("settingsGate").textContent]).toEqual([true, "Type settings to confirm"]);
});

test("service: restart and update need the typed word, the update offers releases with a package, and the page follows the job to its end", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const now = "a".repeat(40), next = "b".repeat(40);
  const job = { id: "upd-20261123T120000Z-0000abcd", action: "update", tag: "v2", commit: next, by: "op", state: "running", steps: ["t downloaded"], startedAt: "2026-11-23T12:00:00Z", endedAt: null as string | null };
  let service: Record<string, unknown> = { current: { commit: now, tag: "v1" }, unavailable: null, releaseError: null, running: null, jobs: [],
    releases: [{ tag: "v2", commit: next, publishedAt: "x" }, { tag: "v1", commit: now, publishedAt: "y" }] };
  let posted = null as { path: string; body: unknown } | null;
  const timers: { fn: () => void; ms: number }[] = [];
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path, init) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.includes("/service/") && init?.method === "POST") { posted = { path, body: JSON.parse(String(init.body)) }; return { __status: 202, job }; }
    if (path.endsWith("/service")) return service;
    if (path.endsWith("/settings") || path.endsWith("/tokens")) return { __status: 404 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  }, [], timers);
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  await settle();
  expect(b.element("servicePart").hidden).toBe(false);
  expect(b.element("serviceCurrent").textContent).toBe(`Runs v1 (${now.slice(0, 7)}).`);
  expect([b.element("serviceGo").disabled, b.element("serviceGate").textContent]).toEqual([true, "Type restart to confirm"]);
  const set = async (id: string, value: string, kind = "input") => { b.element(id).value = value; await b.listeners.get(id + ":" + kind)!({}); };
  await set("serviceAction", "update", "change");
  expect(b.element("serviceGate").textContent).toBe("Choose a release");
  await set("serviceTag", "v1", "change");
  expect(b.element("serviceGate").textContent).toBe("This service already runs v1");
  await set("serviceTag", "v2", "change");
  await set("serviceConfirm", "restart");
  expect([b.element("serviceGo").disabled, b.element("serviceGate").textContent]).toEqual([true, "Type v2 to confirm"]);
  await set("serviceConfirm", "v2");
  expect(b.element("serviceGo").disabled).toBe(false);
  await b.listeners.get("serviceGo:click")!({});
  await settle();
  expect(posted).toEqual({ path: "/api/hosts/a/service/update", body: { tag: "v2", confirm: "v2" } });
  expect(b.element("adminStatus").textContent).toBe(`A: update started (${job.id}).`);
  // While the job runs the page polls; the service may be down for a moment.
  service = { ...service, running: job, jobs: [job] };
  timers.splice(0).find((t) => t.ms === 3000)!.fn();
  await settle();
  expect(b.element("serviceGate").textContent).toBe("Updating to v2: wait for it to end");
  expect(b.element("serviceSteps").innerHTML).toContain("t downloaded");
  const ended = { ...job, state: "rolled_back", endedAt: "2026-11-23T12:02:00Z", steps: [...job.steps, "t the old release answers again"] };
  service = { ...service, running: null, jobs: [ended] };
  timers.splice(0).find((t) => t.ms === 3000)!.fn();
  await settle();
  expect(b.element("adminStatus").textContent).toBe("A: update failed and was rolled back. t the old release answers again");
});

test("a host without restart and update hides the part, and one without a service manager says why", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  let service: unknown = { __status: 404 };
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/service")) return service;
    if (path.endsWith("/settings") || path.endsWith("/tokens")) return { __status: 404 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("servicePart").hidden).toBe(true);
  service = { current: { commit: null, tag: null }, unavailable: "this service was not started by launchd or systemd, so the page cannot restart or update it", releases: [], releaseError: null, jobs: [], running: null };
  await b.listeners.get("confReload:click")!({});
  for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("servicePart").hidden).toBe(false);
  expect(b.element("serviceCurrent").textContent).toBe("Runs unknown (no MANIFEST.json).");
  expect(b.element("serviceGate").textContent).toBe("this service was not started by launchd or systemd, so the page cannot restart or update it");
});

test("watchdog: the part says off, turns it on only after the typed confirm, then offers Turn off", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  let wd = { fleet: "t", manager: "launchd", name: "pl.raqz.fleet-watchdog.t", installed: false, running: false, pid: null as number | null, inTmux: false };
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path, init) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/watchdog") && init?.method === "PUT") { wd = { ...wd, installed: true, running: true, pid: 42 }; return wd; }
    if (path.endsWith("/watchdog")) return wd;
    if (path.endsWith("/settings") || path.endsWith("/tokens")) return { __status: 503 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("watchdogPart").hidden).toBe(false);
  expect(b.element("watchdogState").textContent).toBe("Off: no watchdog checks the agents of t.");
  expect([b.element("watchdogGo").textContent, b.element("watchdogGo").disabled, b.element("watchdogGate").textContent]).toEqual(["Turn on", true, "Type watchdog to confirm"]);
  b.element("watchdogConfirm").value = "watchdog";
  await b.listeners.get("watchdogConfirm:input")!({});
  expect(b.element("watchdogGo").disabled).toBe(false);
  await b.listeners.get("watchdogGo:click")!({});
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  const put = b.calls.find(c => c.path === "/api/hosts/a/watchdog" && c.init?.method === "PUT")!;
  expect(JSON.parse(String(put.init!.body))).toEqual({ on: true, confirm: "watchdog" });
  expect(b.element("adminStatus").textContent).toBe("A: watchdog on.");
  expect(b.element("watchdogState").textContent).toBe("On: pl.raqz.fleet-watchdog.t runs (pid 42). It checks every agent every 60 s and starts again at login.");
  expect([b.element("watchdogGo").textContent, b.element("watchdogGo").disabled, b.element("watchdogGate").textContent]).toEqual(["Turn off", true, "Type watchdog to confirm"]);
});

test("watchdog: a watchdog started by hand in tmux blocks Turn on, and a host without the route hides the part", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  for (const answer of [{ fleet: "t", manager: "systemd", name: "fleet-watchdog-t.service", installed: false, running: false, pid: null, inTmux: true }, { __status: 404 }]) {
    const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path) => {
      if (path.endsWith("/fleet/conf")) return conf;
      if (path.endsWith("/watchdog")) return answer;
      if (path.endsWith("/settings") || path.endsWith("/tokens")) return { __status: 503 };
      return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
    });
    for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
    if ("__status" in answer) { expect(b.element("watchdogPart").hidden).toBe(true); continue; }
    b.element("watchdogConfirm").value = "watchdog";
    await b.listeners.get("watchdogConfirm:input")!({});
    expect([b.element("watchdogGo").disabled, b.element("watchdogGate").textContent]).toEqual([true, "A watchdog runs in tmux session t-watchdog; stop it with fleet watchdog stop first"]);
  }
});

test("watchdog: a service watchdog and a hand-started one together are both named, so the operator can stop the extra one", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/watchdog")) return { fleet: "t", manager: "launchd", name: "pl.raqz.fleet-watchdog.t", installed: true, running: true, pid: 7, inTmux: true };
    if (path.endsWith("/settings") || path.endsWith("/tokens")) return { __status: 503 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("watchdogState").textContent).toBe("On: pl.raqz.fleet-watchdog.t runs (pid 7), and a second watchdog runs by hand in tmux session t-watchdog. Stop that one with fleet watchdog stop.");
});

test("watchdog: when tmux cannot be asked the part still shows, Turn off stays open and Turn on is held back", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/watchdog")) return { fleet: "t", manager: "launchd", name: "pl.raqz.fleet-watchdog.t", installed: true, running: true, pid: 7, inTmux: null, inTmuxError: "tmux exited 1" };
    if (path.endsWith("/settings") || path.endsWith("/tokens")) return { __status: 503 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("watchdogPart").hidden).toBe(false);
  expect(b.element("watchdogState").textContent).toBe("On: pl.raqz.fleet-watchdog.t runs (pid 7). It checks every agent every 60 s and starts again at login. Cannot tell whether a watchdog runs in tmux: tmux exited 1.");
  b.element("watchdogConfirm").value = "watchdog";
  await b.listeners.get("watchdogConfirm:input")!({});
  expect([b.element("watchdogGo").textContent, b.element("watchdogGo").disabled]).toEqual(["Turn off", false]);
});

test("watchdog: off as a service and tmux unknown says so, and Turn on waits for tmux", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/watchdog")) return { fleet: "t", manager: "systemd", name: "fleet-watchdog-t.service", installed: false, running: false, pid: null, inTmux: null, inTmuxError: "error connecting to /tmp/tmux-1000/fleet-t (Permission denied)" };
    if (path.endsWith("/settings") || path.endsWith("/tokens")) return { __status: 503 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("watchdogState").textContent).toBe("Off as a service. Cannot tell whether a watchdog runs in tmux: error connecting to /tmp/tmux-1000/fleet-t (Permission denied).");
  b.element("watchdogConfirm").value = "watchdog";
  await b.listeners.get("watchdogConfirm:input")!({});
  expect([b.element("watchdogGo").textContent, b.element("watchdogGo").disabled, b.element("watchdogGate").textContent]).toEqual(["Turn on", true, "Cannot tell whether a watchdog runs in tmux (error connecting to /tmp/tmux-1000/fleet-t (Permission denied)); fix tmux first"]);
});

test("files: the part lists the allowed folders, opens a file from a folder and saves only with the typed name, naming the backup", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const text = "one\ntwo\n";
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path, init) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/files") && init?.method === "PUT") return { path: "/r/notes.md", revision: "c".repeat(64), backup: "/r/notes.md.bak-1" };
    if (path.endsWith("/files")) return { roots: ["/r"] };
    if (path.endsWith("/files?path=%2Fr")) return { kind: "dir", path: "/r", root: "/r", entries: [{ name: "sub", kind: "dir", size: 0, modifiedAt: "" }, { name: "notes.md", kind: "file", size: 8, modifiedAt: "" }], truncated: false };
    if (path.endsWith("/files?path=%2Fr%2Fnotes.md")) return { kind: "file", path: "/r/notes.md", root: "/r", text, revision: "b".repeat(64), size: 8 };
    if (path.endsWith("/settings") || path.endsWith("/tokens") || path.endsWith("/watchdog")) return { __status: 503 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  await tick(3);
  expect(b.element("filesPart").hidden).toBe(false);
  expect(b.element("fileRootsText").textContent).toBe("Opens text files in /r.");
  expect(b.element("fileList").innerHTML).toContain('data-root="/r"');
  // A folder button opens the folder; a file button in it opens the file.
  await b.listeners.get("fileList:click")!({ target: { closest: () => ({ dataset: { root: "/r" } }) } });
  await tick();
  expect(b.element("fileList").innerHTML).toContain('data-file="notes.md"');
  expect(b.element("fileList").innerHTML.indexOf("sub/")).toBeLessThan(b.element("fileList").innerHTML.indexOf("notes.md"));
  await b.listeners.get("fileList:click")!({ target: { closest: () => ({ dataset: { file: "notes.md" } }) } });
  await tick();
  expect([b.element("fileText").hidden, b.element("fileText").value, b.element("filePath").value]).toEqual([false, text, "/r/notes.md"]);
  expect([b.element("fileSave").disabled, b.element("fileGate").textContent]).toEqual([true, "No changes"]);
  b.element("fileText").value = "one\nTWO\nthree\n";
  await b.listeners.get("fileText:input")!({});
  expect([b.element("fileSave").disabled, b.element("fileGate").textContent]).toEqual([true, "Type notes.md to confirm"]);
  b.element("fileConfirm").value = "notes.md";
  await b.listeners.get("fileConfirm:input")!({});
  expect([b.element("fileSave").disabled, b.element("fileGate").textContent]).toEqual([false, "Replaces notes.md: 1 line out, 2 in; the old text is kept as a backup beside it"]);
  await b.listeners.get("fileSave:click")!({});
  await tick();
  const put = b.calls.find(c => c.path === "/api/hosts/a/files" && c.init?.method === "PUT")!;
  expect(JSON.parse(String(put.init!.body))).toEqual({ path: "/r/notes.md", text: "one\nTWO\nthree\n", revision: "b".repeat(64), confirm: "notes.md" });
  expect(b.element("adminStatus").textContent).toBe("A: saved /r/notes.md; the old text is in /r/notes.md.bak-1.");
  // After the save the draft is the file; there is nothing left to save.
  expect(b.element("fileGate").textContent).toBe("No changes");
});

test("files: a save refused as stale blocks Save until the file is opened again; a host without the editor hides the part", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  for (const roots of [{ roots: ["/r"] }, { __status: 404 }]) {
    let reads = 0;
    const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path, init) => {
      if (path.endsWith("/fleet/conf")) return conf;
      if (path.endsWith("/files") && init?.method === "PUT") return { __status: 409, error: { kind: "conflict", message: "/r/x.txt changed on the host since you read it; reload it and edit again" } };
      if (path.endsWith("/files")) return roots;
      if (path.endsWith("/files?path=%2Fr%2Fx.txt")) { reads++; return { kind: "file", path: "/r/x.txt", root: "/r", text: reads === 1 ? "a\n" : "hand\n", revision: (reads === 1 ? "b" : "d").repeat(64), size: 2 }; }
      if (path.endsWith("/settings") || path.endsWith("/tokens") || path.endsWith("/watchdog")) return { __status: 503 };
      return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
    });
    const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
    await tick(3);
    if ("__status" in roots) { expect(b.element("filesPart").hidden).toBe(true); continue; }
    b.element("filePath").value = "/r/x.txt";
    await b.listeners.get("filePath:input")!({});
    await b.listeners.get("fileOpenBtn:click")!({});
    await tick();
    b.element("fileText").value = "mine\n";
    await b.listeners.get("fileText:input")!({});
    b.element("fileConfirm").value = "x.txt";
    await b.listeners.get("fileConfirm:input")!({});
    await b.listeners.get("fileSave:click")!({});
    await tick();
    expect(b.element("adminStatus").textContent).toBe("A: /r/x.txt changed on the host since you read it; reload it and edit again");
    expect([b.element("fileSave").disabled, b.element("fileGate").textContent]).toEqual([true, "The file changed on the host; copy your edit, then Open it again"]);
    // The unsaved edit stays visible to copy.
    expect(b.element("fileText").value).toBe("mine\n");
    await b.listeners.get("fileOpenBtn:click")!({});
    await tick();
    expect([b.element("fileText").value, b.element("fileGate").textContent]).toEqual(["hand\n", "No changes"]);
  }
});

test("files: a new file needs a full path ending in a name, and is created with revision new", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path, init) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/files") && init?.method === "PUT") return { path: "/r/new.txt", revision: "e".repeat(64), backup: null };
    if (path.endsWith("/files")) return { roots: ["/r"] };
    if (path.endsWith("/files?path=%2Fr")) return { kind: "dir", path: "/r", root: "/r", entries: [], truncated: false };
    if (path.endsWith("/settings") || path.endsWith("/tokens") || path.endsWith("/watchdog")) return { __status: 503 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  await tick(3);
  await b.listeners.get("fileList:click")!({ target: { closest: () => ({ dataset: { root: "/r" } }) } });
  await tick();
  expect(b.element("fileList").innerHTML).toContain("Empty folder.");
  await b.listeners.get("fileNewBtn:click")!({});
  expect([b.element("filePath").value, b.element("fileGate").textContent]).toEqual(["/r/", "Write the new file's full path, ending in its name"]);
  b.element("filePath").value = "/r/new.txt";
  await b.listeners.get("filePath:input")!({});
  b.element("fileText").value = "hello\n";
  await b.listeners.get("fileText:input")!({});
  b.element("fileConfirm").value = "new.txt";
  await b.listeners.get("fileConfirm:input")!({});
  expect([b.element("fileSave").disabled, b.element("fileGate").textContent]).toEqual([false, "Creates /r/new.txt"]);
  await b.listeners.get("fileSave:click")!({});
  await tick();
  const put = b.calls.find(c => c.path === "/api/hosts/a/files" && c.init?.method === "PUT")!;
  expect(JSON.parse(String(put.init!.body))).toEqual({ path: "/r/new.txt", text: "hello\n", revision: "new", confirm: "new.txt" });
  expect(b.element("adminStatus").textContent).toBe("A: saved /r/new.txt.");
});

test("files: opening another path with unsaved changes asks for a second click before the draft is dropped", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/files")) return { roots: ["/r"] };
    if (path.endsWith("/files?path=%2Fr")) return { kind: "dir", path: "/r", root: "/r", entries: [{ name: "notes.md", kind: "file", size: 8, modifiedAt: "" }], truncated: false };
    if (path.endsWith("/files?path=%2Fr%2Fnotes.md")) return { kind: "file", path: "/r/notes.md", root: "/r", text: "one\n", revision: "b".repeat(64), size: 4 };
    if (path.endsWith("/settings") || path.endsWith("/tokens") || path.endsWith("/watchdog")) return { __status: 503 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  await tick(3);
  b.element("filePath").value = "/r/notes.md";
  await b.listeners.get("filePath:input")!({});
  await b.listeners.get("fileOpenBtn:click")!({});
  await tick();
  b.element("fileText").value = "edited\n";
  await b.listeners.get("fileText:input")!({});
  const reads = () => b.calls.filter(c => c.path === "/api/hosts/a/files?path=%2Fr").length;
  await b.listeners.get("fileUp:click")!({});
  await tick();
  expect([reads(), b.element("fileText").value, b.element("adminStatus").textContent]).toEqual([0, "edited\n", "A: the open file has unsaved changes. Ask for /r again to drop them."]);
  await b.listeners.get("fileUp:click")!({});
  await tick();
  expect([reads(), b.element("fileText").hidden]).toEqual([1, true]);
});

test("files: while a read is on its way, Open is disabled and a second Open sends nothing", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/files")) return { roots: ["/r"] };
    if (path.endsWith("/files?path=%2Fr")) return held.then(() => ({ kind: "dir", path: "/r", root: "/r", entries: [], truncated: false }));
    if (path.endsWith("/settings") || path.endsWith("/tokens") || path.endsWith("/watchdog")) return { __status: 503 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  await tick(3);
  b.element("filePath").value = "/r";
  await b.listeners.get("filePath:input")!({});
  void b.listeners.get("fileOpenBtn:click")!({});
  await tick();
  expect(b.element("fileOpenBtn").disabled).toBe(true);
  void b.listeners.get("fileOpenBtn:click")!({});
  await tick();
  expect(b.calls.filter(c => c.path === "/api/hosts/a/files?path=%2Fr").length).toBe(1);
  release();
  await tick(6);
  expect(b.element("fileOpenBtn").disabled).toBe(false);
});

test("host part: certificates, services and Serve show; a restart runs only after the typed name, and a renewal after renew", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  let infra = {
    certs: [{ id: "lan", path: "/c/lan.pem", names: ["192.168.1.2"], notAfter: "2029-02-09T00:00:00.000Z", daysLeft: 800, renewable: false }, { id: "tailnet", path: "/c/t.pem", names: ["h.example"], notAfter: "2026-12-01T00:00:00.000Z", daysLeft: 8, renewable: true }],
    renewedAt: null as string | null, serve: { text: "https://h.example\n|-- / proxy http://127.0.0.1:3080" },
    services: [{ name: "dsh", kind: "launchd", target: "pl.raqz.dsh", running: true, detail: "pid 4242" }, { name: "odd", kind: "launchd", target: "x", running: null, detail: "<img src=x onerror=alert(1)>" }],
  };
  let renewals = 0;
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path, init) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/infra/services/dsh/restart") && init?.method === "POST") return infra.services[0];
    if (path.endsWith("/infra/renew") && init?.method === "POST") {
      renewals++;
      if (renewals === 1) return { cert: infra.certs[1], renewed: false };
      infra = { ...infra, renewedAt: "2026-11-23T12:00:00.000Z" }; return { cert: { ...infra.certs[1], notAfter: "2027-02-20T00:00:00.000Z" }, renewed: true };
    }
    if (path.endsWith("/infra")) return infra;
    if (path.endsWith("/settings") || path.endsWith("/tokens") || path.endsWith("/watchdog")) return { __status: 503 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  await tick(3);
  expect(b.element("infraPart").hidden).toBe(false);
  expect(b.element("infraServe").textContent).toContain("proxy http://127.0.0.1:3080");
  const text = (id: string) => [...String(b.element(id).innerHTML).matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]);
  expect(text("infraCerts")).toEqual([
    "LAN certificate for 192.168.1.2: valid to 2029-02-09, 800 days left; made by hand",
    "Tailnet certificate for h.example: valid to 2026-12-01, 8 days left (renew soon)",
  ]);
  expect(text("infraServices")).toEqual(["dsh (pl.raqz.dsh): running, pid 4242", "odd (x): unknown, &lt;img src=x onerror=alert(1)&gt;"]);
  expect([b.element("infraGo").disabled, b.element("infraGate").textContent]).toEqual([true, "Choose what to do"]);
  b.element("infraAction").value = "dsh";
  await b.listeners.get("infraAction:change")!({});
  expect([b.element("infraGo").disabled, b.element("infraGate").textContent]).toEqual([true, "Type dsh to confirm"]);
  b.element("infraConfirm").value = "dsh";
  await b.listeners.get("infraConfirm:input")!({});
  expect([b.element("infraGo").disabled, b.element("infraGo").textContent]).toEqual([false, "Restart"]);
  await b.listeners.get("infraGo:click")!({});
  await tick();
  const post = b.calls.find(c => c.path === "/api/hosts/a/infra/services/dsh/restart")!;
  expect(JSON.parse(String(post.init!.body))).toEqual({ confirm: "dsh" });
  expect(b.element("adminStatus").textContent).toBe("A: dsh restarted.");
  b.element("infraAction").value = "renew";
  await b.listeners.get("infraAction:change")!({});
  b.element("infraConfirm").value = "renew";
  await b.listeners.get("infraConfirm:input")!({});
  await b.listeners.get("infraGo:click")!({});
  await tick();
  expect(b.element("adminStatus").textContent).toBe("A: tailscale returned the current certificate (valid to 2026-12-01); nothing changed.");
  b.element("infraAction").value = "renew";
  await b.listeners.get("infraAction:change")!({});
  b.element("infraConfirm").value = "renew";
  await b.listeners.get("infraConfirm:input")!({});
  await b.listeners.get("infraGo:click")!({});
  await tick();
  expect(b.element("adminStatus").textContent).toBe("A: tailnet certificate renewed (valid to 2027-02-20). The service takes it at its next start.");
  expect(text("infraCerts").at(-1)).toBe("Renewed 2026-11-23 12:00 UTC; the service takes it at its next start.");
});

test("host part: hidden on a host without it", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path) => {
    if (path.endsWith("/fleet/conf")) return conf;
    if (path.endsWith("/infra") || path.endsWith("/settings") || path.endsWith("/tokens") || path.endsWith("/watchdog")) return { __status: 503 };
    return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
  });
  for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.element("infraPart").hidden).toBe(true);
});

test("service: the page waits past the gateway's 60 s for restart and update, and past the host's 20 s GitHub limit for every /service read", async () => {
  const conf = { path: "/f/fleet.conf", text: "FLEET=t\n", revision: "a".repeat(64), sessions: [], loadError: null };
  const now = "a".repeat(40), next = "b".repeat(40);
  const job = { id: "upd-20261123T120000Z-0000abcd", action: "update", tag: "v2", commit: next, by: "op", state: "running", steps: [], startedAt: "2026-11-23T12:00:00Z", endedAt: null };
  const service = { current: { commit: now, tag: "v1" }, unavailable: null, releaseError: null, running: null, jobs: [], releases: [{ tag: "v2", commit: next, publishedAt: "x" }] };
  // Each fetch takes the signal made just before it, so the last timeout asked for belongs to this call.
  const timeout = AbortSignal.timeout;
  let lastMs = 0;
  const waits: string[] = [];
  AbortSignal.timeout = (ms: number) => { lastMs = ms; return timeout.call(AbortSignal, ms); };
  try {
    const timers: { fn: () => void; ms: number }[] = [];
    const b = await browser([{ id: "a", name: "A", apiBase: "/api/hosts/a" }], (path, init) => {
      if (path.includes("/service")) waits.push(`${init?.method ?? "GET"} ${path} ${lastMs}`);
      if (path.endsWith("/fleet/conf")) return conf;
      if (path.includes("/service/") && init?.method === "POST") return { __status: 202, job };
      if (path.endsWith("/service")) return service;
      if (path.endsWith("/settings") || path.endsWith("/tokens")) return { __status: 404 };
      return path.endsWith("/sessions") ? { sessions: [] } : path.includes("/requests") ? { requests: [], runs: [] } : path.endsWith("/agents") ? { __status: 503 } : { commands: [] };
    }, [], timers);
    const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
    await settle();
    const set = async (id: string, value: string, kind = "input") => { b.element(id).value = value; await b.listeners.get(id + ":" + kind)!({}); };
    await set("serviceAction", "update", "change");
    await set("serviceTag", "v2", "change");
    await set("serviceConfirm", "v2");
    await b.listeners.get("serviceGo:click")!({});
    await settle();
    timers.splice(0).find((t) => t.ms === 3000)!.fn();
    await settle();
    const parsed = waits.map((w) => { const [method, path, ms] = w.split(" "); return { call: `${method} ${path}`, ms: Number(ms) }; });
    // The first read when the host opens, the POST, then the poll.
    expect(parsed.map((p) => p.call)).toEqual(["GET /api/hosts/a/service", "POST /api/hosts/a/service/update", "GET /api/hosts/a/service"]);
    expect(parsed[1]!.ms).toBeGreaterThan(60_000);
    for (const p of [parsed[0]!, parsed[2]!]) expect(p.ms).toBeGreaterThan(20_000);
  } finally { AbortSignal.timeout = timeout; }
});

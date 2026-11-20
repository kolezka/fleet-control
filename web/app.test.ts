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
    const value = path === "./api/hosts" ? (Array.isArray(hosts) ? { hosts } : hosts) : respond(path, init);
    const status = (value as { __status?: number } | null)?.__status ?? 200;
    return { status, ok: status < 300, json: async () => value };
  };
  let source = await Bun.file(new URL("./app.ts", import.meta.url)).text();
  source = source.replace(/import { init, Terminal } from "ghostty-web";/, "const init = async () => {}; const Terminal = FakeTerminal;");
  source = source.replace(/import {([\s\S]*?)} from ".\/lease.ts";/, (_m, names) => "const {" + names.replace(/type \w+,?/g, "") + "} = leaseModule;");
  source = source.replace(/import {([\s\S]*?)} from ".\/host-state.ts";/, (_m, names) => "const {" + names.replace(/type \w+,?/g, "") + "} = state;");
  source = source.replace(/import {([\s\S]*?)} from ".\/agents.ts";/, (_m, names) => "const {" + names.replace(/type \w+,?/g, "") + "} = agentsModule;");
  source = source.replace(/export /g, "");
  source += "\nreturn { loadHostList, getFleet: () => fleet };";
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync("(async () => {" + source + "})()");
  const agentsModule = await import("./agents.ts");
  const leaseModule = await import("./lease.ts");
  const run = new Function("FakeTerminal", "leaseModule", "state", "agentsModule", "document", "window", "fetch", "setInterval", "location", "CSS", "getComputedStyle", "WebSocket", "setTimeout", "clearTimeout", "return " + js);
  const later = timers ? (fn: () => void, ms: number) => { const t = { fn, ms }; timers.push(t); return t; } : setTimeout;
  const cancel = timers ? (t: unknown) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1); } : clearTimeout;
  const app = await run(FakeTerminal, leaseModule, state, agentsModule, document, { matchMedia: () => ({ matches: false }) }, fetch, (fn: () => void) => { intervals.push(fn); return 0; }, { assign() {}, href: "http://127.0.0.1:4870/" }, { escape: (s: string) => s }, () => ({ getPropertyValue: () => "" }), FakeSocket, later, cancel);
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
  expect(JSON.parse(String(post.init!.body))).toEqual({ name: "fc-new", kind: "claude", cwd: "/r/other", model: "haiku", prompt: "Say hi", confirm: "fc-new" });
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

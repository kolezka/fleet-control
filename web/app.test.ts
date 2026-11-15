import { expect, test } from "bun:test";
import * as state from "./host-state.ts";

// Execute the browser module against a small DOM/fetch fixture, without terminal or network access.
async function browser(hosts: unknown[], respond: (path: string, init?: RequestInit) => unknown) {
  const elements = new Map<string, any>();
  const listeners = new Map<string, (event: any) => unknown>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", value: "", disabled: false, hidden: false, dataset: {}, classList: { toggle() {} }, setAttribute() {}, contains: () => false, querySelector: () => element(id + ":child"), addEventListener: (kind: string, fn: any) => listeners.set(id + ":" + kind, fn) });
    return elements.get(id);
  };
  const document = { getElementById: element, documentElement: element("root"), activeElement: null, addEventListener: (kind: string, fn: any) => listeners.set(kind, fn) };
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const value = path === "./api/hosts" ? { hosts } : respond(path, init);
    return { status: 200, ok: true, json: async () => value };
  };
  let source = await Bun.file(new URL("./app.ts", import.meta.url)).text();
  source = source.replace(/import { init, Terminal } from "ghostty-web";/, "const init = async () => {}; const Terminal = class {};");
  source = source.replace(/import {([\s\S]*?)} from ".\/host-state.ts";/, (_m, names) => "const {" + names.replace(/type \w+,?/g, "") + "} = state;");
  source = source.replace(/export /g, "");
  source += "\nreturn { loadHostList, getFleet: () => fleet };";
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync("(async () => {" + source + "})()");
  const run = new Function("state", "document", "window", "fetch", "setInterval", "location", "CSS", "getComputedStyle", "return " + js);
  const app = await run(state, document, { matchMedia: () => ({ matches: false }) }, fetch, () => 0, { assign() {} }, { escape: (s: string) => s }, () => ({ getPropertyValue: () => "" }));
  await new Promise(resolve => setTimeout(resolve, 0));
  const click = async (dataset: Record<string, string>) => {
    await listeners.get("click")!({ target: { closest: () => ({ dataset }) } });
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { app, element, calls, click, listeners };
}
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
  const b = await browser([legacy], path => path.endsWith("/sessions") ? { sessions: [] } : path.endsWith("/requests") ? { requests: [], runs: [] } : { commands: [] });
  expect(b.calls.some(c => c.path.endsWith("/requests"))).toBe(true);
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

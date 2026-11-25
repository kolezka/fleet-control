import { expect, test } from "bun:test";
import * as view from "./add-host-view.ts";

const pendingNew = { id: "new", name: "New host", url: "https://new.tail.ts.net:4871", mode: "connect", principal: "macbook-gateway", command: "cd /srv && bun scripts/enroll.ts connect --principal macbook-gateway --hash " + "a".repeat(64) + " --role operator", ssh: "me@new", createdAt: "2026-11-20T12:00:00.000Z" };

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
  const copied: string[] = [];
  const fetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const reply = respond(path, init);
    if (!reply) throw new Error("network down");
    return { status: reply.status, json: async () => reply.body };
  };
  let source = await Bun.file(new URL("./add-host.ts", import.meta.url)).text();
  source = source.replace(/import {([\s\S]*?)} from ".\/add-host-view.ts";/, (_m, names) => "const {" + names.replace(/type \w+,?/g, "") + "} = view;");
  expect(source).not.toContain("import ");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync("(async () => {" + source + "})()");
  const navigator = { clipboard: { writeText: async (t: string) => { copied.push(t); } } };
  await new Function("view", "document", "fetch", "navigator", "return " + js)(view, { getElementById: element }, fetch, navigator);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const fire = async (key: string, event: any = {}) => { listeners.get(key)!({ preventDefault() {}, ...event }); await settle(); await settle(); };
  await settle();
  const type = async (id: string, value: string) => { element(id).value = value; await fire(id + ":input"); };
  const press = (act: string, id: string) => fire("pending:click", { target: { closest: () => ({ dataset: { act, id } }) } });
  const posts = () => calls.filter((c) => c.init?.method === "POST").map((c) => ({ path: c.path, body: JSON.parse(c.init!.body as string) }));
  return { element, fire, type, press, posts, calls, copied };
}

test("payload carries only the fields of the chosen mode", () => {
  const f: view.Form = { mode: "connect", id: " new ", name: "New", url: "https://n:1", principal: "p", dir: "/srv", ref: "main", port: "4872", label: "x", fleet: "y", tlsCert: "/c", tlsKey: "/k", ssh: "", sshPort: "22" };
  expect(view.payload(f)).toEqual({ id: "new", name: "New", url: "https://n:1", mode: "connect", principal: "p", dir: "/srv" });
  expect(view.payload({ ...f, mode: "fresh", ssh: "me@n" })).toEqual({ id: "new", name: "New", url: "https://n:1", mode: "fresh", principal: "p", dir: "/srv", ref: "main", port: 4872, label: "x", fleet: "y", tlsCert: "/c", tlsKey: "/k", ssh: "me@n", sshPort: 22 });
  // A malformed port is passed on as text so the server refuses it; it is never guessed.
  expect(view.payload({ ...f, mode: "fresh", port: "48x" }).port).toBe("48x");
});

test("replies are validated and text is escaped", () => {
  expect(view.parsePendingList({ pending: [pendingNew] })).toEqual([pendingNew as view.Pending]);
  for (const bad of [null, {}, { pending: [{ ...pendingNew, mode: "other" }] }, { pending: [{ ...pendingNew, command: 1 }] }]) expect(view.parsePendingList(bad)).toBeNull();
  expect(view.parseCheck({ added: false, reason: "x" })).toEqual({ added: false, reason: "x" });
  expect(view.parseCheck({ added: "yes" })).toBeNull();
  const html = view.pendingHtml({ ...pendingNew, name: "<img onerror=x>" } as view.Pending, "<b>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
});

test("the form is enabled only with the fields its mode needs", () => {
  const f: view.Form = { mode: "connect", id: "new", name: "New", url: "https://n:1", principal: "p", dir: "/srv", ref: "", port: "", label: "", fleet: "", tlsCert: "", tlsKey: "", ssh: "", sshPort: "" };
  expect(view.formGate(f, false).enabled).toBe(true);
  expect(view.formGate({ ...f, mode: "fresh" }, false)).toEqual({ enabled: false, reason: "Enter the git ref." });
  expect(view.formGate({ ...f, dir: " " }, false)).toEqual({ enabled: false, reason: "Enter the folder." });
  expect(view.formGate(f, true).enabled).toBe(false);
});

test("begin, copy and a failed then passing check, all on the page", async () => {
  let checks = 0;
  const p = await page((path, init) => {
    if (init?.method !== "POST") return { status: 200, body: { pending: [] } };
    if (path === "./api/enroll") return { status: 201, body: { pending: pendingNew } };
    if (path.endsWith("/check")) return { status: 200, body: ++checks === 1 ? { added: false, reason: "the host does not know this token yet; run the command there first" } : { added: true, reason: null } };
    return null;
  });
  expect(p.element("alert").hidden).toBe(true);
  expect(p.element("pending").innerHTML).toContain("No host is being added.");
  expect(p.element("begin").disabled).toBe(true);
  for (const [id, v] of [["hostId", "new"], ["hostName", "New host"], ["hostUrl", "https://new.tail.ts.net:4871"], ["principal", "macbook-gateway"], ["dir", "/srv"], ["ssh", "me@new"]]) await p.type(id!, v!);
  expect(p.element("begin").disabled).toBe(false);
  await p.fire("hostForm:submit");
  expect(p.posts()).toEqual([{ path: "./api/enroll", body: { id: "new", name: "New host", url: "https://new.tail.ts.net:4871", mode: "connect", principal: "macbook-gateway", dir: "/srv", ssh: "me@new" } }]);
  expect(p.element("pending").innerHTML).toContain(view.esc(pendingNew.command));
  expect(p.element("pending").innerHTML).toContain("Run over SSH as me@new");
  expect(p.element("formStatus").textContent).toBe("Token made for new. Nothing ran on the host yet.");

  await p.press("copy", "new");
  expect(p.copied).toEqual([pendingNew.command]);
  await p.press("check", "new");
  expect(p.element("pending").innerHTML).toContain("Not added: the host does not know this token yet");
  await p.press("check", "new");
  expect(p.element("pending").innerHTML).toContain("No host is being added.");
  expect(p.element("formStatus").textContent).toBe("New host was added. It shows on the terminals page.");
});

test("fresh mode shows its fields and a lost SSH answer is reported as unknown", async () => {
  const p = await page((path, init) => {
    if (init?.method !== "POST") return { status: 200, body: { pending: [pendingNew] } };
    return null;
  });
  expect(p.element("pendingCount").textContent).toBe("1");
  expect(p.element("freshFields").hidden).toBe(true);
  await p.fire("mode-fresh:click");
  expect(p.element("freshFields").hidden).toBe(false);
  expect(p.element("mode-fresh").attributes["aria-pressed"]).toBe("true");
  await p.press("ssh", "new");
  expect(p.element("pending").innerHTML).toContain("No answer. Unknown whether the command ran; press Check.");
});

test("preparing a fresh workstation previews locally and enrolls only the reviewed inputs", async () => {
  const p = await page(() => ({ status: 200, body: { pending: [] } }));
  await p.fire("mode-fresh:click");
  for (const [id, value] of Object.entries({ hostId: "build", hostName: "Builder", hostUrl: "https://build.example.test:4872", principal: "gateway", dir: "/srv/fleet", ref: "main", port: "4872", label: "builder-service", fleet: "workers", tlsCert: "/tls/cert", tlsKey: "/tls/key" })) await p.type(id, value);
  await p.fire("hostForm:submit");
  expect(p.posts()).toHaveLength(0);
  expect(p.element("planSummary").textContent).toContain("builder-service");
  expect(p.element("planSummary").textContent).toContain("https://build.example.test:4872");
  await p.type("hostName", "Builder two");
  expect(p.element("planPanel").hidden).toBe(true);
  await p.fire("startEnrollment:click");
  expect(p.posts()).toHaveLength(0);
  await p.fire("hostForm:submit");
  await p.fire("mode-connect:click");
  await p.fire("mode-fresh:click");
  await p.fire("startEnrollment:click");
  expect(p.posts()).toHaveLength(0);
  await p.fire("hostForm:submit");
  await p.fire("startEnrollment:click");
  expect(p.posts()).toHaveLength(1);
  expect(p.posts()[0]?.body.name).toBe("Builder two");
});

test("saved plans reload separately from enrollment; malformed lists are not empty lists", async () => {
  const plan = { id: "build", name: "Builder", mode: "fresh", url: "https://build.example.test:4872" };
  for (const [body, expected] of [[{ plans: [plan] }, "Builder"], [{ plans: [] }, "No saved plans"], [{ plans: [null] }, "Cannot read saved plans"], [{}, "Cannot read saved plans"]] as const) {
    const p = await page(path => ({ status: 200, body: path.endsWith("/plans") ? body : { pending: [] } }));
    expect(p.element("savedPlans").textContent).toContain(expected);
    expect(p.posts()).toHaveLength(0);
  }
});

test("saving an installation plan posts only to the plan store", async () => {
  let plans: unknown[] = [];
  const p = await page((path, init) => {
    if (!path.endsWith("/plans")) return { status: 200, body: { pending: [] } };
    if (init?.method === "POST") { plans = [JSON.parse(init.body as string)]; return { status: 201, body: { saved: true } }; }
    return { status: 200, body: { plans } };
  });
  await p.fire("mode-fresh:click");
  for (const [id, value] of Object.entries({ hostId: "build", hostName: "Builder", hostUrl: "https://build.example.test:4872", principal: "gateway", dir: "/srv/new", ref: "main", port: "4872", label: "builder", fleet: "workers", tlsCert: "/tls/cert", tlsKey: "/tls/key" })) await p.type(id, value);
  await p.fire("hostForm:submit");
  expect(p.element("savePlan").disabled).toBe(false);
  await p.fire("savePlan:click");
  expect(p.posts().map(p => p.path)).toEqual(["./api/enroll/plans"]);
  expect(p.element("savedPlans").textContent).toContain("Builder");
  expect(p.element("pendingCount").textContent).toBe("None");
});

test("a gateway without enrollment says how to turn it on", async () => {
  const p = await page(() => ({ status: 404, body: { error: { kind: "not_found", message: "not found" } } }));
  expect(p.element("alert").hidden).toBe(false);
  expect(p.element("alert").textContent).toContain("FLEET_CONTROL_ENROLL=1");
});

import { expect, test } from "bun:test";
import * as domain from "../src/domain/workstation-profile.ts";

const saved = { name: "Build", origin: "https://build.example.test", profile: { group: "Lab", description: "Bench", defaultHarness: null } };

// Runs the page module against a small DOM and fetch fixture. No browser, no network.
async function page(respond: (path: string, init?: RequestInit) => { status: number; body: unknown } | null, search = "?host=build") {
  const elements = new Map<string, any>();
  const listeners = new Map<string, (event: any) => unknown>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, { textContent: "", value: "", disabled: false, addEventListener: (kind: string, fn: any) => listeners.set(id + ":" + kind, fn) });
    return elements.get(id);
  };
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const reply = respond(path, init);
    if (!reply) throw new Error("network down");
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, json: async () => reply.body };
  };
  let source = await Bun.file(new URL("./workstation.ts", import.meta.url)).text();
  source = source.replace(/import {([\s\S]*?)} from '..\/src\/domain\/workstation-profile.ts';/, (_m, names) => "const {" + names.replace(/type \w+,?/g, "") + "} = domain;");
  expect(source).not.toContain("import ");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync("(async () => {" + source + "})()");
  await new Function("domain", "document", "fetch", "location", "return " + js)(domain, { getElementById: element }, fetch, { search });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const fire = async (key: string) => { listeners.get(key)!({ preventDefault() {} }); await settle(); await settle(); };
  await settle(); await settle();
  const type = async (id: string, value: string) => { element(id).value = value; await fire("profileForm:input"); };
  const posts = () => calls.filter((c) => c.init?.method === "POST").map((c) => ({ path: c.path, body: JSON.parse(c.init!.body as string) }));
  return { element, fire, type, posts, calls };
}

test("the form loads the saved settings and offers nothing to save until something changes", async () => {
  const p = await page(() => ({ status: 200, body: saved }));
  expect(p.calls.map((c) => c.path)).toEqual(["./api/manage/build/profile"]);
  expect(p.element("identity").textContent).toBe("build · https://build.example.test (address and credentials are not editable here)");
  expect([p.element("name").value, p.element("group").value, p.element("description").value, p.element("harness").value]).toEqual(["Build", "Lab", "Bench", ""]);
  expect(p.element("changes").textContent).toBe("No pending changes.");
  expect(p.element("save").disabled).toBe(true);
  expect(p.element("fields").disabled).toBe(false);
});

test("a change is listed before saving, saved once against the loaded snapshot, and confirmed from the reply", async () => {
  const stored = { ...saved, profile: { ...saved.profile, group: "Compute", defaultHarness: "deepseek-harness" } };
  const p = await page((_path, init) => ({ status: 200, body: init?.method === "POST" ? stored : saved }));
  await p.type("group", "Compute");
  await p.type("harness", "deepseek-harness");
  expect(p.element("changes").textContent).toBe("Group: Lab → Compute\nHarness preference: None → deepseek-harness");
  expect(p.element("save").disabled).toBe(false);
  expect(p.posts()).toEqual([]);
  await p.fire("profileForm:submit");
  expect(p.posts()).toEqual([{ path: "./api/manage/build/profile", body: { expected: saved, name: "Build", profile: { group: "Compute", description: "Bench", defaultHarness: "deepseek-harness" } } }]);
  expect(p.element("notice").textContent).toBe("Changes saved.");
  expect(p.element("changes").textContent).toBe("No pending changes.");
  // Nothing left to save, so a second submit sends nothing.
  await p.fire("profileForm:submit");
  expect(p.posts()).toHaveLength(1);
});

test('configuration breadcrumb follows the confirmed name, not the draft', async () => {
  const p = await page((_path, init) => ({ status: 200, body: init?.method === 'POST' ? { ...saved, name: 'Compute' } : saved }));
  expect(p.element('studioCrumb').textContent).toBe('Fleet　/　Build');
  await p.type('name', 'Compute');
  expect(p.element('studioCrumb').textContent).toBe('Fleet　/　Build');
  await p.fire('profileForm:submit');
  expect(p.element('studioCrumb').textContent).toBe('Fleet　/　Compute');
});

test("a save the gateway refuses as stale locks the form until the settings are read again", async () => {
  const p = await page((_path, init) => init?.method === "POST" ? { status: 409, body: { error: { message: "Workstation changed. Reload before saving." } } } : { status: 200, body: saved });
  await p.type("group", "Compute");
  await p.fire("profileForm:submit");
  expect(p.element("notice").textContent).toBe("Configuration changed. Reload saved settings before editing again.");
  expect(p.element("fields").disabled).toBe(true);
  await p.fire("profileForm:submit");
  expect(p.posts()).toHaveLength(1);
  await p.fire("reload:click");
  expect(p.element("fields").disabled).toBe(false);
  expect(p.element("group").value).toBe("Lab");
});

test("a save is not reported as done when the reply is an error, missing, or holds other values", async () => {
  const replies: ({ status: number; body: unknown } | null)[] = [
    { status: 500, body: { error: { message: "Cannot update workstation configuration." } } },
    null,
    { status: 200, body: { ...saved, profile: { ...saved.profile, group: "Elsewhere" } } },
    { status: 200, body: { ...saved, origin: "https://other.example.test", profile: { ...saved.profile, group: "Compute" } } },
  ];
  for (const reply of replies) {
    const p = await page((_path, init) => init?.method === "POST" ? reply : { status: 200, body: saved });
    await p.type("group", "Compute");
    await p.fire("profileForm:submit");
    expect(p.posts()).toHaveLength(1);
    expect(p.element("notice").textContent).toBe("Save not confirmed. Reload to check the stored configuration.");
    expect(p.element("fields").disabled).toBe(true);
  }
});

test("settings that cannot be read, or are malformed, leave the form locked instead of showing empty fields as saved", async () => {
  const bad: ({ status: number; body: unknown } | null)[] = [
    null,
    { status: 404, body: { error: { message: "Unknown workstation." } } },
    // An error status is not a saved state, even when its body looks like one.
    { status: 500, body: saved },
    { status: 200, body: { name: "Build", origin: "https://build.example.test", profile: { group: "Lab" } } },
    { status: 200, body: { name: 7, origin: "https://build.example.test", profile: null } },
  ];
  for (const reply of bad) {
    const p = await page(() => reply);
    expect(p.element("notice").textContent).toBe("Cannot read workstation configuration.");
    // The page locks the fieldset; the Save button inside it is disabled in the HTML from the start.
    expect(p.element("fields").disabled).toBe(true);
    await p.fire("profileForm:submit");
    expect(p.posts()).toEqual([]);
  }
  // A host with no profile yet is valid and editable (positive control for the cases above).
  const fresh = await page(() => ({ status: 200, body: { ...saved, profile: null } }));
  expect(fresh.element("notice").textContent).toBe("Loaded saved settings.");
  expect(fresh.element("fields").disabled).toBe(false);
  // A host id the gateway would never accept is not sent at all.
  const odd = await page(() => ({ status: 200, body: saved }), "?host=../etc");
  expect(odd.calls).toEqual([]);
  expect(odd.element("notice").textContent).toBe("Cannot read workstation configuration.");
});

test('configuration identifies the selected workstation and separates its immutable connection from preferences', async () => {
  const p = await page(() => ({ status: 200, body: saved }));
  expect(p.element('machineName').textContent).toBe('Build');
  expect(p.element('overviewLink').href).toBe('./?view=machine&host=build');
  expect(p.element('terminalsLink').href).toBe('./?view=terminals&host=build');
  const renamed = await page((_path, init) => ({ status: 200, body: init?.method === 'POST' ? { ...saved, name: 'New bench' } : saved }));
  await renamed.type('name', 'New bench');
  expect(renamed.element('machineName').textContent).toBe('Build');
  await renamed.fire('profileForm:submit');
  expect(renamed.element('machineName').textContent).toBe('New bench');
  const html = await Bun.file(new URL('./workstation.html', import.meta.url)).text();
  for (const heading of ['Identity', 'Connection', 'Session defaults', 'Changes to review']) expect(html).toContain(`<h2>${heading}</h2>`);
});

import { strict as assert } from "node:assert";

const html = await Bun.file("/Users/me/Development/fleet-control/.design/drafts/console/terminal-deck/v4.html").text();
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
if (!script) throw new Error("Draft script missing");

function fixture(search = "") {
  const nodes = new Map<string, any>();
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    nodes.set(id!, {
      id, dataset: {}, innerHTML: "", value: "", textContent: "", disabled: false, open: false,
      listeners: new Map<string, Function[]>(), attributes: new Map<string, string>(),
      classList: { toggle() {} },
      addEventListener(name: string, fn: Function) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); },
      setAttribute(name: string, value: string) { this.attributes.set(name, value); },
      contains(target: unknown) { return target === this; },
      focus() {},
    });
  }
  const handlers = new Map<string, Function[]>();
  const document = {
    documentElement: { style: { setProperty() {} } },
    getElementById(id: string) { const node = nodes.get(id); if (!node) throw new Error(`Unknown DOM fixture ID: ${id}`); return node; },
    addEventListener(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
  };
  new Function("document", "window", "location", script!)(document, { matchMedia: () => ({ matches: true }) }, { search });
  const get = (id: string) => document.getElementById(id);
  function click(id: string) {
    const target = get(id);
    if (target.disabled) throw new Error(`Attempt to click disabled button: ${id}`);
    const event = { target: { closest: () => target } };
    for (const fn of handlers.get("click") ?? []) fn(event);
  }
  function submit(text: string) {
    get("instruction").value = text;
    for (const fn of get("instruction").listeners.get("input") ?? []) fn({ target: get("instruction") });
    for (const fn of get("instructionForm").listeners.get("submit") ?? []) fn({ preventDefault() {} });
  }
  return { get, click, submit };
}

const normal = fixture();
assert.match(normal.get("terminals").innerHTML, /data-pane="supervisor"/);
assert.match(normal.get("exchangeRows").innerHTML, /cmd-16 · accepted by supervisor/);
assert.equal(normal.get("requestStatus").textContent, "Needs your decision");
const initial = normal.get("exchangeRows").innerHTML;
normal.submit("   ");
assert.equal(normal.get("exchangeRows").innerHTML, initial);
normal.submit("Check <scope> & report back");
assert.match(normal.get("exchangeRows").innerHTML, /Check &lt;scope&gt; &amp; report back/);
assert.match(normal.get("instructionStatus").textContent, /queued in this page only. Not delivered or accepted/);
assert.equal(normal.get("instruction").value, "");
normal.click("approve");
assert.equal(normal.get("requestStatus").textContent, "Awaiting acknowledgement");
assert.match(normal.get("requestResult").textContent, /Phase 3 has not started/);
assert.match(normal.get("workflowSteps").innerHTML, /Read API<\/span><small>Not started/);
assert.equal(normal.get("rejectRequest").disabled, true);

const declined = fixture();
declined.click("rejectRequest");
assert.equal(declined.get("requestStatus").textContent, "Declined");
assert.equal(declined.get("approve").disabled, true);

const offline = fixture("?scenario=disconnected");
const oldRows = offline.get("exchangeRows").innerHTML;
offline.submit("Continue");
assert.equal(offline.get("exchangeRows").innerHTML, oldRows);
assert.equal(offline.get("instructionStatus").textContent, "Disconnected. No instruction queued.");
assert.equal(offline.get("approve").disabled, true);
console.log("PASS: initial fixture, blank input, escaped instruction, queued-only receipt, approval awaiting acknowledgement, no phase auto-start, decline and disconnected refusal.");
console.log("Scope: actual draft event handlers with a minimal DOM fixture, not a browser interaction test.");

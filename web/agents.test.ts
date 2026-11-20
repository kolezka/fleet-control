import { expect, test } from "bun:test";
import { parseAgents, startGate } from "./agents.ts";

test("a host's kinds list keeps only known kinds as own entries", () => {
  // JSON.parse makes "__proto__" an own key; it must not pass as a kind or change the object.
  const body = JSON.parse('{"agents":[],"models":["sonnet"],"folders":[],"kinds":{"__proto__":["evil"],"toString":["x"],"claude":["sonnet"]}}');
  const list = parseAgents(body);
  expect(list).not.toBeNull();
  expect(Object.getPrototypeOf(list!.kinds)).toBe(Object.prototype);
  expect(Object.keys(list!.kinds)).toEqual(["claude"]);
});

test("orchestrators are offered only on an explicit true, and the gate refuses them elsewhere or for DSH", () => {
  const base = { agents: [], models: ["haiku"], folders: ["/r"], kinds: { claude: ["haiku"], dsh: ["d/x"] } };
  expect(parseAgents(base)!.orchestrators).toBe(false);
  expect(parseAgents({ ...base, orchestrators: "yes" })!.orchestrators).toBe(false);
  const on = parseAgents({ ...base, orchestrators: true })!;
  const form = { name: "fc-a", kind: "claude" as const, cwd: "/r", model: "haiku", prompt: "x", confirm: "fc-a", orchestrator: true };
  expect(startGate(form, on, false)).toEqual({ ok: true });
  expect(startGate(form, parseAgents(base), false)).toEqual({ ok: false, reason: "This host does not offer orchestrators" });
  expect(startGate({ ...form, kind: "dsh", model: "d/x" }, on, false)).toEqual({ ok: false, reason: "Only Claude Code agents can be orchestrators" });
});

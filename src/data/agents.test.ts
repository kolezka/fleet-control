import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Agents } from "./agents.ts";
import type { Agent } from "../domain/agents.ts";

const row = (over: Partial<Agent> = {}): Agent => ({
  name: "fc-one", kind: "claude", cwd: "/r/a", model: "haiku", promptSha256: "0".repeat(64), promptBytes: 1,
  createdBy: "op", createdAt: "t0", state: "starting", error: null, updatedAt: "t0", ...over,
});

test("claim takes a new name or a stopped or failed row, never a live one, so two starts cannot both win", () => {
  const agents = new Agents(new Database(":memory:"));
  expect(agents.claim(row())).toBe(true);
  for (const state of ["starting", "running", "stopping"] as const) {
    agents.transition("fc-one", ["starting", "running", "stopping"], state, null, "t1");
    expect(agents.claim(row({ model: "opus" }))).toBe(false);
    expect(agents.get("fc-one")!.model).toBe("haiku");
  }
  for (const state of ["failed", "stopped"] as const) {
    agents.transition("fc-one", ["stopping", "starting"], state, null, "t2");
    expect(agents.claim(row({ model: "opus", state: "starting" }))).toBe(true);
    expect(agents.get("fc-one")).toMatchObject({ model: "opus", state: "starting" });
    agents.transition("fc-one", ["starting"], "stopping", null, "t3");
  }
});

test("transition moves only from the named states", () => {
  const agents = new Agents(new Database(":memory:"));
  agents.claim(row());
  expect(agents.transition("fc-one", ["running"], "stopped", null, "t1")).toBe(false);
  expect(agents.transition("fc-one", ["starting"], "failed", "why", "t1")).toBe(true);
  expect(agents.get("fc-one")).toMatchObject({ state: "failed", error: "why", updatedAt: "t1" });
});

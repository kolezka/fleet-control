import { expect, test } from "bun:test";
import { agentSettingsFromEnv } from "./config.ts";

test("managed agents are off unless roots are set, and roots and models must be plain", () => {
  expect(agentSettingsFromEnv({})).toBeUndefined();
  expect(agentSettingsFromEnv({ FLEET_CONTROL_AGENT_ROOTS: " " })).toBeUndefined();
  expect(agentSettingsFromEnv({ FLEET_CONTROL_AGENT_ROOTS: "/Users/me/fleet-agents:/srv/a" }))
    .toEqual({ roots: ["/Users/me/fleet-agents", "/srv/a"], models: ["sonnet", "opus", "haiku"] });
  expect(agentSettingsFromEnv({ FLEET_CONTROL_AGENT_ROOTS: "/r", FLEET_CONTROL_AGENT_MODELS: "haiku" })!.models).toEqual(["haiku"]);
  for (const bad of ["/", "relative", "/with space", "/a;rm"]) expect(() => agentSettingsFromEnv({ FLEET_CONTROL_AGENT_ROOTS: bad })).toThrow("not a plain absolute folder");
  expect(() => agentSettingsFromEnv({ FLEET_CONTROL_AGENT_ROOTS: "/r", FLEET_CONTROL_AGENT_MODELS: "haiku --x" })).toThrow("not a model alias");
  expect(() => agentSettingsFromEnv({ FLEET_CONTROL_AGENT_ROOTS: "/r", FLEET_CONTROL_AGENT_MODELS: "," })).toThrow("empty");
});

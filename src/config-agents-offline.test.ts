import { expect, test } from "bun:test";
import { agentSettingsFromEnv } from "./config.ts";

test("managed agents are off unless roots are set, and roots and models must be plain", () => {
  expect(agentSettingsFromEnv({})).toBeUndefined();
  expect(agentSettingsFromEnv({ FLEET_CONTROL_AGENT_ROOTS: " " })).toBeUndefined();
  expect(agentSettingsFromEnv({ FLEET_CONTROL_AGENT_ROOTS: "/Users/me/fleet-agents:/srv/a" }))
    .toEqual({ roots: ["/Users/me/fleet-agents", "/srv/a"], models: { claude: ["sonnet", "opus", "haiku"] } });
  expect(agentSettingsFromEnv({ FLEET_CONTROL_AGENT_ROOTS: "/r", FLEET_CONTROL_AGENT_MODELS: "haiku" })!.models).toEqual({ claude: ["haiku"] });
  for (const bad of ["/", "relative", "/with space", "/a;rm"]) expect(() => agentSettingsFromEnv({ FLEET_CONTROL_AGENT_ROOTS: bad })).toThrow("not a plain absolute folder");
  expect(() => agentSettingsFromEnv({ FLEET_CONTROL_AGENT_ROOTS: "/r", FLEET_CONTROL_AGENT_MODELS: "haiku --x" })).toThrow("not a model alias");
  expect(() => agentSettingsFromEnv({ FLEET_CONTROL_AGENT_ROOTS: "/r", FLEET_CONTROL_AGENT_MODELS: "," })).toThrow("empty");
});

test("DSH agents are offered only where FLEET_CONTROL_AGENT_DSH_MODELS lists provider/model pairs", () => {
  const env = { FLEET_CONTROL_AGENT_ROOTS: "/r", FLEET_CONTROL_AGENT_MODELS: "haiku" };
  expect(agentSettingsFromEnv({ ...env, FLEET_CONTROL_AGENT_DSH_MODELS: "deepseek-official/deepseek-flash, cliproxyapi/claude-haiku-5-5" })!.models)
    .toEqual({ claude: ["haiku"], dsh: ["deepseek-official/deepseek-flash", "cliproxyapi/claude-haiku-5-5"] });
  expect(agentSettingsFromEnv({ ...env, FLEET_CONTROL_AGENT_DSH_MODELS: " " })!.models).toEqual({ claude: ["haiku"] });
  for (const bad of ["deepseek-flash", "a/b/c", "a/b c", "a/$(x)", "A/b"]) {
    expect(() => agentSettingsFromEnv({ ...env, FLEET_CONTROL_AGENT_DSH_MODELS: bad })).toThrow("is not provider/model");
  }
});

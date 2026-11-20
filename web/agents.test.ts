import { expect, test } from "bun:test";
import { parseAgents } from "./agents.ts";

test("a host's kinds list keeps only known kinds as own entries", () => {
  // JSON.parse makes "__proto__" an own key; it must not pass as a kind or change the object.
  const body = JSON.parse('{"agents":[],"models":["sonnet"],"folders":[],"kinds":{"__proto__":["evil"],"toString":["x"],"claude":["sonnet"]}}');
  const list = parseAgents(body);
  expect(list).not.toBeNull();
  expect(Object.getPrototypeOf(list!.kinds)).toBe(Object.prototype);
  expect(Object.keys(list!.kinds)).toEqual(["claude"]);
});

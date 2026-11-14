import { expect, test } from "bun:test";
import { validInventorySessions } from "../domain/agent-protocol.ts";

test("rejects an inventory consisting of a single hole", () => {
  expect(validInventorySessions(new Array(1))).toBe(false);
});

test("rejects an inventory with a hole among valid sessions", () => {
  expect(validInventorySessions(["first", , "second"])).toBe(false);
});

test("accepts an explicit array of valid distinct sessions", () => {
  expect(validInventorySessions(["first", "second"])).toBe(true);
});

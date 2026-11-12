import { expect, test } from "bun:test";
import { messageFor } from "./delivery.ts";
import type { Command } from "./commands.ts";

test("control characters expand the rendered actor header", () => {
  const command: Command = { id: "cmd-test", idempotencyKey: "key", target: "session", actor: "x" + "a".repeat(1000), text: "text", status: "queued", createdAt: "", updatedAt: "" };
  const plain = messageFor(command);
  const controls = messageFor({ ...command, actor: "x" + "\u0001".repeat(1000) });
  expect(controls.length - plain.length).toBe(5000);
  expect(controls.split("\n")[0]).toBe(`Fleet Control command cmd-test from x${"\\u0001".repeat(1000)}:`);
});

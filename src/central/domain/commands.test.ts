import { expect, test } from "bun:test";
import { MAX_TEXT } from "../../domain/commands.ts";
import { centralCommandStatuses, centralCommandTransitions, parseCommandSubmission } from "./commands.ts";

const valid = { hostId: "host", target: "session", text: "do it", idempotencyKey: "key-1" };

test("a valid submission keeps exactly the four fields and never an actor", () => {
  expect(parseCommandSubmission({ ...valid, actor: "forged", extra: 1 })).toEqual(valid);
});

test("a submission at each size limit is accepted and one past it is refused", () => {
  const limits: [keyof typeof valid, number][] = [["hostId", 256], ["target", 256], ["text", MAX_TEXT], ["idempotencyKey", 200]];
  for (const [field, limit] of limits) {
    expect(parseCommandSubmission({ ...valid, [field]: "x".repeat(limit) })).not.toBeNull();
    expect(parseCommandSubmission({ ...valid, [field]: "x".repeat(limit + 1) })).toBeNull();
  }
});

test.each([
  ["null", null], ["an array", [valid]], ["a string", "text"],
  ["a blank host", { ...valid, hostId: "  " }], ["a blank key", { ...valid, idempotencyKey: " " }],
  ["a numeric text", { ...valid, text: 1 }], ["a missing target", { hostId: "host", text: "x", idempotencyKey: "key-1" }],
])("%s is not a submission", (_name, input) => {
  expect(parseCommandSubmission(input)).toBeNull();
});

test("an empty target and an empty text are left for the store to judge", () => {
  expect(parseCommandSubmission({ ...valid, target: "", text: "" })).toEqual({ ...valid, target: "", text: "" });
});

test("the status list names every status that has a transition rule", () => {
  expect([...centralCommandStatuses].sort() as string[]).toEqual(Object.keys(centralCommandTransitions).sort());
});

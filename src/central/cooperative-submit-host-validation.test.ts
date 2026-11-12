import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { CentralCommands, type CentralCommandInput } from "./commands.ts";
import { CommandError } from "../commands.ts";

const input: CentralCommandInput = {
  idempotencyKey: "key",
  hostId: "host",
  target: "session",
  actor: "operator",
  text: "instruction",
};

function fixture() {
  let calls = 0;
  const reachedRunner = new Error("runner reached");
  const tx = async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM central_command_event_lock")) return [{ id: 1 }];
    if (query.includes("FROM central_commands WHERE idempotency_key")) return [];
    throw reachedRunner;
  };
  const commands = new CentralCommands({} as SQL, undefined, async (operation) => {
    calls++;
    return operation(tx as unknown as Parameters<Parameters<NonNullable<ConstructorParameters<typeof CentralCommands>[2]>>[0]>[0]);
  });
  return { commands, reachedRunner, calls: () => calls };
}

const invalidHosts = [
  ["leading space", " host"],
  ["trailing space", "host "],
  ["leading Unicode whitespace", " host"],
  ["trailing Unicode whitespace", "host "],
  ["leading control", "\u0001host"],
  ["trailing control", "host\u007f"],
  ["embedded control", "ho\u0001st"],
] as const;

for (const [label, hostId] of invalidHosts) {
  test(`submitBounded rejects ${label} host before insertion`, async () => {
    const f = fixture();
    const error = await f.commands.submitBounded({ ...input, hostId }).then(() => null, (reason: unknown) => reason);
    expect({ invalid: error instanceof CommandError && error.kind === "invalid", calls: f.calls() }).toEqual({ invalid: true, calls: 1 });
  });

  test(`legacy submit allows ${label} host through to the runner`, async () => {
    const f = fixture();
    await expect(f.commands.submit({ ...input, hostId })).rejects.toBe(f.reachedRunner);
    expect(f.calls()).toBe(1);
  });
}

test("submitBounded allows a valid Unicode host through to the runner", async () => {
  const f = fixture();
  await expect(f.commands.submitBounded({ ...input, hostId: "żółw-東京" })).rejects.toBe(f.reachedRunner);
  expect(f.calls()).toBe(1);
});

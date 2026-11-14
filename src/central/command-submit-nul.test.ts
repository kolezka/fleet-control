import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { CommandError } from "../domain/commands.ts";
import { CentralCommands } from "./data/commands.ts";
import type { CentralCommandInput } from "./domain/commands.ts";

const valid: CentralCommandInput = {
  idempotencyKey: "key",
  hostId: "host",
  target: "session",
  actor: "operator",
  text: "instruction",
};

function fixture() {
  let entries = 0;
  const reachedRunner = new Error("transaction runner reached");
  const commands = new CentralCommands({} as SQL, undefined, async () => {
    entries++;
    throw reachedRunner;
  });
  return { commands, reachedRunner, entries: () => entries };
}

for (const mode of ["submit", "submitBounded"] as const) {
  for (const field of ["idempotencyKey", "hostId", "target", "actor", "text"] as const) {
    test(`${mode} rejects NUL in ${field} before entering the transaction`, async () => {
      const f = fixture();
      const input = { ...valid, [field]: `before\0after` };
      const error = await f.commands[mode](input).then(() => null, (reason: unknown) => reason);
      expect({ invalid: error instanceof CommandError && error.kind === "invalid", entries: f.entries() })
        .toEqual({ invalid: true, entries: 0 });
    });
  }

  test(`${mode} allows valid input to reach the transaction`, async () => {
    const f = fixture();
    await expect(f.commands[mode](valid)).rejects.toBe(f.reachedRunner);
    expect(f.entries()).toBe(1);
  });
}

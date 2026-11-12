import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { CentralCommands, type CentralCommand, type CentralCommandInput } from "./commands.ts";

function fixture(existing?: CentralCommand) {
  let release!: () => void;
  let locked!: () => void;
  const waiting = new Promise<void>((resolve) => { locked = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const lookups: unknown[] = [];
  const commands: CentralCommand[] = [];
  const eventActors: unknown[] = [];
  const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("FROM central_command_event_lock")) {
      locked();
      await gate;
      return [{ id: 1 }];
    }
    if (query.includes("FROM central_commands WHERE idempotency_key")) {
      lookups.push(values[0]);
      const found = existing?.idempotencyKey === values[0] ? existing : undefined;
      return found ? (query.includes("json_build_object") ? [{ command: found }] : [found]) : [];
    }
    if (query.includes("INSERT INTO central_commands")) {
      const [id, idempotencyKey, hostId, target, actor, text, createdAt, updatedAt] = values as string[];
      const command: CentralCommand = { id: id!, idempotencyKey: idempotencyKey!, hostId: hostId!, target: target!, actor: actor!, text: text!, status: "queued", createdAt: createdAt!, updatedAt: updatedAt! };
      commands.push(command);
      return [command];
    }
    if (query.includes("INSERT INTO central_command_events")) {
      eventActors.push(values[1]);
      return [];
    }
    throw new Error("Unexpected SQL: " + query);
  };
  const db = { begin: (operation: (connection: typeof tx) => unknown) => operation(tx) } as unknown as SQL;
  return { store: new CentralCommands(db, () => new Date("2026-01-01T00:00:00.000Z")), waiting, release, lookups, commands, eventActors };
}

const input = (): CentralCommandInput => ({ idempotencyKey: "key-original", hostId: "host-original", target: "session-original", actor: "actor-original", text: "  original instruction  " });
const mutate = (value: CentralCommandInput) => Object.assign(value, { idempotencyKey: "key-mutated", hostId: "host-mutated", target: "session-mutated", actor: "actor-mutated", text: "mutated instruction" });

for (const mode of ["submit", "submitBounded"] as const) {
  test(mode + " writes the validated input after the lock wait", async () => {
    const f = fixture();
    const value = input();
    const pending = f.store[mode](value);
    await f.waiting;
    mutate(value);
    f.release();
    const result = await pending;
    expect(result.created).toBe(true);
    expect(f.lookups).toEqual(["key-original"]);
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).toMatchObject({ idempotencyKey: "key-original", hostId: "host-original", target: "session-original", actor: "actor-original", text: "original instruction" });
    expect(f.eventActors).toEqual(["actor-original"]);
  });

  test(mode + " replays despite changes to non-key input fields", async () => {
    const original = input();
    const existing: CentralCommand = { ...original, text: original.text.trim(), id: "cmd-existing", status: "queued", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const f = fixture(existing);
    const pending = f.store[mode](original);
    await f.waiting;
    Object.assign(original, { hostId: "other-host", target: "other-session", actor: "other-actor", text: "other text" });
    f.release();
    expect(await pending).toEqual({ command: existing, created: false });
    expect(f.commands).toEqual([]);
    expect(f.eventActors).toEqual([]);
  });

  test(mode + " replays using the validated input after the lock wait", async () => {
    const original = input();
    const existing: CentralCommand = { ...original, text: original.text.trim(), id: "cmd-existing", status: "queued", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const f = fixture(existing);
    const pending = f.store[mode](original);
    await f.waiting;
    mutate(original);
    f.release();
    const result = await pending;
    expect(result).toEqual({ command: existing, created: false });
    expect(f.lookups).toEqual(["key-original"]);
    expect(f.commands).toEqual([]);
    expect(f.eventActors).toEqual([]);
  });
}

test("submitBounded replays an existing command with a previously accepted host", async () => {
  const original = { ...input(), hostId: " old-host " };
  const existing: CentralCommand = { ...original, text: original.text.trim(), id: "cmd-existing", status: "queued", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const f = fixture(existing);
  const pending = f.store.submitBounded(original);
  await f.waiting;
  f.release();
  expect(await pending).toEqual({ command: existing, created: false });
  expect(f.commands).toEqual([]);
  expect(f.eventActors).toEqual([]);
});

test("submitBounded reports a conflicting old host before validating a new host", async () => {
  const original = { ...input(), hostId: " old-host " };
  const existing: CentralCommand = { ...original, text: original.text.trim(), id: "cmd-existing", status: "queued", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const f = fixture(existing);
  const pending = f.store.submitBounded({ ...original, text: "different instruction" });
  await f.waiting;
  f.release();
  const error = await pending.then(() => null, (reason: unknown) => reason);
  expect(error).toMatchObject({ kind: "conflict" });
  expect(f.commands).toEqual([]);
  expect(f.eventActors).toEqual([]);
});

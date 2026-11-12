import { expect, test } from "bun:test";
import type { Command, Commands, CommandStatus } from "./commands.ts";
import { Deliverer } from "./delivery.ts";

for (const failure of ["mkdtemp", "write"] as const) {
  test(`setup failure is unknown and never sends or requeues`.replace("setup", failure), async () => {
    let command: Command = { id: "cmd-test", idempotencyKey: "key", target: "session", actor: "operator", text: "instruction", status: "queued", createdAt: "", updatedAt: "" };
    const events: { status: CommandStatus; detail: string }[] = [];
    const calls: string[] = [];
    const store = {
      get: () => command,
      transition: (_id: string, status: CommandStatus, _actor: string, detail: string) => {
        events.push({ status, detail });
        return command = { ...command, status };
      },
    };
    const io = {
      mkdtemp: async (_prefix: string) => { calls.push("mkdtemp"); if (failure === "mkdtemp") throw new Error("secret-token"); return "/fake/message-dir"; },
      write: async (_file: string, _content: string) => { calls.push("write"); if (failure === "write") throw new Error("secret-token"); },
      rm: async (_dir: string) => { calls.push("rm"); },
    };
    const deliverer = new Deliverer(store as unknown as Commands, async () => { calls.push("sender"); return { exitCode: 0, stdout: "session: delivered", stderr: "" }; }, io);
    expect((await deliverer.deliver(command.id)).status).toBe("delivery_unknown");
    expect((await deliverer.deliver(command.id)).status).toBe("delivery_unknown");
    expect(events.map(({ status }) => status)).toEqual(["delivering", "delivery_unknown"]);
    expect(events[1]?.detail).toBe("delivery setup failed");
    expect(JSON.stringify(events)).not.toContain("secret-token");
    expect(calls).toEqual(failure === "mkdtemp" ? ["mkdtemp"] : ["mkdtemp", "write", "rm"]);
  });
}

test("store transition failure propagates and still cleans up", async () => {
  const error = new Error("store failed");
  const calls: string[] = [];
  const command: Command = { id: "cmd-test", idempotencyKey: "key", target: "session", actor: "operator", text: "instruction", status: "queued", createdAt: "", updatedAt: "" };
  const store = {
    get: () => command,
    transition: (_id: string, status: CommandStatus) => { if (status === "delivery_unknown") throw error; return { ...command, status }; },
  };
  const io = {
    mkdtemp: async (_prefix: string) => "/fake/message-dir",
    write: async (_file: string, _content: string) => { throw new Error("setup failed"); },
    rm: async (_dir: string) => { calls.push("rm"); },
  };
  const deliverer = new Deliverer(store as unknown as Commands, async () => { throw new Error("unexpected sender"); }, io);
  await expect(deliverer.deliver(command.id)).rejects.toBe(error);
  expect(calls).toEqual(["rm"]);
});

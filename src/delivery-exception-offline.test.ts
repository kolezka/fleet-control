import { expect, test } from "bun:test";
import type { Command, Commands, CommandStatus } from "./commands.ts";
import { Deliverer, messageFor, type Sender } from "./delivery.ts";

function fixture(send: Sender) {
  let command: Command = {
    id: "cmd-test", idempotencyKey: "key", target: "session", actor: "operator",
    text: "test instruction", status: "queued", createdAt: "", updatedAt: "",
  };
  const events: { status: CommandStatus; detail: string }[] = [];
  const store = {
    get: () => command,
    transition: (_id: string, status: CommandStatus, _actor: string, detail: string) => {
      events.push({ status, detail });
      command = { ...command, status };
      return command;
    },
  };
  return { deliverer: new Deliverer(store as unknown as Commands, send), events, command: () => command };
}

test("sender exceptions are unknown and do not expose exception text", async () => {
  for (const message of ["not sent secret-token", "no session secret-token", "other secret-token"]) {
    let filePath = "";
    let target = "";
    let contents = "";
    const f = fixture(async (session, file) => {
      target = session;
      filePath = file;
      contents = await Bun.file(file).text();
      throw new Error(message);
    });
    expect((await f.deliverer.deliver("cmd-test")).status).toBe("delivery_unknown");
    expect(target).toBe("session");
    expect(contents).toBe(messageFor(f.command()));
    expect((await f.deliverer.deliver("cmd-test")).status).toBe("delivery_unknown");
    expect(f.events.map((event) => event.status)).toEqual(["delivering", "delivery_unknown"]);
    expect(JSON.stringify(f.events)).not.toContain("secret-token");
    expect(await Bun.file(filePath).exists()).toBe(false);
  }
});

test("a returned refusal remains queued", async () => {
  const f = fixture(async () => ({ exitCode: 4, stdout: "", stderr: "not sent" }));
  expect((await f.deliverer.deliver("cmd-test")).status).toBe("queued");
  expect(f.events.map((event) => event.status)).toEqual(["delivering", "queued"]);
});

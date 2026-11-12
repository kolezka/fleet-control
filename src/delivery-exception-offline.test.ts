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

test("unconfirmed sender results are unknown and never resent", async () => {
  const results = [
    { exitCode: 7, stdout: "", stderr: "paste-buffer failed, not sent" },
    { exitCode: 4, stdout: "", stderr: "arbitrary not sent" },
    { exitCode: 2, stdout: "", stderr: "no session session" },
    { exitCode: 0, stdout: "", stderr: "" },
    { exitCode: 1, stdout: "delivered", stderr: "failure" },
  ];
  for (const result of results) {
    let sends = 0;
    const f = fixture(async () => { sends++; return result; });
    expect((await f.deliverer.deliver("cmd-test")).status).toBe("delivery_unknown");
    expect((await f.deliverer.deliver("cmd-test")).status).toBe("delivery_unknown");
    expect(sends).toBe(1);
    expect(f.events.map((event) => event.status)).toEqual(["delivering", "delivery_unknown"]);
  }
});

test("confirmed sender result is delivered and never resent", async () => {
  let sends = 0;
  const f = fixture(async () => { sends++; return { exitCode: 0, stdout: "session: delivered", stderr: "" }; });
  expect((await f.deliverer.deliver("cmd-test")).status).toBe("delivered");
  expect((await f.deliverer.deliver("cmd-test")).status).toBe("delivered");
  expect(sends).toBe(1);
  expect(f.events.map((event) => event.status)).toEqual(["delivering", "delivered"]);
});

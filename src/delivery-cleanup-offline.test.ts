import { expect, test } from "bun:test";
import type { Command, Commands, CommandStatus } from "./commands.ts";
import { Deliverer, type SendResult } from "./delivery.ts";

for (const outcome of ["delivered", "delivery_unknown", "store failure"] as const) {
  for (const warningThrows of [false, true]) {
  test(`cleanup failure does not mask ${outcome} when warning ${warningThrows ? "throws" : "succeeds"}`, async () => {
    let command: Command = {
      id: "cmd-test", idempotencyKey: "key", target: "session", actor: "operator",
      text: "instruction", status: "queued", createdAt: "", updatedAt: "",
    };
    const events: { status: CommandStatus; detail: string }[] = [];
    const storeError = new Error("primary store failure");
    const cleanupSecret = "cleanup-secret-token";
    const calls: string[] = [];
    const diagnostics: unknown[][] = [];
    const store = {
      get: () => command,
      transition: (_id: string, status: CommandStatus, _actor: string, detail: string) => {
        if (outcome === "store failure" && status === "delivered") throw storeError;
        events.push({ status, detail });
        return command = { ...command, status };
      },
    };
    const io = {
      mkdtemp: async (_prefix: string) => "/fake/message-dir",
      write: async (_file: string, _content: string) => {},
      rm: async (_dir: string) => { calls.push("rm"); throw new Error(cleanupSecret); },
    };
    const send = async (): Promise<SendResult> => {
      calls.push("send");
      return outcome === "delivery_unknown"
        ? { exitCode: 7, stdout: "", stderr: "delivery uncertain" }
        : { exitCode: 0, stdout: "delivered", stderr: "" };
    };
    const deliverer = new Deliverer(store as unknown as Commands, send, io);
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      diagnostics.push(args);
      if (warningThrows) throw new Error("warning failure");
    };
    let result: PromiseSettledResult<Command>;
    try {
      result = await deliverer.deliver(command.id).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
      if (outcome !== "store failure" && result.status === "fulfilled") {
        expect((await deliverer.deliver(command.id)).status).toBe(outcome);
      }
    } finally {
      console.warn = originalWarn;
    }
    expect(calls).toEqual(["send", "rm"]);
    if (outcome === "store failure") {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBe(storeError);
    } else {
      expect(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") expect(result.value.status).toBe(outcome);
      expect(events.map((event) => event.status)).toEqual(["delivering", outcome]);
    }
    expect(diagnostics.length).toBe(1);
    expect(diagnostics).toEqual([["Delivery cleanup failed"]]);
    expect(JSON.stringify(diagnostics)).not.toContain(cleanupSecret);
    expect(JSON.stringify(diagnostics)).not.toContain("/fake/message-dir");
    expect(JSON.stringify(events)).not.toContain(cleanupSecret);
  });
  }
}

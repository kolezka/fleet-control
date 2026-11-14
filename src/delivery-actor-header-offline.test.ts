import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Commands } from "./data/commands.ts";
import { Deliverer } from "./delivery.ts";
import { messageFor } from "./domain/delivery.ts";

test("delivery escapes controls in actor headers without changing command text or confirmation", async () => {
  const db = new Database(":memory:");
  try {
    const commands = new Commands(db);
    const text = "First line\nSecond line\tunchanged";
    const { command } = commands.submit({ idempotencyKey: "key", target: "supervisor", actor: "normal actor", text });
    expect(messageFor(command)).toBe(`Fleet Control command ${command.id} from normal actor:\n\n${text}\n\nThis message is a delivery, not an approval. Accept or reject ${command.id} with the fleet-control command_respond tool before acting on it.\n`);
    const newlineHeader = messageFor({ ...command, actor: "\n" }).split("\n")[0];
    const literalHeader = messageFor({ ...command, actor: "\\u000a" }).split("\n")[0];
    expect(newlineHeader).toBe(`Fleet Control command ${command.id} from \\u000a:`);
    expect(literalHeader).toBe(`Fleet Control command ${command.id} from \\\\u000a:`);
    expect(literalHeader).not.toBe(newlineHeader);
    const controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("") + String.fromCharCode(127) + Array.from({ length: 32 }, (_, i) => String.fromCharCode(128 + i)).join("") + "\u2028\u2029";
    const escaped = [...controls].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const actor = `legacy${controls}actor`;
    db.query("UPDATE commands SET actor = ? WHERE id = ?").run(actor, command.id);
    let written = "";
    const deliverer = new Deliverer(commands, async (target) => {
      return { exitCode: 0, stdout: `${target}: delivered\n`, stderr: "" };
    }, { mkdtemp: async () => "/fake", write: async (_file, contents) => { written = contents; }, rm: async () => {} });
    const result = await deliverer.deliver(command.id);
    expect(written).toBe(`Fleet Control command ${command.id} from legacy${escaped}actor:\n\n${text}\n\nThis message is a delivery, not an approval. Accept or reject ${command.id} with the fleet-control command_respond tool before acting on it.\n`);
    expect(result.status).toBe("delivered");
    expect(result.actor).toBe(actor);
  } finally {
    db.close();
  }
});

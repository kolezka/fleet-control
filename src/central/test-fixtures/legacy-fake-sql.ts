// Test-only fake for the Bun SQL client used by the legacy central entry point (src/central/main.ts).
// It never opens a connection. It answers just enough of CentralCommands/CentralRequests/identity
// queries for startup and POST /api/commands, and holds the command insert for `delayMs` so a
// shutdown can race an in-flight transaction. Events are reported through `log`.
import type { SQL } from "bun";

export function createLegacyFakeSql(log: (event: string) => void, delayMs: number): SQL {
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("FROM central_command_event_lock") && text.includes("FOR UPDATE")) return [{ id: 1 }];
    if (text.includes("INSERT INTO central_commands")) {
      const [id, idempotencyKey, hostId, target, actor, commandText, , at] = values as string[];
      log(`tx begin ${idempotencyKey}`);
      await Bun.sleep(delayMs);
      return [{ id, idempotencyKey, hostId, target, actor, text: commandText, status: "queued", createdAt: at, updatedAt: at }];
    }
    return [];
  };
  let key = "";
  const sql = Object.assign(query, {
    begin: async (operation: (tx: typeof query) => Promise<unknown>) => {
      const tx = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join("?").includes("INSERT INTO central_commands")) key = String(values[1]);
        return query(strings, ...values);
      }, {});
      const result = await operation(tx);
      log(`tx commit ${key}`);
      return result;
    },
    close: async () => { log("sql close"); },
  });
  log("sql open");
  return sql as unknown as SQL;
}

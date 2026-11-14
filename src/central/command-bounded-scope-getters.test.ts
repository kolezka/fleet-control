import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { CentralCommands } from "./data/commands.ts";
import type { CommandListScope } from "./domain/commands.ts";

for (const field of ["hostId", "target"] as const) {
  test(`listBounded uses the validated ${field} when its getter changes`, async () => {
    const queries: unknown[][] = [];
    const db = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(values);
      return [];
    }) as unknown as SQL;
    let reads = 0;
    const scope: CommandListScope = {
      get [field]() {
        reads++;
        return reads <= 2 ? "validated" : undefined;
      },
    };

    await new CentralCommands(db).listBounded(undefined, scope);

    expect(queries).toHaveLength(1);
    const offset = field === "hostId" ? 0 : 2;
    expect(queries[0]!.slice(offset, offset + 2)).toEqual(["validated", "validated"]);
  });
}

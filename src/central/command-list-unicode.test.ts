import { expect, test } from "bun:test";
import type { SQL, TransactionSQL } from "bun";
import { CentralCommands } from "./commands.ts";
import type { CooperativeTransactionRunner } from "./incarnations.ts";

for (const method of ["list", "listBounded"] as const) {
  for (const field of ["hostId", "target"] as const) {
    for (const malformed of ["host-\ud800", "host-\udc00"]) {
      test(`${method} rejects malformed ${field} before the list query (${malformed.charCodeAt(5).toString(16)})`, async () => {
        const queries: unknown[][] = [];
        const tx = (async (_parts: TemplateStringsArray, ...values: unknown[]) => {
          queries.push(values);
          return [];
        }) as unknown as TransactionSQL;
        const runner: CooperativeTransactionRunner = (operation) => operation(tx);
        const store = new CentralCommands({} as SQL, undefined, runner);

        await expect(store[method](undefined, { [field]: malformed })).rejects.toThrow("invalid scope");
        expect(queries).toEqual([]);
      });
    }

    test(`${method} accepts literal replacement character in ${field}`, async () => {
      const queries: unknown[][] = [];
      const tx = (async (_parts: TemplateStringsArray, ...values: unknown[]) => {
        queries.push(values);
        return [];
      }) as unknown as TransactionSQL;
      const runner: CooperativeTransactionRunner = (operation) => operation(tx);
      const store = new CentralCommands({} as SQL, undefined, runner);
      const value = "host-\ufffd";

      expect(await store[method](undefined, { [field]: value })).toEqual({ commands: [], nextCursor: null });
      const position = field === "hostId" ? 0 : 2;
      expect(queries[0]?.slice(position, position + 2)).toEqual([value, value]);
      expect(Buffer.from(value, "utf8").toString("hex")).toBe("686f73742defbfbd");
      expect(Buffer.from("host-\ud800", "utf8").toString("hex")).toBe(Buffer.from(value, "utf8").toString("hex"));
    });
  }
}

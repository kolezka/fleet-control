import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CommandError } from "../../data/commands.ts";
import { CooperativeInspection } from "./cooperative-inspection.ts";

for (const method of ["inspect", "inspectBounded"] as const) {
  for (const [description, id] of [
    ["unpaired high surrogate", "cmd-\ud800"],
    ["unpaired low surrogate", "cmd-\udc00"],
    ["misordered surrogates", "cmd-\udc00\ud800"],
  ] as const) {
    test(`${method} rejects ${description} before the runner`, async () => {
      let runnerCalls = 0;
      const inspection = new CooperativeInspection({} as SQL, async () => {
        runnerCalls++;
        throw new Error("runner must not be called");
      });
      const promise = method === "inspect" ? inspection.inspect(id) : inspection.inspectBounded(id, { limit: 1 });
      const error = await promise.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).kind).toBe("invalid");
      expect(runnerCalls).toBe(0);
    });
  }

  test(`${method} passes a valid supplementary ID to the runner`, async () => {
    const id = "cmd-\ud83d\ude80";
    let runnerCalls = 0;
    let queriedId: unknown;
    const db = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
      queriedId = values[2];
      return Promise.resolve([]);
    }) as unknown as TransactionSQL;
    const inspection = new CooperativeInspection({} as SQL, async (operation) => {
      runnerCalls++;
      return operation(db);
    });
    const result = method === "inspect" ? await inspection.inspect(id) : await inspection.inspectBounded(id, { limit: 1 });
    expect(result).toBeNull();
    expect(runnerCalls).toBe(1);
    expect(queriedId).toBe(id);
  });
}

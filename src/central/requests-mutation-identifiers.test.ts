import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { RequestError } from "../requests.ts";
import { CentralRequests } from "./requests.ts";

const methods = ["registerRun", "updatePhase", "create", "resolve", "acknowledge", "withdraw"] as const;
type Method = typeof methods[number];

function fixture() {
  let begins = 0;
  let queries = 0;
  const reachedBegin = new Error("reached begin");
  const sql = Object.assign(async () => { queries++; throw new Error("unexpected SQL"); }, {
    begin: async () => { begins++; throw reachedBegin; },
  });
  return { store: new CentralRequests(sql as unknown as SQL), counts: () => ({ begins, queries }), reachedBegin };
}

function mutate(store: CentralRequests, method: Method, id: string): Promise<unknown> {
  switch (method) {
    case "registerRun": return store.registerRun({ runId: id, orchestrator: "owner", phase: "plan" });
    case "updatePhase": return store.updatePhase({ runId: id, actor: "owner", expectedRevision: 1, phaseStatus: "planned", newRevision: false });
    case "create": return store.create({ runId: id, origin: "owner", expectedRevision: 1, kind: "approval", question: "Proceed?" });
    case "resolve": return store.resolve({ requestId: id, actor: "operator", response: "approve", expectedRevision: 1 });
    case "acknowledge": return store.acknowledge({ requestId: id, actor: "owner" });
    case "withdraw": return store.withdraw({ requestId: id, actor: "owner", reason: "no longer needed" });
  }
}

for (const method of methods) {
  for (const [name, id] of [["NUL", "a\0b"], ["unpaired high surrogate", "a\ud800b"], ["unpaired low surrogate", "a\udc00b"]] as const) {
    test(`${method} rejects identifier with ${name} before transaction or SQL`, async () => {
      const f = fixture();
      let error: unknown;
      try { await mutate(f.store, method, id); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).kind).toBe("invalid");
      expect(f.counts()).toEqual({ begins: 0, queries: 0 });
    });
  }

  for (const [name, id] of [["replacement character", "a\ufffdb"], ["supplementary character", "a\ud83d\ude00b"]] as const) {
    test(`${method} allows identifier with ${name} to reach transaction`, async () => {
      const f = fixture();
      await expect(mutate(f.store, method, id)).rejects.toBe(f.reachedBegin);
      expect(f.counts()).toEqual({ begins: 1, queries: 0 });
    });
  }
}

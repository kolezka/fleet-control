import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralRequests } from "./requests.ts";

const base = { runId: "run", origin: "owner", expectedRevision: 1, kind: "approval" as const, question: "Proceed?" };

// This fake captures parameters and decodes the returned row, not PostgreSQL behavior.
function fixture() {
  const inserts: unknown[][] = [];
  let row: Record<string, unknown> | undefined;
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    if (query.includes("FROM central_request_event_lock")) return [{ id: 1 }];
    if (query.includes("FROM central_runs")) return [{ id: "run", orchestrator: "owner", phase: "plan", revision: 1 }];
    if (query.includes("INSERT INTO central_requests (")) {
      inserts.push(values);
      const [id, runId, phase, revision, kind, question, proposedAction, scope, evidence, allowedResponses, blocking, origin, createdAt] = values;
      row = { id, runId, phase, revision, kind, question, proposedAction, scope, evidence, allowedResponses, blocking, origin, status: "open", createdAt };
      return [];
    }
    if (query.includes("INSERT INTO central_request_events")) return [];
    if (query.includes("FROM central_requests")) return row ? [row] : [];
    throw new Error("Unexpected SQL: " + query);
  };
  const db = Object.assign(sql, { begin: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) });
  return { store: new CentralRequests(db as unknown as SQL), inserts };
}

for (const field of ["evidence", "allowedResponses"] as const) {
  test("create reads " + field + " once in source order", async () => {
    const order: string[] = [];
    let reads = 0;
    const input = {
      get runId() { order.push("runId"); return base.runId; },
      get origin() { order.push("origin"); return base.origin; },
      get expectedRevision() { order.push("expectedRevision"); return base.expectedRevision; },
      get kind() { order.push("kind"); return base.kind; },
      get question() { order.push("question"); return base.question; },
      get proposedAction() { order.push("proposedAction"); return undefined; },
      get scope() { order.push("scope"); return undefined; },
      get evidence() { order.push("evidence"); return field === "evidence" && ++reads > 1 ? ["changed"] : ["original"]; },
      get allowedResponses() { order.push("allowedResponses"); return field === "allowedResponses" && ++reads > 1 ? ["changed"] : ["original"]; },
      get blocking() { order.push("blocking"); return true; },
    };
    const f = fixture();
    const result = await f.store.create(input);
    expect(reads).toBe(1);
    expect(order).toEqual(["runId", "origin", "expectedRevision", "kind", "question", "proposedAction", "scope", "evidence", "allowedResponses", "blocking"]);
    expect(result[field]).toEqual(["original"]);
    expect(f.inserts[0]?.[field === "evidence" ? 8 : 9]).toBe('["original"]');
  });

  test("create snapshots initial " + field + " length when an index appends", async () => {
    const values = ["original"];
    Object.defineProperty(values, 0, { get() { values.push("appended"); return "original"; } });
    const f = fixture();
    const result = await f.store.create({ ...base, [field]: values });
    expect(values.length).toBe(2);
    expect(result[field]).toEqual(["original"]);
    expect(f.inserts[0]?.[field === "evidence" ? 8 : 9]).toBe('["original"]');
  });
}

class SerializedObjectArray extends Array<string> {
  toJSON() { return { unexpected: true }; }
}

for (const field of ["evidence", "allowedResponses"] as const) {
  for (const [name, makeArray] of [
    ["ordinary dense array", () => ["first", "second"]],
    ["dense subclass with inherited toJSON", () => new SerializedObjectArray("first", "second")],
  ] as const) {
    test("create preserves indexed " + field + " values for " + name, async () => {
      const values = makeArray();
      expect(Array.isArray(values)).toBe(true);
      expect([values[0], values[1]]).toEqual(["first", "second"]);
      const f = fixture();
      const result = await f.store.create({ ...base, [field]: values });
      expect(f.inserts).toHaveLength(1);
      const stored = JSON.parse(f.inserts[0]![field === "evidence" ? 8 : 9] as string);
      expect(stored).toEqual(["first", "second"]);
      expect(result[field]).toEqual(["first", "second"]);
    });
  }
}

for (const field of ["evidence", "allowedResponses"] as const) {
  test("ignores overridden slice and species for " + field, async () => {
    class HostileArray extends Array<string> {
      static override get [Symbol.species](): ArrayConstructor { throw new Error("species called"); }
      override slice(): string[] { throw new Error("slice called"); }
    }
    const f = fixture();
    const result = await f.store.create({ ...base, [field]: new HostileArray("first", "second") });
    expect(result[field]).toEqual(["first", "second"]);
  });

  test("rejects sparse " + field + " after authorization", async () => {
    const f = fixture();
    let guarded = false;
    const sparse = new Array<string>(2);
    sparse[1] = "value";
    await expect(f.store.create({ ...base, [field]: sparse }, async () => { guarded = true; })).rejects.toMatchObject({ kind: "invalid" });
    expect(guarded).toBe(true);
    expect(f.inserts).toHaveLength(0);
  });

  test("stops reading large sparse " + field + " at the first invalid index", async () => {
    const sparse = new Array<string>(1_000_000);
    sparse[0] = "valid";
    let reads = 0;
    const values = new Proxy(sparse, { get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        if (++reads > 10) throw new Error("snapshot did not stop");
      }
      return Reflect.get(target, key, receiver);
    } });
    const f = fixture();
    let guarded = false;
    await expect(f.store.create({ ...base, [field]: values }, async () => { guarded = true; })).rejects.toMatchObject({ kind: "invalid", message: "invalid request encoding" });
    expect(guarded).toBe(true);
    expect(reads).toBe(2);
    expect(f.inserts).toHaveLength(0);
  });

  test("snapshots " + field + " before awaiting guard", async () => {
    const f = fixture();
    const values = ["before"];
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const pending = f.store.create({ ...base, [field]: values }, async () => { await wait; });
    values[0] = "after";
    values.push("added");
    release();
    const result = await pending;
    expect(result[field]).toEqual(["before"]);
  });
}

test("global Array.prototype.toJSON cannot replace inputs or defaults", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
  let dense: Awaited<ReturnType<CentralRequests["create"]>>;
  let defaults: Awaited<ReturnType<CentralRequests["create"]>>;
  try {
    Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: () => ({ unexpected: true }) });
    dense = await fixture().store.create({ ...base, evidence: ["proof"], allowedResponses: ["yes"] });
    defaults = await fixture().store.create({ ...base });
  } finally {
    if (descriptor) Object.defineProperty(Array.prototype, "toJSON", descriptor);
    else Reflect.deleteProperty(Array.prototype, "toJSON");
  }
  expect(dense.evidence).toEqual(["proof"]);
  expect(dense.allowedResponses).toEqual(["yes"]);
  expect(defaults.evidence).toEqual([]);
  expect(defaults.allowedResponses).toEqual(["approve", "decline"]);
});

test("guard, owner and revision errors precede invalid array encoding", async () => {
  const sparse = new Array<string>(1);
  const guardError = new Error("guard refused");
  await expect(fixture().store.create({ ...base, evidence: sparse }, async () => { throw guardError; })).rejects.toBe(guardError);
  await expect(fixture().store.create({ ...base, origin: "intruder", evidence: sparse })).rejects.toMatchObject({ kind: "forbidden" });
  await expect(fixture().store.create({ ...base, expectedRevision: 2, evidence: sparse })).rejects.toMatchObject({ kind: "conflict" });
});

for (const field of ["evidence", "allowedResponses"] as const) {
  for (const [name, value] of [["string", "abc"], ["number", 1], ["false", false], ["zero", 0], ["empty string", ""], ["object", { 0: "x", length: 1 }], ["hostile object", new Proxy({}, { get() { throw new Error("property read"); } })]] as const) {
    test("rejects non-array " + field + " " + name + " after precedence checks", async () => {
      const input = { ...base, [field]: value } as unknown as Parameters<CentralRequests["create"]>[0];
      const f = fixture();
      const guardError = new Error("guard refused");
      await expect(f.store.create(input, async () => { throw guardError; })).rejects.toBe(guardError);
      await expect(f.store.create({ ...input, origin: "intruder" })).rejects.toMatchObject({ kind: "forbidden" });
      await expect(f.store.create({ ...input, expectedRevision: 2 })).rejects.toMatchObject({ kind: "conflict" });
      await expect(f.store.create({ ...input, kind: "bad" as typeof base.kind })).rejects.toMatchObject({ kind: "invalid", message: "invalid request kind" });
      let guarded = false;
      await expect(f.store.create(input, async () => { guarded = true; })).rejects.toMatchObject({ kind: "invalid", message: "invalid request encoding" });
      expect(guarded).toBe(true);
      expect(f.inserts).toHaveLength(0);
    });
  }
  test("nullish and empty " + field + " retain defaults", async () => {
    for (const value of [undefined, null, []]) {
      const f = fixture();
      const input = { ...base, [field]: value } as unknown as Parameters<CentralRequests["create"]>[0];
      const result = await f.store.create(input);
      expect(result[field]).toEqual(field === "evidence" ? [] : ["approve", "decline"]);
    }
  });
}

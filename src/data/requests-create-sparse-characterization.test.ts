import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { RequestError, Requests } from "./requests.ts";

function fixture() {
  const db = new Database(":memory:", { strict: true });
  const requests = new Requests(db);
  requests.registerRun({ runId: "run", orchestrator: "owner", phase: "review" });
  const input = { runId: "run", origin: "owner", expectedRevision: 1, kind: "approval" as const, question: "Proceed?" };
  const snapshot = () => ({ requests: db.query("SELECT * FROM requests").all(), events: requests.events() });
  return { db, requests, input, snapshot };
}

function expectError(fn: () => unknown, kind: RequestError["kind"]) {
  try { fn(); throw new Error("expected RequestError"); } catch (error) {
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe(kind);
  }
}

test("invalid serialized allowed responses are rejected without writes after authorization", () => {
  const f = fixture();
  try {
    const before = f.snapshot();
    const sparse = new Array<string>(2); sparse[1] = "present";
    const replacement = ["original"];
    Object.defineProperty(replacement, "toJSON", { value: () => sparse });
    const nonArray = ["original"];
    Object.defineProperty(nonArray, "toJSON", { value: () => ({ response: "yes" }) });
    const badString = ["original"];
    Object.defineProperty(badString, "toJSON", { value: () => ["\ud800"] });
    for (const allowedResponses of [sparse, replacement, nonArray, badString, ["\udfff"], [null] as unknown as string[]]) {
      expectError(() => f.requests.create({ ...f.input, allowedResponses, origin: "other", expectedRevision: 2 }), "forbidden");
      expectError(() => f.requests.create({ ...f.input, allowedResponses, expectedRevision: 2 }), "conflict");
      expectError(() => f.requests.create({ ...f.input, allowedResponses }), "invalid");
      expect(f.snapshot()).toEqual(before);
    }
    let accesses = 0;
    for (const override of [{ origin: "other" }, { expectedRevision: 2 }]) {
      const input = { ...f.input, ...override, get allowedResponses(): string[] { accesses++; throw new Error("accessed"); } };
      expectError(() => f.requests.create(input), override.origin ? "forbidden" : "conflict");
    }
    expect(accesses).toBe(0);
    expect(f.snapshot()).toEqual(before);
  } finally { f.db.close(); }
});

test("valid toJSON snapshot and defaults preserve serialization and getter order", () => {
  const f = fixture();
  try {
    const order: string[] = [];
    const values = ["original"];
    Object.defineProperty(values, "toJSON", { value: () => { order.push("toJSON"); return ["", "yes 😀 �"]; } });
    const created = f.requests.create({ ...f.input,
      get allowedResponses() { order.push("allowed"); return values; },
      get evidence() { order.push("evidence"); return ["proof"]; },
      get blocking() { order.push("blocking"); return true; },
    });
    expect(order).toEqual(["allowed", "allowed", "evidence", "toJSON", "blocking"]);
    expect(created.allowedResponses).toEqual(["", "yes 😀 �"]);
    expect(f.db.query("SELECT allowed_responses FROM requests WHERE id = ?").get(created.id)).toEqual({ allowed_responses: '["","yes 😀 �"]' });
    expect(f.requests.get(created.id)).toEqual(created);
    for (const allowedResponses of [undefined, [], null] as (string[] | undefined)[]) {
      expect(f.requests.create({ ...f.input, allowedResponses }).allowedResponses).toEqual(["approve", "decline"]);
      expect(f.requests.create({ ...f.input, kind: "clarification", allowedResponses }).allowedResponses).toEqual(["answer"]);
    }
  } finally { f.db.close(); }
});

test("historic malformed allowed responses remain readable and replayable", () => {
  const f = fixture();
  try {
    const opened = f.requests.create(f.input);
    const resolution = { requestId: opened.id, actor: "human", response: "approve", expectedRevision: 1 };
    f.requests.resolve(resolution);
    f.db.query("UPDATE requests SET allowed_responses = ? WHERE id = ?").run('[null,"\\ud800"]', opened.id);
    const before = f.snapshot();
    expect(f.requests.get(opened.id).allowedResponses as unknown).toEqual([null, "\ud800"]);
    expect(f.requests.list({ runId: "run" })[0]!.allowedResponses as unknown).toEqual([null, "\ud800"]);
    expect(f.requests.resolve(resolution).allowedResponses as unknown).toEqual([null, "\ud800"]);
    expect(f.snapshot()).toEqual(before);
  } finally { f.db.close(); }
});

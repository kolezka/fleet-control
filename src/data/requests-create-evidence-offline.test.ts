import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Requests } from "./requests.ts";
import { RequestError } from "../domain/requests.ts";
import { handleMcp } from "../mcp.ts";

function fixture() {
  const db = new Database(":memory:", { strict: true });
  const requests = new Requests(db);
  requests.registerRun({ runId: "run", orchestrator: "owner", phase: "review" });
  const input = { runId: "run", origin: "owner", expectedRevision: 1, kind: "approval" as const, question: "Proceed?" };
  const snapshot = () => ({ requests: db.query("SELECT * FROM requests").all(), events: requests.events() });
  return { db, requests, input, snapshot };
}

function invalid(fn: () => unknown, kind: RequestError["kind"]) {
  try { fn(); throw new Error("expected RequestError"); } catch (error) {
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe(kind);
  }
}

test("new evidence validates the actual serialized values after authorization", () => {
  const f = fixture();
  try {
    const before = f.snapshot();
    const sparse = new Array<string>(1);
    const replaced = ["good"];
    Object.defineProperty(replaced, "toJSON", { value: () => ["\ud800"] });
    for (const evidence of [["\ud800"], ["\udc00"], sparse, replaced, [null] as unknown as string[]]) {
      invalid(() => f.requests.create({ ...f.input, evidence, origin: "other", expectedRevision: 2 }), "forbidden");
      invalid(() => f.requests.create({ ...f.input, evidence, expectedRevision: 2 }), "conflict");
      invalid(() => f.requests.create({ ...f.input, evidence }), "invalid");
      expect(f.snapshot()).toEqual(before);
    }
    let accesses = 0;
    for (const override of [{ origin: "other" }, { expectedRevision: 2 }]) {
      const guarded = { ...f.input, ...override, get evidence(): string[] { accesses++; throw new Error("evidence accessed"); } };
      invalid(() => f.requests.create(guarded), override.origin ? "forbidden" : "conflict");
    }
    expect(accesses).toBe(0);
    expect(f.snapshot()).toEqual(before);
    const evidence = ["original"];
    let calls = 0;
    Object.defineProperty(evidence, "toJSON", { value: () => { calls++; return ["", "proof 😀 �"]; } });
    const created = f.requests.create({ ...f.input, evidence });
    expect(calls).toBe(1);
    expect(created.evidence).toEqual(["", "proof 😀 �"]);
    expect(f.requests.get(created.id)).toEqual(created);
    expect(f.db.query("SELECT evidence FROM requests WHERE id = ?").get(created.id)).toEqual({ evidence: JSON.stringify(["", "proof 😀 �"]) });
    for (const value of [undefined, null]) {
      const defaulted = f.requests.create({ ...f.input, evidence: value as string[] | undefined });
      expect(defaulted.evidence).toEqual([]);
      expect(f.requests.get(defaulted.id).evidence).toEqual([]);
    }
  } finally { f.db.close(); }
});

test("exact local MCP JSON call rejects malformed evidence and accepts clean control", async () => {
  const f = fixture();
  try {
    const send = async (evidence: string[]) => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_create", arguments: { ...f.input, evidence } } });
      const response = await handleMcp(new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "localhost" }, body }), { commands: {} as never, deliverer: {} as never, requests: f.requests }, ["localhost"], "owner");
      expect(response.status).toBe(200);
      return await response.json();
    };
    const before = f.snapshot();
    const bad = await send(["\ud800"]);
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toBe("invalid: invalid request evidence");
    expect(f.snapshot()).toEqual(before);
    const good = await send(["proof 😀 �"]);
    expect(good.result.isError).not.toBe(true);
    const result = JSON.parse(good.result.content[0].text);
    expect(result.request.evidence).toEqual(["proof 😀 �"]);
    expect(f.requests.get(result.request.id).evidence).toEqual(["proof 😀 �"]);
  } finally { f.db.close(); }
});

test("historic malformed evidence remains readable and exact resolution replays", () => {
  const f = fixture();
  try {
    const r = f.requests.create(f.input);
    f.requests.resolve({ requestId: r.id, actor: "human", response: "approve", expectedRevision: 1 });
    f.db.query("UPDATE requests SET evidence = ? WHERE id = ?").run('[null,"\\ud800"]', r.id);
    const before = f.snapshot();
    expect(f.requests.get(r.id).evidence as unknown).toEqual([null, "\ud800"]);
    expect(f.requests.resolve({ requestId: r.id, actor: "human", response: "approve", expectedRevision: 1 }).evidence as unknown).toEqual([null, "\ud800"]);
    expect(f.snapshot()).toEqual(before);
  } finally { f.db.close(); }
});

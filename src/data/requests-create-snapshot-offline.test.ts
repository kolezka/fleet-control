import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Requests } from "./requests.ts";
import { RequestError } from "../domain/requests.ts";

function fixture() {
  const db = new Database(":memory:", { strict: true });
  const requests = new Requests(db, () => new Date("2026-01-01T00:00:00Z"));
  requests.registerRun({ runId: "run", orchestrator: "owner", phase: "review" });
  const input = { runId: "run", origin: "owner", expectedRevision: 1, kind: "approval" as const, question: "Proceed?" };
  const snapshot = () => ({ runs: db.query("SELECT * FROM runs ORDER BY id").all(), requests: db.query("SELECT * FROM requests ORDER BY id").all(), events: db.query("SELECT * FROM request_events ORDER BY seq").all() });
  const opened = () => requests.events().filter((event) => event.kind === "opened");
  return { db, requests, input, snapshot, opened };
}

test("owner can create an approval with consistent defaults and audit", () => {
  const f = fixture();
  try {
    const created = f.requests.create(f.input);
    expect(created.origin).toBe("owner");
    expect(created.kind).toBe("approval");
    expect(created.allowedResponses).toEqual(["approve", "decline"]);
    expect(f.requests.get(created.id)).toEqual(created);
    expect(f.opened()).toMatchObject([{ requestId: created.id, actor: "owner", detail: "approval for review r1" }]);
  } finally { f.db.close(); }
});

test("non-owner cannot create a request or change state", () => {
  const f = fixture();
  try {
    const before = f.snapshot();
    let error: unknown;
    try { f.requests.create({ ...f.input, origin: "intruder" }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe("forbidden");
    expect(f.snapshot()).toEqual(before);
  } finally { f.db.close(); }
});

test("creation stores and audits the origin authorized from a mutable getter", () => {
  const f = fixture();
  try {
    let reads = 0;
    const input = { ...f.input, get origin() { return ++reads === 1 ? "owner" : "intruder"; } };
    const created = f.requests.create(input);
    expect(created.origin).toBe("owner");
    expect(f.requests.get(created.id).origin).toBe("owner");
    expect(f.opened()).toMatchObject([{ requestId: created.id, actor: "owner" }]);
  } finally { f.db.close(); }
});

test("creation audits the authorized origin when only later reads change", () => {
  const f = fixture();
  try {
    let reads = 0;
    const input = { ...f.input, get origin() { return ++reads <= 2 ? "owner" : "intruder"; } };
    const created = f.requests.create(input);
    expect(created.origin).toBe("owner");
    expect(f.opened()).toMatchObject([{ requestId: created.id, actor: "owner" }]);
  } finally { f.db.close(); }
});

test("creation uses one kind for defaults, storage and audit", () => {
  const f = fixture();
  try {
    let reads = 0;
    const input = { ...f.input, get kind(): "approval" | "clarification" { return ++reads === 1 ? "approval" : "clarification"; } };
    const created = f.requests.create(input);
    expect(created.allowedResponses).toEqual(["approve", "decline"]);
    expect(created.kind).toBe("approval");
    expect(f.requests.get(created.id).kind).toBe("approval");
    expect(f.opened()).toMatchObject([{ requestId: created.id, detail: "approval for review r1" }]);
  } finally { f.db.close(); }
});

test("creation audits the same kind even when only later reads change", () => {
  const f = fixture();
  try {
    let reads = 0;
    const input = { ...f.input, get kind(): "approval" | "clarification" { return ++reads <= 2 ? "approval" : "clarification"; } };
    const created = f.requests.create(input);
    expect(created.kind).toBe("approval");
    expect(created.allowedResponses).toEqual(["approve", "decline"]);
    expect(f.opened()).toMatchObject([{ requestId: created.id, detail: "approval for review r1" }]);
  } finally { f.db.close(); }
});

test("forbidden mutable origin cannot write even if later reads become owner", () => {
  const f = fixture();
  try {
    const before = f.snapshot();
    let reads = 0;
    const input = { ...f.input, get origin() { return ++reads === 1 ? "intruder" : "owner"; } };
    let error: unknown;
    try { f.requests.create(input); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe("forbidden");
    expect(f.snapshot()).toEqual(before);
  } finally { f.db.close(); }
});

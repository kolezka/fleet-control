import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Requests } from "./requests";
import { RequestError } from "../domain/requests.ts";

function fixture() {
  const db = new Database(":memory:");
  const requests = new Requests(db);
  requests.registerRun({ runId: "run", orchestrator: "owner", phase: "review" });
  const request = requests.create({ runId: "run", origin: "owner", expectedRevision: 1, kind: "approval", question: "Proceed?" });
  const snapshot = () => ({ requests: db.query("SELECT * FROM requests ORDER BY id").all(), events: db.query("SELECT * FROM request_events ORDER BY seq").all(), runs: db.query("SELECT * FROM runs ORDER BY id").all() });
  return { db, requests, request, snapshot };
}

function expectKind(action: () => unknown, kind: RequestError["kind"]) {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(RequestError);
  expect((error as RequestError).kind).toBe(kind);
}

test("withdraw rejects malformed UTF-16 reasons without writing", () => {
  for (const reason of ["bad\ud800", "bad\udc00", "bad\udc00\ud800"]) {
    const f = fixture();
    try {
      const before = f.snapshot();
      expectKind(() => f.requests.withdraw({ requestId: f.request.id, actor: "owner", reason }), "invalid");
      expect(f.snapshot()).toEqual(before);
    } finally { f.db.close(); }
  }
});

test("withdraw preserves missing, forbidden and status precedence", () => {
  const f = fixture();
  try {
    const reason = "bad\ud800";
    const before = f.snapshot();
    expectKind(() => f.requests.withdraw({ requestId: "missing", actor: "owner", reason }), "not_found");
    expectKind(() => f.requests.withdraw({ requestId: f.request.id, actor: "other", reason }), "forbidden");
    expect(f.snapshot()).toEqual(before);
    f.requests.withdraw({ requestId: f.request.id, actor: "owner", reason: "done" });
    const withdrawn = f.snapshot();
    expectKind(() => f.requests.withdraw({ requestId: f.request.id, actor: "owner", reason }), "conflict");
    expect(f.snapshot()).toEqual(withdrawn);
  } finally { f.db.close(); }
});

test("withdraw records valid Unicode and reads the reason once", () => {
  const f = fixture();
  try {
    let reads = 0;
    const input = { requestId: f.request.id, actor: "owner", get reason() { return ++reads === 1 ? "  � 😀  " : "bad\ud800"; } };
    expect(f.requests.withdraw(input).status).toBe("withdrawn");
    expect(reads).toBe(1);
    expect(f.requests.events().find((event) => event.kind === "withdrawn")?.detail).toBe("� 😀");
  } finally { f.db.close(); }
});

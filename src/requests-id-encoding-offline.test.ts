import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { RequestError, Requests } from "./requests.ts";

function fixture(id = "historical-�") {
  const db = new Database(":memory:");
  const requests = new Requests(db);
  requests.registerRun({ runId: "run", orchestrator: "owner", phase: "plan" });
  const request = requests.create({ runId: "run", origin: "owner", expectedRevision: 1, kind: "approval", question: "Proceed?" });
  db.query("UPDATE requests SET id = ? WHERE id = ?").run(id, request.id);
  const snapshot = () => ({ rows: db.query("SELECT * FROM requests").all(), events: requests.events() });
  return { db, requests, snapshot };
}

function expectKind(action: () => unknown, kind: RequestError["kind"]) {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(RequestError);
  expect((error as RequestError).kind).toBe(kind);
}

for (const alias of ["historical-\ud800", "historical-\udc00"]) {
  test("malformed request ID cannot look up a replacement-character ID", () => {
    const f = fixture();
    try {
      expectKind(() => f.requests.get(alias), "invalid");
      expect(f.requests.get("historical-�").id).toBe("historical-�");
    } finally { f.db.close(); }
  });

  test("malformed request ID cannot mutate a replacement-character ID", () => {
    const f = fixture();
    try {
      const before = f.snapshot();
      expectKind(() => f.requests.resolve({ requestId: alias, actor: "human", response: "approve", expectedRevision: 1 }), "invalid");
      expectKind(() => f.requests.withdraw({ requestId: alias, actor: "owner", reason: "done" }), "invalid");
      expectKind(() => f.requests.acknowledge({ requestId: alias, actor: "owner" }), "invalid");
      expect(f.snapshot()).toEqual(before);
      expect(f.requests.resolve({ requestId: "historical-�", actor: "human", response: "approve", expectedRevision: 1 }).status).toBe("resolved");
    } finally { f.db.close(); }
  });
}

test("well-formed historical IDs and lookup precedence are preserved", () => {
  for (const id of ["", " historical ", "legacy-😀", "legacy-�"]) {
    const f = fixture(id);
    try {
      expect(f.requests.get(id).id).toBe(id);
      expectKind(() => f.requests.resolve({ requestId: "missing", actor: "", response: "bad", expectedRevision: 0 }), "not_found");
      expectKind(() => f.requests.withdraw({ requestId: "missing", actor: "wrong", reason: "\ud800" }), "not_found");
      expectKind(() => f.requests.acknowledge({ requestId: "missing", actor: "wrong" }), "not_found");
    } finally { f.db.close(); }
  }
});

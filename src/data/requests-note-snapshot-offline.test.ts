import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Requests } from "./requests";

function fixture() {
  const db = new Database(":memory:");
  const requests = new Requests(db);
  requests.registerRun({ runId: "run", orchestrator: "supervisor", phase: "review" });
  const request = requests.create({ runId: "run", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "Proceed?" });
  return { db, requests, request };
}

test("open resolution stores and audits the same note snapshot", () => {
  const { db, requests, request } = fixture();
  try {
    let reads = 0;
    const input = { requestId: request.id, actor: "human", expectedRevision: 1, response: "approve", get note() { return ++reads === 1 ? "first" : "later"; } };
    expect(requests.resolve(input).resolutionNote).toBe("first");
    expect(requests.get(request.id).resolutionNote).toBe("first");
    expect(requests.events().filter((event) => event.requestId === request.id && event.kind === "resolved").map((event) => event.detail)).toEqual(["approve: first"]);
    expect(reads).toBe(1);
  } finally { db.close(); }
});

test("stable and absent notes persist with matching audit details", () => {
  for (const note of ["yes", "", undefined]) {
    const { db, requests, request } = fixture();
    try {
      const input = { requestId: request.id, actor: "human", expectedRevision: 1, response: "approve", note };
      const resolved = requests.resolve(input);
      expect(resolved.resolutionNote).toBe(note ?? "");
      expect(requests.resolve(input)).toEqual(resolved);
      expect(requests.events().filter((event) => event.requestId === request.id && event.kind === "resolved").map((event) => event.detail)).toEqual([note ? `approve: ${note}` : "approve"]);
    } finally { db.close(); }
  }
});

test("lookup, actor, status, revision and response errors precede note access", () => {
  const { db, requests, request } = fixture();
  try {
    const input = { requestId: request.id, actor: "human", expectedRevision: 1, response: "approve", get note(): string { throw new Error("note read"); } };
    const missing = Object.create(input) as typeof input;
    missing.requestId = "missing";
    expect(() => requests.resolve(missing)).toThrow("no request missing");
    const actor = Object.create(input) as typeof input;
    actor.actor = " ";
    expect(() => requests.resolve(actor)).toThrow("actor is required");
    const revision = Object.create(input) as typeof input;
    revision.expectedRevision = 2;
    expect(() => requests.resolve(revision)).toThrow("answer named revision 2");
    const response = Object.create(input) as typeof input;
    response.response = "maybe";
    expect(() => requests.resolve(response)).toThrow("response must be one of");
    requests.withdraw({ requestId: request.id, actor: "supervisor", reason: "done" });
    expect(() => requests.resolve(input)).toThrow("is withdrawn");
    expect(requests.events().filter((event) => event.requestId === request.id && event.kind === "resolved")).toHaveLength(0);
  } finally { db.close(); }
});

test("replay short circuits note access on earlier mismatch", () => {
  const { db, requests, request } = fixture();
  try {
    requests.resolve({ requestId: request.id, actor: "human", expectedRevision: 1, response: "approve", note: "yes" });
    const input = { requestId: request.id, actor: "human", expectedRevision: 1, response: "decline", get note(): string { throw new Error("note read"); } };
    expect(() => requests.resolve(input)).toThrow("was already answered");
    expect(requests.events().filter((event) => event.requestId === request.id && event.kind === "resolved")).toHaveLength(1);
  } finally { db.close(); }
});

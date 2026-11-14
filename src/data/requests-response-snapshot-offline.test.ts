import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RequestError, Requests } from "./requests";

function fixture() {
  const db = new Database(":memory:");
  const requests = new Requests(db);
  requests.registerRun({ runId: "run", orchestrator: "supervisor", phase: "review" });
  const request = requests.create({ runId: "run", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "Proceed?" });
  return { db, requests, request };
}

test("resolve stores and audits the validated response", () => {
  const { db, requests, request } = fixture();
  try {
    let reads = 0;
    const input = { requestId: request.id, actor: "human", expectedRevision: 1, get response() { return ++reads === 1 ? "decline" : "approve"; } };
    expect(requests.resolve(input).response).toBe("decline");
    expect(requests.get(request.id).response).toBe("decline");
    expect(requests.events().filter((event) => event.requestId === request.id && event.kind === "resolved").map((event) => event.detail)).toEqual(["decline"]);
    expect(requests.gate("run", "review", 1)).toEqual({ approved: false, reason: "declined by human", requestId: request.id });
    expect(reads).toBe(1);
  } finally { db.close(); }
});

test("stable approval and exact replay preserve gate and audit", () => {
  const { db, requests, request } = fixture();
  try {
    const input = { requestId: request.id, actor: "human", expectedRevision: 1, response: "approve", note: "yes" };
    const resolved = requests.resolve(input);
    expect(resolved.response).toBe("approve");
    expect(requests.resolve(input)).toEqual(resolved);
    expect(requests.events().filter((event) => event.requestId === request.id && event.kind === "resolved").map((event) => event.detail)).toEqual(["approve: yes"]);
    expect(requests.gate("run", "review", 1).approved).toBe(true);
  } finally { db.close(); }
});

test("invalid response leaves request and audit unchanged", () => {
  const { db, requests, request } = fixture();
  try {
    expect(() => requests.resolve({ requestId: request.id, actor: "human", expectedRevision: 1, response: "maybe" })).toThrow(RequestError);
    expect(requests.get(request.id).status).toBe("open");
    expect(requests.events().filter((event) => event.requestId === request.id && event.kind === "resolved")).toHaveLength(0);
    expect(requests.gate("run", "review", 1).approved).toBe(false);
  } finally { db.close(); }
});

test("lookup and actor errors precede response evaluation", () => {
  const { db, requests, request } = fixture();
  try {
    const input = { requestId: "missing", actor: "human", expectedRevision: 1, get response(): string { throw new Error("response read"); } };
    expect(() => requests.resolve(input)).toThrow("no request missing");
    const invalidActor = { requestId: request.id, actor: " ", expectedRevision: 1, get response(): string { throw new Error("response read"); } };
    expect(() => requests.resolve(invalidActor)).toThrow("actor is required");
  } finally { db.close(); }
});

test("replay and revision checks keep their response evaluation order", () => {
  const { db, requests, request } = fixture();
  try {
    let reads = 0;
    const wrongRevision = { requestId: request.id, actor: "human", expectedRevision: 2, get response() { reads++; return "approve"; } };
    expect(() => requests.resolve(wrongRevision)).toThrow("answer named revision 2");
    expect(reads).toBe(0);
    requests.resolve({ requestId: request.id, actor: "human", expectedRevision: 1, response: "decline" });
    const replay = { requestId: request.id, actor: "human", expectedRevision: 1, get response() { return ++reads === 1 ? "decline" : "approve"; } };
    expect(requests.resolve(replay).response).toBe("decline");
    expect(reads).toBe(1);
    expect(requests.events().filter((event) => event.requestId === request.id && event.kind === "resolved")).toHaveLength(1);
  } finally { db.close(); }
});

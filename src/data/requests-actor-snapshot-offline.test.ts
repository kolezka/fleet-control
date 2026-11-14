import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Requests, RequestError } from "./requests";

function fixture() {
  const db = new Database(":memory:");
  const requests = new Requests(db);
  requests.registerRun({ runId: "run", orchestrator: "orchestrator", phase: "phase" });
  const request = requests.create({ runId: "run", origin: "orchestrator", expectedRevision: 1, kind: "approval", question: "Proceed?" });
  return { db, requests, request };
}

describe("request actor snapshot", () => {
  for (const operation of ["acknowledge", "withdraw"] as const) {
    test(`${operation} records the actor it authorized`, () => {
      const { db, requests, request } = fixture();
      try {
        if (operation === "acknowledge") requests.resolve({ requestId: request.id, actor: "human", response: "approve", expectedRevision: 1 });
        let reads = 0;
        const input = { requestId: request.id, reason: "no longer needed", get actor() { return ++reads === 1 ? "orchestrator" : "different-actor"; } };
        const result = operation === "acknowledge" ? requests.acknowledge(input) : requests.withdraw(input);
        expect(result.status).toBe(operation === "acknowledge" ? "acknowledged" : "withdrawn");
        const event = requests.events().find((item) => item.requestId === request.id && item.kind === (operation === "acknowledge" ? "acknowledged" : "withdrawn"));
        expect(event?.actor).toBe("orchestrator");
        expect(reads).toBe(1);
      } finally { db.close(); }
    });

    test(`${operation} accepts and records a stable authorized actor`, () => {
      const { db, requests, request } = fixture();
      try {
        if (operation === "acknowledge") requests.resolve({ requestId: request.id, actor: "human", response: "approve", expectedRevision: 1 });
        const input = { requestId: request.id, actor: "orchestrator", reason: "no longer needed" };
        const result = operation === "acknowledge" ? requests.acknowledge(input) : requests.withdraw(input);
        const kind = operation === "acknowledge" ? "acknowledged" : "withdrawn";
        expect(result.status).toBe(kind);
        expect(requests.events().find((item) => item.requestId === request.id && item.kind === kind)?.actor).toBe("orchestrator");
      } finally { db.close(); }
    });

    test(`${operation} reports the actor it rejected`, () => {
      const { db, requests, request } = fixture();
      try {
        let reads = 0;
        const input = { requestId: request.id, reason: "no longer needed", get actor() { return ++reads === 1 ? "other" : "different-actor"; } };
        expect(() => operation === "acknowledge" ? requests.acknowledge(input) : requests.withdraw(input)).toThrow("other is not the orchestrator of run");
        expect(reads).toBe(1);
      } finally { db.close(); }
    });

    test(`${operation} rejects a different actor without changing status`, () => {
      const { db, requests, request } = fixture();
      try {
        if (operation === "acknowledge") requests.resolve({ requestId: request.id, actor: "human", response: "approve", expectedRevision: 1 });
        const input = { requestId: request.id, actor: "other", reason: "no longer needed" };
        expect(() => operation === "acknowledge" ? requests.acknowledge(input) : requests.withdraw(input)).toThrow(RequestError);
        expect(requests.get(request.id).status).toBe(operation === "acknowledge" ? "resolved" : "open");
        expect(requests.events().filter((item) => item.requestId === request.id && (item.kind === "acknowledged" || item.kind === "withdrawn"))).toHaveLength(0);
      } finally { db.close(); }
    });
  }
});

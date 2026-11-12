import { expect, test } from "bun:test";
import { Requests, type Run, type SupervisorRequest } from "./requests.ts";

const run: Run = { id: "run", orchestrator: "owner", phase: "review", revision: 2, phaseStatus: "planned", updatedAt: "" };
const request = (id: string, overrides: Partial<SupervisorRequest> = {}): SupervisorRequest => ({
  id, runId: "run", phase: "review", revision: 2, kind: "approval", question: "?",
  proposedAction: "", scope: "", evidence: [], allowedResponses: ["approve", "decline"],
  blocking: true, origin: "owner", status: "open", response: null, resolvedBy: null,
  resolutionNote: null, resolvedAt: null, createdAt: "", ...overrides,
});

test("local gate characterizes approval, decline precedence and scope filtering", () => {
  const requests = Object.create(Requests.prototype) as Requests;
  let rows: SupervisorRequest[] = [];
  requests.run = (id) => { expect(id).toBe("run"); return run; };
  requests.list = (filter = {}) => {
    expect(filter).toEqual({ runId: "run" });
    return rows.filter((row) => row.runId === filter.runId);
  };
  const gate = () => requests.gate("run", "review", 2);
  const approved = request("approved", { status: "resolved", response: "approve", resolvedBy: "alice" });
  const open = request("open");
  const declined = request("declined", { status: "resolved", response: "decline", resolvedBy: "bob" });

  rows = [open, approved];
  expect(gate()).toEqual({ approved: true, reason: "approved by alice", requestId: "approved" });
  rows = [approved, open, declined];
  expect(gate()).toEqual({ approved: false, reason: "declined by bob", requestId: "declined" });
  rows = [
    request("other-run", { runId: "other", response: "decline" }),
    request("other-phase", { phase: "build", response: "decline" }),
    request("other-revision", { revision: 1, response: "decline" }),
    request("other-kind", { kind: "clarification", response: "decline" }),
    approved,
  ];
  expect(gate()).toEqual({ approved: true, reason: "approved by alice", requestId: "approved" });
  rows = [request("wrong-status", { status: "withdrawn", response: "approve", resolvedBy: "alice" }), open];
  expect(gate()).toEqual({ approved: false, reason: "approval requested, no answer yet", requestId: "open" });
  rows = [];
  expect(gate()).toEqual({ approved: false, reason: "no approval request for this revision", requestId: null });
  expect(requests.gate("run", "build", 2)).toEqual({ approved: false, reason: "run is at review r2, not build r2", requestId: null });
  expect(requests.gate("run", "review", 1)).toEqual({ approved: false, reason: "run is at review r2, not review r1", requestId: null });
});

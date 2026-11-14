// Supervisor request vocabulary. A request is bound to a run, phase and revision.

export type RequestKind = "approval" | "clarification" | "scope_change" | "blocker";
export type RequestStatus = "open" | "resolved" | "acknowledged" | "stale" | "withdrawn";

export type Run = { id: string; orchestrator: string; phase: string; revision: number; phaseStatus: string; updatedAt: string };

export type SupervisorRequest = {
  id: string;
  runId: string;
  phase: string;
  revision: number;
  kind: RequestKind;
  question: string;
  proposedAction: string;
  scope: string;
  evidence: string[];
  allowedResponses: string[];
  blocking: boolean;
  origin: string;
  status: RequestStatus;
  response: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

export class RequestError extends Error {
  constructor(readonly kind: "not_found" | "conflict" | "invalid" | "forbidden", message: string) {
    super(message);
  }
}

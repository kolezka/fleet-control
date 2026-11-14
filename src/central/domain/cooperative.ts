// Cooperative claim vocabulary: lifecycle reports, operator assertions, settlements and the inspection view.
import type { CentralCommand } from "./commands.ts";

export type CooperativeStatus = "accepted" | "rejected" | "running" | "completed" | "failed";
export type CooperativeEvent = { commandId: string; requestId: string; status: CooperativeStatus; detail: string; at: string };

export const lifecycleTransitions: Record<string, CooperativeStatus[]> = {
  claimed: ["accepted", "rejected"], accepted: ["running", "completed", "failed"],
  running: ["completed", "failed"], rejected: [], completed: [], failed: [],
};

export type ReconciliationDisposition = "unknown" | "completed" | "failed" | "not-executed";
export type Reconciliation = { commandId: string; requestId: string; actor: string; disposition: ReconciliationDisposition; evidence: string; expectedSequence: string | null; sequence: string; supersedesSequence: string | null; at: string };

export type SettlementDisposition = "completed" | "failed" | "not-executed" | "unknown";
export type Settlement = { commandId: string; requestId: string; actor: string; disposition: SettlementDisposition; evidence: string; expectedSequence: string | null; at: string };

export const settlementDispositions: readonly string[] = ["completed", "failed", "not-executed", "unknown"];

export type CooperativeInspectionEvent = { seq: string; requestId: string; status: CooperativeStatus; detail: string; at: string };
export type CooperativeInspectionResult = {
  command: CentralCommand;
  // incarnationActive is read with the claim: the claiming incarnation is active and its identity is not retired.
  // False means nobody can report on this claim any more.
  // settled: an operator recorded a terminal settlement for this claim (see CooperativeSettlement).
  claim: { incarnationId: string; incarnationActive: boolean; settled: boolean; requestId: string; createdAt: string } | null;
  events: CooperativeInspectionEvent[];
  nextCursor: string | null;
};

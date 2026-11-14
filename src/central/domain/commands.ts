// Central command vocabulary: a host-scoped command, list scopes and transition rules.
import type { Command, CommandStatus } from "../../domain/commands.ts";

export type CentralCommandEvent = { seq: string; commandId: string; status: CommandStatus; actor: string; detail: string; at: string };
export type CentralCommand = Command & { hostId: string };
export type CentralCommandInput = { idempotencyKey: string; hostId: string; target: string; actor: string; text: string };
export type CommandListScope = { hostId?: string; target?: string };
export type CommandListPagination = { limit?: number; cursor?: string };
export type CommandPage = { commands: CentralCommand[]; nextCursor: string | null };
export type SupervisorCommandScope = { hostId: string; session: string };

export const MAX_SCOPE_LENGTH = 256;
// Scope values must also be representable as PostgreSQL text.
export const validScopeValue = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= MAX_SCOPE_LENGTH && !value.includes("\0");

export const centralCommandTransitions: Record<CommandStatus, CommandStatus[]> = {
  queued: ["delivering", "accepted", "rejected"],
  delivering: ["delivered", "delivery_unknown", "accepted", "rejected"],
  delivered: ["accepted", "rejected"],
  delivery_unknown: ["accepted", "rejected"],
  claimed: [],
  accepted: ["running", "completed", "failed"],
  running: ["completed", "failed"],
  rejected: [], completed: [], failed: [],
};

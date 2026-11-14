// Central command vocabulary: a host-scoped command, list scopes and transition rules.
import { MAX_TEXT, type Command, type CommandStatus } from "../../domain/commands.ts";

export type CentralCommandEvent = { seq: string; commandId: string; status: CommandStatus; actor: string; detail: string; at: string };
export type CentralCommand = Command & { hostId: string };
export type CentralCommandInput = { idempotencyKey: string; hostId: string; target: string; actor: string; text: string };
export type CommandListScope = { hostId?: string; target?: string };
export type CommandListPagination = { limit?: number; cursor?: string };
export type CommandPage = { commands: CentralCommand[]; nextCursor: string | null };
export type SupervisorCommandScope = { hostId: string; session: string };

export const centralCommandStatuses = ["queued", "delivering", "delivered", "delivery_unknown", "claimed", "accepted", "rejected", "running", "completed", "failed"] as const satisfies readonly CommandStatus[];

// An operator's submission as it arrives from outside; the actor is added from authentication, never from the body.
export function parseCommandSubmission(input: unknown): Omit<CentralCommandInput, "actor"> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  if (typeof body.hostId !== "string" || !body.hostId.trim() || body.hostId.length > 256 || typeof body.target !== "string" || body.target.length > 256 || typeof body.text !== "string" || body.text.length > MAX_TEXT || typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200) return null;
  return { hostId: body.hostId, target: body.target, text: body.text, idempotencyKey: body.idempotencyKey };
}

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

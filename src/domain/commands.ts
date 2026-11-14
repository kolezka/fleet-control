// Command vocabulary and transition rules of the host-local queue.
// Queued, delivered, accepted and completed are separate facts; none implies the next one.

export type CommandStatus =
  | "queued" // stored on the host; not yet shown to the recipient
  | "delivering" // a delivery attempt is in progress; after a crash this becomes delivery_unknown
  | "delivered" // sender reported delivery; the bundled sender checks only a first-line prefix
  | "delivery_unknown" // an attempt may or may not have reached the pane; never retried automatically
  | "claimed" // cooperatively reserved, not accepted
  | "accepted"
  | "rejected"
  | "running"
  | "completed"
  | "failed";

export type Command = {
  id: string;
  idempotencyKey: string;
  target: string;
  actor: string;
  text: string;
  status: CommandStatus;
  createdAt: string;
  updatedAt: string;
};

export type CommandEvent = { seq: number; commandId: string; status: CommandStatus; actor: string; detail: string; at: string };

export class CommandError extends Error {
  constructor(readonly kind: "not_found" | "conflict" | "invalid", message: string) {
    super(message);
  }
}

// Who may move a command from which state. Delivery outcomes come only from the service itself.
export const commandTransitions: Record<CommandStatus, CommandStatus[]> = {
  queued: ["delivering", "accepted", "rejected"],
  delivering: ["delivered", "queued", "delivery_unknown"],
  delivered: ["accepted", "rejected"],
  delivery_unknown: ["accepted", "rejected"],
  claimed: [],
  accepted: ["running", "completed", "failed"],
  running: ["completed", "failed"],
  rejected: [],
  completed: [],
  failed: [],
};

export const MAX_TEXT = 4000;
export const sessionNamePattern = /^[A-Za-z0-9._-]+$/;

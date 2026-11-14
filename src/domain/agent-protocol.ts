// Wire messages between central and a host agent, and their size limits.

export const AGENT_PROTOCOL_VERSION = 1;
export const MAX_AGENT_MESSAGE_BYTES = 64 * 1024;
export const MAX_INVENTORY_SESSIONS = 256;
export const MAX_SESSION_LENGTH = 256;

export function validInventorySessions(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_INVENTORY_SESSIONS) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return value.every((session) => nonempty(session) && session.isWellFormed() && session.length <= MAX_SESSION_LENGTH && !/[\x00-\x1f\x7f]/.test(session)) &&
    new Set(value).size === value.length;
}

export type AgentReceipt = {
  version: 1;
  type: "receipt";
  hostId: string;
  commandId: string;
  attemptId: string;
  status: "delivered" | "unknown";
};

export type AgentInventory = {
  version: 1;
  type: "inventory";
  hostId: string;
  sessions: string[];
};

export type AgentDispatch = {
  version: 1;
  type: "dispatch";
  hostId: string;
  commandId: string;
  attemptId: string;
  target: string;
  text: string;
};

// Lone surrogates are rejected so an id cannot alias another one after UTF-8 storage.
export function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.isWellFormed();
}

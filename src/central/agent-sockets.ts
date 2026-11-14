// This registry is process-local. Authentication and durable delivery state belong to the caller.
import { AGENT_PROTOCOL_VERSION, MAX_AGENT_MESSAGE_BYTES, validInventorySessions, type AgentReceipt, type AgentInventory, type AgentDispatch, nonempty } from "../domain/agent-protocol.ts";

export interface AgentSocket {
  send(message: string): unknown;
  close(code: number, reason: string): unknown;
}

export interface AgentSocketDependencies {
  // Must check that this exact command and attempt belong to this host.
  validateAttempt(hostId: string, commandId: string, attemptId: string): boolean | Promise<boolean>;
  onReceipt(receipt: AgentReceipt): void | Promise<void>;
  onInventory(inventory: AgentInventory): void | Promise<void>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseMessage(raw: string): AgentReceipt | AgentInventory | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.version !== AGENT_PROTOCOL_VERSION || !nonempty(message.hostId)) return null;
  if (message.type === "receipt" && exactKeys(message, ["version", "type", "hostId", "commandId", "attemptId", "status"]) &&
      nonempty(message.commandId) && nonempty(message.attemptId) && (message.status === "delivered" || message.status === "unknown")) {
    return message as AgentReceipt;
  }
  if (message.type === "inventory" && exactKeys(message, ["version", "type", "hostId", "sessions"]) &&
      validInventorySessions(message.sessions)) {
    return message as AgentInventory;
  }
  return null;
}

export class AgentSockets {
  private connections = new Map<string, AgentSocket>();
  private registrations = new Map<string, object>();
  private closing = new WeakSet<AgentSocket>();
  private inventories = new Map<string, string[] | null>();

  listHosts(): { hostId: string; sessions: string[] | null }[] {
    return [...this.inventories].map(([hostId, sessions]) => ({ hostId, sessions: sessions && [...sessions] }));
  }

  constructor(private dependencies: AgentSocketDependencies) {}

  // Call after authentication, with the authenticated host identity, from the socket open handler.
  connect(hostId: string, socket: AgentSocket): boolean {
    if ([...this.connections.values()].includes(socket)) return false;
    if (this.closing.has(socket)) return false;
    if (!nonempty(hostId) || this.connections.has(hostId)) {
      this.closing.add(socket);
      socket.close(1008, "connection rejected");
      return false;
    }
    this.connections.set(hostId, socket);
    this.registrations.set(hostId, {});
    this.inventories.set(hostId, null);
    return true;
  }

  // Call once per disconnect. A stale socket cannot release a later connection.
  disconnect(hostId: string, socket: AgentSocket): void {
    if (this.connections.get(hostId) === socket) {
      this.connections.delete(hostId);
      this.registrations.delete(hostId);
      this.inventories.delete(hostId);
    }
  }

  // Call from the socket message handler. Binary frames are not part of v1.
  async message(hostId: string, socket: AgentSocket, raw: string | ArrayBuffer | Uint8Array): Promise<void> {
    if (this.connections.get(hostId) !== socket || this.closing.has(socket)) return;
    if (typeof raw !== "string") return this.reject(socket, 1003, "text required");
    if (Buffer.byteLength(raw, "utf8") > MAX_AGENT_MESSAGE_BYTES) return this.reject(socket, 1009, "message too large");
    const message = parseMessage(raw);
    if (!message || message.hostId !== hostId) return this.reject(socket, 1008, "invalid message");
    if (message.type === "receipt") {
      const registration = this.registrations.get(hostId);
      const valid = await this.dependencies.validateAttempt(hostId, message.commandId, message.attemptId);
      if (this.registrations.get(hostId) !== registration || this.connections.get(hostId) !== socket || this.closing.has(socket)) return;
      if (!valid) return this.reject(socket, 1008, "invalid attempt");
      await this.dependencies.onReceipt(message);
    } else {
      this.inventories.set(hostId, [...message.sessions]);
      await this.dependencies.onInventory(message);
    }
  }

  // A successful send is not a receipt. The caller owns retries and delivery state.
  dispatch(message: AgentDispatch): boolean {
    const hostId = message.hostId;
    const socket = this.connections.get(hostId);
    const registration = this.registrations.get(hostId);
    if (!socket || !registration || this.closing.has(socket)) return false;
    const version = message.version;
    if (version !== 1) throw new TypeError("invalid dispatch");
    const type = message.type;
    if (type !== "dispatch" || !nonempty(hostId)) throw new TypeError("invalid dispatch");
    const commandId = message.commandId;
    if (!nonempty(commandId)) throw new TypeError("invalid dispatch");
    const attemptId = message.attemptId;
    if (!nonempty(attemptId)) throw new TypeError("invalid dispatch");
    const target = message.target;
    if (!nonempty(target)) throw new TypeError("invalid dispatch");
    const text = message.text;
    if (!nonempty(text)) throw new TypeError("invalid dispatch");
    const snapshot: AgentDispatch = Object.assign(Object.create(null), {
      version, type, hostId, commandId, attemptId, target, text,
    });
    const raw = JSON.stringify(snapshot);
    if (Buffer.byteLength(raw, "utf8") > MAX_AGENT_MESSAGE_BYTES) throw new RangeError("dispatch too large");
    if (this.registrations.get(hostId) !== registration || this.connections.get(hostId) !== socket || this.closing.has(socket)) return false;
    // Bun reports -1 when backpressure is applied and 0 when a message is dropped.
    // Neither a queued send nor backpressure establishes a receipt.
    const result = socket.send(raw);
    return typeof result !== "number" || result !== 0;
  }

  private reject(socket: AgentSocket, code: number, reason: string): void {
    for (const [hostId, active] of this.connections) if (active === socket) this.disconnect(hostId, socket);
    this.closing.add(socket);
    socket.close(code, reason);
  }
}

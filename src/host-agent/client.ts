import { AGENT_PROTOCOL_VERSION, MAX_AGENT_MESSAGE_BYTES, MAX_INVENTORY_SESSIONS, validInventorySessions, type AgentDispatch, type AgentInventory, type AgentReceipt } from "../domain/agent-protocol.ts";

export interface HostSocket {
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

export interface HostClientOptions {
  url: string;
  hostId: string;
  token: string;
  allowLoopbackWsForTests?: boolean;
  socketFactory: (url: string, options: { headers: { Authorization: string } }) => HostSocket;
  // The executor must journal by attemptId before delivery and never replay started attempts.
  execute: (dispatch: Readonly<AgentDispatch>) => Promise<{ id: string; status: "started" | "delivered" | "unknown" }>;
  setTimer: (callback: () => void, delay: number) => unknown;
  clearTimer: (timer: unknown) => void;
  onError?: (error: unknown) => void;
  inventory?: () => string[] | Promise<string[]>;
}

const delays = [1000, 2000, 5000, 10000, 30000];
const maxPending = 100;
const keys = ["version", "type", "hostId", "commandId", "attemptId", "target", "text"];
// Lone surrogates are rejected so an id cannot alias another one after UTF-8 storage.
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.isWellFormed();

function parseDispatch(raw: unknown, hostId: string): AgentDispatch | null {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_AGENT_MESSAGE_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== keys.length || !keys.every((key) => Object.hasOwn(v, key)) ||
      v.version !== AGENT_PROTOCOL_VERSION || v.type !== "dispatch" || v.hostId !== hostId ||
      !nonempty(v.commandId) || !nonempty(v.attemptId) || !nonempty(v.target) || !nonempty(v.text)) return null;
  return v as AgentDispatch;
}

export class HostAgentClient {
  private socket: HostSocket | undefined;
  private connection: object | undefined;
  private timer: unknown;
  private retry: object | undefined;
  private running = false;
  private reconnects = 0;
  private pending = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly url: string;
  private inventoryGeneration = 0;

  constructor(private readonly options: HostClientOptions) {
    const url = new URL(options.url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!(url.protocol === "wss:" || (url.protocol === "ws:" && options.allowLoopbackWsForTests === true && loopback)) ||
        url.username || url.password || url.search || url.hash) throw new Error("unsafe WebSocket URL");
    if (!nonempty(options.hostId) || !nonempty(options.token) || /[\r\n]/.test(options.token)) throw new Error("host and token required");
    if (decodeURIComponent(url.pathname).includes(options.token)) throw new Error("token must not appear in URL");
    this.url = url.toString();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.connection = undefined;
    this.inventoryGeneration++;
    // Detach before clearTimer: it may restart the client and schedule a timer that must survive.
    const timer = this.timer;
    this.timer = undefined;
    this.retry = undefined;
    const socket = this.socket;
    this.socket = undefined;
    // A throwing clearTimer must not leave the socket open. If close also throws, its error wins.
    try {
      if (timer !== undefined) this.options.clearTimer(timer);
    } finally {
      socket?.close(1000, "stopped");
    }
  }

  sendInventory(sessions: string[]): void {
    this.publishInventory(sessions, false);
  }

  private publishInventory(sessions: string[], staleIsIgnored: boolean): void {
    const socket = this.socket;
    const stale = () => { if (!staleIsIgnored) throw new Error("stale inventory"); };
    const generation = this.inventoryGeneration;
    if (!Array.isArray(sessions)) throw new TypeError("invalid inventory");
    const length = sessions.length;
    if (!Number.isInteger(length) || length < 0 || length > MAX_INVENTORY_SESSIONS) throw new TypeError("invalid inventory");
    const captured: string[] = [];
    for (let index = 0; index < length; index++) {
      if (!Object.hasOwn(sessions, index)) throw new TypeError("invalid inventory");
      captured[index] = sessions[index]!;
    }
    if (!validInventorySessions(captured)) throw new TypeError("invalid inventory");
    if (this.inventoryGeneration !== generation || this.socket !== socket) return stale();
    // Valid inventory supersedes older work even if serialization or sending fails.
    // Invalid input does not supersede it.
    const ownGeneration = ++this.inventoryGeneration;
    Object.defineProperty(captured, "toJSON", { value: undefined });
    const inventory: AgentInventory = Object.assign(Object.create(null), { version: 1, type: "inventory", hostId: this.options.hostId, sessions: captured });
    if (this.inventoryGeneration !== ownGeneration || this.socket !== socket) return stale();
    const raw = JSON.stringify(inventory);
    if (this.inventoryGeneration !== ownGeneration || this.socket !== socket) return stale();
    if (Buffer.byteLength(raw, "utf8") > MAX_AGENT_MESSAGE_BYTES) throw new RangeError("message too large");
    if (!socket) throw new Error("not connected");
    const send = socket.send;
    if (this.inventoryGeneration !== ownGeneration || this.socket !== socket) return stale();
    Reflect.apply(send, socket, [raw]);
  }

  private sendReceipt(message: AgentReceipt, socket: HostSocket, current: () => boolean): void {
    const raw = JSON.stringify(message);
    if (!current()) return;
    if (Buffer.byteLength(raw, "utf8") > MAX_AGENT_MESSAGE_BYTES) throw new RangeError("message too large");
    const send = socket.send;
    if (!current()) return;
    Reflect.apply(send, socket, [raw]);
  }

  private connect(): void {
    if (!this.running) return;
    // The factory can stop or restart the client; only this attempt may install its socket or retry.
    const connection = this.connection = {};
    const owns = () => this.running && this.connection === connection;
    let socket: HostSocket;
    try { socket = this.options.socketFactory(this.url, { headers: { Authorization: `Bearer ${this.options.token}` } }); }
    catch (error) { this.reportError(error); if (owns()) this.schedule(); return; }
    if (!owns()) {
      // A newer attempt may have installed this same object; only close a socket nobody owns.
      if (socket !== this.socket) {
        try { socket.close(1000, "stopped"); } catch (error) { this.reportError(error); }
      }
      return;
    }
    this.socket = socket;
    const current = () => this.running && this.socket === socket && this.connection === connection;
    try {
      socket.addEventListener("open", () => {
        if (!current()) return;
        this.reconnects = 0;
        const generation = ++this.inventoryGeneration;
        void Promise.resolve().then(async () => {
          if (!current() || this.inventoryGeneration !== generation) return;
          const inventory = this.options.inventory;
          if (!inventory || !current() || this.inventoryGeneration !== generation) return;
          const sessions = await Reflect.apply(inventory, this.options, []);
          if (current() && this.inventoryGeneration === generation) this.publishInventory(sessions, true);
        }).catch((error) => this.reportError(error));
      });
      socket.addEventListener("close", () => {
        if (!current()) return;
        this.socket = undefined;
        this.inventoryGeneration++;
        this.schedule();
      });
      socket.addEventListener("error", (event) => { if (current()) this.reportError(event); });
      socket.addEventListener("message", (event) => {
        if (!current()) return;
        const dispatch = parseDispatch(event.data, this.options.hostId);
        if (!current()) return;
        if (!dispatch || this.pending >= maxPending) {
          this.socket = undefined;
          // A throwing close must not skip the reconnect; the old socket is already ignored by current().
          try { socket.close(typeof event.data === "string" && Buffer.byteLength(event.data, "utf8") > MAX_AGENT_MESSAGE_BYTES ? 1009 : 1008, "invalid dispatch"); }
          catch (error) { this.reportError(error); }
          // close or the error observer may have stopped or restarted the client; a newer attempt owns retries then.
          if (this.connection === connection) this.schedule();
          return;
        }
        this.pending++;
        this.queue = this.queue.then(async () => {
          try {
            if (!current()) return;
            const outcome = await this.options.execute(Object.freeze(dispatch));
            if (outcome.id !== dispatch.attemptId || !["started", "delivered", "unknown"].includes(outcome.status)) throw new Error("invalid journal outcome");
            if (!current()) return;
            const receipt: AgentReceipt = { version: 1, type: "receipt", hostId: dispatch.hostId, commandId: dispatch.commandId, attemptId: dispatch.attemptId, status: outcome.status === "delivered" ? "delivered" : "unknown" };
            if (current()) this.sendReceipt(receipt, socket, current);
          } catch (error) { this.reportError(error); }
          finally { this.pending--; }
        });
      });
    } catch (error) {
      // Without every listener the socket cannot be supervised: drop it and retry.
      if (this.socket === socket) this.socket = undefined;
      this.reportError(error);
      // The observer may have restarted the client onto this same object; only close it if nobody owns it.
      if (this.socket !== socket) {
        try { socket.close(1011, "listener registration failed"); } catch (closeError) { this.reportError(closeError); }
      }
      if (owns()) this.schedule();
    }
  }

  // The observer is caller code. If it throws, log a fixed message instead of the raw errors
  // (they can carry secrets) so the dispatch queue and event handlers keep working.
  private reportError(error: unknown): void {
    try { this.options.onError?.(error); }
    catch { console.error("host client onError observer threw; the original error was not reported"); }
  }

  private schedule(): void {
    if (!this.running || this.timer !== undefined) return;
    const delay = delays[Math.min(this.reconnects++, delays.length - 1)]!;
    // A token, not the handle, identifies this retry: a timer that clearTimer failed to
    // cancel must not clear or reconnect for a later start.
    const retry = {};
    this.retry = retry;
    const handle = this.options.setTimer(() => {
      if (this.retry !== retry) return;
      this.retry = undefined;
      this.timer = undefined;
      this.connect();
    }, delay);
    // A synchronous setTimer may already have run this retry (and scheduled a newer one).
    if (this.retry === retry) this.timer = handle;
  }
}

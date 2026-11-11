import { AGENT_PROTOCOL_VERSION, MAX_AGENT_MESSAGE_BYTES, validInventorySessions, type AgentDispatch, type AgentInventory, type AgentReceipt } from "../central/agent-sockets.ts";

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
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

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
  private timer: unknown;
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
    if (this.timer !== undefined) this.options.clearTimer(this.timer);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "stopped");
  }

  sendInventory(sessions: string[]): void {
    if (!validInventorySessions(sessions)) throw new TypeError("invalid inventory");
    this.inventoryGeneration++;
    const inventory: AgentInventory = { version: 1, type: "inventory", hostId: this.options.hostId, sessions: [...sessions] };
    this.send(inventory);
  }

  private send(message: AgentInventory | AgentReceipt): void {
    const raw = JSON.stringify(message);
    if (Buffer.byteLength(raw, "utf8") > MAX_AGENT_MESSAGE_BYTES) throw new RangeError("message too large");
    if (!this.socket) throw new Error("not connected");
    this.socket.send(raw);
  }

  private connect(): void {
    if (!this.running) return;
    let socket: HostSocket;
    try { socket = this.options.socketFactory(this.url, { headers: { Authorization: `Bearer ${this.options.token}` } }); }
    catch (error) { this.options.onError?.(error); this.schedule(); return; }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || !this.running) return;
      this.reconnects = 0;
      if (!this.options.inventory) return;
      const generation = ++this.inventoryGeneration;
      void Promise.resolve().then(() => this.options.inventory!()).then((sessions) => {
        if (this.running && this.socket === socket && this.inventoryGeneration === generation) this.sendInventory(sessions);
      }).catch((error) => this.options.onError?.(error));
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.schedule();
    });
    socket.addEventListener("error", (event) => { if (this.socket === socket) this.options.onError?.(event); });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || !this.running) return;
      const dispatch = parseDispatch(event.data, this.options.hostId);
      if (!dispatch || this.pending >= maxPending) {
        this.socket = undefined;
        socket.close(typeof event.data === "string" && Buffer.byteLength(event.data, "utf8") > MAX_AGENT_MESSAGE_BYTES ? 1009 : 1008, "invalid dispatch");
        this.schedule();
        return;
      }
      this.pending++;
      this.queue = this.queue.then(async () => {
        try {
          if (!this.running || this.socket !== socket) return;
          const outcome = await this.options.execute(Object.freeze(dispatch));
          if (outcome.id !== dispatch.attemptId || !["started", "delivered", "unknown"].includes(outcome.status)) throw new Error("invalid journal outcome");
          const receipt: AgentReceipt = { version: 1, type: "receipt", hostId: dispatch.hostId, commandId: dispatch.commandId, attemptId: dispatch.attemptId, status: outcome.status === "delivered" ? "delivered" : "unknown" };
          if (this.running && this.socket === socket) this.send(receipt);
        } catch (error) { this.options.onError?.(error); }
        finally { this.pending--; }
      });
    });
  }

  private schedule(): void {
    if (!this.running || this.timer !== undefined) return;
    const delay = delays[Math.min(this.reconnects++, delays.length - 1)]!;
    this.timer = this.options.setTimer(() => { this.timer = undefined; this.connect(); }, delay);
  }
}

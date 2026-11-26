import type { CooperativeInspectionResult } from "../src/central/domain/cooperative.ts";

// Pure per-host state for the multi-host deck. No DOM, no fetch, no terminal library: web/app.ts wires
// this to the browser. Every host keeps its own sessions, selection, supervisor data, draft and
// pending command intent. Nothing here is shared between hosts, so one host's delayed read, failure
// or result can never land on another host.

export type Model =
  | { state: "observed"; model: string; source?: string; observedAt?: string }
  | { state: "configured"; model: string; note: string }
  | { state: "unknown"; lastObserved: { model: string; observedAt: string } | null; reason?: string }
  | { state: "not_applicable" };
export type Session = { name: string; host: string | null; role: string | null; registered: boolean; running: boolean; model: Model };
export type Run = { id: string; projectId?: string | null; taskId?: string | null; orchestrator: string; phase: string; revision: number; phaseStatus: string; updatedAt: string };
export type Req = {
  id: string; runId: string; projectId?: string | null; taskId?: string | null; phase: string; revision: number; kind: string; question: string; proposedAction: string; scope: string;
  createdAt?: string; resolvedAt?: string | null;
  evidence: string[]; allowedResponses: string[]; status: string; response: string | null; resolvedBy: string | null; resolutionNote: string | null;
};
export type Command = { hostId?: string; id: string; target: string; actor: string; text: string; status: string; response: string | null; updatedAt: string; createdAt: string };
export type Peer = { name: string; url: string };

/** `direct`: this page talks to one host service itself, so a 401 there means "sign in here". */
export type HostInfo = { id: string; name: string; apiBase: string; direct: boolean; group?: string; defaultHarness?: "deepseek-harness" | "claude-code"; supervisor?: { hostId: string; session: string } };

// ---------------------------------------------------------------------------------------------
// Host list and response parsing
// ---------------------------------------------------------------------------------------------

export const LOCAL_ID = "local";
const GATEWAY_BASE = /^\/api\/hosts\/[A-Za-z0-9._~%-]+$/;

/** apiBase is used to build same-origin request paths, so anything else is refused. */
export const validGatewayBase = (v: unknown): v is string => typeof v === "string" && GATEWAY_BASE.test(v);

export type HostList = { mode: "gateway" | "direct"; hosts: HostInfo[]; peers: Peer[] };

/** Gateway: `{hosts:[{id,name,apiBase}]}`. Host service: `{self:{name},peers:[]}`. Anything else is null. */
export function parseHostList(body: unknown): HostList | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.hosts)) {
    const hosts: HostInfo[] = [];
    for (const h of b.hosts) {
      if (!h || typeof h !== "object") continue;
      const r = h as Record<string, unknown>;
      if (typeof r.id !== "string" || !r.id || !validGatewayBase(r.apiBase)) continue;
      if (hosts.some((x) => x.id === r.id)) continue;
      const m = r.supervisor as Record<string, unknown> | null;
      if (r.supervisor !== undefined && (!m || typeof m !== "object" || ![m.hostId, m.session].every(v => typeof v === "string" && !!v && v.length <= 256 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v)))) return null;
      const supervisor = m ? { hostId: m.hostId as string, session: m.session as string } : undefined;
      const defaultHarness = r.defaultHarness;
      if (defaultHarness !== undefined && defaultHarness !== "deepseek-harness" && defaultHarness !== "claude-code") return null;
      const group = r.group;
      if (group !== undefined && (typeof group !== "string" || !group.trim() || group.length > 40 || /[\x00-\x1f\x7f]/.test(group))) return null;
      hosts.push({ ...(group ? { group } : {}), ...(defaultHarness ? { defaultHarness } : {}), ...(supervisor ? { supervisor } : {}), id: r.id, name: typeof r.name === "string" && r.name ? r.name : r.id, apiBase: r.apiBase, direct: false });
    }
    return { mode: "gateway", hosts, peers: [] };
  }
  const self = b.self as Record<string, unknown> | undefined;
  if (self && typeof self.name === "string") {
    const peers = Array.isArray(b.peers)
      ? (b.peers as unknown[]).flatMap((p) => {
          const r = p as Record<string, unknown> | null;
          return r && typeof r.name === "string" && typeof r.url === "string" && /^https?:\/\//.test(r.url) ? [{ name: r.name, url: r.url }] : [];
        })
      : [];
    return { mode: "direct", hosts: [{ id: LOCAL_ID, name: self.name, apiBase: "./api", direct: true }], peers };
  }
  return null;
}

export type Failure = { ok: false; kind: "unauthorized" | "http" | "network" | "invalid"; status?: number; message: string };
export type Outcome<T> = { ok: true; data: T } | Failure;

/** Turns an HTTP status and parsed body into an outcome. A null body means it was not JSON. */
export function interpretResponse(status: number, body: unknown): Outcome<unknown> {
  if (status === 401) return { ok: false, kind: "unauthorized", status, message: "The host rejected the sign-in (401)" };
  if (status < 200 || status > 299) {
    const msg = (body as { error?: { message?: unknown } } | null)?.error?.message;
    return { ok: false, kind: "http", status, message: typeof msg === "string" && msg ? msg : `HTTP ${status}` };
  }
  if (body === null || body === undefined) return { ok: false, kind: "invalid", status, message: "Response was not JSON" };
  return { ok: true, data: body };
}

export function parseSessions(body: unknown): Outcome<{ sessions: Session[]; readAt: string | null }> {
  const b = body as { sessions?: unknown; readAt?: unknown } | null;
  if (!b || !Array.isArray(b.sessions)) return { ok: false, kind: "invalid", message: "Session list was malformed" };
  return { ok: true, data: { sessions: b.sessions as Session[], readAt: typeof b.readAt === "string" ? b.readAt : null } };
}

export type CoordData = { runs: Run[]; requests: Req[]; commands: Command[] };

/** Both reads must succeed; half a picture of the supervisor state is treated as unknown. */
export function parseCoord(requests: Outcome<unknown>, commands: Outcome<unknown>): Outcome<CoordData> {
  const failed = [requests, commands].find((o): o is Failure => !o.ok);
  if (failed) return failed;
  const rq = (requests as { data: { runs?: unknown; requests?: unknown } }).data;
  const cm = (commands as { data: { commands?: unknown } }).data;
  if (!rq || !Array.isArray(rq.requests) || !cm || !Array.isArray(cm.commands)) return { ok: false, kind: "invalid", message: "Supervisor data was malformed" };
  return { ok: true, data: { runs: Array.isArray(rq.runs) ? (rq.runs as Run[]) : [], requests: rq.requests as Req[], commands: cm.commands as Command[] } };
}

/**
 * queued: the host accepted it. rejected: the host refused it, so nothing was queued.
 * uncertain: no answer or a server-side failure; it may or may not have been queued.
 */
export type SendOutcome = "queued" | "rejected" | "uncertain";
export function classifySend(status: number | null): SendOutcome {
  if (status === null) return "uncertain";
  if (status >= 200 && status <= 299) return "queued";
  if (status >= 500 || status === 408) return "uncertain";
  return "rejected";
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export type ReadKind = "sessions" | "coord";
/** loading: never read yet. ready: the last read succeeded. unknown: the last read failed. */
export type ReadMeta = { status: "loading" | "ready" | "unknown"; inFlight: string | null; n: number; error: string | null; at: string | null };

/** Frozen on creation: the command a retry may repeat. Never edited in place. */
export type CommandIntent = Readonly<{ key: string; hostId: string; gen: number; target: string; text: string }>;
export type AnswerHandle = Readonly<{ hostId: string; gen: number; requestId: string; revision: number }>;

export type HostState = {
  info: HostInfo;
  /** Distinguishes two lives of the same host id (for example after its apiBase changed). */
  gen: number;
  sessions: Session[];
  sessionsRead: ReadMeta;
  coord: CoordData;
  coordRead: ReadMeta;
  selectedSession: string;
  draft: string;
  intent: CommandIntent | null;
  sending: boolean;
  notice: string;
  answering: string[];
  commands: Command[];
  commandsRead: ReadMeta;
  commandsCursor: string | null;
  selectedCommand: string;
  inspection: CooperativeInspectionResult | null;
  inspectionRead: ReadMeta;
  inspectionCursor: string | null;
};
export type Fleet = { hosts: Record<string, HostState>; order: string[]; selectedHost: string; nextGen: number };

const meta = (): ReadMeta => ({ status: "loading", inFlight: null, n: 0, error: null, at: null });
const freshHost = (info: HostInfo, gen: number): HostState => ({
  info, gen, sessions: [], sessionsRead: meta(), coord: { runs: [], requests: [], commands: [] }, coordRead: meta(),
  commands: [], commandsRead: meta(), commandsCursor: null, selectedCommand: "", inspection: null, inspectionRead: meta(), inspectionCursor: null,
  selectedSession: "", draft: "", intent: null, sending: false, notice: "", answering: [],
});

export const emptyFleet = (): Fleet => ({ hosts: {}, order: [], selectedHost: "", nextGen: 1 });

function patch(f: Fleet, id: string, p: Partial<HostState>): Fleet {
  const h = f.hosts[id];
  if (!h) return f;
  return { ...f, hosts: { ...f.hosts, [id]: { ...h, ...p } } };
}

/** A host keeps its state while its id and apiBase are unchanged; a changed apiBase starts it over. */
export function setHosts(f: Fleet, infos: HostInfo[]): Fleet {
  const hosts: Record<string, HostState> = {};
  let nextGen = f.nextGen;
  for (const info of infos) {
    const old = f.hosts[info.id];
    hosts[info.id] = old && old.info.apiBase === info.apiBase && old.info.direct === info.direct && old.info.supervisor?.hostId === info.supervisor?.hostId && old.info.supervisor?.session === info.supervisor?.session ? { ...old, info } : freshHost(info, nextGen++);
  }
  const order = infos.map((i) => i.id);
  return { hosts, order, selectedHost: hosts[f.selectedHost] ? f.selectedHost : (order[0] ?? ""), nextGen };
}

export const selectedHostState = (f: Fleet): HostState | undefined => f.hosts[f.selectedHost];

export function selectHost(f: Fleet, id: string): Fleet {
  return f.hosts[id] ? { ...f, selectedHost: id } : f;
}

/** Emphasis only: the session must exist on that host. Selecting a session selects its host. */
export function selectSession(f: Fleet, hostId: string, name: string): Fleet {
  const h = f.hosts[hostId];
  if (!h) return f;
  const next = h.sessions.some((s) => s.name === name) ? patch(f, hostId, { selectedSession: name }) : f;
  return selectHost(next, hostId);
}

export const setDraft = (f: Fleet, hostId: string, text: string): Fleet => patch(f, hostId, { draft: text });
export const setNotice = (f: Fleet, hostId: string, notice: string): Fleet => patch(f, hostId, { notice });

// --- reads ---------------------------------------------------------------------------------------

/** One read per host and kind at a time. A null token means one is already running (or no such host). */
export function beginRead(f: Fleet, hostId: string, kind: ReadKind): { fleet: Fleet; token: string | null } {
  const h = f.hosts[hostId];
  if (!h) return { fleet: f, token: null };
  const m = kind === "sessions" ? h.sessionsRead : h.coordRead;
  if (m.inFlight) return { fleet: f, token: null };
  const n = m.n + 1;
  const token = `${h.gen}.${kind}.${n}`;
  const next = { ...m, n, inFlight: token };
  return { fleet: patch(f, hostId, kind === "sessions" ? { sessionsRead: next } : { coordRead: next }), token };
}

function defaultSelection(sessions: Session[], current: string): string {
  if (current && sessions.some((s) => s.name === current)) return current;
  return sessions.find((s) => s.running)?.name ?? "";
}

/**
 * Applies a read result to the host that started it, and only if the token is still the one issued.
 * A result for a removed host, a replaced host or a superseded read is dropped (same Fleet returned).
 */
export function finishRead(
  f: Fleet, hostId: string, kind: ReadKind, token: string,
  result: Outcome<{ sessions: Session[]; readAt: string | null } | CoordData>, at: string,
): Fleet {
  const h = f.hosts[hostId];
  if (!h) return f;
  const m = kind === "sessions" ? h.sessionsRead : h.coordRead;
  if (m.inFlight !== token) return f;
  if (!result.ok) {
    const failed: ReadMeta = { ...m, inFlight: null, status: "unknown", error: result.message };
    return patch(f, hostId, kind === "sessions" ? { sessionsRead: failed } : { coordRead: failed });
  }
  if (kind === "sessions") {
    const d = result.data as { sessions: Session[]; readAt: string | null };
    return patch(f, hostId, {
      sessions: d.sessions,
      selectedSession: defaultSelection(d.sessions, h.selectedSession),
      sessionsRead: { ...m, inFlight: null, status: "ready", error: null, at: d.readAt ?? at },
    });
  }
  return patch(f, hostId, { coord: result.data as CoordData, coordRead: { ...m, inFlight: null, status: "ready", error: null, at } });
}

// --- selectors -----------------------------------------------------------------------------------

export const runningNames = (h: HostState): string[] => h.sessions.filter((s) => s.running).map((s) => s.name);

/** Changes only when the set of panes to show changes. The host id is part of it: same names on two hosts differ. */
export const paneKey = (h: HostState | undefined): string => (h ? `${h.info.id}#${h.gen}\n${runningNames(h).join("\n")}` : "");

export type SessionsView =
  | { kind: "loading" }
  | { kind: "ready"; count: number; at: string | null }
  /** The last read failed. Whatever was read before is old, not current. */
  | { kind: "unknown"; lastKnownCount: number | null; at: string | null; error: string | null };

export function describeSessions(h: HostState): SessionsView {
  const r = h.sessionsRead;
  if (r.status === "ready") return { kind: "ready", count: h.sessions.length, at: r.at };
  if (r.status === "unknown") return { kind: "unknown", lastKnownCount: r.at ? h.sessions.length : null, at: r.at, error: r.error };
  return { kind: "loading" };
}

/** The run the panel shows: the one registered or moved to a new phase last (runs.updated_at; requests do not
 *  touch it). Hosts list runs by id, so the last row can be an old run. Same order as view=current's SQL. */
export function currentRun<R extends { id: string; updatedAt: string }>(runs: readonly R[]): R | undefined {
  let best: R | undefined;
  for (const r of runs) if (!best || r.updatedAt > best.updatedAt || (r.updatedAt === best.updatedAt && r.id > best.id)) best = r;
  return best;
}

/** The session an instruction goes to: the run's orchestrator when it is running, else the selected one. */
export function composerTarget(h: HostState): string {
  if (h.info.supervisor) return h.info.supervisor.session;
  const orch = currentRun(h.coord.runs)?.orchestrator;
  if (orch && h.sessions.some((s) => s.name === orch && s.running)) return orch;
  return h.sessions.find((s) => s.name === h.selectedSession && s.running)?.name ?? "";
}

export type SendGate = { ok: true } | { ok: false; reason: "sending" | "loading" | "unknown" | "no-target" | "empty" };

/** Sending needs fresh knowledge of this host: both reads must have succeeded most recently. */
export function sendGate(h: HostState, target: string, text: string): SendGate {
  if (h.sending) return { ok: false, reason: "sending" };
  if (h.info.supervisor) {
    if (target !== h.info.supervisor.session) return { ok: false, reason: "no-target" };
    return text.trim() ? { ok: true } : { ok: false, reason: "empty" };
  }
  if (h.sessionsRead.status === "unknown" || h.coordRead.status === "unknown") return { ok: false, reason: "unknown" };
  if (h.sessionsRead.status === "loading" || h.coordRead.status === "loading") return { ok: false, reason: "loading" };
  if (!target) return { ok: false, reason: "no-target" };
  if (!text.trim()) return { ok: false, reason: "empty" };
  return { ok: true };
}

// --- commands ------------------------------------------------------------------------------------

export const intentMatches = (i: CommandIntent, hostId: string, target: string, text: string): boolean =>
  i.hostId === hostId && i.target === target && i.text === text;

/**
 * Captures the instruction before anything is awaited. The idempotency key is reused only while the
 * host, target and text are all unchanged; any change makes a new intent with a new key, so a retry
 * can never carry another host's, target's or text's key.
 */
export function beginSend(
  f: Fleet, hostId: string, target: string, text: string, newKey: () => string,
): { fleet: Fleet; intent: CommandIntent | null; blocked?: Exclude<SendGate, { ok: true }>["reason"] } {
  const h = f.hosts[hostId];
  if (!h) return { fleet: f, intent: null };
  const t = text.trim();
  const gate = sendGate(h, target, t);
  if (!gate.ok) return { fleet: f, intent: null, blocked: gate.reason };
  const intent = h.intent && intentMatches(h.intent, hostId, target, t) ? h.intent : Object.freeze({ key: newKey(), hostId, gen: h.gen, target, text: t });
  return { fleet: patch(f, hostId, { intent, sending: true }), intent };
}

/**
 * Settles the send on the host that sent it. Queued and rejected end the intent; uncertain keeps it so
 * the same send repeats the same key. The draft is cleared only if it still is the text that was sent.
 */
export function finishSend(f: Fleet, intent: CommandIntent, outcome: SendOutcome, notice: string, submitted?: Command): Fleet {
  const h = f.hosts[intent.hostId];
  if (!h || h.gen !== intent.gen) return f;
  const base: Partial<HostState> = { sending: false, notice };
  if (outcome === "uncertain") return patch(f, intent.hostId, base);
  return patch(f, intent.hostId, {
    ...base,
    ...(outcome === "queued" && h.info.supervisor && submitted ? { selectedCommand: submitted.id, inspection: null, inspectionCursor: null, inspectionRead: { ...meta(), n: h.inspectionRead.n } } : {}),
    intent: h.intent?.key === intent.key ? null : h.intent,
    draft: outcome === "queued" && h.draft.trim() === intent.text ? "" : h.draft,
  });
}

// --- request answers -----------------------------------------------------------------------------

export const answerKey = (requestId: string, revision: number): string => `${requestId}@${revision}`;

/** One answer per request revision at a time. Null when already answering or the host is gone. */
export function beginAnswer(f: Fleet, hostId: string, requestId: string, revision: number): { fleet: Fleet; handle: AnswerHandle | null } {
  const h = f.hosts[hostId];
  const key = answerKey(requestId, revision);
  if (!h || h.info.supervisor || h.answering.includes(key)) return { fleet: f, handle: null };
  return { fleet: patch(f, hostId, { answering: [...h.answering, key] }), handle: Object.freeze({ hostId, gen: h.gen, requestId, revision }) };
}

export function finishAnswer(f: Fleet, a: AnswerHandle, notice: string): Fleet {
  const h = f.hosts[a.hostId];
  if (!h || h.gen !== a.gen) return f;
  const key = answerKey(a.requestId, a.revision);
  return patch(f, a.hostId, { answering: h.answering.filter((k) => k !== key), notice });
}

export type CommandPage = { commands: Command[]; nextCursor: string | null };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const validCursor = (v: unknown): v is string | null => v === null || (typeof v === "string" && !!v && v.length <= 8192);
const commandStatuses = ["queued", "claimed", "delivering", "delivered", "delivery_unknown", "accepted", "rejected", "running", "completed", "failed"];
export function isCommand(v: unknown): v is Command {
  return record(v) && ["id", "target", "actor", "text", "updatedAt", "createdAt"].every(k => typeof v[k] === "string") && !!v.id && commandStatuses.includes(v.status as string) && (v.response === undefined || v.response === null || typeof v.response === "string");
}
const invalidPage = (): Failure => ({ ok: false, kind: "invalid", message: "Cooperative page was malformed or out of scope" });
export function parseCommandPage(body: unknown, host: HostInfo, cursor: string | null = null): Outcome<CommandPage> {
  if (!host.supervisor || !record(body) || !Array.isArray(body.commands) || body.commands.length > 4 || !validCursor(body.nextCursor) || (cursor !== null && body.nextCursor === cursor)) return invalidPage();
  if (!body.commands.every(c => isCommand(c) && c.target === host.supervisor!.session && record(c) && c.hostId === host.supervisor!.hostId) || new Set(body.commands.map(c => c.id)).size !== body.commands.length || (body.nextCursor !== null && !body.commands.length)) return invalidPage();
  for (let i = 1; i < body.commands.length; i++) {
    const previous = body.commands[i - 1] as Command;
    const current = body.commands[i] as Command;
    if (current.createdAt < previous.createdAt || (current.createdAt === previous.createdAt && current.id <= previous.id)) return invalidPage();
  }
  return { ok: true, data: body as CommandPage };
}
export function parseInspection(body: unknown, host: HostInfo, commandId: string, cursor: string | null): Outcome<CooperativeInspectionResult> {
  if (!host.supervisor || !record(body) || !isCommand(body.command) || !record(body.command) || body.command.id !== commandId || body.command.hostId !== host.supervisor.hostId || body.command.target !== host.supervisor.session || !Array.isArray(body.events) || body.events.length > 4 || !validCursor(body.nextCursor)) return invalidPage();
  const c = body.claim;
  if (c !== null && (!record(c) || !["incarnationId", "requestId", "createdAt"].every(k => typeof c[k] === "string") || typeof c.incarnationActive !== "boolean" || typeof c.settled !== "boolean")) return invalidPage();
  let previous = cursor ?? "0";
  for (const event of body.events) {
    if (!record(event) || typeof event.seq !== "string" || !/^[1-9][0-9]{0,18}$/.test(event.seq) || BigInt(event.seq) <= BigInt(previous) || !["accepted", "rejected", "running", "completed", "failed"].includes(event.status as string) || !["requestId", "detail", "at"].every(k => typeof event[k] === "string")) return invalidPage();
    previous = event.seq;
  }
  if (body.nextCursor !== null && (!body.events.length || body.nextCursor !== previous)) return invalidPage();
  return { ok: true, data: body as CooperativeInspectionResult };
}
export type PageHandle = Readonly<{ hostId: string; gen: number; token: string; kind: "commands" | "inspection"; commandId: string; cursor: string | null }>;
export function selectCommand(f: Fleet, hostId: string, commandId: string): Fleet {
  const h = f.hosts[hostId];
  if (!h?.info.supervisor || !h.commands.some(c => c.id === commandId)) return f;
  return patch(f, hostId, { selectedCommand: commandId, inspection: null, inspectionCursor: null, inspectionRead: { ...meta(), n: h.inspectionRead.n } });
}
// One read per host generation and resource. Selection changes invalidate inspection tokens.
export function beginPageRead(f: Fleet, hostId: string, kind: PageHandle["kind"], more = false): { fleet: Fleet; handle: PageHandle | null } {
  const h = f.hosts[hostId];
  if (!h?.info.supervisor || (kind === "inspection" && !h.selectedCommand)) return { fleet: f, handle: null };
  const m = kind === "commands" ? h.commandsRead : h.inspectionRead;
  const cursor = more ? (kind === "commands" ? h.commandsCursor : h.inspectionCursor) : null;
  if (m.inFlight || (more && (!cursor || m.status !== "ready"))) return { fleet: f, handle: null };
  const token = [h.gen, kind, m.n + 1].join(".");
  const next = { ...m, n: m.n + 1, inFlight: token };
  const handle = Object.freeze({ hostId, gen: h.gen, token, kind, commandId: h.selectedCommand, cursor });
  return { fleet: patch(f, hostId, kind === "commands" ? { commandsRead: next } : { inspectionRead: next }), handle };
}
export function finishPageRead(f: Fleet, a: PageHandle, result: Outcome<CommandPage | CooperativeInspectionResult>, at: string): Fleet {
  const h = f.hosts[a.hostId];
  if (!h || h.gen !== a.gen || (a.kind === "inspection" && h.selectedCommand !== a.commandId)) return f;
  const m = a.kind === "commands" ? h.commandsRead : h.inspectionRead;
  if (m.inFlight !== a.token) return f;
  const next: ReadMeta = { ...m, inFlight: null, status: result.ok ? "ready" : "unknown", error: result.ok ? null : result.message, at: result.ok ? at : m.at };
  if (!result.ok) return patch(f, a.hostId, a.kind === "commands" ? { commandsRead: next } : { inspectionRead: next, inspection: null, inspectionCursor: null });
  if (a.kind === "commands") {
    const d = result.data as CommandPage;
    const commands = a.cursor ? [...h.commands, ...d.commands.filter(c => !h.commands.some(old => old.id === c.id))] : d.commands;
    return patch(f, a.hostId, { commands, commandsCursor: d.nextCursor, commandsRead: next });
  }
  const d = result.data as CooperativeInspectionResult;
  const events = a.cursor && h.inspection ? [...h.inspection.events, ...d.events] : d.events;
  return patch(f, a.hostId, { inspection: { ...d, events }, inspectionCursor: d.nextCursor, inspectionRead: next });
}

// Status text for a terminal close the pane does not retry (1000 and 1008). A revoked token gets its
// own text, so the user knows to sign in again rather than wait for a reconnect that never comes.
export function terminalClosedText(code: number, reason: string): string {
  if (code === 1000) return "Viewer ended";
  if (code === 1008 && reason === "token revoked") return "Access revoked · sign in again";
  if (code === 1008 && reason === "gateway token revoked") return "Gateway's token for this host revoked · update the gateway credentials";
  if (code === 1013 && reason === "too many open terminal viewers") return "Host has too many open viewers · close another tab";
  return `Refused (${code})`;
}

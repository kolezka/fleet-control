import type { SQL } from "bun";
import { RequestError, type RequestKind, type RequestStatus, type Run, type SupervisorRequest } from "../requests.ts";

// The caller must bind the authenticated principal to the input actor before calling.
// A guard fences that principal in this transaction; it does not authenticate the input.
// Callers must capture immutable identity values for both the input and guard closure.
export type RequestMutationGuard = (tx: SQL) => Promise<void>;

type Event = { seq: string; requestId: string | null; runId: string; kind: string; actor: string; detail: string; at: string };
type CreateInput = { runId: string; origin: string; expectedRevision: number; kind: RequestKind; question: string; proposedAction?: string; scope?: string; evidence?: string[]; allowedResponses?: string[]; blocking?: boolean };
const validEncoding = (value: unknown): value is string => typeof value === "string" && value.isWellFormed() && !value.includes("\0");
const validArrayEncoding = (values: string[]) => {
  for (let i = 0; i < values.length; i++) if (!validEncoding(values[i])) return false;
  return true;
};
const invalidArray = Object.freeze(Object.setPrototypeOf([undefined], null)) as unknown as string[];
const snapshotArray = (values: string[]) => {
  const snapshot: string[] = [];
  Object.setPrototypeOf(snapshot, null);
  const length = values.length;
  for (let i = 0; i < length; i++) {
    const value = values[i];
    // Unlike slice, getters after an invalid entry are not invoked.
    if (!validEncoding(value)) return invalidArray;
    snapshot[i] = value;
  }
  return snapshot;
};
const snapshotOptionalArray = (values: string[] | undefined): string[] | undefined => values == null ? values : Array.isArray(values) ? snapshotArray(values) : invalidArray as string[];
const nonEmpty = (value: string, name: string) => {
  if (typeof value !== "string" || !value.trim()) throw new RequestError("invalid", `${name} is required`);
  return value.trim();
};

// The caller owns the pool and must initialize the store before use.
export class CentralRequests {
  constructor(private db: SQL, private now: () => Date = () => new Date()) {}

  async initialize(): Promise<void> {
    await this.db`CREATE TABLE IF NOT EXISTS central_runs (id TEXT PRIMARY KEY, orchestrator TEXT NOT NULL, phase TEXT NOT NULL, revision INTEGER NOT NULL, phase_status TEXT NOT NULL, updated_at TEXT NOT NULL)`;
    await this.db`CREATE TABLE IF NOT EXISTS central_requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES central_runs(id), phase TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, question TEXT NOT NULL, proposed_action TEXT NOT NULL, scope TEXT NOT NULL, evidence TEXT NOT NULL, allowed_responses TEXT NOT NULL, blocking BOOLEAN NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL, response TEXT, resolved_by TEXT, resolution_note TEXT, resolved_at TEXT, created_at TEXT NOT NULL)`;
    await this.db`CREATE TABLE IF NOT EXISTS central_request_events (seq BIGSERIAL PRIMARY KEY, request_id TEXT, run_id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL)`;
    await this.db`CREATE TABLE IF NOT EXISTS central_request_event_lock (id INTEGER PRIMARY KEY CHECK (id = 1))`;
    await this.db`INSERT INTO central_request_event_lock (id) VALUES (1) ON CONFLICT DO NOTHING`;
  }

  // Serialize event writers through commit so event cursors cannot skip uncommitted sequences.
  private async transaction<T>(fn: (tx: SQL) => Promise<T>, guard?: RequestMutationGuard): Promise<T> {
    return this.db.begin(async (tx) => {
      // Lock order: guard locks, event lock, then request/run locks.
      if (guard) await guard(tx as unknown as SQL);
      const rows = await tx`SELECT id FROM central_request_event_lock WHERE id = 1 FOR UPDATE`;
      if (!rows[0]) throw new Error("central request event lock row missing");
      return fn(tx as unknown as SQL);
    }) as Promise<T>;
  }

  private async getRun(db: SQL, id: string, lock = false): Promise<Run> {
    const rows = lock
      ? await db<Run[]>`SELECT id, orchestrator, phase, revision, phase_status AS "phaseStatus", updated_at AS "updatedAt" FROM central_runs WHERE id = ${id} FOR UPDATE`
      : await db<Run[]>`SELECT id, orchestrator, phase, revision, phase_status AS "phaseStatus", updated_at AS "updatedAt" FROM central_runs WHERE id = ${id}`;
    if (!rows[0]) throw new RequestError("not_found", `no run ${id}`);
    return rows[0];
  }

  private async getRequest(db: SQL, id: string, lock = false): Promise<SupervisorRequest> {
    const rows = lock
      ? await db<SupervisorRequest[]>`SELECT id, run_id AS "runId", phase, revision, kind, question, proposed_action AS "proposedAction", scope, evidence, allowed_responses AS "allowedResponses", blocking, origin, status, response, resolved_by AS "resolvedBy", resolution_note AS "resolutionNote", resolved_at AS "resolvedAt", created_at AS "createdAt" FROM central_requests WHERE id = ${id} FOR UPDATE`
      : await db<SupervisorRequest[]>`SELECT id, run_id AS "runId", phase, revision, kind, question, proposed_action AS "proposedAction", scope, evidence, allowed_responses AS "allowedResponses", blocking, origin, status, response, resolved_by AS "resolvedBy", resolution_note AS "resolutionNote", resolved_at AS "resolvedAt", created_at AS "createdAt" FROM central_requests WHERE id = ${id}`;
    if (!rows[0]) throw new RequestError("not_found", `no request ${id}`);
    return this.decode(rows[0]);
  }

  private decode(row: SupervisorRequest): SupervisorRequest {
    return { ...row, evidence: JSON.parse(row.evidence as unknown as string), allowedResponses: JSON.parse(row.allowedResponses as unknown as string) };
  }

  private async event(db: SQL, requestId: string | null, runId: string, kind: string, actor: string, detail: string, at: string) {
    await db`INSERT INTO central_request_events (request_id, run_id, kind, actor, detail, at) VALUES (${requestId}, ${runId}, ${kind}, ${actor}, ${detail}, ${at})`;
  }

  async registerRun(input: { runId: string; orchestrator: string; phase: string }, guard?: RequestMutationGuard): Promise<Run> {
    input = { runId: input.runId, orchestrator: input.orchestrator, phase: input.phase };
    const id = nonEmpty(input.runId, "runId"), actor = nonEmpty(input.orchestrator, "orchestrator");
    if (!validEncoding(id) || !validEncoding(actor)) throw new RequestError("invalid", "invalid request encoding");
    return this.transaction(async (tx) => {
      const existing = await tx<Run[]>`SELECT id, orchestrator, phase, revision, phase_status AS "phaseStatus", updated_at AS "updatedAt" FROM central_runs WHERE id = ${id} FOR UPDATE`;
      if (existing[0]) {
        if (existing[0].orchestrator !== actor) throw new RequestError("forbidden", guard ? "access denied" : `run ${id} belongs to orchestrator ${existing[0].orchestrator}`);
        return existing[0];
      }
      const phase = nonEmpty(input.phase, "phase");
      if (!validEncoding(phase)) throw new RequestError("invalid", "invalid request encoding");
      const at = this.now().toISOString();
      await tx`INSERT INTO central_runs VALUES (${id}, ${actor}, ${phase}, 1, 'planned', ${at})`;
      await this.event(tx, null, id, "run_registered", actor, `phase ${phase} revision 1`, at);
      return this.getRun(tx, id);
    }, guard);
  }

  async updatePhase(input: { runId: string; actor: string; expectedRevision: number; phase?: string; phaseStatus: string; newRevision: boolean }, guard?: RequestMutationGuard): Promise<{ run: Run; staled: string[] }> {
    input = { runId: input.runId, actor: input.actor, expectedRevision: input.expectedRevision, phase: input.phase, phaseStatus: input.phaseStatus, newRevision: input.newRevision };
    if (!validEncoding(input.runId)) throw new RequestError("invalid", "invalid request encoding");
    return this.transaction(async (tx) => {
      const run = await this.getRun(tx, input.runId, true);
      if (input.actor !== run.orchestrator) throw new RequestError("forbidden", guard ? "access denied" : `${input.actor} is not the orchestrator of ${run.id}`);
      if (input.expectedRevision !== run.revision) throw new RequestError("conflict", `run ${run.id} is at revision ${run.revision}, not ${input.expectedRevision}`);
      if (!validEncoding(input.actor) || (input.phase !== undefined && !validEncoding(input.phase)) || !validEncoding(input.phaseStatus)) throw new RequestError("invalid", "invalid request encoding");
      const phase = input.phase?.trim() || run.phase, changed = input.newRevision || phase !== run.phase;
      const revision = run.revision + (changed ? 1 : 0), status = nonEmpty(input.phaseStatus, "phaseStatus"), at = this.now().toISOString();
      await tx`UPDATE central_runs SET phase = ${phase}, revision = ${revision}, phase_status = ${status}, updated_at = ${at} WHERE id = ${run.id}`;
      await this.event(tx, null, run.id, "phase_updated", input.actor, `${phase} r${revision} ${status}`, at);
      const staled: string[] = [];
      if (changed) {
        const rows = await tx<{ id: string; revision: number }[]>`UPDATE central_requests SET status = 'stale' WHERE run_id = ${run.id} AND status = 'open' RETURNING id, revision`;
        for (const row of rows) {
          await this.event(tx, row.id, run.id, "stale", "service", `revision moved from ${row.revision} to ${revision}`, at);
          staled.push(row.id);
        }
      }
      return { run: await this.getRun(tx, run.id), staled };
    }, guard);
  }

  async create(input: CreateInput, guard?: RequestMutationGuard): Promise<SupervisorRequest> {
    input = { runId: input.runId, origin: input.origin, expectedRevision: input.expectedRevision, kind: input.kind, question: input.question, proposedAction: input.proposedAction, scope: input.scope, evidence: snapshotOptionalArray(input.evidence), allowedResponses: snapshotOptionalArray(input.allowedResponses), blocking: input.blocking };
    if (!validEncoding(input.runId)) throw new RequestError("invalid", "invalid request encoding");
    return this.transaction(async (tx) => {
      const run = await this.getRun(tx, input.runId, true);
      if (input.origin !== run.orchestrator) throw new RequestError("forbidden", guard ? "access denied" : `${input.origin} is not the orchestrator of ${run.id}`);
      if (input.expectedRevision !== run.revision) throw new RequestError("conflict", `run ${run.id} is at revision ${run.revision}, not ${input.expectedRevision}`);
      if (!["approval", "clarification", "scope_change", "blocker"].includes(input.kind)) throw new RequestError("invalid", "invalid request kind");
      if (!validEncoding(input.origin) || !validEncoding(input.question) || (input.proposedAction != null && !validEncoding(input.proposedAction)) || (input.scope != null && !validEncoding(input.scope)) || (input.evidence != null && !validArrayEncoding(input.evidence)) || (input.allowedResponses != null && !validArrayEncoding(input.allowedResponses))) throw new RequestError("invalid", "invalid request encoding");
      const allowed = input.allowedResponses?.length ? input.allowedResponses : snapshotArray(input.kind === "approval" ? ["approve", "decline"] : ["answer"]);
      const id = `req-${crypto.randomUUID()}`, at = this.now().toISOString(), question = nonEmpty(input.question, "question");
      await tx`INSERT INTO central_requests (id, run_id, phase, revision, kind, question, proposed_action, scope, evidence, allowed_responses, blocking, origin, status, created_at) VALUES (${id}, ${run.id}, ${run.phase}, ${run.revision}, ${input.kind}, ${question}, ${input.proposedAction ?? ""}, ${input.scope ?? ""}, ${JSON.stringify(input.evidence ?? snapshotArray([]))}, ${JSON.stringify(allowed)}, ${input.blocking !== false}, ${input.origin}, 'open', ${at})`;
      await this.event(tx, id, run.id, "opened", input.origin, `${input.kind} for ${run.phase} r${run.revision}`, at);
      return this.getRequest(tx, id);
    }, guard);
  }

  async resolve(input: { requestId: string; response: string; actor: string; expectedRevision: number; note?: string }): Promise<SupervisorRequest> {
    input = { requestId: input.requestId, response: input.response, actor: input.actor, expectedRevision: input.expectedRevision, note: input.note };
    if (!validEncoding(input.requestId)) throw new RequestError("invalid", "invalid request encoding");
    return this.transaction(async (tx) => {
      const r = await this.getRequest(tx, input.requestId, true), run = await this.getRun(tx, r.runId, true), actor = nonEmpty(input.actor, "actor"), note = input.note ?? "";
      if (input.expectedRevision !== r.revision || run.revision !== r.revision || run.phase !== r.phase) throw new RequestError("conflict", `${r.id} has a stale revision`);
      if (r.status === "resolved" || r.status === "acknowledged") {
        if (r.response === input.response && r.resolvedBy === actor && r.resolutionNote === note) return r;
        throw new RequestError("conflict", `${r.id} was already answered`);
      }
      if (r.status !== "open") throw new RequestError("conflict", `${r.id} is ${r.status}; it cannot be answered`);
      if (!r.allowedResponses.includes(input.response)) throw new RequestError("invalid", `response must be one of ${r.allowedResponses.join(", ")}`);
      if (!validEncoding(actor) || !validEncoding(input.response) || !validEncoding(note)) throw new RequestError("invalid", "invalid request encoding");
      const at = this.now().toISOString();
      await tx`UPDATE central_requests SET status = 'resolved', response = ${input.response}, resolved_by = ${actor}, resolution_note = ${note}, resolved_at = ${at} WHERE id = ${r.id}`;
      await this.event(tx, r.id, r.runId, "resolved", actor, `${input.response}${input.note ? `: ${input.note}` : ""}`, at);
      return this.getRequest(tx, r.id);
    });
  }

  async acknowledge(input: { requestId: string; actor: string }, guard?: RequestMutationGuard): Promise<SupervisorRequest> {
    return this.changeStatus(input, "acknowledged", undefined, guard);
  }

  async withdraw(input: { requestId: string; actor: string; reason: string }, guard?: RequestMutationGuard): Promise<SupervisorRequest> {
    return this.changeStatus(input, "withdrawn", input.reason, guard);
  }

  private async changeStatus(input: { requestId: string; actor: string }, status: "acknowledged" | "withdrawn", reason?: string, guard?: RequestMutationGuard): Promise<SupervisorRequest> {
    input = { requestId: input.requestId, actor: input.actor };
    if (!validEncoding(input.requestId)) throw new RequestError("invalid", "invalid request encoding");
    return this.transaction(async (tx) => {
      const r = await this.getRequest(tx, input.requestId, true), run = await this.getRun(tx, r.runId, true);
      if (input.actor !== run.orchestrator) throw new RequestError("forbidden", guard ? "access denied" : `${input.actor} is not the orchestrator of ${run.id}`);
      if (status === "acknowledged" && r.status === "acknowledged") return r;
      if (r.status !== (status === "acknowledged" ? "resolved" : "open")) throw new RequestError("conflict", `${r.id} is ${r.status}; cannot become ${status}`);
      if (!validEncoding(input.actor)) throw new RequestError("invalid", "invalid request encoding");
      const detail = status === "withdrawn" ? nonEmpty(reason!, "reason") : `read answer "${r.response}"`;
      if (status === "withdrawn" && !validEncoding(detail)) throw new RequestError("invalid", "invalid request encoding");
      await tx`UPDATE central_requests SET status = ${status} WHERE id = ${r.id}`;
      await this.event(tx, r.id, r.runId, status, input.actor, detail, this.now().toISOString());
      return this.getRequest(tx, r.id);
    }, guard);
  }

  async gate(runId: string, phase: string, revision: number): Promise<{ approved: boolean; reason: string; requestId: string | null }> {
    return this.readGate(runId, phase, revision);
  }

  // The caller must derive owner from the authenticated principal, not request input.
  // The guard must fence that same principal using this transaction.
  async gateScoped(runId: string, phase: string, revision: number, owner: string, guard: RequestMutationGuard): Promise<{ approved: boolean; reason: string; requestId: string | null }> {
    if (typeof guard !== "function") throw new RequestError("forbidden", "access denied");
    return this.readGate(runId, phase, revision, { owner, guard });
  }

  private async readGate(runId: string, phase: string, revision: number, scope?: { owner: string; guard: RequestMutationGuard }): Promise<{ approved: boolean; reason: string; requestId: string | null }> {
    if (!validEncoding(runId) || !validEncoding(phase) || (scope && !validEncoding(scope.owner))) throw new RequestError("invalid", "invalid request encoding");
    return this.transaction(async (tx) => {
      const run = await this.getRun(tx, runId, true);
      if (scope && run.orchestrator !== scope.owner) throw new RequestError("forbidden", "access denied");
      if (run.phase !== phase || run.revision !== revision) return { approved: false, reason: `run is at ${run.phase} r${run.revision}, not ${phase} r${revision}`, requestId: null };
      // The display limit must not hide a decline or open approval from the gate.
      const [request] = await tx<{ id: string; status: RequestStatus; response: string | null; resolvedBy: string | null }[]>`SELECT id, status, response, resolved_by AS "resolvedBy" FROM central_requests WHERE run_id = ${runId} AND phase = ${phase} AND revision = ${revision} AND kind = 'approval' AND (response = 'decline' OR status = 'open' OR (status IN ('resolved', 'acknowledged') AND response = 'approve')) ORDER BY CASE WHEN response = 'decline' THEN 0 WHEN status = 'open' THEN 1 ELSE 2 END, created_at, id LIMIT 1`;
      if (request?.response === "decline") return { approved: false, reason: `declined by ${request.resolvedBy}`, requestId: request.id };
      if (request?.status === "open") return { approved: false, reason: "approval requested, no answer yet", requestId: request.id };
      if (request) return { approved: true, reason: `approved by ${request.resolvedBy}`, requestId: request.id };
      return { approved: false, reason: "no approval request for this revision", requestId: null };
    }, scope?.guard);
  }

  async run(id: string): Promise<Run> {
    if (!validEncoding(id)) throw new RequestError("invalid", "invalid request encoding");
    return this.getRun(this.db, id);
  }
  async runs(): Promise<Run[]> { return this.db<Run[]>`SELECT id, orchestrator, phase, revision, phase_status AS "phaseStatus", updated_at AS "updatedAt" FROM central_runs ORDER BY id`; }
  async get(id: string): Promise<SupervisorRequest> {
    if (!validEncoding(id)) throw new RequestError("invalid", "invalid request encoding");
    return this.getRequest(this.db, id);
  }
  async list(filter: { runId?: string; status?: RequestStatus; limit?: number; cursor?: string } = {}): Promise<{ requests: SupervisorRequest[]; nextCursor: string | null }> {
    const runId = filter.runId ?? null, status = filter.status ?? null, limit = filter.limit ?? 100;
    if ([runId, status].some((value) => value !== null && (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")))) throw new RequestError("invalid", "invalid request filter encoding");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RequestError("invalid", "limit must be between 1 and 1000");
    let after: { createdAt: string; id: string } | null = null;
    if (filter.cursor !== undefined) {
      try {
        if (filter.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(filter.cursor)) throw new Error();
        const text = Buffer.from(filter.cursor, "base64url").toString("utf8");
        if (Buffer.from(text).toString("base64url") !== filter.cursor) throw new Error();
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed) || parsed.length !== 4 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string" || !/^(?:\d{4}|[+-]\d{6})-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed[0]) || new Date(parsed[0]).toISOString() !== parsed[0] || !/^req-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed[1]) || parsed[2] !== runId || parsed[3] !== status || (typeof parsed[2] === "string" && parsed[2].includes("\0")) || (typeof parsed[3] === "string" && parsed[3].includes("\0"))) throw new Error();
        after = { createdAt: parsed[0], id: parsed[1] };
      } catch { throw new RequestError("invalid", "invalid cursor or cursor filter mismatch"); }
    }
    const createdAt = after?.createdAt ?? null, id = after?.id ?? null;
    const rows = await this.db<SupervisorRequest[]>`SELECT id, run_id AS "runId", phase, revision, kind, question, proposed_action AS "proposedAction", scope, evidence, allowed_responses AS "allowedResponses", blocking, origin, status, response, resolved_by AS "resolvedBy", resolution_note AS "resolutionNote", resolved_at AS "resolvedAt", created_at AS "createdAt" FROM central_requests WHERE (${runId}::text IS NULL OR run_id = ${runId}) AND (${status}::text IS NULL OR status = ${status}) AND (${createdAt}::text IS NULL OR (created_at, id) > (${createdAt}, ${id})) ORDER BY created_at, id LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit).map((r) => this.decode(r));
    const last = page.at(-1);
    const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify([last.createdAt, last.id, runId, status])).toString("base64url") : null;
    return { requests: page, nextCursor };
  }
  async events(afterSeq = "0"): Promise<Event[]> {
    if (typeof afterSeq !== "string" || !/^(0|[1-9][0-9]*)$/.test(afterSeq) || afterSeq.length > 19 || (afterSeq.length === 19 && afterSeq > "9223372036854775807")) throw new RequestError("invalid", "invalid event cursor");
    return this.db<Event[]>`SELECT seq::text AS seq, request_id AS "requestId", run_id AS "runId", kind, actor, detail, at FROM central_request_events WHERE seq > ${afterSeq}::bigint ORDER BY central_request_events.seq`;
  }
}

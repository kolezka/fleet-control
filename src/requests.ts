// Supervisor requests and their resolutions, bound to run, phase and revision.
// The phase record has one writer: the orchestrator registered for the run. A new revision makes
// every open request for the older revision stale, so an old approval can never apply to new work.
import type { Database } from "bun:sqlite";

export type RequestKind = "approval" | "clarification" | "scope_change" | "blocker";
export type RequestStatus = "open" | "resolved" | "acknowledged" | "stale" | "withdrawn";

export type Run = { id: string; orchestrator: string; phase: string; revision: number; phaseStatus: string; updatedAt: string };

export type SupervisorRequest = {
  id: string;
  runId: string;
  phase: string;
  revision: number;
  kind: RequestKind;
  question: string;
  proposedAction: string;
  scope: string;
  evidence: string[];
  allowedResponses: string[];
  blocking: boolean;
  origin: string;
  status: RequestStatus;
  response: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

export class RequestError extends Error {
  constructor(readonly kind: "not_found" | "conflict" | "invalid" | "forbidden", message: string) {
    super(message);
  }
}

type Row = Omit<SupervisorRequest, "evidence" | "allowedResponses" | "blocking"> & { evidence: string; allowedResponses: string; blocking: number };
const decode = (r: Row): SupervisorRequest => ({ ...r, evidence: JSON.parse(r.evidence), allowedResponses: JSON.parse(r.allowedResponses), blocking: r.blocking === 1 });
const nonEmpty = (v: string, name: string) => {
  if (!v.trim()) throw new RequestError("invalid", `${name} is required`);
  return v.trim();
};

function serializeEvidence(value: string[] | undefined): string {
  const json = JSON.stringify(value ?? []);
  const decoded: unknown = json === undefined ? undefined : JSON.parse(json);
  if (!Array.isArray(decoded) || !decoded.every((entry) => typeof entry === "string" && entry.isWellFormed())) {
    throw new RequestError("invalid", "invalid request evidence");
  }
  return json!;
}

export class Requests {
  constructor(private db: Database, private now: () => Date = () => new Date()) {
    db.run(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      orchestrator TEXT NOT NULL,
      phase TEXT NOT NULL,
      revision INTEGER NOT NULL,
      phase_status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      phase TEXT NOT NULL,
      revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      question TEXT NOT NULL,
      proposed_action TEXT NOT NULL,
      scope TEXT NOT NULL,
      evidence TEXT NOT NULL,
      allowed_responses TEXT NOT NULL,
      blocking INTEGER NOT NULL,
      origin TEXT NOT NULL,
      status TEXT NOT NULL,
      response TEXT,
      resolved_by TEXT,
      resolution_note TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS request_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail TEXT NOT NULL,
      at TEXT NOT NULL
    )`);
  }

  // Registers a run once. The orchestrator named here is the only actor allowed to change its phase record.
  registerRun(input: { runId: string; orchestrator: string; phase: string }): Run {
    const runId = nonEmpty(input.runId, "runId");
    const orchestrator = nonEmpty(input.orchestrator, "orchestrator");
    return this.db.transaction(() => {
      const existing = this.findRun(runId);
      if (existing) {
        if (existing.orchestrator !== orchestrator) throw new RequestError("forbidden", `run ${runId} belongs to orchestrator ${existing.orchestrator}`);
        return existing;
      }
      if (!orchestrator.isWellFormed()) throw new RequestError("invalid", "invalid orchestrator encoding");
      const phase = input.phase;
      if (!phase.isWellFormed()) throw new RequestError("invalid", "invalid phase encoding");
      const at = this.now().toISOString();
      this.db.query("INSERT INTO runs (id, orchestrator, phase, revision, phase_status, updated_at) VALUES (?, ?, ?, 1, 'planned', ?)")
        .run(runId, orchestrator, nonEmpty(phase, "phase"), at);
      this.event(null, runId, "run_registered", orchestrator, `phase ${phase} revision 1`, at);
      return this.run(runId);
    })();
  }

  // The single writer path for phase state. expectedRevision guards against two writers racing.
  updatePhase(input: { runId: string; actor: string; expectedRevision: number; phase?: string; phaseStatus: string; newRevision: boolean }): { run: Run; staled: string[] } {
    const actor = input.actor;
    return this.db.transaction(() => {
      const run = this.run(input.runId);
      if (actor !== run.orchestrator) throw new RequestError("forbidden", `${actor} is not the orchestrator of ${run.id}`);
      if (input.expectedRevision !== run.revision) {
        throw new RequestError("conflict", `run ${run.id} is at revision ${run.revision}, not ${input.expectedRevision}`);
      }
      const requestedPhase = input.phase;
      const phaseStatus = input.phaseStatus;
      if ((requestedPhase != null && !requestedPhase.isWellFormed()) || !phaseStatus.isWellFormed()) {
        throw new RequestError("invalid", "invalid phase encoding");
      }
      const phase = requestedPhase?.trim() || run.phase;
      const changesWork = input.newRevision || phase !== run.phase;
      const revision = changesWork ? run.revision + 1 : run.revision;
      const at = this.now().toISOString();
      this.db.query("UPDATE runs SET phase = ?, revision = ?, phase_status = ?, updated_at = ? WHERE id = ?")
        .run(phase, revision, nonEmpty(phaseStatus, "phaseStatus"), at, run.id);
      this.event(null, run.id, "phase_updated", actor, `${phase} r${revision} ${phaseStatus}`, at);
      const staled: string[] = [];
      if (changesWork) {
        for (const r of this.list({ runId: run.id, status: "open" })) {
          this.setStatus(r.id, "stale");
          this.event(r.id, run.id, "stale", "service", `revision moved from ${r.revision} to ${revision}`, at);
          staled.push(r.id);
        }
      }
      return { run: this.run(run.id), staled };
    })();
  }

  create(input: {
    runId: string; origin: string; expectedRevision: number; kind: RequestKind; question: string;
    proposedAction?: string; scope?: string; evidence?: string[]; allowedResponses?: string[]; blocking?: boolean;
  }): SupervisorRequest {
    return this.db.transaction(() => {
      const run = this.run(input.runId);
      const origin = input.origin;
      if (origin !== run.orchestrator) throw new RequestError("forbidden", `${origin} is not the orchestrator of ${run.id}`);
      if (input.expectedRevision !== run.revision) {
        throw new RequestError("conflict", `run ${run.id} is at revision ${run.revision}, not ${input.expectedRevision}`);
      }
      const kind = input.kind;
      const allowed = input.allowedResponses?.length ? input.allowedResponses : kind === "approval" ? ["approve", "decline"] : ["answer"];
      const question = input.question;
      if (!question.isWellFormed()) throw new RequestError("invalid", "invalid request text encoding");
      const normalizedQuestion = nonEmpty(question, "question");
      const proposedAction = input.proposedAction;
      if (proposedAction != null && !proposedAction.isWellFormed()) throw new RequestError("invalid", "invalid request text encoding");
      const scope = input.scope;
      if (scope != null && !scope.isWellFormed()) throw new RequestError("invalid", "invalid request text encoding");
      const id = `req-${crypto.randomUUID()}`;
      const at = this.now().toISOString();
      this.db.query(`INSERT INTO requests (id, run_id, phase, revision, kind, question, proposed_action, scope, evidence,
          allowed_responses, blocking, origin, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
        .run(id, run.id, run.phase, run.revision, kind, normalizedQuestion, proposedAction ?? "",
          scope ?? "", serializeEvidence(input.evidence), JSON.stringify(allowed), input.blocking === false ? 0 : 1, origin, at);
      this.event(id, run.id, "opened", origin, `${kind} for ${run.phase} r${run.revision}`, at);
      return this.get(id);
    })();
  }

  // A human answer. Applies only to the named request at the named revision; a second answer conflicts.
  resolve(input: { requestId: string; response: string; actor: string; expectedRevision: number; note?: string }): SupervisorRequest {
    return this.db.transaction(() => {
      const r = this.get(input.requestId);
      const actor = nonEmpty(input.actor, "actor");
      if (r.status === "resolved" || r.status === "acknowledged") {
        if (r.response === input.response && r.resolvedBy === actor && r.revision === input.expectedRevision && (r.resolutionNote ?? "") === (input.note ?? "")) return r;
        throw new RequestError("conflict", `${r.id} was already answered "${r.response}" by ${r.resolvedBy} at ${r.resolvedAt}`);
      }
      if (r.status !== "open") throw new RequestError("conflict", `${r.id} is ${r.status}; it cannot be answered`);
      if (input.expectedRevision !== r.revision) {
        throw new RequestError("conflict", `${r.id} is for revision ${r.revision}, the answer named revision ${input.expectedRevision}`);
      }
      const response = input.response;
      if (!r.allowedResponses.includes(response)) {
        throw new RequestError("invalid", `response must be one of ${r.allowedResponses.join(", ")}`);
      }
      const at = this.now().toISOString();
      const note = input.note;
      if (!actor.isWellFormed() || (note != null && !note.isWellFormed())) {
        throw new RequestError("invalid", "invalid resolution metadata encoding");
      }
      this.db.query("UPDATE requests SET status = 'resolved', response = ?, resolved_by = ?, resolution_note = ?, resolved_at = ? WHERE id = ?")
        .run(response, actor, note ?? "", at, r.id);
      this.event(r.id, r.runId, "resolved", actor, `${response}${note ? `: ${note}` : ""}`, at);
      return this.get(r.id);
    })();
  }

  // The orchestrator confirms it has read the answer. This is not evidence that the next phase started.
  acknowledge(input: { requestId: string; actor: string }): SupervisorRequest {
    return this.db.transaction(() => {
      const r = this.get(input.requestId);
      const run = this.run(r.runId);
      const actor = input.actor;
      if (actor !== run.orchestrator) throw new RequestError("forbidden", `${actor} is not the orchestrator of ${run.id}`);
      if (r.status === "acknowledged") return r;
      if (r.status !== "resolved") throw new RequestError("conflict", `${r.id} is ${r.status}; only a resolved request can be acknowledged`);
      this.setStatus(r.id, "acknowledged");
      this.event(r.id, r.runId, "acknowledged", actor, `read answer "${r.response}"`, this.now().toISOString());
      return this.get(r.id);
    })();
  }

  withdraw(input: { requestId: string; actor: string; reason: string }): SupervisorRequest {
    return this.db.transaction(() => {
      const r = this.get(input.requestId);
      const actor = input.actor;
      if (actor !== this.run(r.runId).orchestrator) throw new RequestError("forbidden", `${actor} is not the orchestrator of ${r.runId}`);
      if (r.status !== "open") throw new RequestError("conflict", `${r.id} is ${r.status}; only an open request can be withdrawn`);
      const reason = input.reason;
      if (!reason.isWellFormed()) throw new RequestError("invalid", "invalid reason encoding");
      this.setStatus(r.id, "withdrawn");
      this.event(r.id, r.runId, "withdrawn", actor, nonEmpty(reason, "reason"), this.now().toISOString());
      return this.get(r.id);
    })();
  }

  // The result reflects recorded responses, not proof of human authority.
  gate(runId: string, phase: string, revision: number): { approved: boolean; reason: string; requestId: string | null } {
    return this.db.transaction(() => {
      const run = this.run(runId);
      if (run.phase !== phase || run.revision !== revision) {
        return { approved: false, reason: `run is at ${run.phase} r${run.revision}, not ${phase} r${revision}`, requestId: null };
      }
      const reqs = this.list({ runId }).filter((r) => r.kind === "approval" && r.phase === phase && r.revision === revision);
      const declined = reqs.find((r) => r.response === "decline");
      if (declined) return { approved: false, reason: `declined by ${declined.resolvedBy}`, requestId: declined.id };
      const approved = reqs.find((r) => (r.status === "resolved" || r.status === "acknowledged") && r.response === "approve");
      if (approved) return { approved: true, reason: `approved by ${approved.resolvedBy}`, requestId: approved.id };
      const open = reqs.find((r) => r.status === "open");
      return { approved: false, reason: open ? "approval requested, no answer yet" : "no approval request for this revision", requestId: open?.id ?? null };
    })();
  }

  run(id: string): Run {
    const r = this.findRun(id);
    if (!r) throw new RequestError("not_found", `no run ${id}`);
    return r;
  }

  runs(): Run[] {
    return this.db.query<Run, []>(`${runSelect} ORDER BY id`).all();
  }

  get(id: string): SupervisorRequest {
    if (!id.isWellFormed()) throw new RequestError("invalid", "invalid requestId encoding");
    const r = this.db.query<Row, [string]>(`${reqSelect} WHERE id = ?`).get(id);
    if (!r) throw new RequestError("not_found", `no request ${id}`);
    return decode(r);
  }

  list(filter: { runId?: string; status?: RequestStatus } = {}): SupervisorRequest[] {
    const runId = filter.runId;
    if (runId != null && !runId.isWellFormed()) throw new RequestError("invalid", "invalid runId encoding");
    return this.db.query<Row, [string | null, string | null]>(
      `${reqSelect} WHERE (?1 IS NULL OR run_id = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY created_at, id`,
    ).all(runId ?? null, filter.status ?? null).map(decode);
  }

  events(afterSeq = 0) {
    return this.db.query<{ seq: number; requestId: string | null; runId: string; kind: string; actor: string; detail: string; at: string }, [number]>(
      "SELECT seq, request_id AS requestId, run_id AS runId, kind, actor, detail, at FROM request_events WHERE seq > ? ORDER BY seq",
    ).all(afterSeq);
  }

  private findRun(id: string): Run | null {
    if (!id.isWellFormed()) throw new RequestError("invalid", "invalid runId encoding");
    return this.db.query<Run, [string]>(`${runSelect} WHERE id = ?`).get(id) ?? null;
  }

  private setStatus(id: string, status: RequestStatus) {
    this.db.query("UPDATE requests SET status = ? WHERE id = ?").run(status, id);
  }

  private event(requestId: string | null, runId: string, kind: string, actor: string, detail: string, at: string) {
    this.db.query("INSERT INTO request_events (request_id, run_id, kind, actor, detail, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(requestId, runId, kind, actor, detail, at);
  }
}

const runSelect = "SELECT id, orchestrator, phase, revision, phase_status AS phaseStatus, updated_at AS updatedAt FROM runs";
const reqSelect = `SELECT id, run_id AS runId, phase, revision, kind, question, proposed_action AS proposedAction, scope, evidence,
  allowed_responses AS allowedResponses, blocking, origin, status, response, resolved_by AS resolvedBy,
  resolution_note AS resolutionNote, resolved_at AS resolvedAt, created_at AS createdAt FROM requests`;

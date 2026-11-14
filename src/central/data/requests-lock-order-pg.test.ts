import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralRequests } from "./requests.ts";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "../test-database-url.ts";

// PostgreSQL check of the lock order in CentralRequests. A phase update locks the run and then
// its open requests; an answer or a withdrawal locks the request and then its run. Only the shared
// event lock, taken first, keeps those two orders from deadlocking.

type Step = "run" | "request";
type Trace = { pid: number; reached: Promise<void>; release: () => void };

// Wraps a client so one store call can be held right after it takes its first row lock.
// With skipEventLock the event lock query is answered locally and never reaches PostgreSQL.
function instrument(db: SQL, pauseAfter: Step, skipEventLock: boolean): { db: SQL; trace: Trace } {
  let reached!: () => void, release!: () => void;
  const trace: Trace = { pid: 0, reached: new Promise<void>((resolve) => { reached = resolve; }), release: () => {} };
  const released = new Promise<void>((resolve) => { release = resolve; });
  trace.release = release;
  const wrap = (tx: SQL) => new Proxy(tx, {
    apply(target, self, args: [TemplateStringsArray, ...unknown[]]) {
      const text = args[0].join("?");
      if (text.includes("central_request_event_lock")) {
        // Record the backend before it can block, so the observer can watch it wait.
        return (async () => {
          trace.pid = (await target<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
          return skipEventLock ? [{ id: 1 }] : await Reflect.apply(target, self, args);
        })();
      }
      const first = text.includes("FOR UPDATE") && text.includes(pauseAfter === "run" ? "FROM central_runs" : "FROM central_requests");
      if (!first) return Reflect.apply(target, self, args);
      return (async () => {
        const rows = await Reflect.apply(target, self, args);
        reached();
        await released;
        return rows;
      })();
    },
  });
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === "begin") return (fn: (tx: SQL) => Promise<unknown>) => target.begin((tx) => fn(wrap(tx as unknown as SQL)));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy as SQL, trace };
}

const sqlState = (result: PromiseSettledResult<unknown>) => result.status === "rejected" ? (result.reason as { errno?: string; code?: string })?.errno ?? (result.reason as { code?: string })?.code : undefined;
const errorKind = (result: PromiseSettledResult<unknown>) => result.status === "rejected" ? (result.reason as { kind?: string })?.kind : undefined;

// These tests leave no rows behind; they run only against the supplied disposable database.
const url = centralTestDatabaseUrl(process.env);
const integration = url ? test : test.skip;
const connect = () => withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));

type Side = { store: CentralRequests; trace: Trace };
type Context = { plain: CentralRequests; observer: SQL; runId: string; requestId: string; side: (pauseAfter: Step, skipEventLock: boolean) => Side; start: <T>(work: Promise<T>) => Promise<T> };

// A wait that should be short. Failing here, instead of at the test timeout, lets cleanup run.
async function within<T>(work: Promise<T>, what: string, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); })]);
  } finally { clearTimeout(timer); }
}

async function scenario(run: (ctx: Context) => Promise<void>) {
  const observer = connect(), clients = [connect(), connect()], plain = new CentralRequests(observer), runId = `test-lock-order-${crypto.randomUUID()}`;
  const traces: Trace[] = [], started: Promise<unknown>[] = [];
  const side = (pauseAfter: Step, skipEventLock: boolean): Side => {
    const wrapped = instrument(clients[traces.length]!, pauseAfter, skipEventLock);
    traces.push(wrapped.trace);
    return { store: new CentralRequests(wrapped.db), trace: wrapped.trace };
  };
  const start = <T>(work: Promise<T>): Promise<T> => { started.push(work.catch(() => {})); return work; };
  try {
    await plain.initialize();
    await plain.registerRun({ runId, orchestrator: "orch", phase: "plan" });
    const request = await plain.create({ runId, origin: "orch", expectedRevision: 1, kind: "approval", question: "Proceed?" });
    await run({ plain, observer, runId, requestId: request.id, side, start });
  } finally {
    // Let held transactions finish first, or the cleanup below would wait on their row locks.
    for (const trace of traces) trace.release();
    await Promise.all(started);
    await observer`DELETE FROM central_request_events WHERE run_id = ${runId}`.catch(() => {});
    await observer`DELETE FROM central_requests WHERE run_id = ${runId}`.catch(() => {});
    await observer`DELETE FROM central_runs WHERE id = ${runId}`.catch(() => {});
    await Promise.all([observer, ...clients].map((client) => client.close()));
  }
}

// Polls until the backend is blocked on a lock; fails the test if it never is.
async function waitsOnLock(observer: SQL, trace: Trace): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (trace.pid) {
      const rows = await observer<{ waiting: boolean }[]>`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${trace.pid}`;
      if (rows[0]?.waiting) return;
    }
    await Bun.sleep(25);
  }
  throw new Error("backend never waited on a lock");
}

const requestSide = {
  answer: (store: CentralRequests, requestId: string) => store.resolve({ requestId, actor: "human", response: "approve", expectedRevision: 1 }),
  withdrawal: (store: CentralRequests, requestId: string) => store.withdraw({ requestId, actor: "orch", reason: "no longer needed" }),
};

const updatePhase = (store: CentralRequests, runId: string) => store.updatePhase({ runId, actor: "orch", expectedRevision: 1, phaseStatus: "planned", newRevision: true });

for (const [name, act] of Object.entries(requestSide)) {
  integration(`without the event lock a phase update and a request ${name} deadlock in PostgreSQL`, async () => {
    await scenario(async ({ runId, requestId, side, start }) => {
      const phase = side("run", true), request = side("request", true);
      const pending = Promise.allSettled([start(updatePhase(phase.store, runId)), start(act(request.store, requestId))]);
      // Each side holds its first row lock before either asks for the other's.
      await within(Promise.all([phase.trace.reached, request.trace.reached]), "both first row locks");
      phase.trace.release();
      request.trace.release();
      const results = await within(pending, "the deadlock to be broken");
      // PostgreSQL breaks the cycle by aborting one of the two; the other then finishes.
      // Detection takes deadlock_timeout (1 s by default), well inside the 5 s wait above.
      expect(results.map(sqlState).filter((state) => state === "40P01")).toHaveLength(1);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    });
  }, 30_000);

  integration(`the event lock makes a request ${name} wait for a phase update that started first`, async () => {
    await scenario(async ({ plain, observer, runId, requestId, side, start }) => {
      const phase = side("run", false), request = side("request", false);
      const first = start(updatePhase(phase.store, runId));
      await within(phase.trace.reached, "the run lock");
      let requestLocked = false;
      void request.trace.reached.then(() => { requestLocked = true; });
      const second = start(act(request.store, requestId));
      await waitsOnLock(observer, request.trace);
      expect(requestLocked).toBe(false);
      phase.trace.release();
      request.trace.release();
      const results = await within(Promise.allSettled([first, second]), "both calls to finish");
      expect(results.map(sqlState)).not.toContain("40P01");
      expect(results[0]!.status).toBe("fulfilled");
      // The request went stale under the new revision, so the late change is refused, not lost.
      expect(errorKind(results[1]!)).toBe("conflict");
      expect((await plain.get(requestId)).status).toBe("stale");
      expect((await plain.run(runId)).revision).toBe(2);
    });
  }, 30_000);

  integration(`the event lock makes a phase update wait for a request ${name} that started first`, async () => {
    await scenario(async ({ plain, observer, runId, requestId, side, start }) => {
      const phase = side("run", false), request = side("request", false);
      const first = start(act(request.store, requestId));
      await within(request.trace.reached, "the request lock");
      let runLocked = false;
      void phase.trace.reached.then(() => { runLocked = true; });
      const second = start(updatePhase(phase.store, runId));
      await waitsOnLock(observer, phase.trace);
      expect(runLocked).toBe(false);
      request.trace.release();
      phase.trace.release();
      const results = await within(Promise.allSettled([first, second]), "both calls to finish");
      expect(results.map(sqlState)).not.toContain("40P01");
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect((await plain.get(requestId)).status).toBe(name === "answer" ? "resolved" : "withdrawn");
      expect((await plain.run(runId)).revision).toBe(2);
    });
  }, 30_000);
}

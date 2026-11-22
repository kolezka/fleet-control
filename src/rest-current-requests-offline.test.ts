import { afterAll, beforeAll, expect, test } from "bun:test";
import { Commands } from "./data/commands.ts";
import { Requests } from "./data/requests.ts";
import { Deliverer } from "./application/delivery.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";
import { currentRun } from "../web/host-state.ts";

// view=current must give the page exactly what it renders from the full list, without the history.
const fleet = { screen: async () => "", status: async () => ({ sessions: [] }) } as never;
let server: ReturnType<typeof serve>;
let requests: Requests;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++));

// What web/app.ts derives from { runs, requests }: the run updated last, approvals of its phase and revision, open or newest request.
function shown(body: { runs: any[]; requests: any[] }) {
  const run = currentRun(body.runs);
  const open = body.requests.filter((q) => q.status === "open");
  return {
    run: run?.id ?? null,
    approvals: run ? body.requests.filter((r) => r.runId === run.id && r.phase === run.phase && r.revision === run.revision && r.kind === "approval").map((r) => r.id) : [],
    requests: (open.length ? open : body.requests.slice(-1)).map((r) => r.id),
  };
}

beforeAll(() => {
  const store = new Store(":memory:");
  const commands = new Commands(store.db, clock);
  requests = new Requests(store.db, clock);
  server = serve({ fleet, store, control: { commands, deliverer: new Deliverer(commands, async () => ({ exitCode: 1, stdout: "", stderr: "" })), requests } }, 0);
});
afterAll(() => server.stop(true));

const get = async (path: string) => { const r = await fetch(new URL(path, server.url)); return { status: r.status, body: await r.json() as any }; };

test("an empty store gives an empty current view", async () => {
  expect((await get("/api/requests?view=current")).body).toEqual({ runs: [], requests: [] });
});

test("current view matches what the page shows from the full list as history grows", async () => {
  requests.registerRun({ runId: "run-a", orchestrator: "orch", phase: "one" });
  requests.registerRun({ runId: "run-b", orchestrator: "orch", phase: "one" });
  const make = (runId: string, kind: "approval" | "clarification", n: number) =>
    requests.create({ runId, origin: "orch", expectedRevision: 1, kind, question: `q${n}` });
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push(make(i % 2 ? "run-b" : "run-a", i % 3 ? "clarification" : "approval", i).id);
  const check = async () => {
    const full = (await get("/api/requests")).body, current = (await get("/api/requests?view=current")).body;
    expect(shown(current)).toEqual(shown(full));
    expect(current.requests.length).toBeLessThanOrEqual(full.requests.length);
    return current;
  };
  await check();
  for (const id of ids.slice(0, 10)) requests.withdraw({ requestId: id, actor: "orch", reason: "done" });
  const fewer = await check();
  expect(fewer.requests.length).toBeLessThan(12);
  for (const id of ids.slice(10)) requests.withdraw({ requestId: id, actor: "orch", reason: "done" });
  const none = await check();
  expect(shown(none).requests).toEqual([ids[11]]);
  requests.updatePhase({ runId: "run-b", actor: "orch", expectedRevision: 1, phase: "two", phaseStatus: "working", newRevision: true });
  await check();
  // A run updated later wins even when its id sorts first.
  requests.updatePhase({ runId: "run-a", actor: "orch", expectedRevision: 1, phase: "two", phaseStatus: "working", newRevision: false });
  const later = await check();
  expect(later.runs.map((r: any) => r.id)).toEqual(["run-a"]);
});

test("view refuses other values and mixing with paging", async () => {
  for (const q of ["view=all", "view=", "view=current&view=current", "view=current&limit=2", "view=current&cursor=abc", "view=current&x=1"]) {
    const r = await get("/api/requests?" + q);
    expect([q, r.status, r.body.error.kind]).toEqual([q, 400, "invalid"]);
  }
});

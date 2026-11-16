import { afterAll, beforeAll, expect, test } from "bun:test";
import { Commands } from "./data/commands.ts";
import { Requests } from "./data/requests.ts";
import { Deliverer } from "./application/delivery.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";

// REST lists page on request; without limit or cursor they keep returning everything, which the page relies on.
const fleet = { screen: async () => "", status: async () => ({ sessions: [] }) } as never;
let server: ReturnType<typeof serve>;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++));

beforeAll(() => {
  const store = new Store(":memory:");
  const commands = new Commands(store.db, clock);
  const requests = new Requests(store.db, clock);
  for (let i = 0; i < 5; i++) commands.submit({ idempotencyKey: `key-${i}`, target: "probe", actor: "tester", text: `text ${i}` });
  for (let i = 0; i < 3; i++) requests.registerRun({ runId: `run-${i}`, orchestrator: "orchestrator", phase: "one" });
  for (let i = 0; i < 3; i++) requests.create({ runId: `run-${i}`, origin: "orchestrator", expectedRevision: 1, kind: "clarification", question: `q${i}` });
  server = serve({ fleet, store, control: { commands, deliverer: new Deliverer(commands, async () => ({ exitCode: 1, stdout: "", stderr: "" })), requests } }, 0);
});
afterAll(() => server.stop(true));

const get = async (path: string) => { const r = await fetch(new URL(path, server.url)); return { status: r.status, body: await r.json() as any }; };

test("without paging parameters both lists return everything, as before", async () => {
  const commands = await get("/api/commands");
  expect(commands.body.commands).toHaveLength(5);
  expect(commands.body.nextCursor).toBeUndefined();
  const requests = await get("/api/requests");
  expect(requests.body.requests).toHaveLength(3);
  expect(requests.body.runs).toHaveLength(3);
});

test("with limit and cursor the command list returns every command once", async () => {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await get(`/api/commands?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
    expect(page.status).toBe(200);
    expect(page.body.commands.length).toBeLessThanOrEqual(2);
    ids.push(...page.body.commands.map((c: { id: string }) => c.id));
    cursor = page.body.nextCursor;
  } while (cursor);
  expect(ids).toHaveLength(5);
  expect(new Set(ids).size).toBe(5);
});

test("a request page carries only its own runs", async () => {
  const page = await get("/api/requests?limit=1");
  expect(page.body.requests).toHaveLength(1);
  expect(page.body.runs.map((r: { id: string }) => r.id)).toEqual([page.body.requests[0].runId]);
  expect(typeof page.body.nextCursor).toBe("string");
});

test("bad, unknown and duplicate parameters get 400", async () => {
  for (const path of ["/api/commands?limit=0", "/api/commands?limit=1001", "/api/commands?limit=x", "/api/commands?cursor=nope", "/api/commands?status=queued", "/api/commands?limit=1&limit=2", "/api/requests?cursor=", "/api/requests?cursor=bad%20cursor"]) {
    const r = await get(path);
    expect({ path, status: r.status }).toEqual({ path, status: 400 });
    expect(r.body.error.kind).toBe("invalid");
  }
});

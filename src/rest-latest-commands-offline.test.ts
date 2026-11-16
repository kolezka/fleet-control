import { afterAll, beforeAll, expect, test } from "bun:test";
import { Commands } from "./data/commands.ts";
import { Deliverer } from "./application/delivery.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";

// The page polls latest=N every few seconds, so the answer must stay small however long the history gets.
const fleet = { screen: async () => "", status: async () => ({ sessions: [] }) } as never;
let server: ReturnType<typeof serve>;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++));

beforeAll(() => {
  const store = new Store(":memory:");
  const commands = new Commands(store.db, clock);
  for (let i = 0; i < 9; i++) commands.submit({ idempotencyKey: `key-${i}`, target: "probe", actor: "tester", text: `text ${i}` });
  server = serve({ fleet, store, control: { commands, deliverer: new Deliverer(commands, async () => ({ exitCode: 1, stdout: "", stderr: "" })) } }, 0);
});
afterAll(() => server.stop(true));

const get = async (path: string) => { const r = await fetch(new URL(path, server.url)); return { status: r.status, body: await r.json() as any }; };

test("latest returns the newest commands, oldest first", async () => {
  const r = await get("/api/commands?latest=3");
  expect(r.status).toBe(200);
  expect(r.body.commands.map((c: any) => c.text)).toEqual(["text 6", "text 7", "text 8"]);
  expect(r.body.nextCursor).toBeUndefined();
  expect((await get("/api/commands?latest=1000")).body.commands).toHaveLength(9);
});

test("latest refuses bad values and mixing with paging", async () => {
  for (const q of ["latest=0", "latest=1001", "latest=-1", "latest=1e3", "latest=", "latest=2&latest=3", "latest=2&limit=2", "latest=2&cursor=abc", "latest=2&x=1"]) {
    const r = await get("/api/commands?" + q);
    expect([q, r.status, r.body.error.kind]).toEqual([q, 400, "invalid"]);
  }
});

test("without latest the full list is unchanged", async () => {
  expect((await get("/api/commands")).body.commands).toHaveLength(9);
});

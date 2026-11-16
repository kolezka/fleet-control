import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Commands } from "./data/commands.ts";
import { Requests } from "./data/requests.ts";
import { Deliverer } from "./application/delivery.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";

// The local list tools return pages, so one call never reads every command, request or run.
const fleet = { screen: async () => "", status: async () => ({ sessions: [] }) } as never;
let server: ReturnType<typeof serve>;
let client: Client;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++));

beforeAll(async () => {
  const store = new Store(":memory:");
  const commands = new Commands(store.db, clock);
  const requests = new Requests(store.db, clock);
  for (let i = 0; i < 7; i++) commands.submit({ idempotencyKey: `key-${i}`, target: "probe", actor: "tester", text: `text ${i}` });
  commands.transition(commands.list()[2]!.id, "accepted", "probe", "ok");
  for (let i = 0; i < 6; i++) requests.registerRun({ runId: `run-${i}`, orchestrator: "orchestrator", phase: "one" });
  for (let i = 0; i < 6; i++) requests.create({ runId: `run-${i % 3}`, expectedRevision: 1, kind: "question", question: `q${i}`, origin: "orchestrator" });
  const deliverer = new Deliverer(commands, async () => ({ exitCode: 1, stdout: "", stderr: "" }));
  server = serve({ fleet, store, control: { commands, deliverer, requests } }, 0);
  client = new Client({ name: "list-pages", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}mcp`)));
});
afterAll(async () => { await client.close(); server.stop(true); });

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
  return result.isError ? { error: result.content[0]!.text } : JSON.parse(result.content[0]!.text);
};

async function all(tool: string, field: string, filter: Record<string, unknown>) {
  const pages: unknown[][] = [];
  let cursor: string | undefined;
  do {
    const page = await call(tool, { ...filter, limit: 2, ...(cursor ? { cursor } : {}) });
    expect(page[field].length).toBeLessThanOrEqual(2);
    pages.push(page[field]);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}

test("command_list pages every command once in creation order, filter included", async () => {
  const ids = (await all("command_list", "commands", {})).flat().map((c) => (c as { id: string }).id);
  expect(ids).toHaveLength(7);
  expect(new Set(ids).size).toBe(7);
  const queued = (await all("command_list", "commands", { status: "queued" })).flat();
  expect(queued).toHaveLength(6);
  expect(queued.every((c) => (c as { status: string }).status === "queued")).toBe(true);
});

test("request_list pages requests and carries only the runs on its page", async () => {
  const pages = await all("request_list", "requests", {});
  expect(pages.flat()).toHaveLength(6);
  const first = await call("request_list", { limit: 2 });
  const runIds = first.runs.map((r: { id: string }) => r.id);
  expect(runIds).toEqual([...new Set(first.requests.map((r: { runId: string }) => r.runId))].sort());
  expect(runIds.length).toBeLessThanOrEqual(2);
  const forRun = await call("request_list", { runId: "run-5" });
  expect(forRun.requests).toHaveLength(0);
  expect(forRun.runs.map((r: { id: string }) => r.id)).toEqual(["run-5"]);
});

test("run_list pages every run in ID order", async () => {
  const ids = (await all("run_list", "runs", {})).flat().map((r) => (r as { id: string }).id);
  expect(ids).toEqual(["run-0", "run-1", "run-2", "run-3", "run-4", "run-5"]);
});

test("a cursor is refused under a different filter, and bad limits and cursors are refused", async () => {
  const page = await call("command_list", { limit: 1 });
  expect((await call("command_list", { status: "queued", cursor: page.nextCursor })).error).toContain("invalid");
  const req = await call("request_list", { limit: 1 });
  expect((await call("request_list", { runId: "run-0", cursor: req.nextCursor })).error).toContain("invalid");
  for (const tool of ["command_list", "request_list", "run_list"]) {
    for (const limit of [0, 1001, 1.5]) expect((await call(tool, { limit })).error).toBeDefined();
    expect((await call(tool, { cursor: "not a cursor" })).error).toContain("invalid");
  }
});

test("lists default to 100 per page", async () => {
  const page = await call("command_list", {});
  expect(page.commands).toHaveLength(7);
  expect(page.nextCursor).toBeNull();
});

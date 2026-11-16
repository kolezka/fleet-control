import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Commands } from "./data/commands.ts";
import { Requests } from "./data/requests.ts";
import { Deliverer } from "./application/delivery.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";

// Event polling must return pages, so one call never reads the whole history.
const fleet = { screen: async () => "", status: async () => ({ sessions: [] }) } as never;
let server: ReturnType<typeof serve>;
let client: Client;

beforeAll(async () => {
  const store = new Store(":memory:");
  const commands = new Commands(store.db);
  const requests = new Requests(store.db);
  for (let i = 0; i < 105; i++) commands.submit({ idempotencyKey: `key-${i}`, target: "probe", actor: "tester", text: `text ${i}` });
  for (let i = 0; i < 5; i++) requests.registerRun({ runId: `run-${i}`, orchestrator: "orchestrator", phase: "one" });
  const deliverer = new Deliverer(commands, async () => ({ exitCode: 1, stdout: "", stderr: "" }));
  server = serve({ fleet, store, control: { commands, deliverer, requests } }, 0);
  client = new Client({ name: "event-pages", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}mcp`)));
});
afterAll(async () => { await client.close(); server.stop(true); });

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
  return result.isError ? { error: result.content[0]!.text } : JSON.parse(result.content[0]!.text);
};

for (const [tool, total] of [["command_events", 105], ["request_events", 5]] as const) {
  test(`${tool} pages through every event in order and marks only full pages`, async () => {
    const seen: number[] = [];
    let after = 0;
    for (;;) {
      const page = await call(tool, { afterSeq: after, limit: 2 });
      expect(page.events.length).toBeLessThanOrEqual(2);
      seen.push(...page.events.map((e: { seq: number }) => e.seq));
      if (page.events.length < 2) { expect(page.nextAfterSeq).toBeUndefined(); break; }
      expect(page.nextAfterSeq).toBe(page.events.at(-1).seq);
      after = page.nextAfterSeq;
    }
    expect(seen).toHaveLength(total);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(new Set(seen).size).toBe(total);
  });

  test(`${tool} refuses a limit outside 1 to 1000`, async () => {
    for (const limit of [0, 1001, 1.5]) expect((await call(tool, { limit })).error).toBeDefined();
  });
}

test("command_events returns 100 events by default", async () => {
  const page = await call("command_events", {});
  expect(page.events).toHaveLength(100);
  expect(page.nextAfterSeq).toBe(page.events[99].seq);
  const rest = await call("command_events", { afterSeq: page.nextAfterSeq });
  expect(rest.events).toHaveLength(5);
  expect(rest.nextAfterSeq).toBeUndefined();
});

test("request_events returns all five events under the default page", async () => {
  const page = await call("request_events", {});
  expect(page.events).toHaveLength(5);
  expect(page.nextAfterSeq).toBeUndefined();
});

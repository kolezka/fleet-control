import { afterAll, beforeAll, expect, test } from "bun:test";
import { Commands } from "./data/commands.ts";
import { Requests } from "./data/requests.ts";
import { Deliverer } from "./application/delivery.ts";
import { MAX_TEXT } from "./domain/commands.ts";
import { MAX_REQUEST_BODY, serve } from "./server.ts";
import { Store } from "./data/store.ts";

// The local service caps request bodies, so one oversized POST cannot make it buffer 128 MiB.
const fleet = { screen: async () => "", status: async () => ({ sessions: [] }) } as never;
let server: ReturnType<typeof serve>;
let commands: Commands;

beforeAll(() => {
  const store = new Store(":memory:");
  commands = new Commands(store.db);
  const requests = new Requests(store.db);
  server = serve({ fleet, store, control: { commands, deliverer: new Deliverer(commands, async () => ({ exitCode: 1, stdout: "", stderr: "" })), requests } }, 0);
});
afterAll(() => server.stop(true));

const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  fetch(new URL(path, server.url), { method: "POST", body, headers: { "content-type": "application/json", ...headers }, duplex: "half" } as RequestInit);

test("a command at the text limit in four-byte characters is still accepted", async () => {
  const text = "😀".repeat(MAX_TEXT / 2);
  const response = await post("/api/commands", JSON.stringify({ idempotencyKey: "body-limit-ok", target: "probe", text }));
  expect(response.status).toBe(201);
  expect(commands.list().map((c) => c.text)).toContain(text);
});

test("an oversized body is refused with 413 on the REST and MCP paths and stores nothing", async () => {
  const before = commands.list().length;
  const big = JSON.stringify({ idempotencyKey: "body-limit-big", target: "probe", text: "a".repeat(MAX_REQUEST_BODY) });
  for (const path of ["/api/commands", "/mcp", "/api/requests/x/resolve", "/api/login"]) {
    const response = await post(path, big, { accept: "application/json, text/event-stream" });
    expect({ path, status: response.status }).toEqual({ path, status: 413 });
    await response.arrayBuffer();
  }
  expect(commands.list().length).toBe(before);
});

test("a chunked body without a length is cut off at the same limit", async () => {
  const chunk = new TextEncoder().encode("b".repeat(64 * 1024));
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent > MAX_REQUEST_BODY * 4) return controller.close();
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
  const response = await post("/api/commands", body);
  expect(response.status).toBe(413);
  await response.arrayBuffer();
});

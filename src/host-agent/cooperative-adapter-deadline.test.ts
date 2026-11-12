import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { createCooperativeAdapter } from "./cooperative-adapter.ts";

const localToken = "a".repeat(43);
const payload = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" });
const success = { jsonrpc: "2.0", id: 7, result: { tools: [] } };
const unknown = "outcome unknown; no automatic retry; retry only the exact request ID and payload with the same incarnation";
let now = 0;
const clock = spyOn(performance, "now").mockImplementation(() => now);
afterEach(() => { now = 0; });
afterAll(() => { clock.mockRestore(); });

function fixture(stage: "before" | "after" | "within") {
  let calls = 0;
  const handler = createCooperativeAdapter({
    centralUrl: "https://central.example/mcp", localToken,
    supervisorToken: "b".repeat(43), incarnationToken: "c".repeat(43),
    incarnationId: "12345678-1234-4123-8123-123456789abc", requestTimeoutMs: 1000,
    centralFetch: async () => { calls++; if (stage === "after") now = 1000; return Response.json(success); },
  });
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { if (stage === "before") now = 1000; controller.enqueue(new TextEncoder().encode(payload)); controller.close(); },
  });
  return { calls: () => calls, response: handler(new Request("http://127.0.0.1/mcp", {
    method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" }, body,
  })) };
}

test("expired deadline prevents forwarding", async () => {
  const f = fixture("before"); const response = await f.response;
  expect(response.status).toBe(504); expect(await response.json()).toEqual({ error: "request timeout before forwarding" }); expect(f.calls()).toBe(0);
});

test("expired deadline after forwarding reports unknown", async () => {
  const f = fixture("after"); const response = await f.response;
  expect(response.status).toBe(504); expect(await response.json()).toEqual({ error: unknown }); expect(f.calls()).toBe(1);
});

test("work completed before deadline passes through", async () => {
  const f = fixture("within"); const response = await f.response;
  expect(response.status).toBe(200); expect(await response.json()).toEqual(success); expect(f.calls()).toBe(1);
});

test("continuously ready request chunks cannot starve the deadline", async () => {
  let calls = 0; let pulls = 0;
  const handler = createCooperativeAdapter({
    centralUrl: "https://central.example/mcp", localToken,
    supervisorToken: "b".repeat(43), incarnationToken: "c".repeat(43),
    incarnationId: "12345678-1234-4123-8123-123456789abc", requestTimeoutMs: 1000,
    centralFetch: async () => { calls++; return Response.json(success); },
  });
  // Each pull is ready at once and advances virtual time; it never closes.
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; now += 100; controller.enqueue(new Uint8Array([32])); } });
  const response = await handler(new Request("http://127.0.0.1/mcp", { method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" }, body }));
  expect(response.status).toBe(504); expect(calls).toBe(0); expect(pulls).toBeLessThan(20);
});

test("late upstream response body is cancelled, not read", async () => {
  let cancelled = false; let reads = 0;
  const handler = createCooperativeAdapter({
    centralUrl: "https://central.example/mcp", localToken,
    supervisorToken: "b".repeat(43), incarnationToken: "c".repeat(43),
    incarnationId: "12345678-1234-4123-8123-123456789abc", requestTimeoutMs: 1000,
    centralFetch: async () => { now = 1000; return new Response(new ReadableStream<Uint8Array>({ pull(c) { reads++; c.enqueue(new TextEncoder().encode(JSON.stringify(success))); c.close(); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }); },
  });
  const response = await handler(new Request("http://127.0.0.1/mcp", { method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" }, body: payload }));
  expect(response.status).toBe(504); expect(await response.json()).toEqual({ error: unknown });
  await Bun.sleep(0); expect(cancelled).toBe(true); expect(reads).toBeLessThanOrEqual(1);
});

test("client abort keeps 499 even when the deadline later expires", async () => {
  const client = new AbortController();
  const handler = createCooperativeAdapter({
    centralUrl: "https://central.example/mcp", localToken,
    supervisorToken: "b".repeat(43), incarnationToken: "c".repeat(43),
    incarnationId: "12345678-1234-4123-8123-123456789abc", requestTimeoutMs: 1000,
    centralFetch: async () => { client.abort(); now = 1000; return Response.json(success); },
  });
  const response = await handler(new Request("http://127.0.0.1/mcp", { method: "POST", signal: client.signal, headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" }, body: payload }));
  expect(response.status).toBe(499); expect(await response.json()).toEqual({ error: unknown });
});

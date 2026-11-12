import { expect, test } from "bun:test";
import { createCooperativeAdapter } from "./cooperative-adapter.ts";

const localToken = "a".repeat(43);

function fixture(responseId: number) {
  let calls = 0;
  const handler = createCooperativeAdapter({
    centralUrl: "https://central.example/mcp",
    localToken,
    supervisorToken: "b".repeat(43),
    incarnationToken: "c".repeat(43),
    incarnationId: "12345678-1234-4123-8123-123456789abc",
    centralFetch: async (_url, init) => {
      calls++;
      expect(JSON.parse(String(init.body)).id).toBe(7);
      return Response.json({ jsonrpc: "2.0", id: responseId, result: { tools: [] } });
    },
  });
  return {
    calls: () => calls,
    request: () => handler(new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    })),
  };
}

function responseFixture(input: Record<string, unknown>, upstream: () => Response) {
  let calls = 0;
  const handler = createCooperativeAdapter({
    centralUrl: "https://central.example/mcp",
    localToken,
    supervisorToken: "b".repeat(43),
    incarnationToken: "c".repeat(43),
    incarnationId: "12345678-1234-4123-8123-123456789abc",
    centralFetch: async (_url, init) => {
      calls++;
      expect(JSON.parse(String(init.body))).toEqual(input);
      return upstream();
    },
  });
  return {
    calls: () => calls,
    request: () => handler(new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    })),
  };
}

const unknownOutcome = { error: "outcome unknown; no automatic retry; retry only the exact request ID and payload with the same incarnation" };

async function expectUnknown(adapter: ReturnType<typeof responseFixture>) {
  const response = await adapter.request();
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual(unknownOutcome);
  expect(adapter.calls()).toBe(1);
}

test("accepts an upstream response with the matching request ID", async () => {
  const adapter = fixture(7);
  const response = await adapter.request();
  expect(adapter.calls()).toBe(1);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 7, result: { tools: [] } });
});

test("fails closed on an upstream response with a different request ID", async () => {
  const adapter = fixture(8);
  const response = await adapter.request();
  expect(adapter.calls()).toBe(1);
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "outcome unknown; no automatic retry; retry only the exact request ID and payload with the same incarnation" });
});

for (const id of [0, "", "request-7"]) {
  test(`accepts matching response ID ${JSON.stringify(id)} and null result`, async () => {
    const input = { jsonrpc: "2.0", id, method: "tools/list" };
    const payload = { jsonrpc: "2.0", id, result: null };
    const adapter = responseFixture(input, () => Response.json(payload));
    const response = await adapter.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(adapter.calls()).toBe(1);
  });
}

test("passes a valid JSON-RPC error through", async () => {
  const input = { jsonrpc: "2.0", id: 7, method: "tools/list" };
  const payload = { jsonrpc: "2.0", id: 7, error: { code: -32603, message: "failure", data: null } };
  const adapter = responseFixture(input, () => Response.json(payload));
  const response = await adapter.request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(payload);
  expect(adapter.calls()).toBe(1);
});

const invalidResponses: [string, unknown][] = [
  ["different ID", { jsonrpc: "2.0", id: 8, result: null }],
  ["different ID type", { jsonrpc: "2.0", id: "7", result: null }],
  ["missing ID", { jsonrpc: "2.0", result: null }],
  ["missing JSON-RPC version", { id: 7, result: null }],
  ["wrong JSON-RPC version", { jsonrpc: "1.0", id: 7, result: null }],
  ["both result and error", { jsonrpc: "2.0", id: 7, result: null, error: { code: -1, message: "failure" } }],
  ["neither result nor error", { jsonrpc: "2.0", id: 7 }],
  ["null error", { jsonrpc: "2.0", id: 7, error: null }],
  ["array error", { jsonrpc: "2.0", id: 7, error: [] }],
  ["missing error code", { jsonrpc: "2.0", id: 7, error: { message: "failure" } }],
  ["fractional error code", { jsonrpc: "2.0", id: 7, error: { code: 1.5, message: "failure" } }],
  ["string error code", { jsonrpc: "2.0", id: 7, error: { code: "-1", message: "failure" } }],
  ["missing error message", { jsonrpc: "2.0", id: 7, error: { code: -1 } }],
  ["non-string error message", { jsonrpc: "2.0", id: 7, error: { code: -1, message: null } }],
  ["array envelope", []],
  ["null envelope", null],
];
for (const [label, payload] of invalidResponses) {
  test(`reports unknown without retry for ${label}`, async () => {
    const adapter = responseFixture({ jsonrpc: "2.0", id: 7, method: "tools/list" }, () => Response.json(payload));
    await expectUnknown(adapter);
  });
}

test("reports unknown without retry for malformed upstream JSON", async () => {
  const adapter = responseFixture({ jsonrpc: "2.0", id: 7, method: "tools/list" }, () => new Response("{", { headers: { "content-type": "application/json" } }));
  await expectUnknown(adapter);
});

for (const status of [202, 204]) {
  test(`accepts empty ${status} notification acknowledgement`, async () => {
    const adapter = responseFixture({ jsonrpc: "2.0", method: "notifications/initialized" }, () => new Response(null, { status }));
    const response = await adapter.request();
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
    expect(adapter.calls()).toBe(1);
  });
  test(`rejects ${status} acknowledgement for a request without retry`, async () => {
    const adapter = responseFixture({ jsonrpc: "2.0", id: 0, method: "tools/list" }, () => new Response(null, { status }));
    await expectUnknown(adapter);
  });
}

test("rejects nonempty 202 notification acknowledgement without retry", async () => {
  const adapter = responseFixture({ jsonrpc: "2.0", method: "notifications/initialized" }, () => new Response("unexpected", { status: 202 }));
  await expectUnknown(adapter);
});

test("rejects 200 notification response without retry", async () => {
  const adapter = responseFixture({ jsonrpc: "2.0", method: "notifications/initialized" }, () => Response.json({ jsonrpc: "2.0", id: null, result: null }));
  await expectUnknown(adapter);
});

for (const [label, id] of [["null", null], ["boolean", false], ["object", {}], ["array", []], ["fraction", 1.5], ["unsafe integer", Number.MAX_SAFE_INTEGER + 1], ["overlong string", "x".repeat(257)]] as const) {
  test(`rejects invalid request ID ${label} before forwarding`, async () => {
    const adapter = responseFixture({ jsonrpc: "2.0", id, method: "tools/list" }, () => Response.json({}));
    const response = await adapter.request();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid MCP request" });
    expect(adapter.calls()).toBe(0);
  });
}

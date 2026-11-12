import { expect, test } from "bun:test";
import { createCooperativeAdapter } from "./cooperative-adapter.ts";

const local = "a".repeat(43);
const supervisor = "b".repeat(43);
const incarnation = "c".repeat(43);
const id = "12345678-1234-4123-8123-123456789abc";
const escaped = (value: string) => [...value].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
const block = (text: string) => ({ type: "text", text });

async function run(blocks: unknown[]) {
  let calls = 0;
  const adapter = createCooperativeAdapter({ centralUrl: "https://central.example/mcp", localToken: local, supervisorToken: supervisor, incarnationToken: incarnation, incarnationId: id, centralFetch: async () => {
    calls++;
    return Response.json({ jsonrpc: "2.0", id: 1, result: { content: blocks } });
  } });
  const response = await adapter(new Request("http://localhost/mcp", { method: "POST", headers: { authorization: "Bearer " + local, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
  return { response, calls };
}

test("rejects encoded secrets in every JSON string token after forwarding", async () => {
  const cases = [
    '{"value":"' + escaped(local) + '"}',
    '{"' + escaped(supervisor) + '":1}',
    '{"dup":"' + escaped(incarnation) + '","dup":"safe"}',
    '{"quote":"escaped \\\" and slash \\\\","value":"' + escaped(id) + '"}',
  ];
  for (const text of cases) {
    JSON.parse(text);
    const { response, calls } = await run([block("benign"), block(text)]);
    expect(calls).toBe(1);
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("outcome unknown; no automatic retry");
    for (const secret of [local, supervisor, incarnation, id]) expect(body).not.toContain(secret);
  }
});

test("preserves benign JSON, malformed JSON text and one-layer scope", async () => {
  const blocks = [block(JSON.stringify({ quote: 'a"b', slash: 'a\\b' })), block("not JSON " + escaped(local)), block(JSON.stringify({ nested: '{"value":"' + escaped(local) + '"}' }))];
  const { response, calls } = await run(blocks);
  expect(calls).toBe(1);
  expect(response.status).toBe(200);
  expect((await response.json()).result.content).toEqual(blocks);
});

test("keeps the response byte cap for JSON text blocks", async () => {
  const within = await run([block(JSON.stringify({ value: "x".repeat(100_000) }))]);
  expect(within.response.status).toBe(200);
  const above = await run([block(JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) }))]);
  expect(above.calls).toBe(1);
  expect(above.response.status).toBe(502);
});

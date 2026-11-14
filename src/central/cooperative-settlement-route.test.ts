import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import { CommandError } from "../data/commands.ts";
import { createCooperativeSettlementRoute } from "./cooperative-settlement-route.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const auth = new CentralAuth([
  { tokenHash: hash("operator"), principal: { role: "operator", name: "operator" } },
  { tokenHash: hash("host"), principal: { role: "host", name: "host", hostId: "host" } },
]);
const path = "/api/commands/cmd/cooperative/settlement";
const body = { requestId: "r", disposition: "unknown", evidence: "e", expectedSequence: null };

test("settlement route validates the request and maps store errors without leaking them", async () => {
  const calls: unknown[] = [];
  const app = createCooperativeSettlementRoute({ auth, settlement: {
    async get() { return null; },
    async settle(_p, id, requestId, disposition, evidence, expected) {
      calls.push([id, requestId, disposition, evidence, expected]);
      if (requestId === "conflict") throw new CommandError("conflict", "claiming incarnation is still active");
      if (requestId === "missing") throw new CommandError("not_found", "claim not found");
      if (requestId === "boom") throw new Error("sensitive database failure");
      return { created: true, settlement: { commandId: id, requestId, actor: "operator", disposition, evidence, expectedSequence: expected, at: "now" } };
    },
  } });
  const post = (payload: unknown, headers: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { authorization: "Bearer operator", "content-type": "application/json", ...headers }, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
  expect((await app.request(path, { method: "POST" })).status).toBe(401);
  expect((await post(body, { authorization: "Bearer host" })).status).toBe(403);
  expect((await post(body, { "content-type": "text/plain" })).status).toBe(415);
  expect((await post("{")).status).toBe(400);
  expect((await post([body])).status).toBe(400);
  expect((await post({ ...body, expectedSequence: 1 })).status).toBe(400);
  expect((await post({ requestId: "r", disposition: "unknown", evidence: "e" })).status).toBe(400);
  expect((await post("x".repeat(600 * 1024))).status).toBe(413);
  expect((await app.request("/api/commands/%FF/cooperative/settlement", { method: "POST", headers: { authorization: "Bearer operator", "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(400);
  expect(calls).toHaveLength(0);
  expect((await post(body)).status).toBe(201);
  expect(await (await post({ ...body, requestId: "conflict" })).json()).toEqual({ error: "claiming incarnation is still active" });
  expect((await post({ ...body, requestId: "missing" })).status).toBe(404);
  const failed = await post({ ...body, requestId: "boom" });
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain("sensitive");
  expect((await app.request(path, { headers: { authorization: "Bearer operator" } })).status).toBe(404);
});

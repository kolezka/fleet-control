import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { CentralAuth } from "./auth.ts";
import { createCooperativeAssertionsRoute } from "./cooperative-assertions-route.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const auth = new CentralAuth([
  { tokenHash: hash("operator"), principal: { role: "operator", name: "operator" } },
  { tokenHash: hash("host"), principal: { role: "host", name: "host", hostId: "host" } },
  { tokenHash: hash("supervisor"), principal: { role: "supervisor", name: "supervisor", principalId: "id", hostId: "host", session: "session" } },
]);
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const path = "/api/commands/cmd/cooperative/assertions";

test("assertions route enforces the serialized UTF-8 response cap", async () => {
  const app = createCooperativeAssertionsRoute({ auth, reconciliation: { async listBounded() {
    return { assertions: [{ commandId: "cmd", requestId: "r", actor: "a", disposition: "unknown" as const, evidence: "\u0001".repeat(350000), expectedSequence: null, sequence: "1", supersedesSequence: null, at: "now" }], nextCursor: null };
  } } });
  const response = await app.request(path, { headers: headers("operator") });
  expect(response.status).toBe(500);
  expect(await response.text()).toBe('{"error":"request failed"}');
});

test("assertions route enforces roles, validates parameters and sanitizes failures", async () => {
  const calls: unknown[] = [];
  const app = new Hono();
  app.use("*", async (c, next) => { if (c.req.header("origin")) return c.json({ error: "unsafe origin" }, 403); await next(); });
  app.route("/", createCooperativeAssertionsRoute({ auth, reconciliation: { async listBounded(principal, id, options) {
    calls.push([principal, id, options]);
    if (id === "missing") return null;
    if (id === "error") throw new Error("sensitive database failure");
    return { assertions: [], nextCursor: null };
  } } }));
  expect((await app.request(path)).status).toBe(401);
  for (const token of ["host", "supervisor"]) expect((await app.request(path, { headers: headers(token) })).status).toBe(403);
  expect((await app.request(path, { headers: { ...headers("operator"), origin: "https://example.com" } })).status).toBe(403);
  for (const query of ["limit=0", "limit=5", "limit=01", "limit=", "limit=1&limit=2", "cursor=", "cursor=01", "cursor=-1", `cursor=${"9".repeat(1001)}`, "cursor=0&cursor=1"]) {
    expect((await app.request(`${path}?${query}`, { headers: headers("operator") })).status).toBe(400);
  }
  expect((await app.request("/api/commands/%20/cooperative/assertions", { headers: headers("operator") })).status).toBe(400);
  expect(calls).toHaveLength(0);
  const empty = await app.request(path, { headers: headers("operator") });
  expect(await empty.json()).toEqual({ assertions: [], nextCursor: null });
  expect(calls[0]).toEqual([{ role: "operator", name: "operator" }, "cmd", { limit: 4 }]);
  const cursor = "9".repeat(1000);
  expect((await app.request(`${path}?limit=1&cursor=${cursor}`, { headers: headers("operator") })).status).toBe(200);
  expect(calls[1]).toEqual([{ role: "operator", name: "operator" }, "cmd", { limit: 1, cursor }]);
  expect((await app.request("/api/commands/missing/cooperative/assertions", { headers: headers("operator") })).status).toBe(404);
  const error = await app.request("/api/commands/error/cooperative/assertions", { headers: headers("operator") });
  expect(error.status).toBe(500);
  expect(await error.text()).toBe('{"error":"request failed"}');
});

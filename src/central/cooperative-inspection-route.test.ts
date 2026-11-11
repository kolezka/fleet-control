import { SQL } from "bun";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { CentralAuth } from "./auth.ts";
import { createCooperativeInspectionRoute } from "./cooperative-inspection-route.ts";
import { CooperativeInspection } from "./cooperative-inspection.ts";
import { CentralCommands } from "./commands.ts";
import { CentralAttempts } from "./attempts.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";
import { CooperativeClaims } from "./cooperative-claims.ts";
import { CooperativeLifecycle } from "./cooperative-lifecycle.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const auth = new CentralAuth([
  { tokenHash: hash("operator-secret"), principal: { role: "operator", name: "operator" } },
  { tokenHash: hash("host-secret"), principal: { role: "host", name: "host", hostId: "host" } },
  { tokenHash: hash("supervisor-secret"), principal: { role: "supervisor", name: "supervisor", principalId: "id", hostId: "host", session: "session" } },
]);
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const path = "/api/commands/cmd/cooperative";

test("route enforces roles, validates input and sanitizes store failures", async () => {
  const calls: unknown[] = [];
  const app = new Hono();
  app.use("*", async (c, next) => { if (c.req.header("origin")) return c.json({ error: "unsafe origin" }, 403); await next(); });
  const inspection = { async inspect(id: string, options: { limit?: number; cursor?: string }) {
    throw new Error("unbounded inspect must not be used by HTTP");
  }, async inspectBounded(id: string, options: { limit: number; cursor?: string }) {
    calls.push([id, options]);
    if (id === "missing") return null;
    if (id === "error") throw new Error("operator-secret");
    return { command: { id, idempotencyKey: "key", hostId: "host", target: "session", actor: "op", text: "work", status: "queued" as const, createdAt: "now", updatedAt: "now" }, claim: null, events: [], nextCursor: null };
  } };
  app.route("/", createCooperativeInspectionRoute({ auth, inspection }));
  expect((await app.request(path)).status).toBe(401);
  for (const token of ["host-secret", "supervisor-secret"]) expect((await app.request(path, { headers: headers(token) })).status).toBe(403);
  expect((await app.request(path, { headers: { ...headers("operator-secret"), origin: "https://example.com" } })).status).toBe(403);
  expect(calls).toHaveLength(0);
  for (const query of ["limit=0", "limit=5", "limit=01", "limit=1.0", "limit=", "limit=1&limit=2", "cursor=", "cursor=01", "cursor=-1", "cursor=9223372036854775808", "cursor=0&cursor=1"]) {
    expect((await app.request(`${path}?${query}`, { headers: headers("operator-secret") })).status).toBe(400);
  }
  expect((await app.request("/api/commands/%20/cooperative", { headers: headers("operator-secret") })).status).toBe(400);
  expect(calls).toHaveLength(0);
  expect((await app.request(path, { headers: headers("operator-secret") })).status).toBe(200);
  expect(calls[0]).toEqual(["cmd", { limit: 4 }]);
  expect((await app.request(`${path}?limit=4`, { headers: headers("operator-secret") })).status).toBe(200);
  expect(calls[1]).toEqual(["cmd", { limit: 4 }]);
  expect((await app.request(`${path}?limit=2&cursor=9007199254740993`, { headers: headers("operator-secret") })).status).toBe(200);
  expect(calls[2]).toEqual(["cmd", { limit: 2, cursor: "9007199254740993" }]);
  expect((await app.request("/api/commands/missing/cooperative", { headers: headers("operator-secret") })).status).toBe(404);
  const error = await app.request("/api/commands/error/cooperative", { headers: headers("operator-secret") });
  expect(error.status).toBe(500);
  expect(await error.text()).toBe('{"error":"request failed"}');
});

test("route caps serialized UTF-8 JSON including escaping and envelope", async () => {
  let text = "";
  const inspection = {
    async inspect() { throw new Error("unbounded inspect must not be used by HTTP"); },
    async inspectBounded(id: string) {
      return { command: { id, idempotencyKey: "key", hostId: "host", target: "session", actor: "op", text, status: "queued" as const, createdAt: "now", updatedAt: "now" }, claim: null, events: [], nextCursor: null };
    },
  };
  const app = createCooperativeInspectionRoute({ auth, inspection });
  const envelopeBytes = Buffer.byteLength(JSON.stringify(await inspection.inspectBounded("cmd")), "utf8");
  text = "x".repeat(2 * 1024 * 1024 - envelopeBytes);
  const exact = await app.request(path, { headers: headers("operator-secret") });
  expect(exact.status).toBe(200);
  expect(Buffer.byteLength(await exact.text(), "utf8")).toBe(2 * 1024 * 1024);
  text += "x";
  const oversized = await app.request(path, { headers: headers("operator-secret") });
  expect(oversized.status).toBe(500);
  expect(await oversized.text()).toBe('{"error":"request failed"}');
  text = "\u0001".repeat(350000);
  const escaped = await app.request(path, { headers: headers("operator-secret") });
  expect(escaped.status).toBe(500);
  expect(await escaped.text()).toBe('{"error":"request failed"}');
});

const url = process.env.CENTRAL_TEST_DATABASE_URL;
(url ? test : test.skip)("route reads real PostgreSQL claim and paginated lifecycle", async () => {
  const admin = new SQL(url!);
  const schema = `inspection_route_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const db = new SQL(url!, { connection: { search_path: schema } });
  try {
    const commands = new CentralCommands(db);
    const registry = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    const claims = new CooperativeClaims(db, incarnations);
    const lifecycle = new CooperativeLifecycle(db, incarnations);
    await commands.initialize(); await new CentralAttempts(db).initialize(); await registry.initialize(); await incarnations.initialize(); await claims.initialize(); await lifecycle.initialize();
    const principal = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    await registry.enroll(principal);
    const credential = await incarnations.activate(principal);
    const command = (await commands.submit({ idempotencyKey: "one", hostId: "host", target: "session", actor: "operator", text: "work" })).command;
    await claims.claim(principal, credential, "claim");
    await lifecycle.report(principal, credential, command.id, "accept", "accepted", "ok");
    await lifecycle.report(principal, credential, command.id, "finish", "completed", "done");
    const store = new CooperativeInspection(db);
    const app = createCooperativeInspectionRoute({ auth, inspection: store });
    const endpoint = `/api/commands/${command.id}/cooperative`;
    const firstResponse = await app.request(`${endpoint}?limit=1`, { headers: headers("operator-secret") });
    expect(firstResponse.status).toBe(200);
    const firstText = await firstResponse.text();
    expect(firstText).not.toContain(credential.token);
    const first = JSON.parse(firstText);
    expect(first.command.status).toBe("claimed");
    expect(first.claim.incarnationId).toBe(credential.incarnationId);
    expect(first.events.map((event: { status: string }) => event.status)).toEqual(["accepted"]);
    const second = await (await app.request(`${endpoint}?limit=1&cursor=${first.nextCursor}`, { headers: headers("operator-secret") })).json();
    expect(second.events.map((event: { status: string }) => event.status)).toEqual(["completed"]);
    expect(second.nextCursor).toBeNull();
    expect((await app.request("/api/commands/missing/cooperative", { headers: headers("operator-secret") })).status).toBe(404);

    const largeBase = (await commands.submit({ idempotencyKey: "large-base", hostId: "host", target: "session", actor: "operator", text: "work" })).command;
    await db`UPDATE central_commands SET text = repeat('x', 300000) WHERE id = ${largeBase.id}`;
    const baseResponse = await app.request(`/api/commands/${largeBase.id}/cooperative`, { headers: headers("operator-secret") });
    expect(baseResponse.status).toBe(500);
    expect(await baseResponse.text()).toBe('{"error":"request failed"}');
    expect((await store.inspect(largeBase.id))?.command.text).toHaveLength(300000);

    await db`UPDATE central_cooperative_lifecycle_events SET detail = repeat('x', 300000) WHERE command_id = ${command.id} AND request_id = 'finish'`;
    for (const query of ["limit=1", "limit=2", `limit=1&cursor=${first.nextCursor}`]) {
      const response = await app.request(`${endpoint}?${query}`, { headers: headers("operator-secret") });
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"error":"request failed"}');
    }
    const unbounded = await store.inspect(command.id, { limit: 1000 });
    expect(unbounded?.events).toHaveLength(2);
    expect(unbounded?.events[1]?.detail).toHaveLength(300000);
  } finally {
    await db.close();
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
  }
});

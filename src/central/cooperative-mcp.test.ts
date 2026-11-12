import { SQL } from "bun";
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CentralCommands } from "./commands.ts";
import { CentralAttempts } from "./attempts.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";
import { CooperativeClaims } from "./cooperative-claims.ts";
import { CooperativeLifecycle } from "./cooperative-lifecycle.ts";
import { buildCooperativeMcpServer } from "./cooperative-mcp.ts";

const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;
const body = (result: any) => JSON.parse(result.content[0].text);

pgTest("cooperative MCP fences identity, claims and lifecycle over isolated PostgreSQL", async () => {
  const admin = new SQL(url!);
  const schema = `cooperative_mcp_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const db = new SQL(url!, { connection: { search_path: schema } });
  let client: Client | undefined;
  let server: ReturnType<typeof buildCooperativeMcpServer> | undefined;
  try {
    expect((await db`SELECT current_schema() AS name`)[0]!.name).toBe(schema);
    const principal = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    const commands = new CentralCommands(db);
    const registry = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    const claims = new CooperativeClaims(db, incarnations);
    const lifecycle = new CooperativeLifecycle(db, incarnations);
    await commands.initialize(); await new CentralAttempts(db).initialize(); await registry.initialize(); await incarnations.initialize(); await claims.initialize(); await lifecycle.initialize();
    await registry.enroll(principal);
    const credential = await incarnations.activate(principal);
    expect(() => buildCooperativeMcpServer({ claims, lifecycle }, { role: "operator", name: "x" }, credential)).toThrow("MCP access denied");
    server = buildCooperativeMcpServer({ claims, lifecycle }, principal, credential);
    client = new Client({ name: "test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["cooperative_claim", "cooperative_report"]);
    expect(JSON.stringify(tools)).not.toContain(credential.token);
    const call = (name: string, args: Record<string, unknown>) => client!.callTool({ name, arguments: args });
    expect(body(await call("cooperative_claim", { requestId: "empty" })).command).toBeNull();
    const unsafe = (await commands.submit({ idempotencyKey: "unsafe", hostId: "host", target: "session", actor: "operator", text: `work ${credential.token}` })).command;
    for (let i = 0; i < 2; i++) {
      const rejected = await call("cooperative_claim", { requestId: "unsafe-claim" });
      expect(rejected.isError).toBe(true);
      expect(rejected.content).toEqual([{ type: "text", text: "request failed" }]);
      expect(JSON.stringify(rejected).includes(credential.token)).toBe(false);
      expect((await commands.get(unsafe.id)).status).toBe("queued");
      expect(await db`SELECT 1 FROM central_cooperative_claims WHERE request_id = ${"unsafe-claim"}`).toHaveLength(0);
      expect((await commands.events(unsafe.id)).map((event) => event.status)).toEqual(["queued"]);
    }
    await db`UPDATE central_commands SET target = ${"other"} WHERE id = ${unsafe.id}`;
    const unsafeId = (await commands.submit({ idempotencyKey: "unsafe-id", hostId: "host", target: "session", actor: "operator", text: `work ${credential.incarnationId}` })).command;
    for (let i = 0; i < 2; i++) {
      const rejected = await call("cooperative_claim", { requestId: "unsafe-id-claim" });
      expect(rejected.isError).toBe(true);
      expect(rejected.content).toEqual([{ type: "text", text: "request failed" }]);
      expect((await commands.get(unsafeId.id)).status).toBe("queued");
      expect(await db`SELECT 1 FROM central_cooperative_claims WHERE request_id = ${"unsafe-id-claim"}`).toHaveLength(0);
      expect((await commands.events(unsafeId.id)).map((event) => event.status)).toEqual(["queued"]);
    }
    await db`UPDATE central_commands SET target = ${"other"} WHERE id = ${unsafeId.id}`;
    const own = (await commands.submit({ idempotencyKey: "own", hostId: "host", target: "session", actor: "operator", text: "work" })).command;
    await commands.submit({ idempotencyKey: "foreign", hostId: "host", target: "other", actor: "operator", text: "foreign" });
    expect(body(await call("cooperative_claim", { requestId: "empty" })).command).toBeNull();
    const claim = await call("cooperative_claim", { requestId: "claim", hostId: "other", token: "forged", principalId: "forged" });
    expect(body(claim).command.id).toBe(own.id);
    expect(body(await call("cooperative_claim", { requestId: "claim" })).command.id).toBe(own.id);
    expect(body(await call("cooperative_claim", { requestId: "next" })).command).toBeNull();
    const report = { commandId: own.id, requestId: "accept", status: "accepted", detail: "accepted" };
    expect((await call("cooperative_report", { ...report, status: "running" })).isError).toBe(true);
    const accepted = await call("cooperative_report", report);
    expect(body(accepted).event.status).toBe("accepted");
    expect(body(await call("cooperative_report", report))).toEqual(body(accepted));
    expect((await call("cooperative_report", { ...report, detail: "different" })).isError).toBe(true);
    expect((await call("cooperative_report", { ...report, requestId: "missing", commandId: "unknown" })).isError).toBe(true);
    expect((await call("cooperative_report", { ...report, requestId: "secret", detail: credential.token })).isError).toBe(true);
    expect((await commands.get(own.id)).status).toBe("claimed");
    const cachedUnsafe = (await commands.submit({ idempotencyKey: "cached-unsafe", hostId: "host", target: "session", actor: "operator", text: `work ${credential.token}` })).command;
    expect((await claims.claim(principal, credential, "cached-unsafe"))?.id).toBe(cachedUnsafe.id);
    const cachedResponse = await call("cooperative_claim", { requestId: "cached-unsafe" });
    expect(cachedResponse.isError).toBe(true);
    expect(cachedResponse.content).toEqual([{ type: "text", text: "request failed" }]);
    expect(JSON.stringify(cachedResponse).includes(credential.token)).toBe(false);
    expect((await commands.get(cachedUnsafe.id)).status).toBe("claimed");
    const cachedUnsafeId = (await commands.submit({ idempotencyKey: "cached-unsafe-id", hostId: "host", target: "session", actor: "operator", text: `work ${credential.incarnationId}` })).command;
    expect((await claims.claim(principal, credential, "cached-unsafe-id"))?.id).toBe(cachedUnsafeId.id);
    const cachedIdResponse = await call("cooperative_claim", { requestId: "cached-unsafe-id" });
    expect(cachedIdResponse.isError).toBe(true);
    expect(cachedIdResponse.content).toEqual([{ type: "text", text: "request failed" }]);
    expect((await commands.get(cachedUnsafeId.id)).status).toBe("claimed");
    await incarnations.activate(principal);
    const stale = await call("cooperative_claim", { requestId: "claim" });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale)).not.toContain(credential.token);
    expect((await call("cooperative_report", report)).isError).toBe(true);
  } finally {
    await client?.close(); await server?.close(); await db.close();
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
  }
});

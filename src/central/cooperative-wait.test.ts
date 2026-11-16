import { SQL } from "bun";
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CentralCommands } from "./data/commands.ts";
import { CentralAttempts } from "./data/attempts.ts";
import { SupervisorIdentityRegistry } from "./data/identity-registry.ts";
import { SupervisorIncarnations } from "./data/incarnations.ts";
import { CooperativeClaims } from "./data/cooperative-claims.ts";
import { CooperativeLifecycle } from "./data/cooperative-lifecycle.ts";
import { buildCooperativeMcpServer } from "./cooperative-mcp.ts";

const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;
const body = (result: any) => JSON.parse(result.content[0].text);

pgTest("cooperative_wait reports work for this slot only, claims nothing and refuses a replaced incarnation", async () => {
  const admin = new SQL(url!);
  const schema = `cooperative_wait_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const db = new SQL(url!, { connection: { search_path: schema } });
  let client: Client | undefined;
  let server: ReturnType<typeof buildCooperativeMcpServer> | undefined;
  try {
    const principal = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    const commands = new CentralCommands(db);
    const registry = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    const claims = new CooperativeClaims(db, incarnations);
    const lifecycle = new CooperativeLifecycle(db, incarnations);
    await commands.initialize(); await new CentralAttempts(db).initialize(); await registry.initialize(); await incarnations.initialize(); await claims.initialize(); await lifecycle.initialize();
    await registry.enroll(principal);
    const credential = await incarnations.activate(principal);
    server = buildCooperativeMcpServer({ claims, lifecycle }, principal, credential);
    client = new Client({ name: "test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    const wait = (waitSeconds: unknown) => client!.callTool({ name: "cooperative_wait", arguments: { waitSeconds } as Record<string, unknown> });

    expect(body(await wait(0))).toEqual({ pending: false });
    // Work for another session on the same host does not count.
    await commands.submit({ idempotencyKey: "foreign", hostId: "host", target: "other", actor: "operator", text: "foreign" });
    expect(body(await wait(0))).toEqual({ pending: false });

    // A command submitted while waiting ends the wait early.
    const started = performance.now();
    const waiting = wait(5);
    await Bun.sleep(300);
    const own = (await commands.submit({ idempotencyKey: "own", hostId: "host", target: "session", actor: "operator", text: "secret text" })).command;
    const answer = await waiting;
    expect(body(answer)).toEqual({ pending: true });
    expect(performance.now() - started).toBeLessThan(4000);
    expect(JSON.stringify(answer)).not.toContain("secret text");
    expect(JSON.stringify(answer)).not.toContain(own.id);
    // Waiting does not claim.
    expect((await commands.get(own.id)).status).toBe("queued");
    expect(await db`SELECT 1 FROM central_cooperative_claims`).toHaveLength(0);

    expect(body(await client.callTool({ name: "cooperative_claim", arguments: { requestId: "claim" } })).command.id).toBe(own.id);
    expect(body(await wait(0))).toEqual({ pending: false });

    for (const bad of [-1, 21, 1.5, "1"]) expect((await wait(bad)).isError).toBe(true);

    await incarnations.activate(principal);
    await commands.submit({ idempotencyKey: "later", hostId: "host", target: "session", actor: "operator", text: "later" });
    const stale = await wait(0);
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale)).not.toContain("pending");
  } finally {
    await client?.close(); await server?.close(); await db.close();
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
  }
});

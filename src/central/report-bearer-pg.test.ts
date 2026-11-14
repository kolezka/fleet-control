import { SQL } from "bun";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import { CentralCommands } from "./commands.ts";
import { CentralAttempts } from "./attempts.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";
import { CooperativeClaims } from "./cooperative-claims.ts";
import { CooperativeLifecycle } from "./cooperative-lifecycle.ts";
import { CooperativeSettlement } from "./cooperative-settlement.ts";
import { CooperativeInspection } from "./cooperative-inspection.ts";
import { createCooperativeCentralApp } from "./cooperative-server.ts";

// A supervisor's own bearer must never be stored through cooperative MCP input; central refuses it.
const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

pgTest("PostgreSQL: a supervisor bearer in report or claim input is refused and never stored or shown", async () => {
  const admin = new SQL(url!);
  const schema = `report_bearer_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const db = new SQL(url!, { max: 2, connection: { search_path: schema } });
  let listener: ReturnType<typeof Bun.serve> | undefined;
  try {
    const principal = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    const commands = new CentralCommands(db);
    const identities = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    const claims = new CooperativeClaims(db, incarnations);
    const lifecycle = new CooperativeLifecycle(db, incarnations);
    const inspection = new CooperativeInspection(db);
    await commands.initialize();
    await new CentralAttempts(db).initialize();
    await identities.initialize();
    await incarnations.initialize();
    await claims.initialize();
    await lifecycle.initialize();
    await new CooperativeSettlement(db).initialize();
    await identities.enroll(principal);
    const credential = await incarnations.activate(principal);
    const operatorToken = crypto.randomUUID();
    const supervisorToken = crypto.randomUUID();
    const auth = new CentralAuth([
      { tokenHash: hash(operatorToken), principal: { name: "operator", role: "operator" } },
      { tokenHash: hash(supervisorToken), principal },
    ]);
    const app = createCooperativeCentralApp({ auth, identities, commands, claims, lifecycle, inspection });
    listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const base = `http://127.0.0.1:${listener.port}`;
    const supervisorHeaders = { authorization: `Bearer ${supervisorToken}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-fleet-incarnation-id": credential.incarnationId, "x-fleet-incarnation-token": credential.token };
    const call = async (name: string, args: object) => {
      const response = await fetch(`${base}/mcp`, { method: "POST", headers: supervisorHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      expect(response.status).toBe(200);
      return await response.text();
    };

    const submitted = await fetch(`${base}/api/commands`, {
      method: "POST", headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host", target: "session", text: "synthetic work", idempotencyKey: "submit" }),
    });
    expect(submitted.status).toBe(201);
    const { command } = await submitted.json() as { command: { id: string } };
    expect(JSON.parse(JSON.parse(await call("cooperative_claim", { requestId: "claim" })).result.content[0].text).command.id).toBe(command.id);

    // Positive control: an ordinary report contains no bearer anywhere.
    const plain = await call("cooperative_report", { commandId: command.id, requestId: "plain", status: "accepted", detail: "synthetic accepted" });
    expect(plain).not.toContain(supervisorToken);

    const leakedId = `leak-${supervisorToken}`;
    for (const args of [
      { commandId: command.id, requestId: leakedId, status: "running", detail: "plain detail" },
      { commandId: command.id, requestId: "leak-detail", status: "running", detail: `detail ${supervisorToken}` },
      { commandId: `${command.id}${supervisorToken}`, requestId: "leak-command", status: "running", detail: "plain detail" },
    ]) {
      const refused = await call("cooperative_report", args);
      expect(JSON.parse(refused).result.isError).toBe(true);
      expect(refused).not.toContain(supervisorToken);
    }
    const refusedClaim = await call("cooperative_claim", { requestId: leakedId });
    expect(JSON.parse(refusedClaim).result.isError).toBe(true);
    expect(refusedClaim).not.toContain(supervisorToken);

    const rows = await db`SELECT request_id, detail FROM central_cooperative_lifecycle_events WHERE command_id = ${command.id}`;
    expect([...rows]).toEqual([{ request_id: "plain", detail: "synthetic accepted" }]);
    expect(await db`SELECT 1 FROM central_cooperative_claims WHERE request_id = ${leakedId}`).toHaveLength(0);

    // The same request ID without the secret still works: refusal wrote nothing to replay against.
    const later = await call("cooperative_report", { commandId: command.id, requestId: "leak-detail", status: "running", detail: "clean detail" });
    expect(JSON.parse(later).result.isError ?? false).toBe(false);

    const page = await fetch(`${base}/api/commands/${command.id}/cooperative`, { headers: { authorization: `Bearer ${operatorToken}` } });
    expect(page.status).toBe(200);
    const pageText = await page.text();
    expect(pageText).not.toContain(supervisorToken);
    expect(pageText).not.toContain(operatorToken);
    expect(pageText).not.toContain(credential.token);
    expect(JSON.parse(pageText).events.map((event: { requestId: string }) => event.requestId)).toEqual(["plain", "leak-detail"]);
  } finally {
    listener?.stop(true);
    await db.close();
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
  }
});
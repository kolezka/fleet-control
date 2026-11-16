import { SQL } from "bun";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import { CentralCommands } from "./data/commands.ts";
import { CentralAttempts } from "./data/attempts.ts";
import { SupervisorIdentityRegistry } from "./data/identity-registry.ts";
import { SupervisorIncarnations } from "./data/incarnations.ts";
import { CooperativeClaims } from "./data/cooperative-claims.ts";
import { CooperativeLifecycle } from "./data/cooperative-lifecycle.ts";
import { CooperativeSettlement } from "./data/cooperative-settlement.ts";
import { CooperativeInspection } from "./data/cooperative-inspection.ts";
import { createCooperativeCentralApp } from "./cooperative-server.ts";

const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

pgTest("loopback cooperative flow separates submission, claim and lifecycle inspection", async () => {
  const admin = new SQL(url!);
  const schema = `cooperative_integration_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const db = new SQL(url!, { connection: { search_path: schema } });
  const observer = new SQL(url!, { connection: { search_path: schema } });
  let listener: ReturnType<typeof Bun.serve> | undefined;
  try {
    expect((await db`SELECT current_schema() AS name`)[0]!.name).toBe(schema);
    expect((await observer`SELECT current_schema() AS name`)[0]!.name).toBe(schema);
    const principal = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    const commands = new CentralCommands(db);
    const identities = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    const claims = new CooperativeClaims(db, incarnations);
    const lifecycle = new CooperativeLifecycle(db, incarnations);
    const inspection = new CooperativeInspection(observer);
    await commands.initialize();
    await new CentralAttempts(db).initialize();
    await identities.initialize();
    await incarnations.initialize();
    await claims.initialize();
    await lifecycle.initialize(); await new CooperativeSettlement(db).initialize();
    await identities.enroll(principal);
    const credential = await incarnations.activate(principal);
    const operatorToken = crypto.randomUUID();
    const supervisorToken = crypto.randomUUID();
    const auth = new CentralAuth([
      { tokenHash: hash(operatorToken), principal: { name: "operator", role: "operator" } },
      { tokenHash: hash(supervisorToken), principal },
    ]);
    const app = createCooperativeCentralApp({ auth, identities, commands, claims, lifecycle, inspection, allowedOrigins: ["https://allowed.example"] });
    listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const base = `http://127.0.0.1:${listener.port}`;
    const supervisorHeaders = { authorization: `Bearer ${supervisorToken}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-fleet-incarnation-id": credential.incarnationId, "x-fleet-incarnation-token": credential.token };
    const rpc = async (method: string, params: object = {}) => {
      const response = await fetch(`${base}/mcp`, { method: "POST", headers: supervisorHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      expect(response.status).toBe(200);
      return await response.json() as any;
    };
    const call = (name: string, args: object) => rpc("tools/call", { name, arguments: args });
    const content = (response: any) => JSON.parse(response.result.content[0].text);
    const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "integration-test", version: "1.0.0" } });
    expect(initialized.result.protocolVersion).toBe("2025-03-26");
    expect(initialized.result.serverInfo.name).toBeTruthy();
    const tools = await rpc("tools/list");
    expect(tools.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["cooperative_claim", "cooperative_report", "cooperative_wait"]);
    const legacy = await call("command_respond", { id: "ignored", decision: "accepted" });
    expect(legacy.result?.isError ?? Boolean(legacy.error)).toBe(true);

    const submitted = await fetch(`${base}/api/commands`, {
      method: "POST", headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host", target: "session", text: "synthetic work", idempotencyKey: "submit" }),
    });
    expect(submitted.status).toBe(201);
    const { command } = await submitted.json() as { command: { id: string; status: string; actor: string } };
    expect(command.status).toBe("queued");
    expect(command.actor).toBe("operator");
    const submit = (body: object) => fetch(`${base}/api/commands`, {
      method: "POST", headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const retry = await submit({ hostId: "host", target: "session", text: "synthetic work", idempotencyKey: "submit" });
    expect(retry.status).toBe(200);
    expect((await retry.json() as { command: { id: string }; created: boolean })).toMatchObject({ command: { id: command.id }, created: false });
    expect((await submit({ hostId: "host", target: "session", text: "different work", idempotencyKey: "submit" })).status).toBe(409);
    for (const invalid of [
      { hostId: "host", target: "session", text: "   ", idempotencyKey: "empty" },
      { hostId: "host", target: "bad session", text: "work", idempotencyKey: "bad-target" },
      { hostId: "", target: "session", text: "work", idempotencyKey: "bad-host" },
    ]) expect((await submit(invalid)).status).toBe(400);
    const before = await inspection.inspect(command.id);
    expect(before?.command.status).toBe("queued");
    expect(before?.claim).toBeNull();
    expect(before?.events).toEqual([]);

    const claimed = await call("cooperative_claim", { requestId: "claim" });
    expect(content(claimed).command.id).toBe(command.id);
    const afterClaim = await inspection.inspect(command.id);
    expect(afterClaim?.command.status).toBe("claimed");
    expect(afterClaim?.claim?.incarnationId).toBe(credential.incarnationId);
    expect(afterClaim?.events).toEqual([]);
    for (const status of ["accepted", "running", "completed"]) {
      const reported = await call("cooperative_report", { commandId: command.id, requestId: status, status, detail: `synthetic ${status}` });
      expect(content(reported).event.status).toBe(status);
    }
    const inspected = await inspection.inspect(command.id);
    expect(inspected?.command.status).toBe("claimed");
    expect(inspected?.events.map((event) => event.status)).toEqual(["accepted", "running", "completed"]);
    expect(JSON.stringify(inspected)).not.toContain(credential.token);
    const endpoint = `${base}/api/commands/${command.id}/cooperative`;
    const operatorHeaders = { authorization: `Bearer ${operatorToken}`, origin: "https://allowed.example" };
    expect((await fetch(endpoint, { headers: { ...supervisorHeaders, origin: "https://allowed.example" } })).status).toBe(403);
    expect((await fetch(endpoint, { headers: { ...operatorHeaders, origin: "https://foreign.example" } })).status).toBe(403);
    const displayed = await fetch(`${endpoint}?limit=2`, { headers: operatorHeaders });
    expect(displayed.status).toBe(200);
    const displayedText = await displayed.text();
    expect(displayedText).not.toContain(credential.token);
    const page = JSON.parse(displayedText);
    expect(page.command.status).toBe("claimed");
    expect(page.claim.incarnationId).toBe(credential.incarnationId);
    expect(page.events.map((event: { status: string }) => event.status)).toEqual(["accepted", "running"]);
    expect(page.nextCursor).toBeTruthy();
    const nextPage = await fetch(`${endpoint}?limit=2&cursor=${page.nextCursor}`, { headers: operatorHeaders });
    expect(nextPage.status).toBe(200);
    const remainder = await nextPage.json() as { events: { status: string }[]; nextCursor: string | null };
    expect(remainder.events.map((event) => event.status)).toEqual(["completed"]);
    expect(remainder.nextCursor).toBeNull();

    const pendingResponse = await fetch(`${base}/api/commands`, {
      method: "POST", headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host", target: "session", text: "pending work", idempotencyKey: "pending" }),
    });
    expect(pendingResponse.status).toBe(201);
    const pending = (await pendingResponse.json() as { command: { id: string } }).command;
    const secondClaim = await call("cooperative_claim", { requestId: "claim-pending" });
    expect(content(secondClaim).command.id).toBe(pending.id);
    const replacement = await incarnations.activate(principal);
    const queuedResponse = await fetch(`${base}/api/commands`, {
      method: "POST", headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host", target: "session", text: "new work", idempotencyKey: "new" }),
    });
    const queued = (await queuedResponse.json() as { command: { id: string } }).command;
    expect(queuedResponse.status).toBe(201);
    const beforeQueued = await inspection.inspect(queued.id);
    const beforePending = await inspection.inspect(pending.id);
    expect((await call("cooperative_claim", { requestId: "new-stale-claim" })).result.isError).toBe(true);
    expect((await call("cooperative_report", { commandId: pending.id, requestId: "new-stale-report", status: "accepted", detail: "valid transition" })).result.isError).toBe(true);
    expect(await inspection.inspect(queued.id)).toEqual(beforeQueued);
    expect(await inspection.inspect(pending.id)).toEqual(beforePending);

    const rawCall = async (headers: Record<string, string>, name: string, args: object) => fetch(`${base}/mcp`, {
      method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
    });
    const baseHeaders = { authorization: `Bearer ${supervisorToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    for (const headers of [
      baseHeaders,
      { ...baseHeaders, "x-fleet-incarnation-id": replacement.incarnationId },
      { ...baseHeaders, "x-fleet-incarnation-id": "forged", "x-fleet-incarnation-token": replacement.token },
      { ...baseHeaders, "x-fleet-incarnation-id": replacement.incarnationId, "x-fleet-incarnation-token": "wrong" },
    ]) {
      expect((await rawCall(headers, "cooperative_claim", { requestId: crypto.randomUUID() })).status).toBe(401);
    }
    const wrongToken = { ...baseHeaders, "x-fleet-incarnation-id": replacement.incarnationId, "x-fleet-incarnation-token": "A".repeat(43) };
    const forgedId = { ...baseHeaders, "x-fleet-incarnation-id": crypto.randomUUID(), "x-fleet-incarnation-token": replacement.token };
    for (const headers of [wrongToken, forgedId]) {
      const response = await rawCall(headers, "cooperative_claim", { requestId: crypto.randomUUID() });
      expect(response.status).toBe(200);
      expect((await response.json() as any).result.isError).toBe(true);
      const report = await rawCall(headers, "cooperative_report", { commandId: pending.id, requestId: crypto.randomUUID(), status: "accepted", detail: "valid transition" });
      expect(report.status).toBe(200);
      expect((await report.json() as any).result.isError).toBe(true);
    }
    expect((await rawCall({ ...baseHeaders, authorization: "Bearer forged" }, "cooperative_claim", { requestId: "forged-bearer" })).status).toBe(401);
    expect(await inspection.inspect(pending.id)).toEqual(beforePending);
    expect(await inspection.inspect(queued.id)).toEqual(beforeQueued);
    const liveHeaders = { ...baseHeaders, "x-fleet-incarnation-id": replacement.incarnationId, "x-fleet-incarnation-token": replacement.token };
    const liveClaim = await rawCall(liveHeaders, "cooperative_claim", { requestId: "live-claim" });
    expect(content(await liveClaim.json()).command.id).toBe(queued.id);
    const beforeRetirement = await inspection.inspect(queued.id);
    await identities.retire(principal);
    expect((await rawCall(liveHeaders, "cooperative_report", { commandId: queued.id, requestId: "retired-report", status: "accepted", detail: "valid transition" })).status).toBe(401);
    expect((await rawCall(liveHeaders, "cooperative_claim", { requestId: "retired-claim" })).status).toBe(401);
    // Retirement changes only the claim's flag: nobody can report on it any more.
    expect(beforeRetirement?.claim?.incarnationActive).toBe(true);
    expect(await inspection.inspect(queued.id)).toEqual({ ...beforeRetirement!, claim: { ...beforeRetirement!.claim!, incarnationActive: false } });
  } finally {
    listener?.stop(true);
    await Promise.all([db.close(), observer.close()]);
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
  }
});

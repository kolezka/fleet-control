import { SQL } from "bun";
import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
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
import { createCooperativeAdapter } from "../host-agent/cooperative-adapter.ts";

const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;
const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

pgTest("local adapter reaches loopback central and fences replaced incarnations", async () => {
  const admin = new SQL(url!);
  const schema = `adapter_integration_${crypto.randomUUID().replaceAll("-", "")}`;
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
    const operatorToken = token();
    const supervisorToken = token();
    const localToken = token();
    const auth = new CentralAuth([
      { tokenHash: hash(operatorToken), principal: { name: "operator", role: "operator" } },
      { tokenHash: hash(supervisorToken), principal },
    ]);
    const app = createCooperativeCentralApp({ auth, identities, commands, claims, lifecycle, inspection });
    listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const base = `http://127.0.0.1:${listener.port}`;
    const adapter = createCooperativeAdapter({
      centralUrl: `${base}/mcp`, localToken, supervisorToken,
      incarnationId: credential.incarnationId, incarnationToken: credential.token,
      centralFetch: fetch, allowLoopbackHttp: true,
    });
    const secrets = [localToken, operatorToken, supervisorToken, credential.token];
    const visible = async (response: Response) => {
      const text = await response.text();
      const output = `${JSON.stringify([...response.headers])} ${text}`;
      for (const secret of secrets) expect(output).not.toContain(secret);
      return text;
    };
    const submit = async (key: string) => {
      const response = await fetch(`${base}/api/commands`, {
        method: "POST", headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
        body: JSON.stringify({ hostId: "host", target: "session", text: `synthetic ${key}`, idempotencyKey: key }),
      });
      expect(response.status).toBe(201);
      return JSON.parse(await visible(response)).command.id as string;
    };
    const inspect = async (id: string) => {
      const response = await fetch(`${base}/api/commands/${id}/cooperative`, { headers: { authorization: `Bearer ${operatorToken}` } });
      expect(response.status).toBe(200);
      return JSON.parse(await visible(response));
    };
    const call = async (name: string, args: object, bearer = localToken) => {
      const response = await adapter(new Request("http://127.0.0.1:1234/mcp", {
        method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }));
      return { status: response.status, body: JSON.parse(await visible(response)) };
    };
    const content = (body: any) => JSON.parse(body.result.content[0].text);
    const commandId = await submit("first");
    expect((await inspect(commandId)).command.status).toBe("queued");
    expect((await call("cooperative_claim", { requestId: "claim" }, token())).status).toBe(401);
    expect((await inspect(commandId)).command.status).toBe("queued");
    const claim = await call("cooperative_claim", { requestId: "claim" });
    expect(claim.status).toBe(200);
    expect(content(claim.body).command.id).toBe(commandId);
    const claimRetry = await call("cooperative_claim", { requestId: "claim" });
    expect(content(claimRetry.body)).toEqual(content(claim.body));
    const reportArgs = { commandId, requestId: "accepted", status: "accepted", detail: "synthetic acceptance" };
    const report = await call("cooperative_report", reportArgs);
    expect(report.status).toBe(200);
    expect(content(report.body).event.status).toBe("accepted");
    expect(content((await call("cooperative_report", reportArgs)).body)).toEqual(content(report.body));
    const before = await inspect(commandId);
    expect(before.command.status).toBe("claimed");
    expect(before.events.map((event: { status: string }) => event.status)).toEqual(["accepted"]);
    const nextId = await submit("next");
    await incarnations.activate(principal);
    const staleClaim = await call("cooperative_claim", { requestId: "stale-claim" });
    const staleReport = await call("cooperative_report", { commandId, requestId: "stale-report", status: "running", detail: "synthetic running" });
    expect(staleClaim.status).toBe(200);
    expect(staleClaim.body.result.isError).toBe(true);
    expect(staleReport.status).toBe(200);
    expect(staleReport.body.result.isError).toBe(true);
    // Replacement changes only the claim's incarnation flag.
    expect(await inspect(commandId)).toEqual({ ...before, claim: { ...before.claim, incarnationActive: false } });
    const next = await inspect(nextId);
    expect(next.command.status).toBe("queued");
    expect(next.claim).toBeNull();
  } finally {
    listener?.stop(true);
    await Promise.all([db.close(), observer.close()]);
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
  }
});

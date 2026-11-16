import { SQL } from "bun";
import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
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
import { createCooperativeAdapter } from "../host-agent/cooperative-adapter.ts";
import { adapterWait, runWaker } from "../host-agent/waker.ts";

const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

// Real central, real adapter, real waker loop. The "agent" is a function that claims and
// completes through the same adapter, as a started agent process would.
pgTest("waker wakes an agent through the adapter when an operator submits, and the agent claims", async () => {
  const admin = new SQL(url!);
  const schema = `cooperative_waker_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const db = new SQL(url!, { connection: { search_path: schema } });
  const servers: ReturnType<typeof Bun.serve>[] = [];
  try {
    const principal = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    const commands = new CentralCommands(db);
    const identities = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    const claims = new CooperativeClaims(db, incarnations);
    const lifecycle = new CooperativeLifecycle(db, incarnations);
    await commands.initialize(); await new CentralAttempts(db).initialize(); await identities.initialize(); await incarnations.initialize();
    await claims.initialize(); await lifecycle.initialize(); await new CooperativeSettlement(db).initialize();
    await identities.enroll(principal);
    const credential = await incarnations.activate(principal);
    const operatorToken = randomBytes(32).toString("base64url");
    const supervisorToken = randomBytes(32).toString("base64url");
    const localToken = randomBytes(32).toString("base64url");
    const auth = new CentralAuth([
      { tokenHash: hash(operatorToken), principal: { name: "operator", role: "operator" } },
      { tokenHash: hash(supervisorToken), principal },
    ]);
    const app = createCooperativeCentralApp({ auth, identities, commands, claims, lifecycle, inspection: new CooperativeInspection(db) });
    servers.push(Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch }));
    const adapter = createCooperativeAdapter({
      centralUrl: `http://127.0.0.1:${servers[0]!.port}/mcp`, localToken, supervisorToken,
      incarnationId: credential.incarnationId, incarnationToken: credential.token,
      centralFetch: (input, init) => fetch(input, init), allowLoopbackHttp: true,
    });
    servers.push(Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: adapter }));
    const adapterUrl = `http://127.0.0.1:${servers[1]!.port}/mcp`;
    const config = { adapterUrl, localToken, command: ["/bin/true"], waitSeconds: 2 };

    const call = async (name: string, args: object) => {
      const response = await fetch(adapterUrl, { method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      const body = await response.json() as any;
      return JSON.parse(body.result.content[0].text);
    };
    const done: string[] = [];
    let starts = 0;
    const agent = async () => {
      starts++;
      for (let n = 0; ; n++) {
        const { command } = await call("cooperative_claim", { requestId: `claim-${starts}-${n}` });
        if (!command) return 0;
        for (const status of ["accepted", "running", "completed"]) await call("cooperative_report", { commandId: command.id, requestId: `${command.id}-${status}`, status, detail: status });
        done.push(command.id);
      }
    };

    let stop = false;
    const loop = runWaker(config, { wait: adapterWait(config), run: agent, sleep: (ms) => Bun.sleep(Math.min(ms, 50)), log: () => {} }, () => stop);
    // Idle: a full wait passes with no agent started.
    await Bun.sleep(2500);
    expect(starts).toBe(0);
    const submit = await fetch(`http://127.0.0.1:${servers[0]!.port}/api/commands`, { method: "POST", headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" }, body: JSON.stringify({ hostId: "host", target: "session", text: "do it", idempotencyKey: "wake-1" }) });
    expect(submit.status).toBeLessThan(300);
    const id = ((await submit.json()) as any).command.id as string;
    const deadline = performance.now() + 5000;
    while (!done.includes(id) && performance.now() < deadline) await Bun.sleep(50);
    stop = true;
    await loop;
    expect(done).toEqual([id]);
    expect(starts).toBe(1);
    const events = await db`SELECT status FROM central_command_events WHERE command_id = ${id} ORDER BY seq`;
    expect(events.map((e: any) => e.status)).toEqual(["queued", "claimed"]);
    const reports = await db`SELECT status FROM central_cooperative_lifecycle_events WHERE command_id = ${id} ORDER BY seq`;
    expect(reports.map((e: any) => e.status)).toEqual(["accepted", "running", "completed"]);
  } finally {
    for (const server of servers) server.stop(true);
    await db.close();
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
  }
});

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

const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;
const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

pgTest("claim response containing the local token remains unreadable after a committed claim", async () => {
  const address = new URL(url!);
  expect(address.protocol).toBe("postgres:");
  expect(address.hostname).toBe("127.0.0.1");
  expect(address.port).toBe("57507");
  expect(address.pathname).toBe("/fleet_control_test");
  expect(address.username).toBe("postgres");
  expect(address.password).toBe("");
  expect(address.search).toBe("");
  const admin = new SQL(url!);
  const schema = `claim_risk_` + crypto.randomUUID().replaceAll("-", "");
  let db: SQL | undefined;
  let observer: SQL | undefined;
  let listener: ReturnType<typeof Bun.serve> | undefined;
  let created = false;
  try {
    await admin`CREATE SCHEMA ${admin(schema)}`;
    created = true;
    db = new SQL(url!, { connection: { search_path: schema } });
    observer = new SQL(url!, { connection: { search_path: schema } });
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
    const submitted = await fetch(`${base}/api/commands`, {
      method: "POST", headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host", target: "session", text: `synthetic ${localToken}`, idempotencyKey: "submit" }),
    });
    expect(submitted.status).toBe(201);
    const { command } = await submitted.json() as { command: { id: string; status: string } };
    expect(command.status).toBe("queued");
    const inspect = async () => {
      const response = await fetch(`${base}/api/commands/${command.id}/cooperative`, { headers: { authorization: `Bearer ${operatorToken}` } });
      expect(response.status).toBe(200);
      return await response.json() as { command: { id: string; status: string }; claim: { incarnationId: string; requestId: string; createdAt: string } | null; events: unknown[] };
    };
    const before = await inspect();
    expect(before.command.status).toBe("queued");
    expect(before.claim).toBeNull();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cooperative_claim", arguments: { requestId: "claim-risk" } } });
    const call = () => adapter(new Request("http://127.0.0.1:1234/mcp", {
      method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" }, body,
    }));
    const assertUnreadable = async (response: Response) => {
      expect(response.status).toBe(502);
      const visible = `${JSON.stringify([...response.headers])} ${await response.text()}`;
      for (const secret of [localToken, operatorToken, supervisorToken, credential.token]) expect(visible).not.toContain(secret);
      expect(visible).toContain("outcome unknown");
    };
    await assertUnreadable(await call());
    const claimed = await inspect();
    expect(claimed.command.id).toBe(command.id);
    expect(claimed.command.status).toBe("claimed");
    expect(claimed.claim).toMatchObject({ incarnationId: credential.incarnationId, requestId: "claim-risk" });
    expect(claimed.events).toEqual([]);
    await assertUnreadable(await call());
    const retried = await inspect();
    expect(retried.command.status).toBe("claimed");
    expect(retried.claim).toEqual(claimed.claim);
    expect(retried.events).toEqual([]);
  } finally {
    listener?.stop(true);
    try {
      await Promise.all([db?.close(), observer?.close()]);
    } finally {
      try { if (created) await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
    }
  }
});

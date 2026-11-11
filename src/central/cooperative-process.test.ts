import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisorIncarnations } from "./incarnations.ts";
import { cleanupCooperativeRole, disposableCooperativeRole } from "./disposable-role-fixture.ts";

const databaseUrl = process.env.CENTRAL_TEST_DATABASE_URL;
const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

(databaseUrl ? test : test.skip)("separate central and adapter processes preserve cooperative fencing", async () => {
  const url = new URL(databaseUrl!);
  expect(["postgres:", "postgresql:"]).toContain(url.protocol);
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.port).toBe("57507");
  expect(url.pathname).toBe("/fleet_control_test");
  expect(url.search + url.hash).toBe("");
  const schema = `cooperative_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(join(tmpdir(), "fleet-cooperative-process-"));
  const credentialsFile = join(directory, "credentials.json");
  const incarnationFile = join(directory, "incarnation.json");
  const configFile = join(directory, "adapter.json");
  const operator = token(), supervisor = token(), local = token();
  const principal = { role: "supervisor" as const, name: "owner", principalId: "owner", hostId: "host", session: "session" };
  const admin = new SQL(databaseUrl!);
  let db: SQL | undefined;
  let fixture: Awaited<ReturnType<typeof disposableCooperativeRole>> | undefined;
  let ownedSchema = false;
  const children: Array<{ process: ReturnType<typeof Bun.spawn>; stdout: Promise<string>; stderr: Promise<string> }> = [];
  const secrets = [operator, supervisor, local];
  const noSecrets = (text: string) => { for (const secret of secrets) expect(text).not.toContain(secret); };
  const start = async (entry: string, env: Record<string, string>) => {
    const child = Bun.spawn([process.execPath, entry], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let ready!: (line: string) => void;
    let failed!: (error: Error) => void;
    const line = new Promise<string>((resolve, reject) => { ready = resolve; failed = reject; });
    const stdout = (async () => {
      let announced = false;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          output += decoder.decode(chunk.value, { stream: true });
          const newline = output.indexOf("\n");
          if (!announced && newline >= 0) { announced = true; ready(output.slice(0, newline)); }
        }
        output += decoder.decode();
        if (!announced) failed(new Error(`process exited before readiness: ${entry}`));
        return output;
      } catch (error) { failed(new Error(`process output failed: ${entry}`)); throw error; }
    })();
    const stderr = new Response(child.stderr).text();
    children.push({ process: child, stdout, stderr });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([line, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`startup timeout: ${entry}`)), 10000); })]);
      noSecrets(result);
      return JSON.parse(result);
    } finally { if (timer) clearTimeout(timer); }
  };
  const request = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  const visible = async (response: Response) => {
    const text = await response.text();
    noSecrets(JSON.stringify([...response.headers]) + text);
    return JSON.parse(text);
  };
  try {
    expect((await admin`SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${schema}`).length).toBe(0);
    fixture = await disposableCooperativeRole(databaseUrl!);
    secrets.push(new URL(fixture.runtimeUrl).password, fixture.runtimeUrl);
    await writeFile(credentialsFile, JSON.stringify([
      { tokenHash: hash(operator), principal: { role: "operator", name: "operator" } },
      { tokenHash: hash(supervisor), principal },
    ]), { mode: 0o600, flag: "wx" });
    const central = await start("src/central/cooperative-main.ts", {
      COOPERATIVE_DATABASE_URL: databaseUrl!, COOPERATIVE_RUNTIME_DATABASE_URL: fixture.runtimeUrl, COOPERATIVE_SCHEMA: schema, COOPERATIVE_CREDENTIALS_FILE: credentialsFile,
      COOPERATIVE_INCARNATION_FILE: incarnationFile, COOPERATIVE_PORT: "0",
    });
    ownedSchema = true;
    expect(Object.keys(central).sort()).toEqual(["incarnationId", "url"]);
    expect(central.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const toolsResponse = await request(`${central.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    expect(toolsResponse.status).toBe(200);
    const tools = (await visible(toolsResponse)).result.tools as { name: string }[];
    expect(tools.map((tool) => tool.name)).toContain("command_submit");
    expect(tools.map((tool) => tool.name).filter((name) => name.startsWith("request_") || name.startsWith("run_") || name.startsWith("phase_"))).toEqual([]);
    const incarnation = await Bun.file(incarnationFile).json() as { incarnationId: string; token: string };
    expect(Object.keys(incarnation).sort()).toEqual(["incarnationId", "token"]);
    expect(incarnation.incarnationId).toBe(central.incarnationId);
    secrets.push(incarnation.token);
    await writeFile(configFile, JSON.stringify({ centralUrl: `${central.url}/mcp`, localToken: local, supervisorToken: supervisor, incarnationFile }), { mode: 0o600, flag: "wx" });
    const adapter = await start("src/host-agent/cooperative-main.ts", { COOPERATIVE_ADAPTER_CONFIG_FILE: configFile });
    expect(Object.keys(adapter)).toEqual(["url"]);
    expect(adapter.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const submit = async (key: string) => {
      const response = await request(`${central.url}/api/commands`, { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" }, body: JSON.stringify({ hostId: "host", target: "session", text: `synthetic ${key}`, idempotencyKey: key }) });
      expect(response.status).toBe(201);
      return (await visible(response)).command.id as string;
    };
    const inspect = async (id: string) => {
      const response = await request(`${central.url}/api/commands/${id}/cooperative`, { headers: { authorization: `Bearer ${operator}` } });
      expect(response.status).toBe(200);
      return await visible(response);
    };
    const call = async (name: string, args: object, bearer = local, adapterUrl = adapter.url) => {
      const response = await request(`${adapterUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      return { status: response.status, body: await visible(response) };
    };
    const content = (body: any) => JSON.parse(body.result.content[0].text);
    const id = await submit("first");
    const initial = await inspect(id);
    expect(initial.command.status).toBe("queued");
    expect((await call("cooperative_claim", { requestId: "claim" }, token())).status).toBe(401);
    expect(await inspect(id)).toEqual(initial);
    const claim = await call("cooperative_claim", { requestId: "claim" });
    expect(claim.status).toBe(200);
    expect(content(claim.body).command.id).toBe(id);
    expect(content((await call("cooperative_claim", { requestId: "claim" })).body)).toEqual(content(claim.body));
    const args = { commandId: id, requestId: "accepted", status: "accepted", detail: "synthetic acceptance" };
    const report = await call("cooperative_report", args);
    expect(report.status).toBe(200);
    expect(content(report.body).event.status).toBe("accepted");
    expect(content((await call("cooperative_report", args)).body)).toEqual(content(report.body));
    const completed = await call("cooperative_report", { commandId: id, requestId: "completed", status: "completed", detail: "synthetic completion" });
    expect(content(completed.body).event.status).toBe("completed");
    const finished = await inspect(id);
    expect(finished.command.status).toBe("claimed");
    expect(finished.events.map((event: { status: string }) => event.status)).toEqual(["accepted", "completed"]);
    const activeId = await submit("active");
    expect(content((await call("cooperative_claim", { requestId: "active-claim" })).body).command.id).toBe(activeId);
    expect(content((await call("cooperative_report", { commandId: activeId, requestId: "active-accept", status: "accepted", detail: "synthetic" })).body).event.status).toBe("accepted");
    const before = await inspect(activeId);
    expect(before.events.map((event: { status: string }) => event.status)).toEqual(["accepted"]);
    const nextId = await submit("next");
    const nextBefore = await inspect(nextId);
    expect(nextBefore.command.status).toBe("queued");
    expect(nextBefore.claim).toBeNull();
    db = new SQL(fixture.runtimeUrl, { connection: { search_path: schema } });
    const [runtime] = await db`SELECT current_user AS role, current_schema() AS name`;
    expect(runtime?.role).toBe(fixture.role);
    expect(runtime?.name).toBe(schema);
    const replacement = await new SupervisorIncarnations(db).activate(principal);
    secrets.push(replacement.token);
    const incarnations = new SupervisorIncarnations(db);
    expect(await db.begin((tx) => incarnations.lockForClaim(tx, principal, incarnation))).toBe(false);
    expect(await db.begin((tx) => incarnations.lockForClaim(tx, principal, replacement))).toBe(true);
    const staleClaim = await call("cooperative_claim", { requestId: "stale-claim" });
    const staleReport = await call("cooperative_report", { commandId: activeId, requestId: "stale-report", status: "running", detail: "synthetic" });
    expect(staleClaim.status).toBe(200);
    expect(staleClaim.body.result).toEqual({ isError: true, content: [{ type: "text", text: "request failed" }] });
    expect(staleReport.status).toBe(200);
    expect(staleReport.body.result).toEqual({ isError: true, content: [{ type: "text", text: "request failed" }] });
    expect(await inspect(activeId)).toEqual(before);
    expect(await inspect(nextId)).toEqual(nextBefore);

    const replacementFile = join(directory, "replacement-incarnation.json");
    const replacementConfigFile = join(directory, "replacement-adapter.json");
    await writeFile(replacementFile, JSON.stringify(replacement), { mode: 0o600, flag: "wx" });
    await writeFile(replacementConfigFile, JSON.stringify({ centralUrl: `${central.url}/mcp`, localToken: local, supervisorToken: supervisor, incarnationFile: replacementFile }), { mode: 0o600, flag: "wx" });
    const replacementAdapter = await start("src/host-agent/cooperative-main.ts", { COOPERATIVE_ADAPTER_CONFIG_FILE: replacementConfigFile });
    expect(Object.keys(replacementAdapter)).toEqual(["url"]);
    expect(replacementAdapter.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const replacementClaim = await call("cooperative_claim", { requestId: "replacement-claim" }, local, replacementAdapter.url);
    expect(replacementClaim.status).toBe(200);
    expect(content(replacementClaim.body).command.id).toBe(nextId);
    const nextClaimed = await inspect(nextId);
    expect(nextClaimed.command.status).toBe("claimed");
    expect(nextClaimed.claim.incarnationId).toBe(replacement.incarnationId);
    expect(nextClaimed.claim.requestId).toBe("replacement-claim");
    expect(nextClaimed.events).toEqual([]);
    const replacementReport = await call("cooperative_report", { commandId: activeId, requestId: "replacement-report", status: "running", detail: "synthetic" }, local, replacementAdapter.url);
    expect(replacementReport.status).toBe(200);
    expect(replacementReport.body.result).toEqual({ isError: true, content: [{ type: "text", text: "request failed" }] });
    expect(await inspect(activeId)).toEqual(before);
    expect(await inspect(nextId)).toEqual(nextClaimed);
  } finally {
    for (const child of children) child.process.kill("SIGKILL");
    const outputs: string[] = [];
    try {
      for (const child of children) {
        await child.process.exited;
        outputs.push(await child.stdout, await child.stderr);
      }
    } finally {
      try { await db?.close(); } finally {
        // Readiness proves this process provisioned the schema. On startup failure,
        // leave an ambiguous schema untouched and identify it for manual inspection.
        try {
          if (ownedSchema) await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
        }
        finally { try { if (fixture) await cleanupCooperativeRole(fixture, schema, !ownedSchema && children.length > 0); } finally { try { await admin.close(); } finally { await rm(directory, { recursive: true, force: true }); } } }
      }
    }
    for (const output of outputs) noSecrets(output);
  }
}, 30000);

import { SQL } from "bun";
import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCentral } from "./main.ts";

const databaseUrl = process.env.CENTRAL_TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

integration("CLI enrollment and retirement gate loopback MCP requests and startup", async () => {
  const parsed = new URL(databaseUrl!);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/fleet_control_test' || parsed.search || parsed.hash) {
    throw new Error("integration test requires a local disposable fleet_control_test database URL without parameters");
  }

  const directory = await mkdtemp(join(tmpdir(), "fleet-central-identity-"));
  const credentialsFile = join(directory, "credentials.json");
  const suffix = randomUUID();
  const identity = { principalId: `identity-${suffix}`, name: `supervisor-${suffix}`, hostId: `host-${suffix}`, session: `session-${suffix}` };
  const token = randomUUID();
  const args = ["--principal-id", identity.principalId, "--name", identity.name, "--host-id", identity.hostId, "--session", identity.session];
  const env = { CENTRAL_DATABASE_URL: databaseUrl!, CENTRAL_CREDENTIALS_FILE: credentialsFile, CENTRAL_PORT: "1" };
  const db = new SQL(databaseUrl!);
  let server: Awaited<ReturnType<typeof startCentral>> | undefined;
  let port = 0;
  let enrolled = false;
  const deps = {
    readCredentials: (path: string) => Bun.file(path).text(),
    createSql: (url: string) => new SQL(url),
    serve: (options: Parameters<NonNullable<Parameters<typeof startCentral>[1]>["serve"]>[0]) => {
      const listener = Bun.serve({ ...options, port: 0 });
      port = listener.port!;
      return listener;
    },
  };
  const cli = async (action: "enroll" | "retire") => {
    const process = Bun.spawn([processExecPath, "src/central/identity-cli.ts", action, ...args], {
      env: { ...Bun.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect({ exitCode, stdout: stdout.trim(), stderr: stderr.trim() }).toEqual({ exitCode: 0, stdout: `Supervisor identity ${action === "enroll" ? "enrolled" : "retired"}.`, stderr: "" });
  };
  const mcp = () => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  try {
    await writeFile(credentialsFile, JSON.stringify([{ tokenHash: createHash("sha256").update(token).digest("hex"), principal: { ...identity, role: "supervisor" } }]), { mode: 0o600 });
    await expect(startCentral(env, deps)).rejects.toThrow("central startup failed");
    await cli("enroll");
    enrolled = true;
    server = await startCentral(env, deps);
    const accepted = await mcp();
    expect(accepted.status).toBe(200);
    const response = await accepted.json() as { id: number; result?: { tools?: { name: string }[] } };
    expect(response.id).toBe(1);
    expect(response.result?.tools?.map((tool) => tool.name)).toContain("command_list");
    await cli("retire");
    const denied = await mcp();
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "unauthorized" });
    await server.stop();
    server = undefined;
    await expect(startCentral(env, deps)).rejects.toThrow("central startup failed");
  } finally {
    try {
      if (server) await server.stop();
    } finally {
      try {
        if (enrolled) await db`DELETE FROM central_supervisor_identities_v2 WHERE principal_id = ${identity.principalId}`;
      } finally {
        await db.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}, 30000);

const processExecPath = process.execPath;

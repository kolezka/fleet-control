// Local real-agent smoke: Claude Code (default ~/.claude config) talks to the cooperative
// adapter over loopback MCP, claims one synthetic command and reports its lifecycle.
// Opt-in only: spends model tokens. Needs CENTRAL_TEST_DATABASE_URL for the disposable
// test database (127.0.0.1:57507/fleet_control_test) and a logged-in \`claude\` CLI.
// Usage: REAL_AGENT_SMOKE=1 CENTRAL_TEST_DATABASE_URL=... bun scripts/real-agent-smoke.ts [--replacement]
// --replacement then replaces the incarnation, checks that an agent on the old adapter
// is fenced, and that an agent on a new adapter claims and reports the next command.
import { SQL } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { disposableCooperativeRole } from "../src/central/disposable-role-fixture.ts";
import { SupervisorIncarnations } from "../src/central/incarnations.ts";

const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const root = resolve(import.meta.dir, "..");

type Child = { process: ReturnType<typeof Bun.spawn>; stderr: Promise<string> };

async function start(entry: string, env: Record<string, string>, children: Child[]): Promise<Record<string, string>> {
  const child = Bun.spawn([process.execPath, join(root, entry)], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  children.push({ process: child, stderr: new Response(child.stderr).text() });
  const reader = child.stdout.getReader();
  let output = "";
  const deadline = Date.now() + 10_000;
  while (!output.includes("\n")) {
    if (Date.now() > deadline) throw new Error(`startup timeout: ${entry}`);
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`process exited before readiness: ${entry}`);
    output += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  return JSON.parse(output.slice(0, output.indexOf("\n")));
}

type AgentRun = { exit: number; result: unknown; stdout: string; stderr: string };

async function runAgent(claudeBin: string, model: string, directory: string, name: string, adapterUrl: string, local: string, prompt: string): Promise<AgentRun> {
  const mcpConfig = join(directory, `${name}-mcp.json`);
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: { fleet: { type: "http", url: `${adapterUrl}/mcp`, headers: { Authorization: `Bearer ${local}` } } } }), { mode: 0o600, flag: "wx" });
  const agent = Bun.spawn([claudeBin, "-p", prompt, "--model", model, "--mcp-config", mcpConfig, "--strict-mcp-config",
    "--allowedTools", "mcp__fleet__cooperative_claim,mcp__fleet__cooperative_report", "--output-format", "json", "--max-turns", "12"],
    { cwd: directory, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", USER: process.env.USER ?? "", TERM: "dumb" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => agent.kill(), 180_000);
  const [stdout, stderr, exit] = await Promise.all([new Response(agent.stdout).text(), new Response(agent.stderr).text(), agent.exited]);
  clearTimeout(timer);
  let result: unknown;
  try { const parsed = JSON.parse(stdout); result = { is_error: parsed.is_error, num_turns: parsed.num_turns, result: parsed.result, total_cost_usd: parsed.total_cost_usd }; }
  catch { result = { unparsed: true }; }
  return { exit, result, stdout, stderr };
}

export async function runRealAgentSmoke(databaseUrl: string, claudeBin = "claude", model = "haiku", replacement = false) {
  const schema = `cooperative_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(join(tmpdir(), "fleet-real-agent-"));
  const children: Child[] = [];
  const operator = token(), supervisor = token(), local = token();
  const principal = { role: "supervisor" as const, name: "owner", principalId: "owner", hostId: "host", session: "session" };
  const admin = new SQL(databaseUrl);
  const fixture = await disposableCooperativeRole(databaseUrl);
  const secrets = [operator, supervisor, local, fixture.runtimeUrl];
  const redact = (text: string) => secrets.reduce((acc, secret) => acc.replaceAll(secret, "<redacted>"), text);
  try {
    const credentialsFile = join(directory, "credentials.json");
    const incarnationFile = join(directory, "incarnation.json");
    await writeFile(credentialsFile, JSON.stringify([
      { tokenHash: hash(operator), principal: { role: "operator", name: "operator" } },
      { tokenHash: hash(supervisor), principal },
    ]), { mode: 0o600, flag: "wx" });
    const central = await start("src/central/cooperative-main.ts", {
      COOPERATIVE_DATABASE_URL: databaseUrl, COOPERATIVE_RUNTIME_DATABASE_URL: fixture.runtimeUrl, COOPERATIVE_SCHEMA: schema,
      COOPERATIVE_CREDENTIALS_FILE: credentialsFile, COOPERATIVE_INCARNATION_FILE: incarnationFile, COOPERATIVE_PORT: "0",
    }, children);
    const configFile = join(directory, "adapter.json");
    await writeFile(configFile, JSON.stringify({ centralUrl: `${central.url}/mcp`, localToken: local, supervisorToken: supervisor, incarnationFile }), { mode: 0o600, flag: "wx" });
    const adapter = await start("src/host-agent/cooperative-main.ts", { COOPERATIVE_ADAPTER_CONFIG_FILE: configFile }, children);
    const operatorHeaders = { authorization: `Bearer ${operator}`, "content-type": "application/json" };
    const submitted = await fetch(`${central.url}/api/commands`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ hostId: "host", target: "session", text: "Synthetic smoke task: compute 17 + 25 and report only the number.", idempotencyKey: "real-agent-smoke" }) });
    if (submitted.status !== 201) throw new Error(`submit failed: ${submitted.status}`);
    const commandId = ((await submitted.json()) as { command: { id: string } }).command.id;

    const prompt = [
      "You are a Fleet Control supervisor in a local synthetic test. Use only the fleet MCP tools.",
      "1. Call cooperative_claim with requestId \"claim-1\".",
      "2. If it returns a command, call cooperative_report for that commandId with requestId \"r-accepted\", status \"accepted\", detail \"accepted\".",
      "3. Then report requestId \"r-running\", status \"running\", detail \"running\".",
      "4. Do the task in the command text yourself (no tools needed), then report requestId \"r-completed\", status \"completed\", detail set to your answer.",
      "Never claim again and never retry with a different requestId. Finish with one line: DONE <commandId>.",
    ].join("\n");
    const run = await runAgent(claudeBin, model, directory, "agent", adapter.url!, local, prompt);
    const agentOut = run.stdout, agentErr = run.stderr, agentExit = run.exit, agentResult = run.result;

    const inspect = async (id: string, incarnationId: string) => {
      const inspected = await (await fetch(`${central.url}/api/commands/${id}/cooperative`, { headers: operatorHeaders })).json() as any;
      const events: any[] = [...inspected.events];
      let page = inspected;
      while (page.nextCursor) {
        page = await (await fetch(`${central.url}/api/commands/${id}/cooperative?cursor=${page.nextCursor}`, { headers: operatorHeaders })).json();
        events.push(...page.events);
      }
      return {
        commandId: id, commandStatus: inspected.command.status as string,
        claim: inspected.claim ? { incarnationMatches: inspected.claim.incarnationId === incarnationId, requestId: inspected.claim.requestId as string, incarnationActive: inspected.claim.incarnationActive as boolean } : null,
        events: events.map((event) => ({ requestId: event.requestId as string, status: event.status as string, detail: event.detail as string })),
      };
    };
    const outputs = [agentOut, agentErr];
    const first = await inspect(commandId, central.incarnationId!);
    let replacementResult: Record<string, unknown> | null = null;
    if (replacement) {
      const nextSubmit = await fetch(`${central.url}/api/commands`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ hostId: "host", target: "session", text: "Synthetic smoke task: compute 6 * 7 and report only the number.", idempotencyKey: "real-agent-smoke-next" }) });
      if (nextSubmit.status !== 201) throw new Error(`submit failed: ${nextSubmit.status}`);
      const nextId = ((await nextSubmit.json()) as { command: { id: string } }).command.id;
      // Replace the incarnation the way a restarted supervisor would; the old adapter keeps its stale credential.
      const db = new SQL(fixture.runtimeUrl, { connection: { search_path: schema } });
      let fresh: { incarnationId: string; token: string };
      try { fresh = await new SupervisorIncarnations(db).activate(principal); } finally { await db.close(); }
      secrets.push(fresh.token);
      const stalePrompt = [
        "You are a Fleet Control supervisor in a local synthetic test. Use only the fleet MCP tools.",
        "1. Call cooperative_claim once with requestId \"stale-claim\".",
        `2. Call cooperative_report once with commandId \"${commandId}\", requestId \"stale-report\", status \"failed\", detail \"stale\".`,
        "Do not retry any call and do not use other requestIds. Finish with one line: RESULTS <claim outcome>; <report outcome>.",
      ].join("\n");
      const stale = await runAgent(claudeBin, model, directory, "stale", adapter.url!, local, stalePrompt);
      outputs.push(stale.stdout, stale.stderr);
      const replacementFile = join(directory, "replacement-incarnation.json");
      await writeFile(replacementFile, JSON.stringify(fresh), { mode: 0o600, flag: "wx" });
      const replacementConfig = join(directory, "replacement-adapter.json");
      await writeFile(replacementConfig, JSON.stringify({ centralUrl: `${central.url}/mcp`, localToken: local, supervisorToken: supervisor, incarnationFile: replacementFile }), { mode: 0o600, flag: "wx" });
      const freshAdapter = await start("src/host-agent/cooperative-main.ts", { COOPERATIVE_ADAPTER_CONFIG_FILE: replacementConfig }, children);
      const freshPrompt = prompt.replace("\"claim-1\"", "\"claim-2\"").replaceAll("\"r-", "\"n-");
      const next = await runAgent(claudeBin, model, directory, "fresh", freshAdapter.url!, local, freshPrompt);
      outputs.push(next.stdout, next.stderr);
      const afterFirst = await inspect(commandId, central.incarnationId!);
      const afterNext = await inspect(nextId, fresh.incarnationId);
      replacementResult = {
        staleAgent: { exit: stale.exit, result: stale.result },
        freshAgent: { exit: next.exit, result: next.result },
        firstAfter: afterFirst, next: afterNext,
        fenced: afterFirst.claim?.incarnationActive === false && JSON.stringify(afterFirst.events) === JSON.stringify(first.events),
        freshCompleted: !!afterNext.claim?.incarnationMatches && afterNext.claim.requestId === "claim-2" && afterNext.events.map((event) => event.status).join(",") === "accepted,running,completed",
      };
    }
    const leaked = secrets.some((secret) => outputs.some((text) => text.includes(secret)));
    return { agentExit, agent: agentResult, agentStderr: redact(agentErr.slice(-1500)), leaked, ...first, replacement: replacementResult };
  } finally {
    for (const child of children) child.process.kill("SIGTERM");
    await Promise.allSettled(children.map((child) => child.process.exited));
    await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
    await admin.close();
    await fixture.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.env.REAL_AGENT_SMOKE !== "1" || !process.env.CENTRAL_TEST_DATABASE_URL) {
    console.error("set REAL_AGENT_SMOKE=1 and CENTRAL_TEST_DATABASE_URL");
    process.exit(2);
  }
  const replacement = process.argv.includes("--replacement");
  const result = await runRealAgentSmoke(process.env.CENTRAL_TEST_DATABASE_URL, "claude", "haiku", replacement);
  console.log(JSON.stringify(result, null, 2));
  const statuses = result.events.map((event) => event.status).join(",");
  const replaced = !replacement || (result.replacement?.fenced === true && result.replacement?.freshCompleted === true);
  process.exit(result.claim && statuses === "accepted,running,completed" && !result.leaked && replaced ? 0 : 1);
}

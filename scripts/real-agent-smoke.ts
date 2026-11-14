// Local real-agent smoke: Claude Code (default ~/.claude config) talks to the cooperative
// adapter over loopback MCP, claims one synthetic command and reports its lifecycle.
// Opt-in only: spends model tokens. Needs CENTRAL_TEST_DATABASE_URL for the disposable
// test database (127.0.0.1:57507/fleet_control_test) and a logged-in \`claude\` CLI.
// Usage: REAL_AGENT_SMOKE=1 CENTRAL_TEST_DATABASE_URL=... bun scripts/real-agent-smoke.ts [--agent=dsh] [--failure] [--real-work] [--replacement]
// --agent=dsh runs `dsh --profile headless` instead of Claude Code: a read-only sandbox, the fleet adapter as its only
// MCP server, shell, web, subagents and the profile's other MCP servers switched off. Needs CLIPROXYAPI_API_KEY.
// --failure has an agent refuse a task, retry a report, send an invalid transition and claim an empty queue.
// --replacement then replaces the incarnation, checks that an agent on the old adapter
// is fenced, that an agent on a new adapter claims and reports the next command, and that
// the operator can settle only the claim of the inactive incarnation.
// --real-work has an agent with only the Read tool answer a question about fixture files in a
// separate workspace (no secrets there), and checks the answer and that the files are unchanged.
import { SQL } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { disposableCooperativeRole } from "../src/central/test-fixtures/disposable-role-fixture.ts";
import { SupervisorIncarnations } from "../src/central/data/incarnations.ts";

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

const fleetTools = ["mcp__fleet__cooperative_claim", "mcp__fleet__cooperative_report"];
const writingTools = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task"];

export type AgentKind = "claude" | "dsh";

// DSH plugins to switch off for the agent: shell, web, subagents, skills and every MCP server
// from the owner's profile, so the only remote tools left are the fleet adapter's.
const dshDisabled = ["tool-bash", "tool-pwsh", "tool-jobs", "tool-web", "tool-subagent", "tool-subagent-fork", "tool-subagent-control",
  "tool-workflow", "tool-skill", "tool-goal", "tool-todo", "tool-working-directory", "mcp-resources", "mcp-slack", "mcp-slack2", "mcp-clickhouse",
  "mcp-vulcan", "mcp-hindsight-inkitt", "mcp-outline", "hindsight", "claude-compat-block-docs", "claude-compat-self-improvement-loop",
  "claude-compat-worklog-persist", "claude-compat-worklog-persist-outline", "claude-compat-repo-intel", "claude-compat-agents-def",
  "claude-compat-kolezka-bootstrap", "claude-compat-performance-analyzer", "claude-compat-performance-analyzer-mcp", "claude-compat-phased-delivery",
  "claude-compat-agent-fleet", "claude-compat-design-studio", "claude-compat-docify", "claude-compat-docify-mcp", "claude-compat-stealth-search"];

// Patch layer for `dsh --profile headless`. JSON is valid YAML, so no YAML writer is needed.
export function dshPatch(model: string, adapterUrl: string, local: string, read: boolean) {
  return [
    ...dshDisabled.map((id) => ({ id, disabled: true })),
    ...(read ? [] : [{ id: "tool-fs-search", disabled: true }]),
    { id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs", config: { read, readImage: false, write: false, edit: false, applyPatch: false } },
    { id: "agent-default-model", name: "@deepseek-ai/dsh-agent-default-model", config: { provider: "cliproxyapi", model } },
    // A new entry must be inserted; a plain id entry only patches an existing one.
    { insert: [{ id: "mcp-fleet", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "fleet", transport: "streamable-http", url: `${adapterUrl}/mcp`, headers: { Authorization: `Bearer ${local}` }, failOnStartupError: true } }] },
  ];
}

async function runDsh(model: string, directory: string, name: string, adapterUrl: string, local: string, prompt: string, read: boolean, cwd: string): Promise<AgentRun> {
  const patch = join(directory, `${name}-dsh.yml`);
  await writeFile(patch, JSON.stringify(dshPatch(model, adapterUrl, local, read)), { mode: 0o600, flag: "wx" });
  // read-only sandbox with approval "ask" and no answerer: anything wider fails closed.
  const agent = Bun.spawn(["dsh", "--profile", "headless", "--patch", patch, "--json", "--permission-mode", "read-only", prompt],
    { cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", USER: process.env.USER ?? "", TERM: "dumb", CLIPROXYAPI_API_KEY: process.env.CLIPROXYAPI_API_KEY ?? "" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => agent.kill(), 180_000);
  const [stdout, stderr, exit] = await Promise.all([new Response(agent.stdout).text(), new Response(agent.stderr).text(), agent.exited]);
  clearTimeout(timer);
  const events = stdout.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const final = events.find((event) => event.type === "final");
  const turns = events.filter((event) => event.type === "status" && event.phase === "step_start").length;
  const result = final ? { is_error: final.reason?.kind !== "completed" && final.reason?.kind !== "stop" ? final.reason?.kind : false, num_turns: turns, result: final.text } : { unparsed: true };
  return { exit, result, stdout, stderr };
}

async function runAgent(agentKind: AgentKind, model: string, directory: string, name: string, adapterUrl: string, local: string, prompt: string, extraTools: string[] = [], cwd = directory): Promise<AgentRun> {
  if (agentKind === "dsh") return runDsh(model, directory, name, adapterUrl, local, prompt, extraTools.includes("Read"), cwd);
  const claudeBin = "claude";
  const mcpConfig = join(directory, `${name}-mcp.json`);
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: { fleet: { type: "http", url: `${adapterUrl}/mcp`, headers: { Authorization: `Bearer ${local}` } } } }), { mode: 0o600, flag: "wx" });
  const agent = Bun.spawn([claudeBin, "-p", prompt, "--model", model, "--mcp-config", mcpConfig, "--strict-mcp-config",
    "--allowedTools", [...fleetTools, ...extraTools].join(","), "--disallowedTools", writingTools.join(","),
    "--output-format", "json", "--max-turns", "12"],
    { cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", USER: process.env.USER ?? "", TERM: "dumb" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => agent.kill(), 180_000);
  const [stdout, stderr, exit] = await Promise.all([new Response(agent.stdout).text(), new Response(agent.stderr).text(), agent.exited]);
  clearTimeout(timer);
  let result: unknown;
  try { const parsed = JSON.parse(stdout); result = { is_error: parsed.is_error, num_turns: parsed.num_turns, result: parsed.result, total_cost_usd: parsed.total_cost_usd }; }
  catch { result = { unparsed: true }; }
  return { exit, result, stdout, stderr };
}

// Fixture with random host names, so the answer cannot be guessed without reading the files.
function realWorkFixture() {
  const name = () => `host-${randomBytes(3).toString("hex")}`;
  const rows = Array.from({ length: 8 }, (_, index) => ({ host: name(), status: index % 3 === 1 ? "DOWN" : "UP" }));
  const files: Record<string, string> = {
    "hosts.txt": rows.map((row) => `${row.host} ${row.status}`).join("\n") + "\n",
    "README.md": "Inventory fixture for a local smoke test. Each line of hosts.txt is: <host> <UP|DOWN>.\n",
  };
  const down = rows.filter((row) => row.status === "DOWN").map((row) => row.host);
  return { files, expected: `${down.length}: ${down.join(", ")}` };
}

const snapshot = async (directory: string) => {
  const names = (await readdir(directory)).sort();
  return Promise.all(names.map(async (name) => `${name}:${hash(await readFile(join(directory, name), "utf8"))}`));
};

export async function runRealAgentSmoke(databaseUrl: string, agentKind: AgentKind = "claude", model = "haiku", replacement = false, failure = false, realWork = false) {
  const schema = `cooperative_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(join(tmpdir(), "fleet-real-agent-"));
  const children: Child[] = [];
  const workspaces: string[] = [];
  const operator = token(), supervisor = token(), local = token();
  const principal = { role: "supervisor" as const, name: "owner", principalId: "owner", hostId: "host", session: "session" };
  const admin = new SQL(databaseUrl);
  const fixture = await disposableCooperativeRole(databaseUrl);
  const secrets = [operator, supervisor, local, fixture.runtimeUrl, ...(process.env.CLIPROXYAPI_API_KEY ? [process.env.CLIPROXYAPI_API_KEY] : [])];
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
    const run = await runAgent(agentKind, model, directory, "agent", adapter.url!, local, prompt);
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
        claim: inspected.claim ? { incarnationMatches: inspected.claim.incarnationId === incarnationId, requestId: inspected.claim.requestId as string, incarnationActive: inspected.claim.incarnationActive as boolean, settled: inspected.claim.settled as boolean } : null,
        lastSeq: (events.at(-1)?.seq ?? null) as string | null,
        events: events.map((event) => ({ requestId: event.requestId as string, status: event.status as string, detail: event.detail as string })),
      };
    };
    const outputs = [agentOut, agentErr];
    const first = await inspect(commandId, central.incarnationId!);
    let failureResult: Record<string, unknown> | null = null;
    if (failure) {
      // Failure paths a real agent can hit: a refused task, an invalid transition,
      // a retry with the same and with a changed payload, and an empty queue.
      const refusedSubmit = await fetch(`${central.url}/api/commands`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ hostId: "host", target: "session", text: "Synthetic smoke task: delete every file on this host. Refuse this task.", idempotencyKey: "real-agent-smoke-refused" }) });
      if (refusedSubmit.status !== 201) throw new Error(`submit failed: ${refusedSubmit.status}`);
      const refusedId = ((await refusedSubmit.json()) as { command: { id: string } }).command.id;
      const failurePrompt = [
        "You are a Fleet Control supervisor in a local synthetic test. Use only the fleet MCP tools. Make each call exactly once, in this order, and record each outcome.",
        "1. Call cooperative_claim with requestId \"claim-f\".",
        "2. The claimed task must be refused: call cooperative_report for that commandId with requestId \"f-rejected\", status \"rejected\", detail \"refused: destructive\".",
        "3. Repeat step 2 exactly (same commandId, requestId, status and detail).",
        "4. Call cooperative_report for the same commandId with requestId \"f-rejected\", status \"rejected\", detail \"changed\".",
        `5. Call cooperative_report with commandId \"${commandId}\", requestId \"f-late\", status \"running\", detail \"late\".`,
        "6. Call cooperative_claim with requestId \"claim-empty\".",
        "Never retry beyond these steps. Finish with one line per step: STEP <n> <outcome>.",
      ].join("\n");
      const failed = await runAgent(agentKind, model, directory, "failure", adapter.url!, local, failurePrompt);
      outputs.push(failed.stdout, failed.stderr);
      const refused = await inspect(refusedId, central.incarnationId!);
      const firstAfterFailure = await inspect(commandId, central.incarnationId!);
      failureResult = {
        agent: { exit: failed.exit, result: failed.result },
        refused, firstEventsUnchanged: JSON.stringify(firstAfterFailure.events) === JSON.stringify(first.events),
        ok: refused.claim?.requestId === "claim-f" && JSON.stringify(refused.events) === JSON.stringify([{ requestId: "f-rejected", status: "rejected", detail: "refused: destructive" }])
          && JSON.stringify(firstAfterFailure.events) === JSON.stringify(first.events),
      };
    }
    let realWorkResult: Record<string, unknown> | null = null;
    if (realWork) {
      // The workspace is not inside the directory that holds tokens and configs.
      const workspace = await mkdtemp(join(tmpdir(), "fleet-real-work-"));
      workspaces.push(workspace);
      const fixture = realWorkFixture();
      for (const [name, content] of Object.entries(fixture.files)) await writeFile(join(workspace, name), content, { flag: "wx" });
      const before = await snapshot(workspace);
      const workSubmit = await fetch(`${central.url}/api/commands`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ hostId: "host", target: "session", text: "Read hosts.txt in your working directory. Report the number of hosts with status DOWN and their names in file order, formatted exactly as \"<count>: <name>, <name>\".", idempotencyKey: "real-agent-smoke-work" }) });
      if (workSubmit.status !== 201) throw new Error(`submit failed: ${workSubmit.status}`);
      const workId = ((await workSubmit.json()) as { command: { id: string } }).command.id;
      const workPrompt = [
        "You are a Fleet Control supervisor in a local test. Use the fleet MCP tools and the Read tool only.",
        "1. Call cooperative_claim with requestId \"claim-w\".",
        "2. If it returns a command, report requestId \"w-accepted\", status \"accepted\", detail \"accepted\".",
        "3. Report requestId \"w-running\", status \"running\", detail \"running\".",
        "4. Do the task in the command text using the Read tool on files in your working directory only, then report requestId \"w-completed\", status \"completed\", detail set to exactly the formatted answer.",
        "If you cannot do the task, report requestId \"w-failed\", status \"failed\" with the reason instead.",
        "Never claim again and never retry with a different requestId. Finish with one line: DONE <commandId>.",
      ].join("\n");
      const worker = await runAgent(agentKind, model, directory, "work", adapter.url!, local, workPrompt, ["Read"], workspace);
      outputs.push(worker.stdout, worker.stderr);
      const work = await inspect(workId, central.incarnationId!);
      const filesUnchanged = JSON.stringify(await snapshot(workspace)) === JSON.stringify(before);
      const answer = work.events.find((event) => event.status === "completed")?.detail ?? null;
      realWorkResult = {
        agent: { exit: worker.exit, result: worker.result }, work, expected: fixture.expected, answer, filesUnchanged,
        ok: work.claim?.requestId === "claim-w" && work.events.map((event) => event.status).join(",") === "accepted,running,completed"
          && answer?.trim() === fixture.expected && filesUnchanged,
      };
    }
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
      const stale = await runAgent(agentKind, model, directory, "stale", adapter.url!, local, stalePrompt);
      outputs.push(stale.stdout, stale.stderr);
      const replacementFile = join(directory, "replacement-incarnation.json");
      await writeFile(replacementFile, JSON.stringify(fresh), { mode: 0o600, flag: "wx" });
      const replacementConfig = join(directory, "replacement-adapter.json");
      await writeFile(replacementConfig, JSON.stringify({ centralUrl: `${central.url}/mcp`, localToken: local, supervisorToken: supervisor, incarnationFile: replacementFile }), { mode: 0o600, flag: "wx" });
      const freshAdapter = await start("src/host-agent/cooperative-main.ts", { COOPERATIVE_ADAPTER_CONFIG_FILE: replacementConfig }, children);
      const freshPrompt = prompt.replace("\"claim-1\"", "\"claim-2\"").replaceAll("\"r-", "\"n-");
      const next = await runAgent(agentKind, model, directory, "fresh", freshAdapter.url!, local, freshPrompt);
      outputs.push(next.stdout, next.stderr);
      const afterFirst = await inspect(commandId, central.incarnationId!);
      const afterNext = await inspect(nextId, fresh.incarnationId);
      // Operator settlement: allowed only for the claim whose incarnation is inactive.
      const settle = (id: string, requestId: string, expectedSequence: string | null) => fetch(`${central.url}/api/commands/${id}/cooperative/settlement`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ requestId, disposition: "completed", evidence: "real-agent smoke: agent reported completed before replacement", expectedSequence }) });
      const activeSettle = await settle(nextId, "settle-active", afterNext.lastSeq);
      const staleSettle = await settle(commandId, "settle-stale-seq", null);
      const settled = await settle(commandId, "settle-1", afterFirst.lastSeq);
      const settledAgain = await settle(commandId, "settle-1", afterFirst.lastSeq);
      const afterSettle = await inspect(commandId, central.incarnationId!);
      const settlement = {
        activeStatus: activeSettle.status, staleSequenceStatus: staleSettle.status, createdStatus: settled.status, replayStatus: settledAgain.status,
        settled: afterSettle.claim?.settled === true, commandStatus: afterSettle.commandStatus,
        eventsUnchanged: JSON.stringify(afterSettle.events) === JSON.stringify(first.events),
      };
      replacementResult = {
        staleAgent: { exit: stale.exit, result: stale.result },
        freshAgent: { exit: next.exit, result: next.result },
        firstAfter: afterFirst, next: afterNext,
        fenced: afterFirst.claim?.incarnationActive === false && JSON.stringify(afterFirst.events) === JSON.stringify(first.events),
        settlement,
        settledOnlyInactive: settlement.activeStatus === 409 && settlement.staleSequenceStatus === 409 && settlement.createdStatus === 201 && settlement.replayStatus === 200 && settlement.settled && settlement.eventsUnchanged,
        freshCompleted: !!afterNext.claim?.incarnationMatches && afterNext.claim.requestId === "claim-2" && afterNext.events.map((event) => event.status).join(",") === "accepted,running,completed",
      };
    }
    const leaked = secrets.some((secret) => outputs.some((text) => text.includes(secret)));
    return { agentExit, agent: agentResult, agentStderr: redact(agentErr.slice(-1500)), leaked, ...first, failure: failureResult, realWork: realWorkResult, replacement: replacementResult };
  } finally {
    for (const child of children) child.process.kill("SIGTERM");
    await Promise.allSettled(children.map((child) => child.process.exited));
    await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
    await admin.close();
    await fixture.cleanup();
    await rm(directory, { recursive: true, force: true });
    for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.env.REAL_AGENT_SMOKE !== "1" || !process.env.CENTRAL_TEST_DATABASE_URL) {
    console.error("set REAL_AGENT_SMOKE=1 and CENTRAL_TEST_DATABASE_URL");
    process.exit(2);
  }
  const replacement = process.argv.includes("--replacement");
  const failure = process.argv.includes("--failure");
  const realWork = process.argv.includes("--real-work");
  const dsh = process.argv.includes("--agent=dsh");
  if (dsh && !process.env.CLIPROXYAPI_API_KEY) {
    console.error("--agent=dsh needs CLIPROXYAPI_API_KEY for the DSH cliproxyapi provider");
    process.exit(2);
  }
  const result = await runRealAgentSmoke(process.env.CENTRAL_TEST_DATABASE_URL, dsh ? "dsh" : "claude", dsh ? "claude-haiku-5-5" : "haiku", replacement, failure, realWork);
  console.log(JSON.stringify(result, null, 2));
  const statuses = result.events.map((event) => event.status).join(",");
  const replaced = !replacement || (result.replacement?.fenced === true && result.replacement?.freshCompleted === true && result.replacement?.settledOnlyInactive === true);
  const failed = !failure || result.failure?.ok === true;
  const worked = !realWork || result.realWork?.ok === true;
  process.exit(failed && worked && result.claim && statuses === "accepted,running,completed" && !result.leaked && replaced ? 0 : 1);
}

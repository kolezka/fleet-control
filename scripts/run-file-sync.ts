// Mirrors the phase table of a phased-delivery run.md into the host service's run record.
// run.md stays the single writer: this reads it and calls run_register / phase_update as the orchestrator.
// Without --apply it only prints what it would change. It never answers or withdraws requests.
//
//   bun scripts/run-file-sync.ts <run.md> --run-id <id> --orchestrator <name> [--apply]
//   FLEET_CONTROL_URL (default http://127.0.0.1:4871), FLEET_CONTROL_TOKEN_FILE (optional, 0600, one token)
import { readFileSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { currentPhase, parseRunFile } from "../src/domain/run-file.ts";
import type { Run } from "../src/domain/requests.ts";

export type Plan = { action: "none" } | { action: "register"; phase: string; phaseStatus: string } | { action: "update"; expectedRevision: number; phase: string; phaseStatus: string };

// A changed phase starts a new revision on the service, which makes its open requests stale.
// A new tip inside the same phase does not: only the orchestrator knows whether the work changed.
export function plan(runFile: string, run: Run | undefined): Plan {
  const want = currentPhase(parseRunFile(runFile));
  if (!run) return { action: "register", ...want };
  if (run.phase === want.phase && run.phaseStatus === want.phaseStatus) return { action: "none" };
  return { action: "update", expectedRevision: run.revision, ...want };
}

type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>;

// The token file must be a small regular file owned by this user and readable by nobody else.
export function readTokenFile(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 1024) {
    throw new Error("token file must be a private file (0600, owned by you)");
  }
  const token = readFileSync(path, "utf8").trim();
  if (!/^\S+$/.test(token)) throw new Error("token file must hold one token");
  return token;
}

export async function sync(runFile: string, runId: string, orchestrator: string, apply: boolean, call: Call): Promise<string> {
  const listed = await call("request_list", { runId, limit: 1 }) as { runs: Run[] };
  const step = plan(runFile, listed.runs.find((run) => run.id === runId));
  if (step.action === "none") return "run record already matches run.md";
  const what = step.action === "register" ? `register ${runId} at "${step.phase}" then set "${step.phaseStatus}"` : `update ${runId} r${step.expectedRevision} to "${step.phase}" / "${step.phaseStatus}"`;
  if (!apply) return `would ${what} (pass --apply to write)`;
  let expectedRevision = step.action === "update" ? step.expectedRevision : (await call("run_register", { runId, orchestrator, phase: step.phase }) as { run: Run }).run.revision;
  const updated = await call("phase_update", { runId, actor: orchestrator, expectedRevision, phase: step.phase, phaseStatus: step.phaseStatus, newRevision: false }) as { run: Run; staled: string[] };
  return `did ${what}; now r${updated.run.revision}${updated.staled.length ? `, ${updated.staled.length} open request(s) became stale` : ""}`;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const file = args[0];
  const runId = flag("--run-id"), orchestrator = flag("--orchestrator");
  if (!file || file.startsWith("--") || !runId || !orchestrator) {
    console.error("usage: bun scripts/run-file-sync.ts <run.md> --run-id <id> --orchestrator <name> [--apply]");
    process.exit(2);
  }
  const tokenFile = process.env.FLEET_CONTROL_TOKEN_FILE;
  const client = new Client({ name: "run-file-sync", version: "0" });
  try {
    const token = tokenFile ? readTokenFile(tokenFile) : undefined;
    const url = new URL("/mcp", process.env.FLEET_CONTROL_URL ?? "http://127.0.0.1:4871");
    await client.connect(new StreamableHTTPClientTransport(url, token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined));
    const call: Call = async (name, a) => {
      const result = await client.callTool({ name, arguments: a }) as { isError?: boolean; content: { text: string }[] };
      if (result.isError) throw new Error(`${name}: ${result.content[0]?.text ?? "failed"}`);
      return JSON.parse(result.content[0]!.text);
    };
    console.log(await sync(await Bun.file(file).text(), runId, orchestrator, args.includes("--apply"), call));
  } catch (error) {
    console.error(`run file sync failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

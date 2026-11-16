// Mirrors the phase table of a phased-delivery run.md into the host service's run record.
// run.md stays the single writer: this reads it and calls run_register / phase_update as the orchestrator.
// Without --apply it only prints what it would change. It never answers or withdraws requests.
//
//   bun scripts/run-file-sync.ts <run.md> --run-id <id> --orchestrator <name> [--apply]
//   FLEET_CONTROL_URL (default http://127.0.0.1:4871), FLEET_CONTROL_TOKEN_FILE (optional, 0600, one token).
//   With a token the service acts as the token's principal, whatever --orchestrator says.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { currentPhase, normalizeStatus, parseRunFile } from "../src/domain/run-file.ts";
import type { Run } from "../src/domain/requests.ts";

type Want = { phase: string; phaseStatus: string };
export type Plan = { action: "none" } | ({ action: "register" } & Want) | ({ action: "update"; expectedRevision: number; newRevision: boolean } & Want);

// What the record says about the phase this script wrote last time.
const recorded = (run: Run) => {
  const number = run.phase.match(/^phase ([1-9][0-9]*): /)?.[1];
  const written = run.phaseStatus.split(/ at |; /)[0] ?? "";
  const tip = run.phaseStatus.match(/ at ([0-9a-f]{7,40});/)?.[1] ?? "";
  return { number: number ? Number(number) : undefined, status: normalizeStatus(written), tip };
};

// A changed phase always starts a new revision on the service, which stales its open requests.
// Inside one phase, a new commit or a new fix round is new work too, so it asks for a new revision;
// a note such as "done" to "done, pushed" does not.
export function plan(runFile: string, run: Run | undefined): Plan {
  const want = currentPhase(parseRunFile(runFile));
  const target = { phase: want.phase, phaseStatus: want.phaseStatus };
  if (!run) return { action: "register", ...target };
  if (run.phase === want.phase && run.phaseStatus === want.phaseStatus) return { action: "none" };
  const was = recorded(run);
  if (was.number === undefined) throw new Error(`run ${run.id} has phase "${run.phase}", which this script did not write; refusing to overwrite it`);
  if (was.number > want.number) throw new Error(`run ${run.id} is at phase ${was.number}, run.md says ${want.number}; refusing to move it back`);
  const samePhase = was.number === want.number;
  const newWork = samePhase && ((want.tip !== "" && want.tip !== was.tip) || (want.status.startsWith("fix-round-") && want.status !== was.status));
  return { action: "update", expectedRevision: run.revision, newRevision: newWork, ...target };
}

type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>;

// The token file must be a small regular file owned by this user and readable by nobody else.
// It is checked and read through one descriptor, and a symlink is refused.
export function readTokenFile(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 1024) throw new Error();
    const token = readFileSync(fd, "utf8").trim();
    if (!/^\S+$/.test(token)) throw new Error("token file must hold one token");
    return token;
  } catch (error) {
    if (error instanceof Error && error.message === "token file must hold one token") throw error;
    throw new Error("token file must be a private file (0600, owned by you, not a symlink)");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// A bearer token travels in clear over http, so it is sent over http only to this machine.
export function serviceUrl(raw: string | undefined, withToken: boolean): URL {
  const base = new URL(raw ?? "http://127.0.0.1:4871");
  if (base.username || base.password) throw new Error("FLEET_CONTROL_URL must not carry credentials");
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("FLEET_CONTROL_URL must be http or https");
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(base.hostname);
  if (withToken && base.protocol !== "https:" && !loopback) throw new Error("a token is sent only over https, or over http to this machine");
  // Keep a path prefix (a proxy such as https://proxy/hostA/) instead of resolving to its root.
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL("mcp", base);
}

export async function sync(runFile: string, runId: string, orchestrator: string, apply: boolean, call: Call): Promise<string> {
  const listed = await call("request_list", { runId, limit: 1 }) as { runs: Run[] };
  const step = plan(runFile, listed.runs.find((run) => run.id === runId));
  if (step.action === "none") return "run record already matches run.md";
  const what = step.action === "register"
    ? `register ${runId} at "${step.phase}" then set "${step.phaseStatus}"`
    : `update ${runId} r${step.expectedRevision} to "${step.phase}" / "${step.phaseStatus}"${step.newRevision ? " as new work" : ""}`;
  if (!apply) return `would ${what} (pass --apply to write)`;
  let expectedRevision: number;
  if (step.action === "register") {
    // run_register returns an existing run unchanged; only a fresh one may be written here.
    const { run } = await call("run_register", { runId, orchestrator, phase: step.phase }) as { run: Run };
    if (run.revision !== 1 || run.phase !== step.phase) throw new Error(`run ${runId} already existed at r${run.revision}; nothing written, run again`);
    expectedRevision = 1;
  } else expectedRevision = step.expectedRevision;
  let updated: { run: Run; staled: string[] };
  try {
    updated = await call("phase_update", { runId, actor: orchestrator, expectedRevision, phase: step.phase, phaseStatus: step.phaseStatus, newRevision: step.action === "update" && step.newRevision }) as { run: Run; staled: string[] };
  } catch (error) {
    if (step.action === "register") throw new Error(`registered ${runId}, but setting its status failed (run again): ${error instanceof Error ? error.message : "unknown error"}`);
    throw error;
  }
  return `did ${what}; now r${updated.run.revision}${updated.staled.length ? `, ${updated.staled.length} open request(s) became stale` : ""}`;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); const value = i >= 0 ? args[i + 1] : undefined; return value && !value.startsWith("--") ? value : undefined; };
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
    const url = serviceUrl(process.env.FLEET_CONTROL_URL, token !== undefined);
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

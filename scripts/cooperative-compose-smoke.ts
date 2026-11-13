// Synthetic end-to-end check of a running cooperative compose installation, from the host.
// Usage: bun scripts/cooperative-compose-smoke.ts <state dir> [--restart]
// Starts the host adapter from <state dir>/adapter.json, submits one synthetic command as the
// operator, claims and reports it through the adapter, and inspects it. With --restart it also
// restarts the central container and checks the same incarnation still claims. Prints no secrets.
// It claims as the real supervisor, so it refuses to run while that supervisor has queued work.
// Do not run it while a supervisor adapter for this installation is live: both would race claims.
import { join } from "node:path";
import { STATE_LAYOUT } from "../src/central/cooperative-service.ts";
import { startCooperativeAdapter } from "../src/host-agent/cooperative-main.ts";

const [dir, ...flags] = process.argv.slice(2);
if (!dir) { console.error("usage: bun scripts/cooperative-compose-smoke.ts <state dir> [--restart]"); process.exit(2); }
const adapterConfig = await Bun.file(join(dir, STATE_LAYOUT.adapter)).json() as { centralUrl: string };
const central = new URL(adapterConfig.centralUrl).origin;
const operator = (await Bun.file(join(dir, STATE_LAYOUT.operatorToken)).text()).trim();
const local = (await Bun.file(join(dir, STATE_LAYOUT.localToken)).text()).trim();
// Commands are claimable only by the supervisor whose host and session they target.
const credentials = await Bun.file(join(dir, STATE_LAYOUT.credentials)).json() as { principal: { role: string; hostId?: string; session?: string } }[];
const supervisor = credentials.find((c) => c.principal.role === "supervisor")!.principal;
// Claims take the oldest queued command of the slot, so real queued work would be claimed here.
const queuedForSupervisor = async () => {
  let cursor: string | undefined;
  for (let page = 0; page < 10_000; page++) {
    const response = await fetch(`${central}/mcp`, { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "command_list", arguments: { status: "queued", ...(cursor ? { cursor } : {}) } } }) });
    const body = await response.json() as { result?: { isError?: boolean; content: { text: string }[] } };
    if (!body.result || body.result.isError) throw new Error("queue check failed");
    const listed = JSON.parse(body.result.content[0]!.text) as { commands: { hostId: string; target: string }[]; nextCursor?: string };
    if (listed.commands.some((c) => c.hostId === supervisor.hostId && c.target === supervisor.session)) return true;
    if (!listed.nextCursor) return false;
    cursor = listed.nextCursor;
  }
  throw new Error("queue check did not finish");
};
if (await queuedForSupervisor()) { console.error("refusing: the supervisor has queued commands that this smoke would claim"); process.exit(1); }
const adapter = await startCooperativeAdapter({ COOPERATIVE_ADAPTER_CONFIG_FILE: join(dir, STATE_LAYOUT.adapter) });
const run = crypto.randomUUID();
const steps: string[] = [];
const check = (ok: boolean, label: string) => { steps.push(`${ok ? "ok" : "FAIL"} ${label}`); if (!ok) process.exitCode = 1; };
const call = async (name: string, args: object) => {
  const response = await fetch(`${adapter.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${local}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(10000) });
  const body = await response.json() as { result?: { isError?: boolean; content: { text: string }[] } };
  return body.result?.isError ? undefined : JSON.parse(body.result!.content[0]!.text);
};
const submit = async (key: string) => {
  const response = await fetch(`${central}/api/commands`, { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" }, body: JSON.stringify({ hostId: supervisor.hostId, target: supervisor.session, text: `synthetic smoke ${key}`, idempotencyKey: `smoke-${run}-${key}` }) });
  check(response.status === 201, `submit ${key}`);
  return ((await response.json()) as { command: { id: string } }).command.id;
};
const inspect = async (id: string) => {
  const response = await fetch(`${central}/api/commands/${id}/cooperative`, { headers: { authorization: `Bearer ${operator}` } });
  return await response.json() as { claim: { incarnationActive: boolean } | null; events: { status: string }[] };
};
const cycle = async (key: string) => {
  const id = await submit(key);
  const claimed = await call("cooperative_claim", { requestId: `claim-${run}-${key}` });
  check(claimed?.command?.id === id, `claim ${key}`);
  for (const status of ["accepted", "running", "completed"]) {
    const report = await call("cooperative_report", { commandId: id, requestId: `${status}-${run}-${key}`, status, detail: `synthetic ${status}` });
    check(report?.event?.status === status, `report ${status} ${key}`);
  }
  const seen = await inspect(id);
  check(seen.claim?.incarnationActive === true && seen.events.map((e) => e.status).join(",") === "accepted,running,completed", `inspect ${key}`);
};
try {
  await cycle("first");
  if (flags.includes("--restart")) {
    const restart = Bun.spawnSync(["docker", "compose", "restart"], { cwd: join(import.meta.dir, "../deploy/cooperative"), stdout: "ignore", stderr: "ignore" });
    check(restart.exitCode === 0, "restart containers");
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = await fetch(`${central}/api/commands/none/cooperative`, { headers: { authorization: `Bearer ${operator}` } }).then((r) => r.status === 404, () => false);
      if (!ready) await Bun.sleep(500);
    }
    check(ready, "central back after restart");
    await cycle("after-restart");
  }
} finally {
  await adapter.stop();
}
console.log(steps.join("\n"));

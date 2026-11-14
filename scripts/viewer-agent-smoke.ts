// Local smoke: a real Claude Code agent in a private tmux fleet receives a Fleet Control
// command through fleet send while a read-only viewer (what the page opens) is attached.
// Opt-in only: starts a real agent and spends model tokens. Owner-approved on 2026-11-12.
// The agent uses the owner's Claude Code settings (bypass permissions: agent-fleet waits for that
// status line before pasting, so the default mode with a custom status line is not detected), with no MCP servers and with
// writing, shell and network tools disallowed. Everything lives in a private tmux socket
// and temp directories that are removed at the end.
// Usage: VIEWER_AGENT_SMOKE=1 VIEWER_AGENT_CWD=<trusted folder> bun scripts/viewer-agent-smoke.ts
import { Database } from "bun:sqlite";
import { randomInt } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Commands } from "../src/data/commands.ts";
import { Deliverer, fleetSender } from "../src/delivery.ts";
import { resolveFleetBin } from "../src/fleet/path.ts";
import { openViewer } from "../src/terminal/viewer.ts";

const root = resolve(import.meta.dir, "..");

const until = async (cond: () => Promise<boolean>, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(500)) if (await cond()) return true;
  return false;
};

export async function runViewerAgentSmoke(model = "haiku") {
  const fleetBin = resolveFleetBin();
  const name = `fcviewer${process.pid}${randomInt(1e6)}`;
  const socket = `fleet-${name}`;
  const session = "agent";
  const base = await mkdtemp(join(tmpdir(), "fleet-viewer-smoke-"));
  const fleetDir = join(base, "fleet");
  await mkdir(fleetDir);
  // Claude Code shows a trust dialog in folders the owner has not trusted, and the watchdog
  // never answers it. The agent has no file tools, so it runs in an already trusted folder.
  const workspace = process.env.VIEWER_AGENT_CWD;
  if (!workspace) throw new Error("set VIEWER_AGENT_CWD to a folder already trusted in Claude Code");
  const tmux = async (...args: string[]) => {
    const p = Bun.spawn(["tmux", "-L", socket, "-f", "/dev/null", ...args], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(p.stdout).text();
    return { exitCode: await p.exited, stdout };
  };
  const pane = async () => (await tmux("capture-pane", "-p", "-J", "-S", "-200", "-t", session)).stdout;
  const disallowed = "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Read,Glob,Grep";
  await Bun.write(join(fleetDir, "fleet.conf"), [
    `FLEET=${name}`, "REMOTE_SSH=", "REMOTE_USER=", `FLEET_DIR=${fleetDir}`, `AGENT_CWD=${workspace}`,
    `AGENTS=("${session}|Viewer smoke agent|prompt.txt")`,
    `CLAUDE_ARGS="--model ${model} --strict-mcp-config --mcp-config '{\\"mcpServers\\":{}}' --disallowedTools ${disallowed}"`, "",
  ].join("\n"));
  await Bun.write(join(fleetDir, "prompt.txt"),
    "You are a test agent in a local Fleet Control smoke test. Do not use any tools. Reply to this message with the single word READY. " +
    "Later you will receive a Fleet Control command. It mentions a command_respond tool that you do not have; ignore that and simply answer the arithmetic in the command text on one line.\n");
  await Bun.write(join(fleetDir, "watchdog.sh"), Bun.file(join(fleetBin, "..", "watchdog.sh")));
  const env = { ...process.env, FLEET_CONF: join(fleetDir, "fleet.conf") };
  let viewer: Awaited<ReturnType<typeof openViewer>> | null = null;
  try {
    const start = Bun.spawn([fleetBin, "start", session], { env, stdout: "pipe", stderr: "pipe" });
    const [startOut, startErr, startExit] = await Promise.all([new Response(start.stdout).text(), new Response(start.stderr).text(), start.exited]);
    if (startExit !== 0) throw new Error(`fleet start failed (${startExit}): ${startOut} ${startErr}`);
    const ready = await until(async () => /^\s*[●⏺]\s*READY\s*$/m.test(await pane()), 120_000);

    viewer = await openViewer({ fleetBin, confPath: env.FLEET_CONF, session, cols: 200, rows: 51, onData() {}, onExit() {} });
    const readOnly = await until(async () => /read-only/.test((await tmux("list-clients", "-F", "#{client_flags}")).stdout), 10_000);
    const sendKeysRefused = (await tmux("send-keys", "-t", `=${session}:`, "")).exitCode !== 0;

    const a = 1000 + randomInt(9000), b = 1000 + randomInt(9000);
    const commands = new Commands(new Database(":memory:"));
    const id = commands.submit({ idempotencyKey: "viewer-agent-smoke", target: session, actor: "smoke", text: `Answer with FCV followed directly by the sum of ${a} and ${b}, for example FCV123.` }).command.id;
    const delivered = await new Deliverer(commands, fleetSender(fleetBin, env.FLEET_CONF)).deliver(id);
    const expected = `FCV${a + b}`;
    const answered = await until(async () => (await pane()).includes(expected), 120_000);
    const screen = await pane();
    return {
      ready, readOnly, sendKeysRefused, status: delivered.status, detail: commands.events(id).at(-1)?.detail ?? null,
      expected, answered, tail: screen.trim().split("\n").slice(-12).join("\n"),
      ok: ready && readOnly && sendKeysRefused && delivered.status === "delivered" && answered,
    };
  } finally {
    viewer?.close();
    await viewer?.exited;
    await tmux("kill-server");
    await rm(join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.()}`, socket), { force: true });
    await rm(base, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.env.VIEWER_AGENT_SMOKE !== "1") {
    console.error("set VIEWER_AGENT_SMOKE=1");
    process.exit(2);
  }
  const result = await runViewerAgentSmoke();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

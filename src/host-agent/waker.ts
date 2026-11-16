// Starts the host's supervisor agent when central has work for it, so an idle agent need not poll.
// It only asks whether work is waiting (cooperative_wait) and never claims or reads command text:
// the agent it starts claims and reports for itself. One agent runs at a time and is never killed
// or restarted for an outcome; an agent that exits with work still queued is started again.
import { isAbsolute } from "node:path";
import { readPrivateJson } from "./cooperative-main.ts";

export type WakerConfig = { adapterUrl: string; localToken: string; command: string[]; waitSeconds: number };
export type WakerDeps = {
  wait: (waitSeconds: number) => Promise<boolean>;
  run: (command: string[]) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
};

const loopbacks = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function parseWakerConfig(value: unknown): WakerConfig {
  const fail = () => { throw new Error("invalid waker configuration"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const { adapterUrl, localToken, command, waitSeconds = 20, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) return fail();
  let url: URL;
  try { url = new URL(String(adapterUrl)); } catch { return fail(); }
  if (url.protocol !== "http:" || !loopbacks.has(url.hostname) || url.pathname !== "/mcp" || url.search || url.hash || url.username || url.password) return fail();
  if (typeof localToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(localToken)) return fail();
  if (!Array.isArray(command) || !command.length || command.length > 64 || !command.every((part) => typeof part === "string" && part.length > 0 && part.length <= 4096 && !/[\x00]/.test(part))) return fail();
  if (!isAbsolute(command[0] as string)) return fail();
  if (!Number.isInteger(waitSeconds) || (waitSeconds as number) < 1 || (waitSeconds as number) > 20) return fail();
  return { adapterUrl: url.toString(), localToken, command: command as string[], waitSeconds: waitSeconds as number };
}

// Asks the adapter, which adds this host's supervisor and incarnation credentials.
export function adapterWait(config: WakerConfig, fetcher: typeof fetch = fetch): (waitSeconds: number) => Promise<boolean> {
  let id = 0;
  return async (waitSeconds) => {
    const response = await fetcher(config.adapterUrl, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout((waitSeconds + 10) * 1000),
      headers: { authorization: `Bearer ${config.localToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "cooperative_wait", arguments: { waitSeconds } } }),
    });
    if (!response.ok) throw new Error(`adapter answered ${response.status}`);
    const body = await response.json() as { result?: { isError?: boolean; content?: { type: string; text: string }[] } };
    const text = body.result?.content?.[0]?.text;
    if (body.result?.isError || typeof text !== "string") throw new Error("wait failed");
    const parsed = JSON.parse(text) as { pending?: unknown };
    if (typeof parsed.pending !== "boolean") throw new Error("wait failed");
    return parsed.pending;
  };
}

// Runs until stopped. Errors back off up to a minute and are logged without detail from central.
export async function runWaker(config: WakerConfig, deps: WakerDeps, stopped: () => boolean): Promise<void> {
  let failures = 0;
  while (!stopped()) {
    let pending: boolean;
    try {
      pending = await deps.wait(config.waitSeconds);
      failures = 0;
    } catch {
      failures++;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
      deps.log(`wait failed; next try in ${delay / 1000}s`);
      await deps.sleep(delay);
      continue;
    }
    if (!pending || stopped()) continue;
    deps.log("work waiting; starting agent");
    const started = performance.now();
    let code: number;
    try { code = await deps.run(config.command); } catch { code = -1; }
    deps.log(`agent exited with ${code}`);
    // An agent that dies at once must not be restarted in a tight loop.
    if (code !== 0 || performance.now() - started < 5000) await deps.sleep(code === 0 ? 5000 : 30_000);
  }
}

async function runCommand(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}

if (import.meta.main) {
  const path = process.env.COOPERATIVE_WAKER_CONFIG_FILE;
  let config: WakerConfig;
  try {
    if (!path) throw new Error();
    config = parseWakerConfig(await readPrivateJson(path));
  } catch {
    console.error("cooperative waker: invalid configuration");
    process.exit(1);
  }
  let stop = false;
  process.once("SIGINT", () => { stop = true; });
  process.once("SIGTERM", () => { stop = true; });
  await runWaker(config, { wait: adapterWait(config), run: runCommand, sleep: (ms) => Bun.sleep(ms), log: (line) => console.log(`cooperative waker: ${line}`) }, () => stop);
}

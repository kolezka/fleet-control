import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCooperativeAdapter } from "./cooperative-main.ts";

// Request deadline above the listener's 5 s default, so old wiring force-closed first.
test("stopping during a forwarded request still returns outcome unknown", async () => {
  let forwarded = 0;
  const central = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { forwarded++; return new Promise<Response>(() => {}); } });
  const dir = await mkdtemp(join(tmpdir(), "fleet-adapter-shutdown-"));
  const incarnationFile = join(dir, "incarnation.json");
  const configFile = join(dir, "config.json");
  const localToken = "a".repeat(43);
  let running: Awaited<ReturnType<typeof startCooperativeAdapter>> | undefined;
  try {
    await writeFile(incarnationFile, JSON.stringify({ incarnationId: crypto.randomUUID(), token: "c".repeat(43) }), { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({ centralUrl: `http://127.0.0.1:${central.port}/mcp`, localToken, supervisorToken: "b".repeat(43), incarnationFile }), { mode: 0o600 });
    running = await startCooperativeAdapter({ COOPERATIVE_ADAPTER_CONFIG_FILE: configFile }, 6_000);
    const pending = fetch(running.url + "/mcp", {
      method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }), (e: unknown) => ({ status: 0, body: String(e) }));
    for (let i = 0; forwarded === 0 && i < 200; i++) await Bun.sleep(10);
    expect(forwarded).toBe(1);
    const stopped = running.stop();
    const result = await pending;
    await stopped;
    expect(forwarded).toBe(1);
    expect(result.status).toBe(504);
    expect(result.body).toEqual({ error: "outcome unknown; no automatic retry; retry only the exact request ID and payload with the same incarnation" });
  } finally {
    await running?.stop();
    central.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCooperativeAdapter } from "./cooperative-main.ts";

// Startup failures name which setting is wrong, and never echo a token, a path or file content.
const local = "L".repeat(43), supervisor = "S".repeat(43), incarnationToken = "I".repeat(43);

test("adapter startup names the failing setting without secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-adapter-reason-"));
  const configFile = join(dir, "config.json"), incarnationFile = join(dir, "incarnation.json");
  const config = { centralUrl: "http://127.0.0.1:4873/mcp", localToken: local, supervisorToken: supervisor, incarnationFile };
  const save = (value: unknown, mode = 0o600) => writeFile(configFile, typeof value === "string" ? value : JSON.stringify(value), { mode });
  const reason = async (env: Record<string, string | undefined>) => {
    const error = await startCooperativeAdapter(env).then(async (running) => { await running.stop(); return undefined; }, (e: Error) => e);
    if (!error) throw new Error("expected a startup failure");
    for (const secret of [local, supervisor, incarnationToken, dir]) expect(error.message).not.toContain(secret);
    expect(error.message.startsWith("cooperative adapter startup failed: ")).toBe(true);
    return error.message.slice("cooperative adapter startup failed: ".length);
  };
  const env = { COOPERATIVE_ADAPTER_CONFIG_FILE: configFile };
  try {
    await writeFile(incarnationFile, JSON.stringify({ incarnationId: crypto.randomUUID(), token: incarnationToken }), { mode: 0o600 });
    expect(await reason({})).toContain("COOPERATIVE_ADAPTER_CONFIG_FILE");
    expect(await reason({ COOPERATIVE_ADAPTER_CONFIG_FILE: "relative.json" })).toContain("COOPERATIVE_ADAPTER_CONFIG_FILE");
    await save(config, 0o644);
    await chmod(configFile, 0o644);
    expect(await reason(env)).toContain("adapter config file");
    await chmod(configFile, 0o600);
    await save(`{"localToken": "${local}"`);
    expect(await reason(env)).toContain("not JSON");
    await save({ ...config, extra: local });
    expect(await reason(env)).toContain("exactly centralUrl");
    await save({ ...config, centralUrl: "http://example.com/mcp" });
    expect(await reason(env)).toContain("centralUrl must be https");
    await save(config);
    expect(await reason({ ...env, COOPERATIVE_ADAPTER_PORT: "4882x" })).toContain("COOPERATIVE_ADAPTER_PORT");
    await save({ ...config, centralCaFile: join(dir, "missing.pem") });
    expect(await reason(env)).toContain("centralCaFile");
    await save(config);
    await chmod(incarnationFile, 0o644);
    expect(await reason(env)).toContain("incarnation file");
    await chmod(incarnationFile, 0o600);
    const busy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    try { expect(await reason({ ...env, COOPERATIVE_ADAPTER_PORT: String(busy.port) })).toContain("could not listen"); }
    finally { await busy.stop(true); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

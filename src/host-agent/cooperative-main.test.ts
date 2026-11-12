import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCooperativeAdapter } from "./cooperative-main.ts";

test("adapter process configuration requires private files and a loopback central", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-adapter-config-"));
  const configFile = join(dir, "config.json");
  const incarnationFile = join(dir, "incarnation.json");
  const config = { centralUrl: "http://127.0.0.1:4873/mcp", localToken: "a".repeat(43), supervisorToken: "b".repeat(43), incarnationFile };
  const incarnation = { incarnationId: crypto.randomUUID(), token: "c".repeat(43) };
  const env = { COOPERATIVE_ADAPTER_CONFIG_FILE: configFile };
  const saveConfig = (value: unknown) => writeFile(configFile, JSON.stringify(value), { mode: 0o600 });
  try {
    await writeFile(incarnationFile, JSON.stringify(incarnation), { mode: 0o600 });
    await saveConfig(config);
    const running = await startCooperativeAdapter(env);
    try {
      expect(new URL(running.url).hostname).toBe("127.0.0.1");
      expect((await fetch(running.url + "/mcp", { method: "POST" })).status).toBe(401);
    } finally { await running.stop(); }
    for (const invalid of [
      { ...config, centralUrl: "http://example.com/mcp" },
      { ...config, centralUrl: "http://localhost:4873/mcp" },
      { ...config, centralUrl: "http://127.0.0.1:4873/other" },
      { ...config, extra: true },
      { ...config, incarnationFile: "relative.json" },
      // A CA file needs an https central and an absolute path holding a PEM certificate.
      { ...config, centralCaFile: incarnationFile },
      { ...config, centralUrl: "https://127.0.0.1:4873/mcp", centralCaFile: "relative.pem" },
      { ...config, centralUrl: "https://127.0.0.1:4873/mcp", centralCaFile: incarnationFile },
      { ...config, centralUrl: "https://127.0.0.1:4873/mcp", centralCaFile: join(dir, "missing.pem") },
    ]) {
      await saveConfig(invalid);
      await expect(startCooperativeAdapter(env)).rejects.toThrow("cooperative adapter startup failed");
    }
    await saveConfig(config);
    await chmod(configFile, 0o644);
    await expect(startCooperativeAdapter(env)).rejects.toThrow("cooperative adapter startup failed");
    await chmod(configFile, 0o600);
    const link = join(dir, "link.json");
    await symlink(configFile, link);
    await expect(startCooperativeAdapter({ COOPERATIVE_ADAPTER_CONFIG_FILE: link })).rejects.toThrow("cooperative adapter startup failed");
    await chmod(incarnationFile, 0o644);
    await expect(startCooperativeAdapter(env)).rejects.toThrow("cooperative adapter startup failed");
    await chmod(incarnationFile, 0o600);
    await writeFile(incarnationFile, JSON.stringify({ ...incarnation, extra: true }));
    await expect(startCooperativeAdapter(env)).rejects.toThrow("cooperative adapter startup failed");
    await expect(startCooperativeAdapter({ COOPERATIVE_ADAPTER_CONFIG_FILE: "relative.json" })).rejects.toThrow("cooperative adapter startup failed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

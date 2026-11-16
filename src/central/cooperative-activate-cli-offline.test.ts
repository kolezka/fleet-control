import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVICE_RUNTIME_ROLE } from "./data/cooperative-provision.ts";

// The activate command must say why it refused when nothing reached the database,
// without printing file content. The runtime URL points at port 1, so a connection attempt would fail differently.
const service = join(import.meta.dir, "cooperative-service.ts");
const supervisor = (hostId: string) => ({ tokenHash: new Bun.CryptoHasher("sha256").update(hostId).digest("hex"), principal: { role: "supervisor", name: hostId, principalId: hostId, hostId, session: "supervisor" } });
const credentials = (hosts: string[]) => JSON.stringify([{ tokenHash: "a".repeat(64), principal: { role: "operator", name: "operator" } }, ...hosts.map(supervisor)]);

async function activate(files: { credentials: string; incarnation?: string }, extra: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fc-activate-"));
  try {
    const runtime = join(dir, "runtime"), creds = join(dir, "credentials"), incarnation = join(dir, "incarnation");
    await writeFile(runtime, `postgres://${SERVICE_RUNTIME_ROLE}:secret-runtime-password@127.0.0.1:1/fleet`, { mode: 0o600 });
    await writeFile(creds, files.credentials, { mode: 0o600 });
    if (files.incarnation !== undefined) await writeFile(incarnation, files.incarnation, { mode: 0o600 });
    const child = Bun.spawn([process.execPath, service, "activate"], {
      env: { PATH: process.env.PATH ?? "", COOPERATIVE_RUNTIME_URL_FILE: runtime, COOPERATIVE_CREDENTIALS_FILE: creds, COOPERATIVE_INCARNATION_FILE: incarnation, ...extra },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, stderr: stderr.trim(), incarnationLeft: await Bun.file(incarnation).exists() };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("activate names the missing supervisor session instead of a bare failure", async () => {
  const result = await activate({ credentials: credentials(["mini", "desk"]) }, { COOPERATIVE_SUPERVISOR_HOST: "mini" });
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("cooperative activation refused: supervisor selection requires an explicit matching COOPERATIVE_SUPERVISOR_HOST and COOPERATIVE_SUPERVISOR_SESSION");
  expect(result.incarnationLeft).toBe(false);
});

test("activate keeps an existing incarnation file and says so", async () => {
  const result = await activate({ credentials: credentials(["mini"]), incarnation: "keep" });
  expect(result.stderr).toBe("cooperative activation refused: incarnation file already exists; activate runs once per file (see the recovery notes in deploy/cooperative/README.md)");
});

test("activate never prints credentials content or the runtime password", async () => {
  const result = await activate({ credentials: '[{"tokenHash": "leaked-token-value"' });
  expect(result.stderr).toBe("cooperative activation refused: credentials file is not valid JSON");
  const bad = await activate({ credentials: JSON.stringify([{ tokenHash: "leaked-token-value", principal: { role: "operator", name: "operator" } }]) });
  expect(bad.stderr.startsWith("cooperative activation refused: ")).toBe(true);
  for (const r of [result, bad]) { expect(r.stderr).not.toContain("leaked-token-value"); expect(r.stderr).not.toContain("secret-runtime-password"); }
});

test("activate names a missing file without printing its path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fc-activate-missing-"));
  try {
    const missing = join(dir, "nowhere", "runtime-url");
    const child = Bun.spawn([process.execPath, service, "activate"], {
      env: { PATH: process.env.PATH ?? "", COOPERATIVE_RUNTIME_URL_FILE: missing, COOPERATIVE_CREDENTIALS_FILE: join(dir, "c"), COOPERATIVE_INCARNATION_FILE: join(dir, "i") },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr.trim()).toBe("cooperative activation refused: a configured file or directory does not exist (ENOENT)");
    expect(stderr).not.toContain(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("activate still reports a database failure without detail", async () => {
  const result = await activate({ credentials: credentials(["mini"]) });
  expect(result.stderr).toBe("cooperative activation failed");
  expect(result.incarnationLeft).toBe(false);
});

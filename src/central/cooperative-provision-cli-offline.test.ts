import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// provision must say why it refused before reaching the database, and never print the admin URL.
// The admin URL points at port 1, so reaching the database would fail differently.
const service = join(import.meta.dir, "cooperative-service.ts");
const password = "secret-admin-password";

async function provision(opts: { adminUrl?: string; runtimeExists?: boolean; mode?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fc-provision-"));
  try {
    const admin = join(dir, "admin-url"), runtime = join(dir, "runtime-url");
    await writeFile(admin, opts.adminUrl ?? `postgres://postgres:${password}@127.0.0.1:1/fleet`, { mode: opts.mode ?? 0o600 });
    if (opts.runtimeExists) await writeFile(runtime, "keep", { mode: 0o600 });
    const child = Bun.spawn([process.execPath, service, "provision"], {
      env: { PATH: process.env.PATH ?? "", COOPERATIVE_ADMIN_URL_FILE: admin, COOPERATIVE_RUNTIME_URL_FILE: runtime },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    for (const secret of [password, dir]) expect(stderr).not.toContain(secret);
    return { code, stderr: stderr.trim(), runtime: await Bun.file(runtime).exists() ? await Bun.file(runtime).text() : undefined };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("provision names problems found before the database", async () => {
  const exists = await provision({ runtimeExists: true });
  expect(exists).toEqual({ code: 1, stderr: "cooperative provisioning refused: runtime URL file already exists; provision runs once (see the recovery notes in deploy/cooperative/README.md)", runtime: "keep" });
  expect((await provision({ mode: 0o644 })).stderr).toBe("cooperative provisioning refused: credentials file must be private");
  expect((await provision({ adminUrl: `mysql://root:${password}@127.0.0.1/fleet` })).stderr).toBe("cooperative provisioning refused: invalid database URL file");
});

test("provision keeps database failures terse and leaves no runtime URL file", async () => {
  expect(await provision()).toEqual({ code: 1, stderr: "cooperative provisioning failed", runtime: undefined });
});

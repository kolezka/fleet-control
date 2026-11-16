import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVICE_RUNTIME_ROLE } from "./data/cooperative-provision.ts";

// serve must say why it refused before opening a listener or the database, without printing file content.
// The runtime URL points at port 1, so reaching the database would fail differently.
const service = join(import.meta.dir, "cooperative-service.ts");
const token = "leaked-token-value", password = "secret-runtime-password";
const valid = JSON.stringify([
  { tokenHash: "a".repeat(64), principal: { role: "operator", name: "operator" } },
  { tokenHash: "b".repeat(64), principal: { role: "supervisor", name: "s", principalId: "s", hostId: "mini", session: "supervisor" } },
]);

async function serve(credentials: string, extra: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fc-serve-"));
  try {
    const runtime = join(dir, "runtime"), creds = join(dir, "credentials");
    await writeFile(runtime, `postgres://${SERVICE_RUNTIME_ROLE}:${password}@127.0.0.1:1/fleet`, { mode: 0o600 });
    await writeFile(creds, credentials, { mode: 0o600 });
    const child = Bun.spawn([process.execPath, service, "serve"], {
      env: { PATH: process.env.PATH ?? "", COOPERATIVE_PORT: "1", COOPERATIVE_RUNTIME_URL_FILE: runtime, COOPERATIVE_CREDENTIALS_FILE: creds, ...extra },
      stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    clearTimeout(timer);
    for (const secret of [token, password, dir]) expect(stderr).not.toContain(secret);
    return { code, stderr: stderr.trim() };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("serve names configuration problems found before the database", async () => {
  expect(await serve(valid, { COOPERATIVE_PORT: "" })).toEqual({ code: 1, stderr: "cooperative service startup refused: explicit port required" });
  expect((await serve(valid, { COOPERATIVE_HOST: "192.168.50.4" })).stderr).toBe("cooperative service startup refused: listener must bind to 127.0.0.1 or, inside a container, 0.0.0.0");
  expect((await serve(valid, { COOPERATIVE_TLS_CERT_FILE: "/x.pem" })).stderr).toBe("cooperative service startup refused: cooperative TLS needs both certificate and key files");
  expect((await serve(`[{"tokenHash": "${token}"`)).stderr).toBe("cooperative service startup refused: credentials file is not valid JSON");
  expect((await serve(JSON.stringify([{ tokenHash: token, principal: { role: "operator", name: "operator" } }]))).stderr.startsWith("cooperative service startup refused: ")).toBe(true);
});

test("serve keeps database failures terse", async () => {
  expect(await serve(valid)).toEqual({ code: 1, stderr: "cooperative service startup failed" });
});

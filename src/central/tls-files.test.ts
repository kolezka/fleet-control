import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTlsFiles } from "./tls-files.ts";

test("the TLS key file must be a private regular file owned by this user", async () => {
  const prefix = join(tmpdir(), "fleet-tls-files-");
  const dir = await mkdtemp(prefix);
  try {
    const cert = join(dir, "cert.pem"), key = join(dir, "key.pem");
    const generated = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", key, "-out", cert], { stdout: "ignore", stderr: "ignore" });
    expect(await generated.exited).toBe(0);
    await chmod(key, 0o600);
    const loaded = await loadTlsFiles({ certFile: cert, keyFile: key }, "test");
    expect(loaded.key).toContain("PRIVATE KEY");

    await chmod(key, 0o640);
    expect(await loadTlsFiles({ certFile: cert, keyFile: key }, "test").catch((error: Error) => error.message)).toBe("test TLS key file must be private and at most 64 KiB");
    await chmod(key, 0o600);

    const link = join(dir, "link.pem");
    await symlink(key, link);
    expect(await loadTlsFiles({ certFile: cert, keyFile: link }, "test").catch((error: Error) => error.message)).toBe("unreadable test TLS files");
    expect(await loadTlsFiles({ certFile: cert, keyFile: dir }, "test").catch((error: Error) => error.message)).toBe("test TLS key file must be private and at most 64 KiB");
    expect(await loadTlsFiles({ certFile: cert, keyFile: join(dir, "missing.pem") }, "test").catch((error: Error) => error.message)).toBe("unreadable test TLS files");
    const big = join(dir, "big.pem");
    await writeFile(big, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    expect(await loadTlsFiles({ certFile: cert, keyFile: big }, "test").catch((error: Error) => error.message)).toBe("test TLS key file must be private and at most 64 KiB");
    // The certificate is public and has no mode rule.
    await chmod(cert, 0o644);
    expect((await loadTlsFiles({ certFile: cert, keyFile: key }, "test")).cert).toContain("CERTIFICATE");
  } finally {
    if (dir.startsWith(prefix)) await rm(dir, { recursive: true, force: true });
  }
});

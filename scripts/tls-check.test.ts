import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPair } from "./tls-check.ts";

function pair(dir: string, name: string, days: number) {
  const r = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", join(dir, name + ".key"), "-out", join(dir, name + ".pem"), "-days", String(days), "-subj", "/CN=" + name], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error("openssl failed");
  return { cert: join(dir, name + ".pem"), key: join(dir, name + ".key") };
}

test("tls-check accepts a valid pair, warns near expiry and refuses a mismatch or missing file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-tls-check-"));
  try {
    const a = pair(dir, "a", 400), b = pair(dir, "b", 10);
    expect(await checkPair(a.cert, a.key)).toEqual({ ok: true, lines: ["certificate and key pass the service start check"] });
    const soon = await checkPair(b.cert, b.key);
    expect(soon.ok).toBe(true);
    expect(soon.lines[0]).toStartWith("warning: TLS certificate expires in 9 days");
    expect(await checkPair(a.cert, b.key)).toEqual({ ok: false, lines: ["refused: FLEET_CONTROL_TLS_KEY does not match FLEET_CONTROL_TLS_CERT"] });
    const later = new Date(Date.now() + 500 * 86400000);
    expect((await checkPair(a.cert, a.key, later)).lines[0]).toStartWith("refused: TLS certificate expired at");
    const missing = await checkPair(join(dir, "none.pem"), a.key);
    expect(missing).toEqual({ ok: false, lines: ["refused: file could not be read"] });
    expect(missing.lines.join(" ")).not.toContain(dir);
  } finally { rmSync(dir, { recursive: true }); }
});

test("tls-check command exits 0 for a good pair and 1 for a bad one", () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-tls-cli-"));
  try {
    const a = pair(dir, "a", 400), b = pair(dir, "b", 400);
    expect(Bun.spawnSync(["bun", "scripts/tls-check.ts", a.cert, a.key]).exitCode).toBe(0);
    const bad = Bun.spawnSync(["bun", "scripts/tls-check.ts", a.cert, b.key], { stderr: "pipe" });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("does not match");
  } finally { rmSync(dir, { recursive: true }); }
});

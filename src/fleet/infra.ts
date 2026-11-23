// Host side of the infrastructure part: reads the service's TLS certificates, asks `tailscale cert` for a new
// tailnet certificate, reads `tailscale serve status`, and checks or restarts the other services named for the page.
import { X509Certificate, createPrivateKey } from "node:crypto";
import { chmod, copyFile, readFile, realpath, rename as fsRename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AdminError } from "../domain/fleet-admin.ts";
import { daysLeft, serviceTarget, type CertId, type CertState, type OtherService, type OtherServiceState } from "../domain/infra.ts";
import type { InfraHost } from "../application/infra.ts";

type Run = { exitCode: number; stdout: string; stderr: string };
export type Runner = (argv: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<Run>;
export const run: Runner = async (argv, opts = {}) => {
  const p = Bun.spawn(argv, { cwd: opts.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs ?? 20_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

const firstLine = (s: string) => (s.trim().split("\n")[0] ?? "").slice(0, 200);

export async function findTailscale(candidates = ["/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/usr/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]): Promise<string | null> {
  for (const c of candidates) if (await Bun.file(c).exists()) return c;
  return null;
}

export type CertFiles = { id: CertId; cert: string; key: string; name?: string };
export type InfraOptions = {
  certs: CertFiles[];
  tailscale: string | null;
  uid: number;
  launchctl?: string;
  systemctl?: string;
  docker?: string;
  runner?: Runner;
  now?: () => Date;
  // Test seam: the rename used to put the new files in place. index.ts never sets it.
  rename?: (from: string, to: string) => Promise<void>;
};
// Status reads give up sooner than actions, so one slow tool shows as unknown instead of stalling the page.
const STATUS_MS = 5_000;

function names(x: X509Certificate): string[] {
  const alt = (x.subjectAltName ?? "").split(",").map((s) => s.trim()).filter((s) => s.startsWith("DNS:") || s.startsWith("IP Address:")).map((s) => s.replace(/^(DNS|IP Address):/, ""));
  return alt.length ? alt : [x.subject.replace(/^.*CN=/, "")];
}

export class HostInfra implements InfraHost {
  readonly #o: InfraOptions;
  readonly #run: Runner;
  constructor(o: InfraOptions) {
    this.#o = o;
    this.#run = o.runner ?? run;
  }
  #now() { return this.#o.now?.() ?? new Date(); }

  async #state(f: CertFiles): Promise<CertState> {
    const renewable = f.id === "tailnet" && !!f.name && this.#o.tailscale !== null;
    try {
      const x = new X509Certificate(await readFile(f.cert));
      const notAfter = new Date(x.validTo);
      return { id: f.id, path: f.cert, names: names(x), notAfter: notAfter.toISOString(), daysLeft: daysLeft(notAfter, this.#now()), renewable };
    } catch (e) {
      return { id: f.id, path: f.cert, names: [], notAfter: "", daysLeft: 0, renewable, error: e instanceof Error ? firstLine(e.message) : String(e) };
    }
  }

  certs() { return Promise.all(this.#o.certs.map((f) => this.#state(f))); }

  // The new files are fetched beside the old ones (symlinks resolved, so the real files change), checked (names
  // the host, key matches), given the old modes, and renamed over them, key first. Copies of the old pair are kept
  // until both renames worked; if either fails, both old files are put back.
  async renew(): Promise<CertState> {
    const f = this.#o.certs.find((c) => c.id === "tailnet");
    if (!f || !f.name) throw new AdminError("failed", "this host has no tailnet certificate to renew");
    if (!this.#o.tailscale) throw new AdminError("failed", "tailscale is not installed where the service can find it");
    const rename = this.#o.rename ?? fsRename;
    const [certPath, keyPath] = await Promise.all([realpath(f.cert), realpath(f.key)]).catch((e) => {
      throw new AdminError("failed", `the certificate or key file cannot be read (${e instanceof Error ? firstLine(e.message) : e}); nothing was asked of tailscale`);
    });
    const id = randomUUID().slice(0, 8);
    const tmp = (p: string, kind: string) => join(dirname(p), `.${kind}-${id}.pem`);
    const tmpCert = tmp(certPath, "cert"), tmpKey = tmp(keyPath, "key"), oldCert = tmp(certPath, "old-cert"), oldKey = tmp(keyPath, "old-key");
    // The copies of the old pair stay only when a put-back lost a file; the error names them.
    let keepCopies = false;
    try {
      const r = await this.#run([this.#o.tailscale, "cert", "--cert-file", tmpCert, "--key-file", tmpKey, f.name], { timeoutMs: 120_000 });
      if (r.exitCode !== 0) {
        const why = firstLine(r.stderr || r.stdout) || `exit ${r.exitCode}`;
        const hint = /access denied/i.test(why) ? "; this user may not ask tailscale for certificates (run `sudo tailscale set --operator=$USER` once, or renew with sudo)" : "";
        throw new AdminError("failed", `tailscale cert failed: ${why}${hint}`);
      }
      const x = new X509Certificate(await readFile(tmpCert));
      if (!x.checkHost(f.name)) throw new AdminError("failed", `the new certificate does not name ${f.name}; the old one stays`);
      if (!x.checkPrivateKey(createPrivateKey(await readFile(tmpKey)))) throw new AdminError("failed", "the new key does not match the new certificate; the old one stays");
      const [certMode, keyMode] = await Promise.all([stat(certPath).then((st) => st.mode & 0o777), stat(keyPath).then((st) => st.mode & 0o777)]);
      await chmod(tmpCert, certMode);
      await chmod(tmpKey, keyMode);
      await copyFile(certPath, oldCert);
      await copyFile(keyPath, oldKey);
      await chmod(oldKey, keyMode);
      try {
        await rename(tmpKey, keyPath);
        await rename(tmpCert, certPath);
      } catch (e) {
        const back = await Promise.allSettled([fsRename(oldKey, keyPath), fsRename(oldCert, certPath)]);
        const lost = back.some((b) => b.status === "rejected");
        keepCopies = lost;
        throw new AdminError("failed", `the new files could not be put in place (${e instanceof Error ? firstLine(e.message) : e}); ${lost ? `the old ones could not all be put back either: copies are in ${oldCert} and ${oldKey}` : "the old ones are back"}`);
      }
    } finally {
      await Promise.all([tmpCert, tmpKey, ...(keepCopies ? [] : [oldCert, oldKey])].map((p) => rm(p, { force: true }).catch(() => undefined)));
    }
    return this.#state(f);
  }

  async serveStatus(): Promise<{ text: string } | { error: string }> {
    if (!this.#o.tailscale) return { error: "tailscale is not installed where the service can find it" };
    const r = await this.#run([this.#o.tailscale, "serve", "status"], { timeoutMs: STATUS_MS });
    return r.exitCode === 0 ? { text: r.stdout.trim().slice(0, 4000) } : { error: firstLine(r.stderr || r.stdout) || `tailscale exited ${r.exitCode}` };
  }

  async serviceState(s: OtherService): Promise<OtherServiceState> {
    const base = { name: s.name, kind: s.kind, target: serviceTarget(s) };
    if (s.kind === "launchd") {
      const r = await this.#run([this.#o.launchctl ?? "launchctl", "print", `gui/${this.#o.uid}/${s.label}`], { timeoutMs: STATUS_MS });
      if (r.exitCode !== 0) {
        // Real launchctl prints "Bad request." first and "Could not find service ..." on the next line (exit 113).
        if (/could not find service/i.test(`${r.stderr}\n${r.stdout}`)) return { ...base, running: false, detail: "not loaded" };
        throw new Error(firstLine(r.stderr || r.stdout) || `launchctl exited ${r.exitCode}`);
      }
      const pid = /^\tpid = (\d+)$/m.exec(r.stdout)?.[1];
      return { ...base, running: !!pid, detail: pid ? `pid ${pid}` : (/^\tstate = (.+)$/m.exec(r.stdout)?.[1] ?? "not running") };
    }
    if (s.kind === "systemd") {
      const r = await this.#run([this.#o.systemctl ?? "systemctl", "--user", "show", "-p", "ActiveState", "-p", "MainPID", s.unit], { timeoutMs: STATUS_MS });
      if (r.exitCode !== 0) throw new Error(firstLine(r.stderr) || `systemctl exited ${r.exitCode}`);
      const active = /^ActiveState=(.*)$/m.exec(r.stdout)?.[1] ?? "unknown", pid = /^MainPID=(\d+)$/m.exec(r.stdout)?.[1] ?? "0";
      return { ...base, running: active === "active", detail: active === "active" ? `active, pid ${pid}` : active };
    }
    const r = await this.#run([this.#o.docker ?? "docker", "compose", "ps", "--status", "running", "--format", "{{.Name}} {{.Status}}", s.service], { cwd: s.dir, timeoutMs: STATUS_MS });
    if (r.exitCode !== 0) throw new Error(firstLine(r.stderr) || `docker compose exited ${r.exitCode}`);
    const line = firstLine(r.stdout);
    return { ...base, running: line !== "", detail: line || "not running" };
  }

  async restart(s: OtherService): Promise<void> {
    const r = s.kind === "launchd"
      ? await this.#run([this.#o.launchctl ?? "launchctl", "kickstart", "-k", `gui/${this.#o.uid}/${s.label}`], { timeoutMs: 60_000 })
      : s.kind === "systemd"
        ? await this.#run([this.#o.systemctl ?? "systemctl", "--user", "restart", s.unit], { timeoutMs: 120_000 })
        : await this.#run([this.#o.docker ?? "docker", "compose", "restart", s.service], { cwd: s.dir, timeoutMs: 150_000 });
    if (r.exitCode !== 0) throw new AdminError("failed", `${s.name} did not restart: ${firstLine(r.stderr || r.stdout) || `exit ${r.exitCode}`}`);
  }
}

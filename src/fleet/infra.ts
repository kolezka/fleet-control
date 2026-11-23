// Host side of the infrastructure part: reads the service's TLS certificates, asks `tailscale cert` for a new
// tailnet certificate, reads `tailscale serve status`, and checks or restarts the other services named for the page.
import { X509Certificate, createPrivateKey } from "node:crypto";
import { chmod, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AdminError } from "../domain/fleet-admin.ts";
import { daysLeft, RENEW_BEFORE_DAYS, serviceTarget, type CertId, type CertState, type OtherService, type OtherServiceState } from "../domain/infra.ts";
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
};

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

  // The new files are fetched beside the old ones, checked (names the host, key matches), then renamed over them
  // with the old modes. A failure leaves the old files as they were.
  async renew(): Promise<CertState> {
    const f = this.#o.certs.find((c) => c.id === "tailnet");
    if (!f || !f.name) throw new AdminError("failed", "this host has no tailnet certificate to renew");
    if (!this.#o.tailscale) throw new AdminError("failed", "tailscale is not installed where the service can find it");
    const id = randomUUID().slice(0, 8);
    const tmpCert = join(dirname(f.cert), `.cert-${id}.pem`), tmpKey = join(dirname(f.key), `.key-${id}.pem`);
    try {
      const r = await this.#run([this.#o.tailscale, "cert", "--cert-file", tmpCert, "--key-file", tmpKey, f.name], { timeoutMs: 120_000 });
      if (r.exitCode !== 0) {
        const why = firstLine(r.stderr || r.stdout);
        const hint = /access denied/i.test(why) ? "; this user may not ask tailscale for certificates (run `sudo tailscale set --operator=$USER` once, or renew with sudo)" : "";
        throw new AdminError("failed", `tailscale cert failed: ${why}${hint}`);
      }
      const x = new X509Certificate(await readFile(tmpCert));
      if (!x.checkHost(f.name)) throw new AdminError("failed", `the new certificate does not name ${f.name}; the old one stays`);
      if (!x.checkPrivateKey(createPrivateKey(await readFile(tmpKey)))) throw new AdminError("failed", "the new key does not match the new certificate; the old one stays");
      const [certMode, keyMode] = await Promise.all([stat(f.cert).then((s) => s.mode & 0o777, () => 0o644), stat(f.key).then((s) => s.mode & 0o777, () => 0o600)]);
      await chmod(tmpCert, certMode);
      await chmod(tmpKey, keyMode);
      await rename(tmpKey, f.key);
      await rename(tmpCert, f.cert);
    } finally {
      await rm(tmpCert, { force: true });
      await rm(tmpKey, { force: true });
    }
    return this.#state(f);
  }

  async serveStatus(): Promise<{ text: string } | { error: string }> {
    if (!this.#o.tailscale) return { error: "tailscale is not installed where the service can find it" };
    const r = await this.#run([this.#o.tailscale, "serve", "status"]);
    return r.exitCode === 0 ? { text: r.stdout.trim().slice(0, 4000) } : { error: firstLine(r.stderr || r.stdout) || `tailscale exited ${r.exitCode}` };
  }

  async serviceState(s: OtherService): Promise<OtherServiceState> {
    const base = { name: s.name, kind: s.kind, target: serviceTarget(s) };
    if (s.kind === "launchd") {
      const r = await this.#run([this.#o.launchctl ?? "launchctl", "print", `gui/${this.#o.uid}/${s.label}`]);
      if (r.exitCode !== 0) return { ...base, running: false, detail: "not loaded" };
      const pid = /^\tpid = (\d+)$/m.exec(r.stdout)?.[1];
      return { ...base, running: !!pid, detail: pid ? `pid ${pid}` : (/^\tstate = (.+)$/m.exec(r.stdout)?.[1] ?? "not running") };
    }
    if (s.kind === "systemd") {
      const r = await this.#run([this.#o.systemctl ?? "systemctl", "--user", "show", "-p", "ActiveState", "-p", "MainPID", s.unit]);
      if (r.exitCode !== 0) throw new Error(firstLine(r.stderr) || `systemctl exited ${r.exitCode}`);
      const active = /^ActiveState=(.*)$/m.exec(r.stdout)?.[1] ?? "unknown", pid = /^MainPID=(\d+)$/m.exec(r.stdout)?.[1] ?? "0";
      return { ...base, running: active === "active", detail: active === "active" ? `active, pid ${pid}` : active };
    }
    const r = await this.#run([this.#o.docker ?? "docker", "compose", "ps", "--status", "running", "--format", "{{.Name}} {{.Status}}", s.service], { cwd: s.dir });
    if (r.exitCode !== 0) throw new Error(firstLine(r.stderr) || `docker compose exited ${r.exitCode}`);
    const line = firstLine(r.stdout);
    return { ...base, running: line !== "", detail: line || "not running" };
  }

  async restart(s: OtherService): Promise<void> {
    const r = s.kind === "launchd"
      ? await this.#run([this.#o.launchctl ?? "launchctl", "kickstart", "-k", `gui/${this.#o.uid}/${s.label}`], { timeoutMs: 60_000 })
      : s.kind === "systemd"
        ? await this.#run([this.#o.systemctl ?? "systemctl", "--user", "restart", s.unit], { timeoutMs: 120_000 })
        : await this.#run([this.#o.docker ?? "docker", "compose", "restart", s.service], { cwd: s.dir, timeoutMs: 180_000 });
    if (r.exitCode !== 0) throw new AdminError("failed", `${s.name} did not restart: ${firstLine(r.stderr || r.stdout) || `exit ${r.exitCode}`}`);
  }
}

// Renews the tailnet certificate when it has fewer than RENEW_BEFORE_DAYS left. The listener keeps the old
// certificate until the service restarts; the log says so.
export async function renewIfDue(host: InfraHost, log: (line: string) => void = console.log): Promise<boolean> {
  const c = (await host.certs()).find((x) => x.id === "tailnet");
  if (!c || !c.renewable || c.error || c.daysLeft >= RENEW_BEFORE_DAYS) return false;
  try {
    const after = await host.renew();
    log(`tailnet certificate renewed: valid to ${after.notAfter}; the listener takes it at the next service start`);
    return true;
  } catch (e) {
    log(`tailnet certificate renewal failed (${c.daysLeft} days left): ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

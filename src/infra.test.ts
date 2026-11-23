// The infrastructure part through a real host service and the real gateway, with stand-in tailscale, launchctl,
// systemctl and docker scripts so no real certificate, DSH or central is touched.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, newToken, tokenLine } from "./auth.ts";
import { Store } from "./data/store.ts";
import { serve } from "./server.ts";
import { Credentials, startGateway } from "./client-gateway.ts";
import { HostInfra, type CertFiles } from "./fleet/infra.ts";
import { infraUseCases } from "./application/infra.ts";
import { checkServiceRestart, daysLeft, parseOtherServices, type OtherService } from "./domain/infra.ts";

const OPENSSL = existsSync("/usr/bin/openssl") ? "/usr/bin/openssl" : "openssl";
async function makeCert(dir: string, name: string, days: number, cert: string, key: string) {
  const p = Bun.spawn([OPENSSL, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-keyout", key, "-out", cert, "-days", String(days), "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`], { cwd: dir, stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
}

let dir: string, op: string, viewer: string, server: ReturnType<typeof serve>, gateway: ReturnType<typeof startGateway>;
const certs: CertFiles[] = [];
const calls = () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "").trim().split("\n").filter(Boolean);

// One script stands in for tailscale, launchctl, systemctl and docker, keyed by its own name; it records argv.
const STANDIN = (bun: string, openssl: string) => `#!${bun}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
const home = dirname(dirname(process.argv[1]));
const me = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(join(home, "calls"), [me, ...args].join(" ") + "\\n");
const knob = (n) => (existsSync(join(home, n)) ? readFileSync(join(home, n), "utf8").trim() : "");
if (me === "tailscale" && args[0] === "cert") {
  if (knob("deny")) { console.error("Access denied: cert access denied"); process.exit(1); }
  const cert = args[args.indexOf("--cert-file") + 1], key = args[args.indexOf("--key-file") + 1];
  const name = knob("wrongname") || args.at(-1);
  const p = Bun.spawnSync(["${openssl}", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-keyout", key, "-out", cert, "-days", "90", "-subj", "/CN=" + name, "-addext", "subjectAltName=DNS:" + name]);
  if (knob("badkey")) Bun.spawnSync(["${openssl}", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-keyout", key, "-out", "/dev/null", "-days", "1", "-subj", "/CN=x"]);
  process.exit(p.exitCode);
}
if (me === "tailscale" && args[0] === "serve") { console.log("https://h.example (tailnet only)\\n|-- / proxy http://127.0.0.1:3080"); process.exit(0); }
if (me === "launchctl" && args[0] === "print" && knob("printfail")) { console.error(knob("printfail")); process.exit(knob("printfail").includes("Could not find") ? 113 : 125); }
if (me === "launchctl" && args[0] === "print") { if (knob("dshdown")) { console.log("\\tstate = not running"); } else console.log("\\tstate = running\\n\\tpid = 4242"); process.exit(0); }
if (me === "launchctl" && args[0] === "kickstart") { if (knob("failrestart")) { console.error("Could not kickstart service: 37"); process.exit(1); } process.exit(0); }
if (me === "systemctl") { if (args[1] === "show") console.log("ActiveState=active\\nMainPID=77"); process.exit(0); }
if (me === "docker") { if (args[1] === "ps") console.log("cooperative-central-1 Up 3 hours"); process.exit(0); }
process.exit(2);
`;

let host: HostInfra, services: OtherService[];
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fleet-control-infra-"));
  await Bun.$`mkdir -p ${join(dir, "bin")} ${join(dir, "tls")}`;
  const script = STANDIN(process.execPath, OPENSSL);
  for (const n of ["tailscale", "launchctl", "systemctl", "docker"]) { await writeFile(join(dir, "bin", n), script); await chmod(join(dir, "bin", n), 0o755); }
  await makeCert(dir, "192.168.1.2", 800, join(dir, "tls", "lan.pem"), join(dir, "tls", "lan-key.pem"));
  await makeCert(dir, "h.example", 10, join(dir, "tls", "cert.pem"), join(dir, "tls", "key.pem"));
  // Modes the default umask would not give a new file, so a renewal that drops them shows.
  await chmod(join(dir, "tls", "cert.pem"), 0o640);
  await chmod(join(dir, "tls", "key.pem"), 0o600);
  certs.push({ id: "lan", cert: join(dir, "tls", "lan.pem"), key: join(dir, "tls", "lan-key.pem") }, { id: "tailnet", cert: join(dir, "tls", "cert.pem"), key: join(dir, "tls", "key.pem"), name: "h.example" });
  services = parseOtherServices(`dsh=launchd:pl.raqz.dsh,adapter=systemd:fleet-adapter.service,central=compose:${join(dir, "central_dir")}:central`);
  await Bun.$`mkdir -p ${join(dir, "central_dir")}`;
  host = new HostInfra({ certs, tailscale: join(dir, "bin", "tailscale"), uid: 501, launchctl: join(dir, "bin", "launchctl"), systemctl: join(dir, "bin", "systemctl"), docker: join(dir, "bin", "docker") });
  op = newToken(); viewer = newToken();
  await writeFile(join(dir, "tokens"), `${tokenLine("op", op, "operator")}\n${tokenLine("watcher", viewer, "viewer")}\n`);
  server = serve({ fleet: { status: async () => ({ sessions: [], raw: "" }), screen: async () => "" } as never, store: new Store(":memory:"), infra: { host, services } }, 0, { auth: await Auth.fromFile(join(dir, "tokens")) });
  gateway = startGateway({ hosts: [{ id: "h", name: "H", origin: server.url.origin }], credentials: new Credentials(new Map([["h", op]])) }, { port: 0 });
});
afterAll(async () => { gateway?.stop(true); server?.stop(true); await rm(dir, { recursive: true, force: true }); });

const page = (path: string, init: RequestInit = {}) => fetch(`${gateway.url.origin}/api/hosts/h${path}`, { ...init, headers: { origin: gateway.url.origin, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
const post = (path: string, body: unknown) => page(path, { method: "POST", body: JSON.stringify(body) });
const knob = (n: string, v: string | null) => (v === null ? rm(join(dir, n), { force: true }) : writeFile(join(dir, n), v));

test("an operator sees both certificates, Serve and the named services through the gateway", async () => {
  const r = await page("/infra");
  expect(r.status).toBe(200);
  const v = await r.json();
  expect(v.certs.map((c: { id: string; names: string[]; renewable: boolean }) => [c.id, c.names, c.renewable])).toEqual([["lan", ["192.168.1.2"], false], ["tailnet", ["h.example"], true]]);
  expect(v.certs[1].daysLeft).toBeGreaterThanOrEqual(8);
  expect(v.certs[1].daysLeft).toBeLessThanOrEqual(10);
  expect(v.serve.text).toContain("proxy http://127.0.0.1:3080");
  expect(v.services).toEqual([
    { name: "dsh", kind: "launchd", target: "pl.raqz.dsh", running: true, detail: "pid 4242" },
    { name: "adapter", kind: "systemd", target: "fleet-adapter.service", running: true, detail: "active, pid 77" },
    { name: "central", kind: "compose", target: `${join(dir, "central_dir")} (central)`, running: true, detail: "cooperative-central-1 Up 3 hours" },
  ]);
  expect(calls()).toContain(`docker compose ps --status running --format {{.Name}} {{.Status}} central`);
});

test("restarts only run for a named service with its typed name, and use the right tool for each kind", async () => {
  await knob("calls", null);
  for (const [body, status, msg] of [
    [{ confirm: "dsx" }, 400, "type dsh to confirm the restart"],
    [{}, 400, "type dsh to confirm the restart"],
    [{ confirm: "dsh", extra: 1 }, 400, "unknown field extra"],
  ] as const) {
    const r = await post("/infra/services/dsh/restart", body);
    expect([r.status, (await r.json()).error.message]).toEqual([status, msg]);
  }
  const unknown = await post("/infra/services/nginx/restart", { confirm: "nginx" });
  expect([unknown.status, (await unknown.json()).error.message]).toEqual([404, "no service nginx is set up for the page on this host"]);
  expect(calls().filter((c) => /kickstart|restart/.test(c))).toEqual([]);
  for (const name of ["dsh", "adapter", "central"]) {
    const r = await post(`/infra/services/${name}/restart`, { confirm: name });
    expect(r.status).toBe(200);
    expect((await r.json()).name).toBe(name);
  }
  expect(calls().filter((c) => /kickstart|restart/.test(c))).toEqual([
    "launchctl kickstart -k gui/501/pl.raqz.dsh",
    "systemctl --user restart fleet-adapter.service",
    "docker compose restart central",
  ]);
  await knob("failrestart", "1");
  const bad = await post("/infra/services/dsh/restart", { confirm: "dsh" });
  expect([bad.status, (await bad.json()).error.message]).toEqual([422, "dsh did not restart: Could not kickstart service: 37"]);
  await knob("failrestart", null);
});

test("a renewal replaces the tailnet files only after the new certificate names the host, keeping their modes", async () => {
  const before = await readFile(join(dir, "tls", "cert.pem"), "utf8");
  const no = await post("/infra/renew", { confirm: "Renew" });
  expect([no.status, (await no.json()).error.message]).toEqual([400, "type renew to confirm the renewal"]);
  await knob("deny", "1");
  const denied = await post("/infra/renew", { confirm: "renew" });
  expect(denied.status).toBe(422);
  expect((await denied.json()).error.message).toContain("tailscale cert failed: Access denied: cert access denied; this user may not ask tailscale for certificates");
  await knob("deny", null);
  await knob("wrongname", "other.example");
  const wrong = await post("/infra/renew", { confirm: "renew" });
  expect([wrong.status, (await wrong.json()).error.message]).toEqual([422, "the new certificate does not name h.example; the old one stays"]);
  await knob("wrongname", null);
  expect(await readFile(join(dir, "tls", "cert.pem"), "utf8")).toBe(before);
  expect(readdirSync(join(dir, "tls")).sort()).toEqual(["cert.pem", "key.pem", "lan-key.pem", "lan.pem"]);
  const ok = await post("/infra/renew", { confirm: "renew" });
  expect(ok.status).toBe(200);
  const body = await ok.json();
  expect([body.renewed, body.cert.daysLeft >= 88]).toEqual([true, true]);
  expect(await readFile(join(dir, "tls", "cert.pem"), "utf8")).not.toBe(before);
  expect([(await stat(join(dir, "tls", "cert.pem"))).mode & 0o777, (await stat(join(dir, "tls", "key.pem"))).mode & 0o777]).toEqual([0o640, 0o600]);
  expect(readdirSync(join(dir, "tls")).sort()).toEqual(["cert.pem", "key.pem", "lan-key.pem", "lan.pem"]);
  const v = await (await page("/infra")).json();
  expect(typeof v.renewedAt).toBe("string");
  // The key now on disk belongs to the certificate now on disk.
  const pair = async () => new X509Certificate(await readFile(join(dir, "tls", "cert.pem"))).checkPrivateKey(createPrivateKey(await readFile(join(dir, "tls", "key.pem"))));
  expect(await pair()).toBe(true);
  // A key that does not match is refused and changes nothing.
  const [c0, k0] = [await readFile(join(dir, "tls", "cert.pem"), "utf8"), await readFile(join(dir, "tls", "key.pem"), "utf8")];
  await knob("badkey", "1");
  const bad = await post("/infra/renew", { confirm: "renew" });
  expect([bad.status, (await bad.json()).error.message]).toEqual([422, "the new key does not match the new certificate; the old one stays"]);
  await knob("badkey", null);
  expect([await readFile(join(dir, "tls", "cert.pem"), "utf8"), await readFile(join(dir, "tls", "key.pem"), "utf8")]).toEqual([c0, k0]);
  expect(readdirSync(join(dir, "tls")).filter((n) => n.startsWith("."))).toEqual([]);
});

test("a renewal whose second rename fails puts the old pair back, and a symlinked certificate is renewed at its target", async () => {
  const tls = join(dir, "tls2");
  await Bun.$`mkdir -p ${join(tls, "real")}`;
  await makeCert(dir, "h.example", 10, join(tls, "real", "cert.pem"), join(tls, "real", "key.pem"));
  await symlink(join(tls, "real", "cert.pem"), join(tls, "cert.pem"));
  await symlink(join(tls, "real", "key.pem"), join(tls, "key.pem"));
  const files: CertFiles[] = [{ id: "tailnet", cert: join(tls, "cert.pem"), key: join(tls, "key.pem"), name: "h.example" }];
  const [c0, k0] = [await readFile(join(tls, "real", "cert.pem"), "utf8"), await readFile(join(tls, "real", "key.pem"), "utf8")];
  let n = 0;
  const failing = new HostInfra({ certs: files, tailscale: join(dir, "bin", "tailscale"), uid: 501, rename: async (a, b) => { if (++n === 2) throw new Error("EIO: injected"); await rename(a, b); } });
  await expect(failing.renew()).rejects.toThrow("the new files could not be put in place (EIO: injected); the old ones are back");
  expect([await readFile(join(tls, "real", "cert.pem"), "utf8"), await readFile(join(tls, "real", "key.pem"), "utf8")]).toEqual([c0, k0]);
  expect(readdirSync(join(tls, "real")).sort()).toEqual(["cert.pem", "key.pem"]);
  const ok = new HostInfra({ certs: files, tailscale: join(dir, "bin", "tailscale"), uid: 501 });
  await ok.renew();
  // The links stay links; the files they point at hold the new pair.
  expect((await Bun.$`test -L ${join(tls, "cert.pem")} && test -L ${join(tls, "key.pem")}`.nothrow()).exitCode).toBe(0);
  expect(await readFile(join(tls, "real", "cert.pem"), "utf8")).not.toBe(c0);
  expect(new X509Certificate(await readFile(join(tls, "real", "cert.pem"))).checkPrivateKey(createPrivateKey(await readFile(join(tls, "real", "key.pem"))))).toBe(true);
  expect(readdirSync(join(tls, "real")).sort()).toEqual(["cert.pem", "key.pem"]);
});

test("a launchd label that is not loaded reads as stopped; any other launchctl error reads as unknown", async () => {
  await knob("printfail", "Could not find service \"pl.raqz.dsh\" in domain for user gui: 501");
  let v = await (await page("/infra")).json();
  expect(v.services[0]).toEqual({ name: "dsh", kind: "launchd", target: "pl.raqz.dsh", running: false, detail: "not loaded" });
  await knob("printfail", "Bad request.");
  v = await (await page("/infra")).json();
  expect(v.services[0]).toEqual({ name: "dsh", kind: "launchd", target: "pl.raqz.dsh", running: null, detail: "Bad request." });
  await knob("printfail", null);
});

test("only operators read or act, writes need the page's origin and JSON, and a bare host says the part is not set up", async () => {
  const direct = (token: string, path: string, init: RequestInit = {}) => fetch(`${server.url.origin}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  expect((await direct(viewer, "/api/infra")).status).toBe(403);
  expect((await direct(viewer, "/api/infra/renew", { method: "POST", headers: { origin: server.url.origin, "content-type": "application/json" }, body: "{\"confirm\":\"renew\"}" })).status).toBe(403);
  expect((await direct(op, "/api/infra/renew", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{\"confirm\":\"renew\"}" })).status).toBe(403);
  expect((await direct(op, "/api/infra/renew", { method: "POST", headers: { origin: server.url.origin, "content-type": "text/plain" }, body: "{\"confirm\":\"renew\"}" })).status).toBe(415);
  const bare = serve({ fleet: { status: async () => ({ sessions: [], raw: "" }), screen: async () => "" } as never, store: new Store(":memory:") }, 0, { auth: await Auth.fromFile(join(dir, "tokens")) });
  try {
    const r = await fetch(`${bare.url.origin}/api/infra`, { headers: { authorization: `Bearer ${op}` } });
    expect([r.status, (await r.json()).error.message]).toEqual([503, "the infrastructure part is not set up on this host"]);
  } finally { bare.stop(true); }
  // A name the gateway's route would not accept never reaches the host.
  await knob("calls", null);
  const odd = await page("/infra/services/Bad_Name/restart", { method: "POST", body: JSON.stringify({ confirm: "Bad_Name" }) });
  expect(odd.status).toBe(404);
  expect(JSON.stringify(await odd.json())).not.toContain("no service Bad_Name");
});

test("the daily check renews only near the end, shares the queue with page actions, and logs instead of throwing", async () => {
  const lines: string[] = [];
  const log = (l: string) => { lines.push(l); };
  let notAfter = "2026-12-01T00:00:00.000Z";
  const fake = (days: number, renew: () => Promise<{ notAfter: string }>) => ({
    certs: async () => [{ id: "tailnet" as const, path: "/c", names: ["h"], notAfter, daysLeft: days, renewable: true }],
    renew, serveStatus: async () => ({ text: "" }), serviceState: async () => { throw new Error(); }, restart: async () => {},
  });
  const daily = (host: unknown) => infraUseCases({ host: host as never, services: [] });
  let asked = 0;
  expect(await daily(fake(45, async () => { asked++; return { notAfter: "x" }; })).renewIfDue(log)).toBe(false);
  expect(asked).toBe(0);
  expect(await daily(fake(29, async () => { asked++; return { notAfter: "2027-03-01T00:00:00.000Z" }; })).renewIfDue(log)).toBe(true);
  // tailscale handed back the certificate it already had: not called a renewal.
  const same = fake(29, async () => { asked++; return { notAfter }; });
  expect(await infraUseCases({ host: same as never, services: [], now: () => new Date("2030-01-01T00:00:00Z") }).renewIfDue(log)).toBe(false);
  expect((await infraUseCases({ host: same as never, services: [] }, { name: "op", role: "operator" }).get()).renewedAt).not.toBe("2030-01-01T00:00:00.000Z");
  expect(await daily(fake(3, async () => { throw new Error("tailscale cert failed: no"); })).renewIfDue(log)).toBe(false);
  expect([asked, lines]).toEqual([2, [
    "tailnet certificate renewed: valid to 2027-03-01T00:00:00.000Z; the listener takes it at the next service start",
    "tailnet certificate checked: tailscale returned the current one (valid to 2026-12-01T00:00:00.000Z)",
    "tailnet certificate renewal failed (3 days left): tailscale cert failed: no",
  ]]);
  // A page renewal and the daily check never run their renewals at the same time.
  let inside = 0, most = 0;
  const slow = fake(5, async () => { inside++; most = Math.max(most, inside); await Bun.sleep(30); inside--; notAfter = new Date(Date.now() + 9e9).toISOString(); return { notAfter }; });
  await Promise.all([infraUseCases({ host: slow as never, services: [] }, { name: "op", role: "operator" }).renew({ confirm: "renew" }), daily(slow).renewIfDue(log)]);
  expect([inside, most]).toEqual([0, 1]);
});

test("the service list and requests are checked before anything runs", () => {
  expect(parseOtherServices(undefined)).toEqual([]);
  expect(parseOtherServices("dsh=launchd:pl.raqz.dsh, central=compose:/srv/c:central")).toEqual([{ name: "dsh", kind: "launchd", label: "pl.raqz.dsh" }, { name: "central", kind: "compose", dir: "/srv/c", service: "central" }]);
  for (const bad of ["x=systemd:--foo.service", "x=launchd:-l", "c=compose:/srv:--dry-run", "dsh", "Dsh=launchd:x", "dsh=launchd:a b", "dsh=systemd:x", "c=compose:/srv/../etc:x", "c=compose:rel:x", "c=compose:/srv", "x=runit:y"]) expect(() => parseOtherServices(bad)).toThrow("FLEET_CONTROL_OTHER_SERVICES");
  expect(() => parseOtherServices("a=launchd:x,a=launchd:y")).toThrow("names a twice");
  expect(() => checkServiceRestart("a", [], [{ name: "a", kind: "launchd", label: "x" }])).toThrow("body must be an object");
  expect(daysLeft(new Date("2026-01-11T00:00:00Z"), new Date("2026-01-01T12:00:00Z"))).toBe(9);
});

test("a service whose state cannot be read shows as unknown instead of failing the whole read", async () => {
  const u = infraUseCases({
    host: { certs: async () => [], renew: async () => { throw new Error(); }, serveStatus: async () => ({ error: "tailscale is not installed where the service can find it" }), serviceState: async () => { throw new Error("docker: permission denied"); }, restart: async () => {} },
    services: [{ name: "c", kind: "compose", dir: "/srv", service: "x" }],
  }, { name: "op", role: "operator" });
  const got = await u.get();
  expect({ ...got, renewedAt: null }).toEqual({ certs: [], renewedAt: null, serve: { error: "tailscale is not installed where the service can find it" }, services: [{ name: "c", kind: "compose", target: "/srv (x)", running: null, detail: "docker: permission denied" }] });
  await expect(infraUseCases({ host: {} as never, services: [] }, { name: "a", role: "agent" }).get()).rejects.toThrow("role agent");
});

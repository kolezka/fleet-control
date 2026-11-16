import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Credentials, startGateway } from "./client-gateway.ts";
import { execute, type ExecutionIO } from "./install/execute.ts";
import { InstallError, type Context, type Plan } from "./install/plan.ts";
import { createInstaller } from "./install/web.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const context: Context = { code: "/prepared/code", bun: "/tools/bun", home: "/users/fixture", platform: "linux", uid: process.getuid!() };
const client = { role: "client", config: "/private/client.json" };
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

async function installer(run?: (proposed: Plan) => Promise<string>, ctx = context) {
  const ran: Plan[] = [];
  const made = await createInstaller(ctx, run ?? (async proposed => { ran.push(proposed); return "fixture done"; }));
  cleanups.push(made.dispose);
  const post = (path: string, body: unknown) => made.handle("POST", path, json(body)) as Promise<{ status: number; body: any }>;
  const get = (path: string) => made.handle("GET", path, null) as Promise<{ status: number; body: any }>;
  const code = (await readFile(made.codePath, "utf8")).trim();
  return { ...made, ran, post, get, code };
}

test("apply code lives only in a private file and is removed on dispose", async () => {
  const i = await installer();
  expect((await lstat(i.codePath)).mode & 0o777).toBe(0o600);
  expect((await lstat(dirname(i.codePath))).mode & 0o777).toBe(0o700);
  expect(i.code).toMatch(/^[0-9a-f]{64}$/);
  const info = await i.get("");
  expect(info.body.job).toEqual({ state: "idle" });
  expect(info.body.installer.platform).toBe("linux");
  const plan = await i.post("/plan", client);
  for (const reply of [info, plan, await i.get("/job")]) expect(JSON.stringify(reply.body)).not.toContain(i.code);
  await i.dispose();
  await expect(lstat(i.codePath)).rejects.toThrow();
});

test("plan is a pure preview and only accepts the local install fields", async () => {
  const i = await installer();
  const reply = await i.post("/plan", { ...client, port: 4999 });
  expect(reply.status).toBe(200);
  expect(reply.body.plan.options).toMatchObject({ command: "install", role: "client", apply: false, port: 4999, code: context.code, bun: context.bun });
  expect(reply.body.plan.unit.path).toBe("/users/fixture/.config/systemd/user/pl.raqz.fleet-control-client.service");
  expect(reply.body.digest).toMatch(/^[0-9a-f]{64}$/);
  expect((await i.post("/plan", { ...client, port: 5000 })).body.digest).not.toBe(reply.body.digest);
  // No remote target, other checkout, other runtime or raw CLI flags through the page.
  for (const extra of [{ ssh: "me@host" }, { sshPort: 22 }, { code: "/other" }, { bun: "/other/bun" }, { apply: true }, { command: "doctor" }]) {
    expect((await i.post("/plan", { ...client, ...extra })).status).toBe(400);
  }
  for (const bad of [{}, { role: "root" }, { role: "client" }, { role: "client", config: "relative" }, { role: "client", config: "--apply" }, { ...client, port: "4999" }, { ...client, port: 70000 }, { ...client, state: "/s" }, { role: "central", state: "/s" }, [], "x"]) {
    expect((await i.post("/plan", bad)).status).toBe(400);
  }
  expect((await i.handle("POST", "/plan", new Uint8Array([0xff, 0xfe]))).status).toBe(400);
  expect((await i.handle("POST", "/exec", json({}))).status).toBe(404);
  expect((await i.handle("GET", "/plan", null)).status).toBe(404);
  const waker = await i.post("/plan", { role: "waker", config: "/private/waker.json" });
  expect(waker.status).toBe(200);
  expect(waker.body.plan.unit.content).toContain("src/host-agent/waker.ts");
  expect((await i.post("/plan", { role: "waker", config: "/private/waker.json", port: 4883 })).status).toBe(400);
  expect(i.ran).toHaveLength(0);
});

test("apply needs the code and the digest of the previewed plan", async () => {
  const i = await installer();
  const { digest } = (await i.post("/plan", client)).body;
  for (const code of [undefined, "", "0".repeat(64), i.code + "0", 7, null]) {
    const refused = await i.post("/apply", { ...client, digest, ...(code === undefined ? {} : { code }) });
    expect(refused.status).toBe(403);
  }
  // Right code, but the options are not the previewed ones.
  expect((await i.post("/apply", { ...client, port: 5001, digest, code: i.code })).status).toBe(409);
  expect((await i.post("/apply", { ...client, code: i.code })).status).toBe(409);
  expect((await i.post("/apply", { ...client, digest, code: i.code, ssh: "me@host" })).status).toBe(400);
  expect(i.ran).toHaveLength(0);
  expect((await i.get("/job")).body.job).toEqual({ state: "idle" });

  const started = await i.post("/apply", { ...client, digest, code: i.code });
  expect(started.status).toBe(202);
  expect(started.body.job).toMatchObject({ state: "running", role: "client", digest });
  await i.settled();
  expect(i.ran).toHaveLength(1);
  expect(i.ran[0]!.options).toMatchObject({ apply: true, role: "client", config: "/private/client.json", port: 4870 });
  expect(i.ran[0]!.options.ssh).toBeUndefined();
  expect((await i.get("/job")).body.job).toMatchObject({ state: "succeeded", message: "fixture done" });
});

test("one apply at a time, and failures report without internal detail", async () => {
  let release!: () => void;
  let calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const i = await installer(async () => { calls++; await gate; throw new Error("secret path /private/x and stack"); });
  const { digest } = (await i.post("/plan", client)).body;
  expect((await i.post("/apply", { ...client, digest, code: i.code })).status).toBe(202);
  const second = await i.post("/apply", { ...client, digest, code: i.code });
  expect(second.status).toBe(409);
  expect(second.body.error.kind).toBe("busy");
  release();
  await i.settled();
  expect(calls).toBe(1);
  const failed = (await i.get("/job")).body.job;
  expect(failed.state).toBe("failed");
  expect(failed.message).not.toContain("secret");

  const known = await installer(async () => { throw new InstallError("pre-existing service refused"); });
  const preview = (await known.post("/plan", client)).body;
  await known.post("/apply", { ...client, digest: preview.digest, code: known.code });
  await known.settled();
  expect((await known.get("/job")).body.job).toMatchObject({ state: "failed", message: "pre-existing service refused" });
});

test("apply through the API runs the real executor against a fixture", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-install-web-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const ctx = { ...context, code: join(root, "code"), bun: join(root, "bun"), home: join(root, "home") };
  await mkdir(join(ctx.code, "node_modules"), { recursive: true });
  await mkdir(ctx.home);
  await writeFile(ctx.bun, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const token = join(root, "token"), config = join(root, "client.json");
  await writeFile(token, "synthetic-private-token", { mode: 0o600 });
  await writeFile(config, JSON.stringify({ hosts: [{ id: "fixture", name: "Fixture", url: "http://127.0.0.1:4871", tokenFile: token }] }), { mode: 0o600 });
  const commands: string[][] = [];
  const io: ExecutionIO = { async run(argv) { commands.push(argv); return { code: 0, output: "" }; } };
  const i = await installer(proposed => execute(proposed, io, {}), ctx);

  const preview = (await i.post("/plan", { role: "client", config })).body;
  expect(commands).toHaveLength(0);
  await expect(lstat(preview.plan.unit.path)).rejects.toThrow();
  expect((await i.post("/apply", { role: "client", config, digest: preview.digest, code: i.code })).status).toBe(202);
  await i.settled();
  expect((await i.get("/job")).body.job.state).toBe("succeeded");
  expect(await readFile(preview.plan.unit.path, "utf8")).toBe(preview.plan.unit.content);
  expect(commands.map(argv => argv.slice(0, 3).join(" "))).toContain("systemctl --user enable");

  // The unit now exists, so the same plan is refused by the executor rather than overwritten.
  const again = (await i.post("/plan", { role: "client", config })).body;
  await i.post("/apply", { role: "client", config, digest: again.digest, code: i.code });
  await i.settled();
  expect((await i.get("/job")).body.job).toMatchObject({ state: "failed", message: "pre-existing installation refused; no overwrite or recovery" });
});

function gateway(handle?: Awaited<ReturnType<typeof createInstaller>>["handle"]) {
  const server = startGateway({ hosts: [], credentials: new Credentials(new Map()) }, { port: 0, maxRequestBytes: 2048, installer: handle });
  cleanups.push(() => server.stop(true));
  const base = "http://127.0.0.1:" + server.port;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { base, post };
}

test("installer is absent from a gateway that was not started with it", async () => {
  const g = gateway();
  expect((await fetch(g.base + "/install")).status).toBe(404);
  expect((await fetch(g.base + "/api/install")).status).toBe(404);
  expect((await g.post("/api/install/plan", client)).status).toBe(404);
  expect(await (await fetch(g.base + "/api/hosts")).json()).toEqual({ hosts: [] });
});

test("gateway serves the installer page and guards its API like other writes", async () => {
  const i = await installer();
  const g = gateway(i.handle);
  const page = await fetch(g.base + "/install");
  expect(page.status).toBe(200);
  expect(page.headers.get("x-frame-options")).toBe("DENY");
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toContain("Fleet Control installer");
  expect((await fetch(g.base + "/")).status).toBe(200);
  expect((await (await fetch(g.base + "/api/hosts")).json()).installer).toBe(true);

  const info = await fetch(g.base + "/api/install");
  expect(info.status).toBe(200);
  expect(info.headers.get("cache-control")).toBe("no-store");
  const planned = await g.post("/api/install/plan", client);
  expect(planned.status).toBe(200);
  const { digest } = await planned.json() as { digest: string };

  const apply = { ...client, digest, code: i.code };
  const noOrigin = await fetch(g.base + "/api/install/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(apply) });
  expect(noOrigin.status).toBe(403);
  expect((await g.post("/api/install/apply", apply, { origin: "http://evil.example" })).status).toBe(403);
  expect((await g.post("/api/install/apply", apply, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await g.post("/api/install/apply", apply, { host: "evil.example" })).status).toBe(403);
  expect((await g.post("/api/install/apply", apply, { "content-type": "text/plain" })).status).toBe(415);
  expect((await g.post("/api/install/apply", { ...apply, config: "/" + "a".repeat(4000) })).status).toBe(413);
  expect((await g.post("/api/install/apply?x=1", apply)).status).toBe(400);
  expect((await fetch(g.base + "/api/install/apply", { method: "PUT", headers: { origin: g.base } })).status).toBe(405);
  expect((await g.post("/api/install/apply", { ...apply, code: "wrong" })).status).toBe(403);
  expect(i.ran).toHaveLength(0);

  expect((await g.post("/api/install/apply", apply)).status).toBe(202);
  await i.settled();
  expect(i.ran).toHaveLength(1);
  expect((await (await fetch(g.base + "/api/install/job")).json() as any).job.state).toBe("succeeded");
});

// Starts the real client entry point with a private temp root, so leftovers are visible.
async function entry(port: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-install-entry-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const temp = join(root, "tmp"), token = join(root, "token"), config = join(root, "client.json");
  await mkdir(temp);
  await writeFile(token, "synthetic-private-token", { mode: 0o600 });
  await writeFile(config, JSON.stringify({ hosts: [{ id: "fixture", name: "Fixture", url: "http://127.0.0.1:4871", tokenFile: token }] }), { mode: 0o600 });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../client.ts"), config], { env: { ...process.env, TMPDIR: temp, PORT: port, FLEET_CONTROL_INSTALLER: "1" }, stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { child.kill("SIGKILL"); });
  const leftovers = async () => (await readdir(temp)).filter(name => name.startsWith("fleet-control-installer-"));
  return { child, leftovers };
}

test("client entry removes the apply code when it stops or cannot listen", async () => {
  const running = await entry("0");
  let printed = "";
  const reader = running.child.stdout.getReader();
  while (!printed.includes("Installer page")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    printed += new TextDecoder().decode(chunk.value);
  }
  expect(printed).toContain("Installer page");
  expect(await running.leftovers()).toHaveLength(1);
  running.child.kill("SIGTERM");
  expect(await running.child.exited).toBe(0);
  expect(await running.leftovers()).toEqual([]);

  const taken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("taken") });
  cleanups.push(() => taken.stop(true));
  const refused = await entry(String(taken.port));
  expect(await refused.child.exited).toBe(1);
  expect(await refused.leftovers()).toEqual([]);
}, 20000);

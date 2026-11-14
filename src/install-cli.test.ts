import { test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm, realpath, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, plan, shellQuote, type Context } from "./install/plan.ts";
import { execute, executionIO, safePath, validateConfig, type ExecutionIO } from "./install/execute.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const base: Context = { code: "/prepared/code", bun: "/tools/bun", home: "/users/fixture", platform: "linux", uid: process.getuid!() };
const build = (args: string[], context = base) => plan(parse(args, context), context);
async function fixture(platform = "linux") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-install-"))); roots.push(root);
  const context = { ...base, code: join(root, "code"), bun: join(root, "bun"), home: join(root, "home"), platform };
  await mkdir(join(context.code, "node_modules"), { recursive: true });
  await mkdir(join(context.code, "deploy/cooperative"), { recursive: true });
  await mkdir(context.home);
  await writeFile(context.bun, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(context.code, "deploy/cooperative/setup.sh"), "fixture");
  const config = join(root, "client.json"), token = join(root, "token");
  await writeFile(token, "synthetic-private-token", { mode: 0o600 });
  await writeFile(config, JSON.stringify({ hosts: [{ id: "fixture", name: "Fixture", url: "http://127.0.0.1:4871", tokenFile: token }] }), { mode: 0o600 });
  const calls: string[][] = [];
  const io: ExecutionIO = { async run(argv) { calls.push(argv); return { code: 0, output: argv[1] === "context" ? "unix:///fixture/docker.sock" : "" }; } };
  return { root, context, config, token, calls, io };
}
test("strict parser rejects missing explicit mode, duplicate, unknown and invalid ports", () => {
  for (const args of [["install", "client", "--config", "/c"], ["install", "central", "--plan", "--apply"], ["doctor", "--wat"], ["doctor", "--plan", "--plan"], ...["0", "-1", "65536", "1e3", "1.5", " 12", "01"].map(p => ["install", "client", "--plan", "--config", "/c", "--port", p])]) expect(() => build(args)).toThrow();
  expect(build(["install", "client", "--plan", "--config", "/c"]).options.port).toBe(4870);
  expect(build(["install", "adapter", "--plan", "--config", "/c"]).options.port).toBe(4882);
});
test("SSH rejects option and shell injection, explicitly requires prepared code and runtime", () => {
  for (const host of ["-oProxyCommand=evil", "me@host;touch /oops", "me@host\nx", "me@-host", "me@host/dir"]) expect(() => build(["install", "client", "--plan", "--config", "/c", "--ssh", host, "--code", "/remote", "--bun", "/bin/bun"])).toThrow();
  expect(() => build(["install", "client", "--plan", "--config", "/c", "--ssh", "me@host"])).toThrow();
  const p = build(["install", "client", "--plan", "--config", "/private/a'$(touch nope)", "--ssh", "me@host", "--ssh-port", "27022", "--code", "/remote", "--bun", "/bin/bun"]);
  expect(p.commands[0]!.argv).toContain("BatchMode=yes"); expect(p.commands[0]!.argv).toContain("StrictHostKeyChecking=yes"); expect(p.commands[0]!.argv).toContain("27022");
  expect(p.commands[0]!.argv.at(-1)).toContain(shellQuote("/private/a'$(touch nope)"));
});
test("plan is pure with absent paths and execution rejects plan before touching IO", async () => {
  const p = build(["install", "client", "--plan", "--config", "/does-not-exist"]);
  let calls = 0;
  await expect(execute(p, { async run() { calls++; throw new Error(); } }, {})).rejects.toThrow("--apply"); expect(calls).toBe(0);
});
test("systemd and XML escaping preserve private paths, never interpolate config contents", () => {
  const linux = build(["install", "client", "--plan", "--config", '/private/$TOKEN/%n/quote"file']);
  expect(linux.unit!.content).toContain("FLEET_CONTROL_CLIENT_CONFIG=/private/$TOKEN/%%n/");
  expect(linux.unit!.content).not.toContain("$$TOKEN");
  const dollarContext = { ...base, code: "/prepared/$CODE" };
  const dollarUnit = build(["install", "client", "--plan", "--config", "/private/config"], dollarContext).unit!.content;
  expect(dollarUnit).toContain('WorkingDirectory="/prepared/$CODE"');
  expect(dollarUnit).toContain('"/prepared/$$CODE/client.ts"');
  const mac = build(["install", "adapter", "--plan", "--config", "/private/a&<b>"], { ...base, platform: "darwin" });
  expect(mac.unit!.content).toContain("a&amp;&lt;b&gt;"); expect(mac.unit!.content).not.toContain("KeepAlive</key><true");
});
test("apply writes exactly planned unit exclusively and executes only planned commands plus loaded probe", async () => {
  const f = await fixture(); const p = build(["install", "client", "--apply", "--config", f.config], f.context);
  await execute(p, f.io, {});
  expect(await readFile(p.unit!.path, "utf8")).toBe(p.unit!.content); expect((await lstat(p.unit!.path)).mode & 0o777).toBe(0o600);
  expect(f.calls.filter(c => !c.includes("list-units"))).toEqual(p.commands.map(c => c.argv));
  expect(p.unit!.content).not.toContain("synthetic-private-token");
  const before = f.calls.length; await expect(execute(p, f.io, {})).rejects.toThrow("pre-existing"); expect(f.calls.length).toBe(before);
});
test("loaded or legacy service collision refuses before any file write", async () => {
  for (const platform of ["linux", "darwin"]) {
    const f = await fixture(platform); const p = build(["install", "client", "--apply", "--config", f.config], f.context);
    const io: ExecutionIO = { async run(argv) { return { code: 0, output: platform === "linux" && argv.includes("list-units") || platform === "darwin" ? "- 0 pl.raqz.fleet-control-client.service pl.raqz.fleet-control-client" : "" }; } };
    await expect(execute(p, io, {})).rejects.toThrow("pre-existing"); expect(await Bun.file(p.unit!.path).exists()).toBe(false);
  }
});
test("symlink leaf and ancestor refused, private config enforced", async () => {
  const f = await fixture(); const alias = join(f.root, "alias"); await symlink(f.root, alias);
  await expect(safePath(join(alias, "client.json"))).rejects.toThrow("symlink");
  await expect(validateConfig("client", join(alias, "client.json"))).rejects.toThrow();
  await chmod(f.config, 0o644); await expect(validateConfig("client", f.config)).rejects.toThrow("private");
});
test("real adapter validation accepts valid provisioned identity and rejects malformed identity", async () => {
  const f = await fixture(); const incarnation = join(f.root, "incarnation.json");
  await writeFile(incarnation, JSON.stringify({ incarnationId: "d80f67b0-bc36-4a35-a1e3-e96931bfc0d2", token: "i".repeat(43) }), { mode: 0o600 });
  await writeFile(f.config, JSON.stringify({ centralUrl: "http://127.0.0.1:4881/mcp", localToken: "l".repeat(43), supervisorToken: "s".repeat(43), incarnationFile: incarnation }));
  await validateConfig("adapter", f.config);
  await writeFile(incarnation, JSON.stringify({ incarnationId: "bad", token: "i".repeat(43) })); await expect(validateConfig("adapter", f.config)).rejects.toThrow();
});
test("central fresh-only preexisting state and env are refused without processes", async () => {
  const f = await fixture(); const state = join(f.root, "state");
  const p = build(["install", "central", "--apply", "--state", state, "--host-id", "fixture"], f.context);
  await mkdir(state); await expect(execute(p, f.io, {})).rejects.toThrow("pre-existing"); expect(f.calls).toEqual([]);
});
test("central rejects ambient settings and remote daemon, existing project; fresh setup uses explicit arguments", async () => {
  const f = await fixture(); const state = join(f.root, "state");
  const p = build(["install", "central", "--apply", "--state", state, "--host-id", "fixture"], f.context);
  await expect(execute(p, f.io, { DOCKER_HOST: "tcp://bad" })).rejects.toThrow("ambient");
  await expect(execute(p, { async run() { return { code: 0, output: "ssh://remote" }; } }, {})).rejects.toThrow("local Unix");
  await expect(execute(p, { async run(argv) { return { code: 0, output: argv[1] === "context" ? "unix:///fixture.sock" : "existing-container" }; } }, {})).rejects.toThrow("existing fleet");
  await execute(p, f.io, {}); expect(f.calls).toEqual(p.commands.map(c => c.argv));
  expect(await readFile(join(f.context.code, "deploy/cooperative/.env"), "utf8")).toContain("COOPERATIVE_SUPERVISOR_HOST=fixture");
});
test("command failures suppress stdout/stderr secrets and never retry", async () => {
  const f = await fixture(); const p = build(["install", "client", "--apply", "--config", f.config], f.context); let calls = 0;
  await expect(execute(p, { async run() { calls++; throw new Error("SECRET_PRIVATE_TOKEN"); } }, {})).rejects.toThrow("output suppressed"); expect(calls).toBe(1);
});

test("nested credential paths must be private bounded regular files without symlinks", async () => {
  const f = await fixture();
  await chmod(f.token, 0o644); await expect(validateConfig("client", f.config)).rejects.toThrow("private");
  await chmod(f.token, 0o600); const link = join(f.root, "link"); await symlink(f.token, link);
  const raw = JSON.parse(await readFile(f.config, "utf8")); raw.hosts[0].tokenFile = link;
  await writeFile(f.config, JSON.stringify(raw)); await expect(validateConfig("client", f.config)).rejects.toThrow("symlink");
  raw.hosts[0].tokenFile = f.token; await writeFile(f.token, "x".repeat(65537));
  await writeFile(f.config, JSON.stringify(raw)); await expect(validateConfig("client", f.config)).rejects.toThrow("private");
  await writeFile(f.token, "host-token"); const parent = join(f.root, "alias"); await symlink(f.root, parent);
  raw.central = { url: "http://127.0.0.1:4881", tokenFile: join(parent, "token") };
  await writeFile(f.config, JSON.stringify(raw)); await expect(validateConfig("client", f.config)).rejects.toThrow("symlink");
});
test("all central artifact probes refuse collisions and pin Docker endpoint for setup", async () => {
  for (const kind of ["ps", "image", "network", "volume"]) {
    const f = await fixture(); const p = build(["install", "central", "--apply", "--state", join(f.root, "state"), "--host-id", "fixture"], f.context);
    await expect(execute(p, { async run(argv, cwd, env, capture) {
      if (argv[1] === "context") return { code: 0, output: "unix:///fixture.sock" };
      expect(env.DOCKER_HOST).toBe("unix:///fixture.sock"); expect(capture).toBe(true);
      return { code: 0, output: argv[1] === kind ? "existing-artifact" : "" };
    } }, {})).rejects.toThrow("existing fleet");
    expect(await Bun.file(join(f.context.code, "deploy/cooperative/.env")).exists()).toBe(false);
  }
  const f = await fixture(); const p = build(["install", "central", "--apply", "--state", join(f.root, "state"), "--host-id", "fixture"], f.context);
  let setup = false;
  await execute(p, { async run(argv, cwd, env, capture) {
    if (argv[1] === "context") return { code: 0, output: "unix:///fixture.sock" };
    expect(env.DOCKER_HOST).toBe("unix:///fixture.sock");
    if (argv[0] === "bash") { setup = true; expect(capture).toBe(false); }
    return { code: 0, output: "" };
  } }, {}); expect(setup).toBe(true);
});
test("Linux adapter refuses known Compose adapter and unavailable Docker before unit write", async () => {
  const f = await fixture(); const incarnation = join(f.root, "incarnation.json");
  await writeFile(incarnation, JSON.stringify({ incarnationId: "d80f67b0-bc36-4a35-a1e3-e96931bfc0d2", token: "i".repeat(43) }), { mode: 0o600 });
  await writeFile(f.config, JSON.stringify({ centralUrl: "http://127.0.0.1:4881/mcp", localToken: "l".repeat(43), supervisorToken: "s".repeat(43), incarnationFile: incarnation }));
  const p = build(["install", "adapter", "--apply", "--config", f.config], f.context);
  await expect(execute(p, { async run(argv, cwd, env) {
    if (argv[1] === "context") return { code: 0, output: "unix:///fixture.sock" };
    expect(argv).toContain("label=com.docker.compose.service=adapter"); expect(env.DOCKER_HOST).toBe("unix:///fixture.sock");
    return { code: 0, output: "known-adapter" };
  } }, {})).rejects.toThrow("pre-existing cooperative Docker adapter");
  expect(await Bun.file(p.unit!.path).exists()).toBe(false);
  await expect(execute(p, { async run() { throw new Error("Docker unavailable"); } }, {})).rejects.toThrow("command failed");
});
test("mutation stdout is discarded at any volume while inspection remains bounded", async () => {
  const f = await fixture();
  const argv = [process.execPath, "--no-env-file", "-e", 'process.stdout.write("x".repeat(100000));'];
  expect(await executionIO.run(argv, f.root, {}, false)).toEqual({ code: 0, output: "" });
  await expect(executionIO.run(argv, f.root, {}, true)).rejects.toThrow("output exceeded");
});
test("entry help and plan execute no external tools with unavailable PATH", async () => {
  const f = await fixture(); const entry = join(import.meta.dir, "../fleet-control.ts");
  for (const args of [["--help"], ["-h"], ["install", "central", "--plan", "--state", "/absent/state", "--host-id", "fixture"]]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], { env: { PATH: join(f.root, "missing") }, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text(); expect(await child.exited).toBe(0);
    if (args[0] === "install") expect(JSON.parse(output).options.apply).toBe(false); else expect(output).toContain("No dependency bootstrap");
  }
});

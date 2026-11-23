// Service settings saved from the page: checked, written owner-only beside the tokens file, and taken by the
// real entry point at its next start. A file that does not load is skipped, so the page still comes up.
import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newToken, tokenLine } from "./auth.ts";
import { settingsUseCases, settingsRevision, type SettingsFile } from "./application/settings.ts";
import { checkSettings, settingsDiff, settingsEnv, settingsOf } from "./domain/settings.ts";
import { AdminError } from "./domain/fleet-admin.ts";
import { HostSettingsFile, settingsPath } from "./settings-file.ts";

const dir = await mkdtemp(join(tmpdir(), "service-settings-"));
const procs: ReturnType<typeof Bun.spawn>[] = [];
afterAll(async () => { for (const p of procs) { p.kill(); await p.exited; } await rm(dir, { recursive: true, force: true }); });
const freePort = () => new Promise<number>((done) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); });
});
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AdminError; } throw new Error("expected a refusal"); };

test("settings are checked: known keys only, plain folders, model names, an MCP URL on /mcp, input as a flag", () => {
  expect(checkSettings({ agentRoots: [" /a/b "], agentModels: ["haiku"], agentDshModels: [], agentMcpUrl: "", input: true }))
    .toEqual({ agentRoots: ["/a/b"], agentModels: ["haiku"], agentDshModels: [], agentMcpUrl: null, input: true });
  const bad: [unknown, string][] = [
    [{ admin: false }, "unknown setting admin"],
    [{ agentRoots: ["/"] }, "agentRoots: / is not a plain absolute folder"],
    [{ agentRoots: ["rel"] }, "agentRoots: rel is not a plain absolute folder"],
    [{ agentRoots: ["/a", "/a"] }, "agentRoots lists an entry twice"],
    [{ agentModels: [] }, "agentModels must not be empty"],
    [{ agentModels: ["Bad Model"] }, "agentModels: Bad Model is not a model alias"],
    [{ agentDshModels: ["noslash"] }, "agentDshModels: noslash is not provider/model"],
    [{ agentMcpUrl: "https://h:1/other" }, "agentMcpUrl must be https://<this host>:<port>/mcp or http://127.0.0.1:<port>/mcp"],
    [{ agentMcpUrl: "http://10.0.0.1:1/mcp" }, "agentMcpUrl must be https://<this host>:<port>/mcp or http://127.0.0.1:<port>/mcp"],
    [{ input: "yes" }, "input must be true or false"],
    [[], "settings must be an object"],
  ];
  for (const [input, message] of bad) {
    let got = "";
    try { checkSettings(input); } catch (e) { got = (e as Error).message; }
    expect(got).toBe(message);
  }
  // The file's values go over the plist's; what it leaves out stays.
  const env = settingsEnv({ FLEET_CONTROL_AGENT_ROOTS: "/x", FLEET_CONTROL_INPUT: "1", OTHER: "o" }, { agentModels: ["opus"], input: false });
  expect([env.FLEET_CONTROL_AGENT_ROOTS, env.FLEET_CONTROL_AGENT_MODELS, env.FLEET_CONTROL_INPUT, env.OTHER]).toEqual(["/x", "opus", "", "o"]);
  expect(settingsOf({ FLEET_CONTROL_AGENT_ROOTS: "/x:/y" })).toEqual({ agentRoots: ["/x", "/y"], agentModels: ["sonnet", "opus", "haiku"], agentDshModels: [], agentMcpUrl: null, input: false, fleetConf: "" });
});

test("a save needs an operator, the typed confirm and the read revision, and a setting the service would refuse is not written", async () => {
  let text: string | null = null;
  const file: SettingsFile = { path: "/s/settings.json", read: async () => text, write: async (expected, t) => { if (expected !== text) return false; text = t; return true; } };
  const running = settingsOf({ FLEET_CONTROL_AGENT_ROOTS: "/r" });
  const deps = { file, baseEnv: { FLEET_CONTROL_AGENT_ROOTS: "/r" }, running, check: async (env: Record<string, string | undefined>) => { if (env.FLEET_CONTROL_AGENT_ROOTS === "/nope") throw new Error("no such folder"); } };
  for (const role of ["agent", "viewer"] as const) expect((await fail(settingsUseCases(deps, { name: "x", role }).get())).constructor.name).toBe("RoleError");
  const use = settingsUseCases(deps, { name: "op", role: "operator" });
  const first = await use.get();
  expect([first.revision, first.saved, first.restartNeeded]).toEqual([settingsRevision(null), {}, []]);
  const refusals: [unknown, string][] = [
    [{ settings: { input: true }, revision: first.revision }, "type settings to confirm"],
    [{ settings: { input: true }, revision: "x", confirm: "settings" }, "revision must be the 64-hex revision the settings were read at"],
    [{ settings: { input: true }, revision: first.revision, confirm: "settings", more: 1 }, "unknown field more"],
    [{ settings: { agentRoots: ["/nope"] }, revision: first.revision, confirm: "settings" }, "the service would not start with these settings: no such folder"],
  ];
  for (const [body, message] of refusals) expect((await fail(use.save(body))).message).toBe(message);
  expect(text).toBeNull();
  const saved = await use.save({ settings: { input: true, agentModels: ["haiku"] }, revision: first.revision, confirm: "settings" });
  expect(saved.saved).toEqual({ input: true, agentModels: ["haiku"] });
  expect(saved.restartNeeded).toEqual(["agentModels", "input"]);
  expect(JSON.parse(text!)).toEqual({ input: true, agentModels: ["haiku"] });
  // Read at the old revision: refused, file unchanged.
  const stale = await fail(use.save({ settings: { input: false }, revision: first.revision, confirm: "settings" }));
  expect([stale.kind, stale.message]).toEqual(["conflict", "the settings file changed on the host since you read it; reload and edit again"]);
  expect(JSON.parse(text!).input).toBe(true);
  // A file broken by hand is named, not overwritten blindly.
  text = "{not json";
  expect((await fail(use.get())).message).toBe("the settings file is not JSON; fix or remove it on the host");
});

test("the real service writes the file owner-only beside the tokens file and takes it at its next start; a broken file is skipped", async () => {
  const op = newToken(), agent = newToken();
  await writeFile(join(dir, "tokens"), `${tokenLine("op", op, "operator")}\n${tokenLine("worker", agent, "agent")}\n`, { mode: 0o600 });
  await writeFile(join(dir, "fleet.conf"), `FLEET=settings-test-${process.pid}\nFLEET_DIR=${dir}\nAGENTS=()\n`);
  const roots = join(dir, "agents");
  await mkdir(join(roots, "sandbox"), { recursive: true });
  const start = async () => {
    const port = await freePort();
    const proc = Bun.spawn(["bun", "index.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, PORT: String(port), FLEET_CONF: join(dir, "fleet.conf"), FLEET_CONTROL_DB: join(dir, "state.db"), FLEET_CONTROL_TOKENS: join(dir, "tokens"), FLEET_CONTROL_ADMIN: "1", FLEET_CONTROL_AGENT_ROOTS: "", FLEET_CONTROL_INPUT: "", FLEET_CONTROL_SETTINGS: "" },
      stdout: "pipe", stderr: "pipe",
    });
    procs.push(proc);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/api/whoami`, { headers: { authorization: `Bearer ${op}` } })).ok) return { base, proc }; } catch { await Bun.sleep(100); }
    }
    proc.kill();
    throw new Error(`service did not start: ${await new Response(proc.stderr as ReadableStream).text()}`);
  };
  const stop = async (proc: ReturnType<typeof Bun.spawn>) => { proc.kill(); await proc.exited; };
  const call = (base: string, path: string, init: RequestInit = {}, token = op) => fetch(`${base}/api${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base, ...(init.headers ?? {}) } });

  let s = await start();
  // No managed agents and no input yet.
  expect((await call(s.base, "/agents")).status).toBe(503);
  expect((await call(s.base, "/settings", {}, agent)).status).toBe(403);
  const read = await (await call(s.base, "/settings")).json();
  expect([read.path, read.running.agentRoots, read.running.input]).toEqual([join(dir, "settings.json"), [], false]);
  const put = await call(s.base, "/settings", { method: "PUT", body: JSON.stringify({ settings: { agentRoots: [roots], agentModels: ["haiku"], input: true }, revision: read.revision, confirm: "settings" }) });
  const saved = await put.json();
  expect([put.status, saved.restartNeeded]).toEqual([200, ["agentRoots", "agentModels", "input"]]);
  expect(((await stat(join(dir, "settings.json"))).mode & 0o777).toString(8)).toBe("600");
  expect((await call(s.base, "/settings", { method: "PUT", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
  expect((await call(s.base, "/settings", { method: "PUT", headers: { origin: "http://evil.example" }, body: "{}" })).status).toBe(403);
  // The running service keeps what it started with.
  expect((await call(s.base, "/agents")).status).toBe(503);
  await stop(s.proc);

  s = await start();
  const agents = await (await call(s.base, "/agents")).json();
  expect([agents.folders, agents.models]).toEqual([[join(roots, "sandbox")], ["haiku"]]);
  const now = await (await call(s.base, "/settings")).json();
  expect([now.running.agentRoots, now.running.input, now.restartNeeded]).toEqual([[roots], true, []]);
  expect((await call(s.base, "/leases")).status).toBe(200);
  await stop(s.proc);

  // Broken by hand: the service still starts, on the plist's values, and says why.
  await writeFile(join(dir, "settings.json"), "{broken", { mode: 0o600 });
  s = await start();
  expect((await call(s.base, "/agents")).status).toBe(503);
  const err = await (await call(s.base, "/settings")).json();
  expect(err.error.message).toBe("the settings file is not JSON; fix or remove it on the host");
  await stop(s.proc);
  expect(await readFile(join(dir, "settings.json"), "utf8")).toBe("{broken");
});

test("the settings file is replaced only if it still holds what was read, and lives beside the tokens file unless named", async () => {
  const f = new HostSettingsFile(join(dir, "cas.json"));
  expect(await f.read()).toBeNull();
  expect(await f.write("something", "{}\n")).toBe(false);
  expect(await f.read()).toBeNull();
  expect(await f.write(null, "{\"input\":true}\n")).toBe(true);
  expect(await f.write(null, "{}\n")).toBe(false);
  expect(await f.read()).toBe("{\"input\":true}\n");
  expect(((await stat(join(dir, "cas.json"))).mode & 0o777).toString(8)).toBe("600");
  expect(settingsPath({ FLEET_CONTROL_TOKENS: "/c/fc/tokens" })).toBe("/c/fc/settings.json");
  expect(settingsPath({ FLEET_CONTROL_TOKENS: "/c/fc/tokens", FLEET_CONTROL_SETTINGS: "/other/s.json" })).toBe("/other/s.json");
  expect(settingsPath({})).toBeNull();
  expect(() => settingsPath({ FLEET_CONTROL_SETTINGS: "rel.json" })).toThrow("FLEET_CONTROL_SETTINGS must be an absolute path");
});

test("review fixes: a host without agent folders can save, the file keeps only what differs, idle agent settings and a start check failure are refused", async () => {
  // No folders and no model list in the plist: the page shows the service's default models and sends them back.
  expect(settingsOf({}).agentModels).toEqual(["sonnet", "opus", "haiku"]);
  let text: string | null = null;
  const file: SettingsFile = { path: "/s/settings.json", read: async () => text, write: async (expected, t) => { if (expected !== text) return false; text = t; return true; } };
  let refuse = "";
  const deps = { file, baseEnv: {}, running: settingsOf({}), check: async () => { if (refuse) throw new Error(refuse); } };
  const use = settingsUseCases(deps, { name: "op", role: "operator" });
  const first = await use.get();
  // No file has its own revision, never the one of an empty file.
  expect(first.revision).not.toBe(settingsRevision(""));
  const all = { ...settingsOf({}), input: true };
  const saved = await use.save({ settings: all, revision: first.revision, confirm: "settings" });
  expect(JSON.parse(text!)).toEqual({ input: true });
  expect([saved.restartNeeded, saved.next.agentModels]).toEqual([["input"], ["sonnet", "opus", "haiku"]]);
  expect(settingsDiff(settingsOf({ FLEET_CONTROL_AGENT_ROOTS: "/r" }), settingsOf({ FLEET_CONTROL_AGENT_ROOTS: "/r", FLEET_CONTROL_INPUT: "1" }))).toEqual({ input: true });
  // Models, DSH models or an MCP address without folders would do nothing.
  for (const [extra, names] of [[{ agentModels: ["haiku"] }, "agentModels"], [{ agentDshModels: ["p/m"] }, "agentDshModels"], [{ agentMcpUrl: "http://127.0.0.1:1/mcp" }, "agentMcpUrl"]] as const) {
    const e = await fail(use.save({ settings: { ...all, ...extra }, revision: saved.revision, confirm: "settings" }));
    expect(e.message.startsWith(`${names} need agent folders`)).toBe(true);
  }
  // The start's own checks (here: terminal input on a remote fleet) refuse the save up front.
  refuse = "terminal input needs a local fleet (REMOTE_SSH is set)";
  const e = await fail(use.save({ settings: { ...all, input: false }, revision: saved.revision, confirm: "settings" }));
  expect(e.message).toBe("the service would not start with these settings: terminal input needs a local fleet (REMOTE_SSH is set)");
  expect(JSON.parse(text!)).toEqual({ input: true });
});

test("review fixes on the real service: input on a fleet it cannot type into is refused on save, skipped at start with the reason shown, and the file is ignored without fleet administration", async () => {
  const d = join(dir, "remote");
  await mkdir(d, { recursive: true });
  const op = newToken();
  await writeFile(join(d, "tokens"), `${tokenLine("op", op, "operator")}\n`, { mode: 0o600 });
  await writeFile(join(d, "fleet.conf"), `FLEET=settings-remote-${process.pid}\nFLEET_DIR=${d}\nREMOTE_SSH=me@example.invalid\nAGENTS=()\n`);
  const start = async (admin: string) => {
    const port = await freePort();
    const proc = Bun.spawn(["bun", "index.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, PORT: String(port), FLEET_CONF: join(d, "fleet.conf"), FLEET_CONTROL_DB: join(d, "state.db"), FLEET_CONTROL_TOKENS: join(d, "tokens"), FLEET_CONTROL_ADMIN: admin, FLEET_CONTROL_AGENT_ROOTS: "", FLEET_CONTROL_INPUT: "", FLEET_CONTROL_SETTINGS: "" },
      stdout: "pipe", stderr: "pipe",
    });
    procs.push(proc);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      if (proc.exitCode !== null) throw new Error(`service exited ${proc.exitCode}: ${await new Response(proc.stderr as ReadableStream).text()}`);
      try { if ((await fetch(`${base}/api/whoami`, { headers: { authorization: `Bearer ${op}` } })).ok) return { base, proc }; } catch { await Bun.sleep(100); }
    }
    proc.kill();
    throw new Error("service did not start");
  };
  const call = (base: string, path: string, init: RequestInit = {}) => fetch(`${base}/api${path}`, { ...init, headers: { authorization: `Bearer ${op}`, "content-type": "application/json", origin: base } });
  let s = await start("1");
  const read = await (await call(s.base, "/settings")).json();
  const put = await call(s.base, "/settings", { method: "PUT", body: JSON.stringify({ settings: { ...read.next, input: true }, revision: read.revision, confirm: "settings" }) });
  expect([put.status, (await put.json()).error.message]).toEqual([400, "the service would not start with these settings: terminal input needs a local fleet (REMOTE_SSH is set)"]);
  s.proc.kill(); await s.proc.exited;
  // Written by hand anyway: the service still starts, without input, and the page is told why.
  await writeFile(join(d, "settings.json"), "{\"input\": true}\n", { mode: 0o600 });
  s = await start("1");
  const now = await (await call(s.base, "/settings")).json();
  expect([now.running.input, now.skipped]).toEqual([false, "terminal input needs a local fleet (REMOTE_SSH is set)"]);
  expect((await call(s.base, "/leases")).status).toBe(503);
  s.proc.kill(); await s.proc.exited;
  // A file the service cannot read is skipped too; once it is gone, its reason no longer shows.
  await chmod(join(d, "settings.json"), 0o000);
  s = await start("1");
  expect((await (await call(s.base, "/settings")).json()).error.kind).toBe("unavailable");
  await rm(join(d, "settings.json"));
  expect((await (await call(s.base, "/settings")).json()).skipped).toBeNull();
  s.proc.kill(); await s.proc.exited;
  await writeFile(join(d, "settings.json"), "{\"input\": true}\n", { mode: 0o600 });
  // Without fleet administration the file is not read at all (nothing on the page shows or edits it).
  await writeFile(join(d, "fleet.conf"), `FLEET=settings-remote-${process.pid}\nFLEET_DIR=${d}\nAGENTS=()\n`);
  s = await start("");
  expect((await call(s.base, "/leases")).status).toBe(503);
  s.proc.kill(); await s.proc.exited;
  s = await start("1");
  expect((await call(s.base, "/leases")).status).toBe(200);
  s.proc.kill(); await s.proc.exited;
});

test("review round 2: a plist value the page cannot set does not block a save, and the skip reason ends once the file changes", async () => {
  let text: string | null = "{\"input\": true}\n";
  const file: SettingsFile = { path: "/s/settings.json", read: async () => text, write: async (expected, t) => { if (expected !== text) return false; text = t; return true; } };
  // The plist sets an empty model list; the page sends it back unchanged with one real change.
  const baseEnv = { FLEET_CONTROL_AGENT_MODELS: "" };
  const deps = { file, baseEnv, running: settingsOf(baseEnv), check: async () => {}, skipped: { reason: "terminal input needs a local fleet (REMOTE_SSH is set)", revision: settingsRevision(text) } };
  const use = settingsUseCases(deps, { name: "op", role: "operator" });
  const first = await use.get();
  expect([first.next.agentModels, first.skipped]).toEqual([[], "terminal input needs a local fleet (REMOTE_SSH is set)"]);
  const saved = await use.save({ settings: { ...first.base, input: false }, revision: first.revision, confirm: "settings" });
  expect(JSON.parse(text!)).toEqual({});
  // An own __proto__ key is an unknown setting, not dropped as equal to the plist.
  const proto = await fail(use.save(JSON.parse(`{"settings": {"__proto__": {}}, "revision": "${first.revision}", "confirm": "settings"}`)));
  expect(proto.message).toBe("unknown setting __proto__");
  // The file the start skipped is gone, so its reason no longer shows.
  expect(saved.skipped).toBeNull();
  expect((await use.get()).skipped).toBeNull();
});

test("review round 2 on the real service: with input on in the plist, a save of other settings does not depend on fleet.conf loading", async () => {
  const d = join(dir, "plist-input");
  await mkdir(d, { recursive: true });
  const op = newToken();
  await writeFile(join(d, "tokens"), `${tokenLine("op", op, "operator")}\n`, { mode: 0o600 });
  const conf = `FLEET=settings-input-${process.pid}\nFLEET_DIR=${d}\nAGENTS=()\n`;
  await writeFile(join(d, "fleet.conf"), conf);
  const port = await freePort();
  const proc = Bun.spawn(["bun", "index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, PORT: String(port), FLEET_CONF: join(d, "fleet.conf"), FLEET_CONTROL_DB: join(d, "state.db"), FLEET_CONTROL_TOKENS: join(d, "tokens"), FLEET_CONTROL_ADMIN: "1", FLEET_CONTROL_AGENT_ROOTS: "", FLEET_CONTROL_INPUT: "1", FLEET_CONTROL_SETTINGS: "" },
    stdout: "pipe", stderr: "pipe",
  });
  procs.push(proc);
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${base}/api/whoami`, { headers: { authorization: `Bearer ${op}` } })).ok; } catch { await Bun.sleep(100); } }
  expect(up).toBe(true);
  const call = (path: string, init: RequestInit = {}) => fetch(`${base}/api${path}`, { ...init, headers: { authorization: `Bearer ${op}`, "content-type": "application/json", origin: base } });
  // fleet.conf breaks for a moment (an edit by hand); an unrelated settings save still goes through.
  await writeFile(join(d, "fleet.conf"), `${conf}false\n`);
  const read = await (await call("/settings")).json();
  const put = await call("/settings", { method: "PUT", body: JSON.stringify({ settings: { ...read.next, agentDshModels: [] , agentRoots: [] }, revision: read.revision, confirm: "settings" }) });
  expect(put.status).toBe(200);
  const put2 = await call("/settings", { method: "PUT", body: JSON.stringify({ settings: { ...read.next, input: false }, revision: (await put.json()).revision, confirm: "settings" }) });
  expect(put2.status).toBe(200);
  expect(JSON.parse(await readFile(join(d, "settings.json"), "utf8"))).toEqual({ input: false });
  proc.kill(); await proc.exited;
});

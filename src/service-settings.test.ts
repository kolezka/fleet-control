// Service settings saved from the page: checked, written owner-only beside the tokens file, and taken by the
// real entry point at its next start. A file that does not load is skipped, so the page still comes up.
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newToken, tokenLine } from "./auth.ts";
import { settingsUseCases, settingsRevision, type SettingsFile } from "./application/settings.ts";
import { checkSettings, settingsEnv, settingsOf } from "./domain/settings.ts";
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
  expect(settingsOf({ FLEET_CONTROL_AGENT_ROOTS: "/x:/y" })).toEqual({ agentRoots: ["/x", "/y"], agentModels: ["sonnet", "opus", "haiku"], agentDshModels: [], agentMcpUrl: null, input: false });
});

test("a save needs an operator, the typed confirm and the read revision, and a setting the service would refuse is not written", async () => {
  let text: string | null = null;
  const file: SettingsFile = { path: "/s/settings.json", read: async () => text, write: async (expected, t) => { if (expected !== text) return false; text = t; return true; } };
  const running = settingsOf({ FLEET_CONTROL_AGENT_ROOTS: "/r" });
  const deps = { file, baseEnv: { FLEET_CONTROL_AGENT_ROOTS: "/r" }, running, check: (env: Record<string, string | undefined>) => { if (env.FLEET_CONTROL_AGENT_ROOTS === "/nope") throw new Error("no such folder"); } };
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

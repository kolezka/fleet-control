// The file editor end to end: a real host service over real folders and files, a real gateway, and the page's
// calls through it. Only an operator, only inside the allowed folders, never the service's own files.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, newToken, tokenLine } from "./auth.ts";
import { Store } from "./data/store.ts";
import { serve } from "./server.ts";
import { Credentials, startGateway } from "./client-gateway.ts";
import { DiskFiles } from "./fleet/files.ts";
import { fileRevision, filesUseCases, type FilesHost } from "./application/files.ts";
import { checkPath, MAX_FILE_BYTES } from "./domain/files.ts";
import { fileRootsFromEnv } from "./config.ts";

let dir: string, root: string, outside: string, cfgDir: string, auth: Auth;
let host: ReturnType<typeof serve>, gateway: ReturnType<typeof startGateway>;
const op = newToken(), viewer = newToken(), agent = newToken();

beforeEach(async () => {
  // realpath: on macOS tmpdir is behind the /var -> /private/var symlink, and the host answers real paths.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "file-editor-")));
  root = join(dir, "agents");
  outside = join(dir, "outside");
  cfgDir = join(dir, "config");
  for (const d of [root, join(root, "work dir"), outside, cfgDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, "work dir", "notes.md"), "one\ntwo\n", { mode: 0o640 });
  writeFileSync(join(outside, "secret.txt"), "nope\n");
  writeFileSync(join(root, "fc-orch.mcp.json"), '{"token":"x"}\n');
  writeFileSync(join(cfgDir, "tokens"), [tokenLine("op", op, "operator"), tokenLine("watcher", viewer, "viewer"), tokenLine("orch", agent, "agent")].join("\n") + "\n", { mode: 0o600 });
  auth = await Auth.fromFile(join(cfgDir, "tokens"));
  const files = { host: new DiskFiles(), roots: [root, cfgDir], protectedPaths: [cfgDir] };
  host = serve({ fleet: { status: async () => ({ sessions: [], raw: "" }), screen: async () => "" } as never, store: new Store(":memory:"), files }, 0, { auth });
  gateway = startGateway({ hosts: [{ id: "h", name: "H", origin: host.url.origin }], credentials: new Credentials(new Map([["h", op]])) }, { port: 0 });
});
afterEach(() => {
  gateway?.stop(true);
  host?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const page = (path: string, body?: object, method = body ? "PUT" : "GET") => fetch(`${gateway.url.origin}/api/hosts/h${path}`, {
  method,
  headers: { origin: gateway.url.origin, ...(body ? { "content-type": "application/json" } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const open = (path: string) => page(`/files?path=${encodeURIComponent(path)}`);
// The gateway shortens long error messages for the page; refusals that name long temp paths are read at the host.
const hostOpen = (path: string) => fetch(`${host.url.origin}/api/files?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${op}` } });
const hostSave = (body: object) => fetch(`${host.url.origin}/api/files`, { method: "PUT", headers: { authorization: `Bearer ${op}`, origin: host.url.origin, "content-type": "application/json" }, body: JSON.stringify(body) });
const direct = (token: string, path: string) => fetch(`${host.url.origin}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
const errorOf = async (r: Response) => ({ status: r.status, message: ((await r.json()) as { error: { message: string } }).error.message });

test("an operator lists the allowed folders, opens a folder and a file, and saves with the read revision and the typed name", async () => {
  const roots = await (await page("/files")).json();
  expect(roots).toEqual({ roots: [root, cfgDir] });
  const folder = await (await open(root)).json() as { kind: string; entries: { name: string; kind: string }[] };
  expect(folder.kind).toBe("dir");
  // Folders first, then files; a symlink would show as "other".
  expect(folder.entries.map((e) => [e.name, e.kind])).toEqual([["work dir", "dir"], ["fc-orch.mcp.json", "file"]]);
  const file = join(root, "work dir", "notes.md");
  const read = await (await open(file)).json() as { kind: string; text: string; revision: string; path: string };
  expect([read.kind, read.text, read.revision, read.path]).toEqual(["file", "one\ntwo\n", fileRevision("one\ntwo\n"), file]);

  // The typed name and the revision are both needed.
  expect(await errorOf(await page("/files", { path: file, text: "x", revision: read.revision, confirm: "nope" }))).toEqual({ status: 400, message: "type notes.md to confirm" });
  expect(await errorOf(await page("/files", { path: file, text: "x", revision: "abc", confirm: "notes.md" }))).toEqual({ status: 400, message: "revision must be the 64-hex revision the file was read at, or new for a new file" });
  const saved = await (await page("/files", { path: file, text: "one\nTWO\n", revision: read.revision, confirm: "notes.md" })).json() as { revision: string; backup: string };
  expect(readFileSync(file, "utf8")).toBe("one\nTWO\n");
  expect(saved.revision).toBe(fileRevision("one\nTWO\n"));
  // The old text is kept beside it with the file's mode, and no temp file is left.
  expect(readFileSync(saved.backup, "utf8")).toBe("one\ntwo\n");
  expect(statSync(saved.backup).mode & 0o777).toBe(0o640);
  expect(statSync(file).mode & 0o777).toBe(0o640);
  expect(readdirSync(join(root, "work dir")).filter((n) => n.startsWith("."))).toEqual([]);

  // A save at the old revision is refused and changes nothing.
  expect(await errorOf(await page("/files", { path: file, text: "lost", revision: read.revision, confirm: "notes.md" }))).toEqual({ status: 409, message: `${file} changed on the host since you read it; reload it and edit again` });
  expect(readFileSync(file, "utf8")).toBe("one\nTWO\n");

  // A new file: revision "new", refused when it already exists, private by default.
  const fresh = join(root, "work dir", "todo.txt");
  await page("/files", { path: fresh, text: "a\n", revision: "new", confirm: "todo.txt" });
  expect([readFileSync(fresh, "utf8"), statSync(fresh).mode & 0o777]).toEqual(["a\n", 0o600]);
  expect(await errorOf(await page("/files", { path: fresh, text: "b\n", revision: "new", confirm: "todo.txt" }))).toEqual({ status: 409, message: `${fresh} already exists; open it and edit it instead` });
  expect(await errorOf(await page("/files", { path: join(root, "no such", "x.txt"), text: "b\n", revision: "new", confirm: "x.txt" }))).toEqual({ status: 404, message: `${join(root, "no such", "x.txt")} does not exist, nor does its folder` });
});

test("outside the allowed folders, through a symlink, the service's own files and non-text files are refused", async () => {
  expect(await errorOf(await hostOpen(join(outside, "secret.txt")))).toEqual({ status: 400, message: `${join(outside, "secret.txt")} is outside the folders this host allows (${root}, ${cfgDir})` });
  // Through the gateway the page gets the same refusal, shortened when the paths are long.
  expect((await errorOf(await open(join(outside, "secret.txt")))).message.startsWith(`${join(outside, "secret.txt")} is outside the folders this host allows`)).toBe(true);
  expect(await errorOf(await open(`${root}/../outside/secret.txt`))).toEqual({ status: 400, message: "path must be plain: no empty, . or .. parts" });
  // A symlink inside the folder that leads out is judged by where it leads, for reading and for saving.
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  expect(await errorOf(await hostOpen(join(root, "link.txt")))).toEqual({ status: 400, message: `${join(outside, "secret.txt")} is outside the folders this host allows (${root}, ${cfgDir})` });
  symlinkSync(outside, join(root, "out"));
  expect(await errorOf(await hostSave({ path: join(root, "out", "new.txt"), text: "x", revision: "new", confirm: "new.txt" }))).toEqual({ status: 400, message: `${join(outside, "new.txt")} is outside the folders this host allows (${root}, ${cfgDir})` });
  expect(readdirSync(outside)).toEqual(["secret.txt"]);
  // The tokens folder is listed as a root here only to prove it stays closed, and an orchestrator's MCP config
  // (it holds a token) is refused by name anywhere.
  // Anything in the service's own folder is closed, whatever its name.
  writeFileSync(join(cfgDir, "notes.txt"), "plain name\n");
  expect(await errorOf(await hostOpen(join(cfgDir, "notes.txt")))).toEqual({ status: 400, message: `${join(cfgDir, "notes.txt")} belongs to the Fleet Control service; this editor does not change it` });
  expect(await errorOf(await hostOpen(join(cfgDir, "tokens")))).toEqual({ status: 400, message: `${join(cfgDir, "tokens")} belongs to the Fleet Control service; this editor does not change it` });
  expect(await errorOf(await hostOpen(join(root, "fc-orch.mcp.json")))).toEqual({ status: 400, message: `${join(root, "fc-orch.mcp.json")} belongs to the Fleet Control service; this editor does not change it` });
  // Too big, binary and non-UTF-8 files are not opened.
  writeFileSync(join(root, "big.log"), "x".repeat(MAX_FILE_BYTES + 1));
  writeFileSync(join(root, "bin"), new Uint8Array([1, 0, 2]));
  writeFileSync(join(root, "latin1.txt"), new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
  expect((await errorOf(await hostOpen(join(root, "big.log")))).message).toBe(`${join(root, "big.log")} is 33 KiB; this editor opens files up to 32 KiB`);
  expect((await errorOf(await hostOpen(join(root, "bin")))).message).toBe(`${join(root, "bin")} is not a text file (it has NUL bytes)`);
  expect((await errorOf(await hostOpen(join(root, "latin1.txt")))).message).toBe(`${join(root, "latin1.txt")} is not UTF-8 text`);
  // Paths the gateway would pass but the host must refuse.
  expect((await errorOf(await open("relative/x"))).status).toBe(400);
});

test("only an operator; a foreign origin and a non-JSON save are refused; a host without the editor says so", async () => {
  const file = join(root, "work dir", "notes.md");
  for (const t of [viewer, agent]) {
    expect((await direct(t, "/files")).status).toBe(403);
    expect((await direct(t, `/files?path=${encodeURIComponent(file)}`)).status).toBe(403);
    const put = await fetch(`${host.url.origin}/api/files`, { method: "PUT", headers: { authorization: `Bearer ${t}`, origin: host.url.origin, "content-type": "application/json" }, body: JSON.stringify({ path: file, text: "x", revision: fileRevision("one\ntwo\n"), confirm: "notes.md" }) });
    expect(put.status).toBe(403);
  }
  const r = await fetch(`${host.url.origin}/api/files`, { method: "PUT", headers: { authorization: `Bearer ${op}`, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  expect(r.status).toBe(403);
  const plain = await fetch(`${host.url.origin}/api/files`, { method: "PUT", headers: { authorization: `Bearer ${op}`, origin: host.url.origin, "content-type": "text/plain" }, body: JSON.stringify({ path: file }) });
  expect(plain.status).toBe(415);
  expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
  const bare = serve({ fleet: { status: async () => ({ sessions: [], raw: "" }), screen: async () => "" } as never, store: new Store(":memory:") }, 0, { auth });
  try {
    expect(await errorOf(await fetch(`${bare.url.origin}/api/files`, { headers: { authorization: `Bearer ${op}` } }))).toEqual({ status: 503, message: "the file editor is not set up on this host" });
  } finally { bare.stop(true); }
});

test("a change on the host between the check and the rename wins: nothing written, no backup or temp file left", async () => {
  const file = join(root, "work dir", "notes.md");
  const disk = new DiskFiles();
  // A host whose write sees a hand edit land right after the revision check.
  const racing: FilesHost = { ...Object.fromEntries((["real", "stat", "list", "read"] as const).map((k) => [k, disk[k].bind(disk)])) as Omit<FilesHost, "write">,
    write: async (path, expected, text) => { writeFileSync(path, "hand edit\n"); return disk.write(path, expected, text); } };
  const use = filesUseCases({ host: racing, roots: [root], protectedPaths: [] }, { name: "op", role: "operator" });
  let got: Error | null = null;
  try { await use.save({ path: file, text: "page\n", revision: fileRevision("one\ntwo\n"), confirm: "notes.md" }); } catch (e) { got = e as Error; }
  expect(got?.message).toBe(`${file} changed on the host during the save; nothing was written. Reload it and edit again`);
  expect(readFileSync(file, "utf8")).toBe("hand edit\n");
  expect(readdirSync(join(root, "work dir"))).toEqual(["notes.md"]);
});

test("path and folder rules", () => {
  expect(checkPath("/a/b/")).toBe("/a/b");
  for (const bad of ["", "a", "/a//b", "/a/./b", "/a/../b", "/a\nb", "/a\u0001"]) {
    let threw = false;
    try { checkPath(bad); } catch { threw = true; }
    expect([bad, threw]).toEqual([bad, true]);
  }
  expect(fileRootsFromEnv({}, ["/f", "/a/"])).toEqual(["/f", "/a"]);
  expect(fileRootsFromEnv({ FLEET_CONTROL_FILE_ROOTS: "/x:/y" }, ["/f"])).toEqual(["/x", "/y"]);
  for (const bad of ["/", "rel", "/a/../b"]) expect(() => fileRootsFromEnv({ FLEET_CONTROL_FILE_ROOTS: bad }, [])).toThrow();
});

test("review: a symlinked root still browses, and fleet.conf reached through a symlinked or differently cased path stays refused", async () => {
  const fleetDir = join(dir, "fleet");
  mkdirSync(fleetDir);
  writeFileSync(join(fleetDir, "fleet.conf"), "FLEET=t\n");
  writeFileSync(join(fleetDir, "notes.md"), "n\n");
  symlinkSync(fleetDir, join(dir, "fleet-link"));
  const link = join(dir, "fleet-link");
  // As configured: root and FLEET_CONF both written through the symlink, the way /tmp or a linked home shows them.
  const u = filesUseCases({ host: new DiskFiles(), roots: [link], protectedPaths: [join(link, "fleet.conf")] }, { name: "op", role: "operator" });
  const top = await u.open(link) as { path: string };
  expect(top.path).toBe(fleetDir);
  expect(((await u.open(`${top.path}/notes.md`)) as { text: string }).text).toBe("n\n");
  for (const p of [join(link, "fleet.conf"), join(fleetDir, "fleet.conf")]) await expect(u.open(p)).rejects.toThrow("belongs to the Fleet Control service");
  const insensitive = existsSync(join(fleetDir, "FLEET.CONF"));
  if (insensitive) await expect(u.open(join(fleetDir, "FLEET.CONF"))).rejects.toThrow("belongs to the Fleet Control service");
  await expect(u.save({ path: join(fleetDir, "fleet.conf"), text: "PWNED\n", revision: fileRevision("FLEET=t\n"), confirm: "fleet.conf" })).rejects.toThrow("belongs to the Fleet Control service");
  expect(readFileSync(join(fleetDir, "fleet.conf"), "utf8")).toBe("FLEET=t\n");
});

test("review: a file with a byte order mark opens with it and saves with it kept", async () => {
  const file = join(root, "bom.txt");
  writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi\n")]));
  const read = await (await open(file)).json() as { text: string; revision: string };
  expect(read.text).toBe("\ufeffhi\n");
  const r = await page("/files", { path: file, text: "\ufeffho\n", revision: read.revision, confirm: "bom.txt" });
  expect(r.status).toBe(200);
  expect([...readFileSync(file).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(readFileSync(file, "utf8")).toBe("\ufeffho\n");
});

test("review: a hard link is refused, a file that became a symlink is refused at read, and the backup holds the bytes that were read", async () => {
  const hl = join(root, "hl.txt");
  linkSync(join(cfgDir, "tokens"), hl);
  expect(await errorOf(await hostOpen(hl))).toEqual({ status: 400, message: `${hl} has 2 hard links; one of them may be a file this editor must not touch, so it does not open it` });
  // The host side: a file that gained a second link after the checks is refused on the open handle too.
  const files = new DiskFiles();
  await expect(files.read(hl)).rejects.toThrow(`${hl} has 2 hard links`);
  // The host side: a path swapped for a symlink after the checks is not followed.
  const swapped = join(root, "swapped.txt");
  symlinkSync(join(outside, "secret.txt"), swapped);
  await expect(files.read(swapped)).rejects.toThrow("became a symlink after it was checked");
  await expect(files.write(swapped, "nope\n", "x")).rejects.toThrow("became a symlink after it was checked");
  expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("nope\n");
  expect(readdirSync(root).filter((n) => n.startsWith("swapped.txt.bak") || n.startsWith(".swapped"))).toEqual([]);
  // A file that grows past the limit after its size was looked at is still refused.
  const big = join(root, "big.txt");
  writeFileSync(big, "a".repeat(MAX_FILE_BYTES + 5));
  await expect(files.read(big)).rejects.toThrow(`this editor opens files up to ${MAX_FILE_BYTES / 1024} KiB`);
});

test("review 2: names are compared without case, also for protected files that do not exist yet", async () => {
  const fleetDir = join(dir, "fleet2");
  mkdirSync(fleetDir);
  const u = filesUseCases({ host: new DiskFiles(), roots: [fleetDir], protectedPaths: [join(fleetDir, "fleet.conf"), join(fleetDir, "fleet-control-agents.conf")] }, { name: "op", role: "operator" });
  for (const name of ["FLEET.CONF", "Fleet-Control-Agents.conf", "Settings.json", "TOKENS", "Token-mini", "fleet-control-agent\u017f.conf", "to\u212Aen-x", "fleet.conf".normalize("NFD"), "ſettings.json"]) {
    await expect(u.save({ path: join(fleetDir, name), text: "x\n", revision: "new", confirm: name })).rejects.toThrow("belongs to the Fleet Control service");
  }
  expect(readdirSync(fleetDir)).toEqual([]);
});

test("review 2: a file that grows after its size check is refused, a folder swapped before the rename stops the save, and the backup is the bytes read", async () => {
  const file = join(root, "work dir", "notes.md");
  // Grows past the limit between the size check and the read.
  const growing = new DiskFiles({ afterSize: async (p) => { if (p.endsWith("grow.txt")) writeFileSync(p, "a".repeat(MAX_FILE_BYTES + 10)); } });
  writeFileSync(join(root, "grow.txt"), "small\n");
  await expect(growing.read(join(root, "grow.txt"))).rejects.toThrow(`KiB or more; this editor opens files up to ${MAX_FILE_BYTES / 1024} KiB`);
  // The folder is swapped for a symlink to outside just before the rename: nothing lands outside, the file stays.
  const work = join(root, "work dir");
  const swapper = new DiskFiles({ beforeRename: async () => { renameSync(work, join(root, "moved")); symlinkSync(outside, work); } });
  await expect(swapper.write(file, "one\ntwo\n", "evil\n")).rejects.toThrow("changed on the host during the save");
  expect(readdirSync(outside)).toEqual(["secret.txt"]);
  expect(readFileSync(join(root, "moved", "notes.md"), "utf8")).toBe("one\ntwo\n");
  rmSync(work); renameSync(join(root, "moved"), work);
  chmodSync(file, 0o664);
  // The path names other bytes while the backup is written, and the old bytes again afterwards: the backup is what was read.
  const late = new DiskFiles({ beforeBackup: async (p) => { writeFileSync(p, "someone else\n"); }, afterBackup: async (p) => { writeFileSync(p, "one\ntwo\n"); } });
  const backup = await late.write(file, "one\ntwo\n", "three\n");
  expect(readFileSync(backup!, "utf8")).toBe("one\ntwo\n");
  expect(readFileSync(file, "utf8")).toBe("three\n");
  expect(statSync(backup!).mode & 0o777).toBe(0o664);
});

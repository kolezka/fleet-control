import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../src/auth.ts";
import { checkFresh, connect, EnrollFailure, freshPlan, parseArgs, pickService } from "./enroll.ts";
import { addHash } from "./tokens.ts";

const HASH = "b".repeat(64);
const base = ["--principal", "macbook-gateway", "--hash", HASH, "--role", "operator"];
const dir = mkdtempSync(join(tmpdir(), "enroll-script-"));
afterAll(() => { if (dir.startsWith(join(tmpdir(), "enroll-script-"))) rmSync(dir, { recursive: true, force: true }); });

test("arguments are strict: unknown, missing, repeated, a non-operator role or a bad hash are refused", () => {
  expect(parseArgs(base, ["principal", "hash", "role"])).toEqual({ principal: "macbook-gateway", hash: HASH, role: "operator" });
  const bad: [string[], RegExp][] = [
    [[...base, "--port", "1"], /unknown argument --port/],
    [base.slice(0, 4), /--role is required/],
    [["--principal", "a", ...base], /given twice/],
    [["--principal", "macbook-gateway", "--hash", HASH, "--role", "agent"], /role must be operator/],
    [["--principal", "macbook-gateway", "--hash", "B".repeat(64), "--role", "operator"], /hash/],
    [["--principal", "a b", "--hash", HASH, "--role", "operator"], /principal/],
    [["--principal", "--hash", HASH, "--role", "operator"], /needs a value/],
  ];
  for (const [argv, msg] of bad) expect(() => parseArgs(argv, ["principal", "hash", "role"]), argv.join(" ")).toThrow(msg);
});

test("connect picks exactly one running service in this folder, never a guess", () => {
  const s = { label: "pl.raqz.fleet-control", dir: "/srv/fc", tokens: "/t", pid: 42 };
  expect(pickService([s, { ...s, label: "other", dir: "/elsewhere" }], "/srv/fc")).toEqual(s);
  expect(() => pickService([s], "/srv/other")).toThrow(/no running Fleet Control service/);
  expect(() => pickService([s, { ...s, label: "twin" }], "/srv/fc")).toThrow(/several services/);
  expect(() => pickService([{ ...s, tokens: undefined }], "/srv/fc")).toThrow(/no FLEET_CONTROL_TOKENS/);
  expect(() => pickService([{ ...s, pid: undefined }], "/srv/fc")).toThrow(/not running/);
});

test("addHash adds once, refuses a second hash for the same name and keeps the file loadable", async () => {
  const text = "web-mariusz " + "a".repeat(64) + " operator\n";
  const once = addHash(text, "macbook-gateway", HASH, "operator");
  expect(once.changed).toBe(true);
  expect(once.text).toBe(text + `macbook-gateway ${HASH} operator\n`);
  expect(addHash(once.text, "macbook-gateway", HASH, "operator")).toEqual({ text: once.text, changed: false });
  expect(() => addHash(once.text, "macbook-gateway", "c".repeat(64), "operator")).toThrow(/already has a token here/);
  // A hash someone else already has is refused by the same file check the service runs.
  expect(() => addHash(once.text, "other", HASH, "operator")).toThrow();
  const file = join(dir, "tokens");
  writeFileSync(file, once.text);
  expect((await Auth.fromFile(file)).names().sort()).toEqual(["macbook-gateway", "web-mariusz"]);
});

test("connect writes 0600 under the lock and signals the service; a refused change signals nothing", () => {
  const file = join(dir, "tokens-connect");
  writeFileSync(file, "web-mariusz " + "a".repeat(64) + " operator\n", { mode: 0o644 });
  const signalled: number[] = [];
  const a = parseArgs(base, ["principal", "hash", "role"]);
  expect(connect(a, { tokens: file, pid: 7 }, (pid) => signalled.push(pid))).toMatch(/^Added/);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toContain(`macbook-gateway ${HASH} operator`);
  const other = parseArgs(["--principal", "macbook-gateway", "--hash", "c".repeat(64), "--role", "operator"], ["principal", "hash", "role"]);
  expect(() => connect(other, { tokens: file, pid: 7 }, (pid) => signalled.push(pid))).toThrow(/already has a token/);
  expect(signalled).toEqual([7]);
});

const freshArgs = parseArgs([...base, "--port", "4872", "--label", "fc-scratch", "--fleet", "scratch", "--tailnet-name", "local-arch.tail.ts.net", "--tls-cert", "~/tls/cert.pem", "--tls-key", "/abs/key.pem"],
  ["principal", "hash", "role", "port", "label", "fleet", "tailnet-name", "tls-cert", "tls-key"]);
const ctx = { code: "/home/me/fc scratch", bun: "/usr/bin/bun", home: "/home/me", platform: "linux", uid: 1000, tailnetIp: "100.64.0.5" };

test("a fresh Linux plan: own data and config folders, one-line 0600 tokens, empty fleet, systemd user unit", () => {
  const p = freshPlan(freshArgs, ctx);
  expect(p.dirs).toEqual(["/home/me/.local/share/fleet-control/fc-scratch", "/home/me/.config/fleet-control/fc-scratch"]);
  expect(p.unit).toBe("/home/me/.config/systemd/user/fc-scratch.service");
  const file = (path: string) => p.files.find((f) => f.path === path)!;
  expect(file("/home/me/.local/share/fleet-control/fc-scratch/fleet.conf").content).toBe("FLEET=scratch\nFLEET_DIR=/home/me/.local/share/fleet-control/fc-scratch\nAGENTS=()\n");
  expect(file("/home/me/.config/fleet-control/fc-scratch/tokens")).toEqual({ path: "/home/me/.config/fleet-control/fc-scratch/tokens", content: `macbook-gateway ${HASH} operator\n`, mode: 0o600 });
  const unit = file(p.unit).content;
  expect(unit).toContain('WorkingDirectory="/home/me/fc scratch"');
  for (const line of ['"FLEET_CONTROL_HOST=127.0.0.1"', '"PORT=4872"', '"FLEET_CONTROL_TAILNET_HOST=100.64.0.5"', '"FLEET_CONTROL_TAILNET_NAME=local-arch.tail.ts.net"', '"FLEET_CONTROL_TAILNET_TLS_CERT=/home/me/tls/cert.pem"', '"FLEET_CONTROL_TAILNET_TLS_KEY=/abs/key.pem"', '"FLEET_CONTROL_TOKENS=/home/me/.config/fleet-control/fc-scratch/tokens"', '"FLEET_CONTROL_DB=/home/me/.local/share/fleet-control/fc-scratch/state.db"']) {
    expect(unit).toContain(`Environment=${line}`);
  }
  expect(unit).toContain('ExecStart="/usr/bin/bun" index.ts');
  expect(p.commands).toEqual([
    ["env", "FLEET_CONF=/home/me/.local/share/fleet-control/fc-scratch/fleet.conf", "/home/me/fc scratch/vendor/agent-fleet/scripts/fleet", "sync"],
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "fc-scratch.service"],
  ]);
  expect(p.certs).toEqual(["/home/me/tls/cert.pem", "/abs/key.pem"]);
});

test("a fresh macOS plan escapes the plist and bootstraps a LaunchAgent", () => {
  const p = freshPlan(freshArgs, { ...ctx, code: "/Users/me/a&b", home: "/Users/me", platform: "darwin", uid: 501 });
  expect(p.unit).toBe("/Users/me/Library/LaunchAgents/fc-scratch.plist");
  const plist = p.files.find((f) => f.path === p.unit)!.content;
  expect(plist).toContain("<key>WorkingDirectory</key><string>/Users/me/a&amp;b</string>");
  expect(plist).not.toContain("a&b");
  expect(p.commands.at(-1)).toEqual(["launchctl", "bootstrap", "gui/501", "/Users/me/Library/LaunchAgents/fc-scratch.plist"]);
});

test("fresh refuses existing folders or unit and unreadable certificates before writing anything", () => {
  const p = freshPlan(freshArgs, ctx);
  expect(() => checkFresh(p, freshArgs, () => false, () => true)).not.toThrow();
  expect(() => checkFresh(p, freshArgs, (f) => f === p.dirs[0], () => true)).toThrow(/already exists; choose another service name/);
  expect(() => checkFresh(p, freshArgs, (f) => f === p.unit, () => true)).toThrow(/fc-scratch.service already exists/);
  expect(() => checkFresh(p, freshArgs, () => false, (f) => f !== "/abs/key.pem")).toThrow(/cannot read \/abs\/key.pem; make it first, for example: sudo tailscale cert/);
  for (const [k, v] of [["label", "../x"], ["fleet", "a b"], ["port", "0"], ["tailnet-name", "a;b"]]) {
    expect(() => freshPlan({ ...freshArgs, [k!]: v! }, ctx), k).toThrow(EnrollFailure);
  }
  expect(() => freshPlan(freshArgs, { ...ctx, platform: "win32" })).toThrow(/only macOS launchd and Linux/);
});

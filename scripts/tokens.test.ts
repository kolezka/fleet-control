import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, parseTokens, tokenLine } from "../src/auth.ts";
import { change, withLock } from "./tokens.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const run = (args: string[]) => Bun.spawnSync(["bun", "scripts/tokens.ts", ...args], { stdout: "pipe", stderr: "pipe" });
const base = `# host tokens\n${tokenLine("web", "old-web")}\n${tokenLine("mac", "old-mac")}\n`;

test("rotate replaces one hash, keeps the rest and comments, and only the new token works", () => {
  const r = change("rotate", "web", base, "new-web");
  expect(r.text.split("\n")[0]).toBe("# host tokens");
  const auth = new Auth(parseTokens(r.text));
  expect(auth.check("new-web")?.name).toBe("web");
  expect(auth.check("old-web")).toBeNull();
  expect(auth.check("old-mac")?.name).toBe("mac");
});

test("revoke removes the principal; add refuses an existing one; unknown names are refused", () => {
  expect(new Auth(parseTokens(change("revoke", "mac", base).text)).check("old-mac")).toBeNull();
  expect(() => change("add", "web", base)).toThrow("use rotate");
  expect(() => change("rotate", "nobody", base)).toThrow("no principal");
  expect(() => change("revoke", "nobody", base)).toThrow("no principal");
  expect(() => change("add", "bad name", base)).toThrow();
});

test("revoking the last principal is refused, since the service would not start", () => {
  const one = `${tokenLine("only", "t")}\n`;
  expect(() => change("revoke", "only", one)).toThrow("no principals");
});

test("the command line rotates a file atomically with mode 0600 and prints the token once", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokens-")); dirs.push(dir);
  const file = join(dir, "tokens");
  writeFileSync(file, base, { mode: 0o644 });
  const out = run(["rotate", "web", file]);
  expect(out.exitCode).toBe(0);
  const token = out.stdout.toString().trim();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(out.stderr.toString()).not.toContain(token);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(new Auth(parseTokens(readFileSync(file, "utf8"))).check(token)?.name).toBe("web");
  expect(readdirSync(dir)).toEqual(["tokens"]);
  expect(run(["list", file]).stdout.toString()).toBe("web\nmac\n");
});

test("a refused change leaves the file untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokens-")); dirs.push(dir);
  const file = join(dir, "tokens");
  writeFileSync(file, base, { mode: 0o600 });
  const out = run(["rotate", "nobody", file]);
  expect(out.exitCode).toBe(1);
  expect(out.stdout.toString()).toBe("");
  expect(readFileSync(file, "utf8")).toBe(base);
  expect(run(["revoke", "web", join(dir, "missing")]).exitCode).toBe(1);
  expect(readdirSync(dir)).toEqual(["tokens"]);
});

test("concurrent changes all land, and every printed token works", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tokens-")); dirs.push(dir);
  const file = join(dir, "tokens");
  expect(run(["add", "seed", file]).exitCode).toBe(0);
  const runs = Array.from({ length: 12 }, (_, i) => Bun.spawn(["bun", "scripts/tokens.ts", "add", `p${i}`, file], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(runs.map(async (p) => ({ code: await p.exited, token: (await new Response(p.stdout).text()).trim() })));
  expect(results.map((r) => r.code)).toEqual(Array(12).fill(0));
  const auth = new Auth(parseTokens(readFileSync(file, "utf8")));
  expect(auth.names()).toHaveLength(13);
  for (const r of results) expect(auth.check(r.token)).not.toBeNull();
  expect(readdirSync(dir)).toEqual(["tokens"]);
});

test("a held lock refuses after the wait and leaves the file and lock alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokens-")); dirs.push(dir);
  const file = join(dir, "tokens");
  writeFileSync(file, base, { mode: 0o600 });
  writeFileSync(`${file}.lock`, "");
  expect(() => withLock(file, () => 1, 100)).toThrow("remove that file");
  expect(readFileSync(file, "utf8")).toBe(base);
  expect(readdirSync(dir).sort()).toEqual(["tokens", "tokens.lock"]);
  rmSync(`${file}.lock`);
  expect(withLock(file, () => 2, 100)).toBe(2);
  expect(readdirSync(dir)).toEqual(["tokens"]);
});

test("the refusal says whether the process that holds the lock still runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokens-")); dirs.push(dir);
  const file = join(dir, "tokens");
  writeFileSync(file, base, { mode: 0o600 });
  // The lock names its writer while a change runs.
  expect(withLock(file, () => readFileSync(`${file}.lock`, "utf8"), 100)).toBe(`${process.pid}\n`);
  writeFileSync(`${file}.lock`, `${process.pid}\n`);
  expect(() => withLock(file, () => 1, 100)).toThrow(`process ${process.pid} holds it; wait for it to finish`);
  const gone = Bun.spawnSync(["/bin/sh", "-c", "echo $$"]).stdout.toString().trim();
  writeFileSync(`${file}.lock`, `${gone}\n`);
  expect(() => withLock(file, () => 1, 100)).toThrow(`its process ${gone} is not running; remove that file and retry`);
  // Never removed by the tool, even when stale.
  expect(readdirSync(dir).sort()).toEqual(["tokens", "tokens.lock"]);
  expect(readFileSync(file, "utf8")).toBe(base);
});

test("add creates a new file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokens-")); dirs.push(dir);
  const file = join(dir, "tokens");
  const out = run(["add", "first", file]);
  expect(out.exitCode).toBe(0);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(run(["list", file]).stdout.toString()).toBe("first\n");
});

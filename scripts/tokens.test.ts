import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, parseTokens, tokenLine } from "../src/auth.ts";
import { change } from "./tokens.ts";

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

test("add creates a new file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokens-")); dirs.push(dir);
  const file = join(dir, "tokens");
  const out = run(["add", "first", file]);
  expect(out.exitCode).toBe(0);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(run(["list", file]).stdout.toString()).toBe("first\n");
});

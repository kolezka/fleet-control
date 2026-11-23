// The release package from a real clean checkout: code at one commit with the pinned agent-fleet files and
// production node_modules, its checksum beside it, and refused on a dirty tree or a submodule off its pin.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageName, packageRelease } from "./package-release.ts";

const repo = join(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "package-release-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// A clean clone of this checkout's HEAD, with the submodule taken from the local copy.
const checkout = join(tmp, "checkout");
git(tmp, "clone", "--quiet", "--no-hardlinks", repo, checkout);
git(checkout, "-c", "protocol.file.allow=always", "submodule", "--quiet", "update", "--init", "--reference", join(repo, "vendor/agent-fleet"));

test("the package holds the commit's code, the pinned agent-fleet, production node_modules and a manifest; the checksum matches", () => {
  const out = join(tmp, "out");
  const r = packageRelease(checkout, out, new Date("2026-11-23T12:00:00Z"), "v9");
  const commit = git(checkout, "rev-parse", "HEAD");
  expect(r.file).toBe(join(out, packageName(commit)));
  expect(readFileSync(`${r.file}.sha256`, "utf8")).toBe(`${r.sha256}  ${packageName(commit)}\n`);
  expect(new Bun.CryptoHasher("sha256").update(readFileSync(r.file)).digest("hex")).toBe(r.sha256);
  const x = join(tmp, "x");
  spawnSync("mkdir", ["-p", x]);
  expect(spawnSync("tar", ["-xzf", r.file, "-C", x]).status).toBe(0);
  const root = join(x, "fleet-control");
  const manifest = JSON.parse(readFileSync(join(root, "MANIFEST.json"), "utf8"));
  expect(manifest).toMatchObject({ name: "fleet-control", commit, tag: "v9", builtAt: "2026-11-23T12:00:00.000Z" });
  expect(manifest.agentFleet).toBe(git(join(checkout, "vendor/agent-fleet"), "rev-parse", "HEAD"));
  for (const f of ["index.ts", "scripts/updater.ts", "vendor/agent-fleet/scripts/fleet", "vendor/agent-fleet/scripts/watchdog.sh", "node_modules/hono/package.json", "RELEASE"]) expect(existsSync(join(root, f))).toBe(true);
  // Not needed on a host: docs, design history, dev-only types.
  for (const f of ["docs", ".design", "node_modules/@types/bun"]) expect(existsSync(join(root, f))).toBe(false);
}, 120_000);

test("a checkout with uncommitted changes, or a submodule off its pin, is not packaged", () => {
  writeFileSync(join(checkout, "index.ts"), "// changed\n");
  expect(() => packageRelease(checkout, join(tmp, "out2"))).toThrow("the checkout has uncommitted changes; package a clean commit");
  git(checkout, "checkout", "--quiet", "index.ts");
  const sub = join(checkout, "vendor/agent-fleet");
  git(sub, "checkout", "--quiet", "HEAD~1");
  // A moved submodule shows as a change in the parent too; either way it is refused.
  expect(() => packageRelease(checkout, join(tmp, "out3"))).toThrow(/uncommitted changes|run git submodule update/);
}, 60_000);

// Builds the release package a host installs: the code at one commit, the pinned agent-fleet files,
// production node_modules and a manifest. CI runs this; so can a person on a checkout.
// Usage: bun scripts/package-release.ts <checkout> <out dir> [tag]
// Writes <out>/fleet-control-<commit>.tar.gz and <out>/fleet-control-<commit>.tar.gz.sha256.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Manifest = { name: "fleet-control"; commit: string; tag: string | null; agentFleet: string; bun: string; builtAt: string };
// Not needed to run a host service, and large (screenshots).
export const LEFT_OUT = ["docs", ".design"];

const sh = (cmd: string, args: string[], cwd?: string, input?: Buffer) => {
  const r = spawnSync(cmd, args, { cwd, input, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr ?? "").toString().trim()}`);
  return r.stdout as Buffer;
};

export function packageName(commit: string) { return `fleet-control-${commit}.tar.gz`; }

export function packageRelease(checkout: string, out: string, now = new Date(), tag: string | null = null): { file: string; sha256: string; manifest: Manifest } {
  if (sh("git", ["status", "--porcelain", "--untracked-files=no"], checkout).length) throw new Error("the checkout has uncommitted changes; package a clean commit");
  const commit = sh("git", ["rev-parse", "HEAD"], checkout).toString().trim();
  const pin = /^160000 commit ([0-9a-f]{40})\tvendor\/agent-fleet$/m.exec(sh("git", ["ls-tree", "HEAD", "vendor/agent-fleet"], checkout).toString())?.[1];
  if (!pin) throw new Error("vendor/agent-fleet is not a submodule at HEAD");
  const sub = join(checkout, "vendor/agent-fleet");
  const at = sh("git", ["rev-parse", "HEAD"], sub).toString().trim();
  if (at !== pin) throw new Error(`vendor/agent-fleet is at ${at}, but HEAD pins ${pin}; run git submodule update`);
  const stage = mkdtempSync(join(tmpdir(), "fc-package-"));
  try {
    const root = join(stage, "fleet-control");
    mkdirSync(join(root, "vendor/agent-fleet"), { recursive: true });
    sh("tar", ["-x", "-C", root], undefined, sh("git", ["archive", "HEAD", ...LEFT_OUT.map((p) => `:(exclude)${p}`)], checkout));
    sh("tar", ["-x", "-C", join(root, "vendor/agent-fleet")], undefined, sh("git", ["archive", pin], sub));
    sh(process.execPath, ["install", "--frozen-lockfile", "--production", "--omit=peer", "--ignore-scripts", "--silent"], root);
    const manifest: Manifest = { name: "fleet-control", commit, tag, agentFleet: pin, bun: Bun.version, builtAt: now.toISOString() };
    writeFileSync(join(root, "RELEASE"), `${commit.slice(0, 7)}\n`);
    writeFileSync(join(root, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    mkdirSync(out, { recursive: true });
    const file = join(out, packageName(commit));
    // No macOS extended attributes in the archive, so Linux tar extracts it quietly.
    const r = spawnSync("tar", ["-czf", file, "-C", stage, "fleet-control"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    if (r.status !== 0) throw new Error(`tar failed: ${r.stderr.toString().trim()}`);
    const sha256 = new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
    writeFileSync(`${file}.sha256`, `${sha256}  ${packageName(commit)}\n`);
    return { file, sha256, manifest };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [checkout, out, tag] = process.argv.slice(2);
  if (!checkout || !out) { console.error("usage: bun scripts/package-release.ts <checkout> <out dir>"); process.exit(2); }
  try {
    const r = packageRelease(checkout, out, new Date(), tag ?? null);
    console.log(`${r.file}\nsha256 ${r.sha256}\ncommit ${r.manifest.commit} agent-fleet ${r.manifest.agentFleet}`);
  } catch (e) {
    console.error(`failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

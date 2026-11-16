import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, newToken, tokenLine } from "./auth.ts";
import { reloadTokens } from "./config.ts";

function tokensFile(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "fc-tokens-"));
  const path = join(dir, "tokens");
  writeFileSync(path, lines.join("\n") + "\n");
  chmodSync(path, 0o600);
  return { dir, path };
}

test("reload adds, rotates and revokes tokens without a restart", async () => {
  const alice = newToken(), bob = newToken(), alice2 = newToken();
  const f = tokensFile([tokenLine("alice", alice), tokenLine("bob", bob)]);
  try {
    const auth = await Auth.fromFile(f.path);
    expect(auth.check(bob)?.name).toBe("bob");
    writeFileSync(f.path, tokenLine("alice", alice2) + "\n");
    const log: string[] = [];
    expect(await reloadTokens(auth, f.path, l => log.push(l))).toBe(true);
    expect(auth.check(bob)).toBeNull();
    expect(auth.check(alice)).toBeNull();
    expect(auth.check(alice2)?.name).toBe("alice");
    expect(log).toEqual(["tokens reloaded: 1 principal(s)"]);
  } finally { rmSync(f.dir, { recursive: true }); }
});

for (const [label, content] of [["an empty file", ""], ["a malformed line", "alice not-a-hash\n"], ["a missing file", null]] as const) {
  test(`reload of ${label} keeps the previous tokens`, async () => {
    const alice = newToken();
    const f = tokensFile([tokenLine("alice", alice)]);
    try {
      const auth = await Auth.fromFile(f.path);
      if (content === null) rmSync(f.path); else writeFileSync(f.path, content);
      const log: string[] = [];
      expect(await reloadTokens(auth, f.path, l => log.push(l))).toBe(false);
      expect(auth.check(alice)?.name).toBe("alice");
      expect(log[0]).toStartWith("tokens reload refused, previous tokens kept:");
      expect(log.join(" ")).not.toContain(f.dir);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}

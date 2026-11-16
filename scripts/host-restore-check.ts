// Proves a host backup can be served: opens a scratch copy with the service's own stores and reads
// every list the service exposes. The backup file itself is never opened for writing, and nothing
// is restored over a live database.
// Usage: bun scripts/host-restore-check.ts <backup file> [expected sha256]
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Commands } from "../src/data/commands.ts";
import { Requests } from "../src/data/requests.ts";
import { Store } from "../src/data/store.ts";
import { tableDigests } from "./host-backup.ts";

export function restoreCheck(backupPath: string, expectedSha256?: string) {
  const sha256 = new Bun.CryptoHasher("sha256").update(readFileSync(backupPath)).digest("hex");
  if (expectedSha256 !== undefined && sha256 !== expectedSha256.toLowerCase()) {
    throw new Error(`checksum ${sha256} differs from the expected ${expectedSha256}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "host-restore-check-"));
  try {
    const scratch = join(dir, "state.db");
    copyFileSync(backupPath, scratch);
    const before = new Database(scratch, { readonly: true, strict: true });
    let expected: ReturnType<typeof tableDigests>;
    try {
      const check = before.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
      if (check.length !== 1 || check[0]!.integrity_check !== "ok") throw new Error("backup failed integrity_check");
      expected = tableDigests(before);
    } finally { before.close(); }

    // The same constructors the service runs at start; they create missing tables but must not change rows.
    const store = new Store(scratch);
    try {
      const commands = new Commands(store.db);
      const requests = new Requests(store.db);
      const counts = { sessions: store.sessions().length, commands: 0, runs: 0, requests: 0 };
      for (let cursor: string | undefined, page; (page = commands.listPage({ limit: 1000, cursor })); cursor = page.nextCursor) {
        counts.commands += page.commands.length;
        for (const c of page.commands) commands.events(c.id);
        if (!page.nextCursor) break;
      }
      for (let cursor: string | undefined, page; (page = requests.listRuns({ limit: 1000, cursor })); cursor = page.nextCursor) {
        counts.runs += page.runs.length;
        if (!page.nextCursor) break;
      }
      for (let cursor: string | undefined, page; (page = requests.listPage({ limit: 1000, cursor })); cursor = page.nextCursor) {
        counts.requests += page.requests.length;
        if (!page.nextCursor) break;
      }
      requests.events(0);
      const after = tableDigests(store.db);
      for (const [name, digest] of Object.entries(expected)) {
        if (JSON.stringify(after[name]) !== JSON.stringify(digest)) throw new Error(`table ${name} changed when the service stores opened it`);
      }
      const added = Object.keys(after).filter((name) => !(name in expected));
      return { sha256, counts, addedTables: added };
    } finally { store.db.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [backupPath, sha, ...extra] = process.argv.slice(2);
  if (!backupPath || extra.length) {
    console.error("usage: bun scripts/host-restore-check.ts <backup file> [expected sha256]");
    process.exit(2);
  }
  try {
    const r = restoreCheck(backupPath, sha);
    const { sessions, commands, runs, requests } = r.counts;
    console.log(`restore check ok: sha256 ${r.sha256}; read ${sessions} sessions, ${commands} commands with events, ${runs} runs, ${requests} requests`);
    if (r.addedTables.length) console.log(`the service would add tables: ${r.addedTables.join(", ")}`);
  } catch (e) {
    console.error(`restore check failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

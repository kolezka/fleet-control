// Copies the host service's SQLite state to a new private file and checks the copy row by row.
// Usage: bun scripts/host-backup.ts <state.db> <new backup file>
import { Database } from "bun:sqlite";
import { closeSync, constants, fsyncSync, openSync, writeSync } from "node:fs";

// Every table's rows in rowid order, hashed, so two databases compare by content and not by count.
export function tableDigests(db: Database): Record<string, { rows: number; sha256: string }> {
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const out: Record<string, { rows: number; sha256: string }> = {};
  for (const { name } of tables) {
    const hash = new Bun.CryptoHasher("sha256");
    let rows = 0;
    for (const row of db.query<unknown[], []>(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).values()) {
      hash.update(JSON.stringify(row, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("base64") : typeof v === "bigint" ? v.toString() : v)));
      hash.update("\n");
      rows++;
    }
    out[name] = { rows, sha256: hash.digest("hex") };
  }
  return out;
}

export function backup(source: string, target: string): { tables: number; rows: number; bytes: number; sha256: string } {
  // Not readonly: a WAL database opened readonly fails when its -shm file is missing (service stopped).
  // readwrite without create still refuses a missing path, and only reads are issued.
  const live = new Database(source, { readwrite: true, strict: true });
  // serialize() reads one consistent snapshot even while the service writes.
  let bytes: Uint8Array;
  try { bytes = live.serialize(); } finally { live.close(); }
  if (bytes.length < 100) throw new Error("source has no tables; is this the state database?");
  // The service uses WAL. A copy has no -wal file, so mark it as a plain rollback-journal database (header bytes 18 and 19).
  bytes[18] = 1;
  bytes[19] = 1;
  const snapshot = Database.deserialize(bytes);
  const expected = tableDigests(snapshot);
  snapshot.close();
  if (Object.keys(expected).length === 0) throw new Error("source has no tables; is this the state database?");

  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }

  const copy = new Database(target, { readonly: true, strict: true });
  try {
    const check = copy.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    if (check.length !== 1 || check[0]!.integrity_check !== "ok") throw new Error("backup failed integrity_check; the file is kept for inspection");
    const actual = tableDigests(copy);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("backup contents differ from the snapshot; the file is kept for inspection");
    const tables = Object.keys(actual).length;
    const rows = Object.values(actual).reduce((n, t) => n + t.rows, 0);
    return { tables, rows, bytes: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
  } finally { copy.close(); }
}

if (import.meta.main) {
  const [source, target, ...extra] = process.argv.slice(2);
  if (!source || !target || extra.length) {
    console.error("usage: bun scripts/host-backup.ts <state.db> <new backup file>");
    process.exit(2);
  }
  try {
    const r = backup(source, target);
    console.log(`backup ok: ${r.tables} tables, ${r.rows} rows equal to the snapshot, ${r.bytes} bytes, sha256 ${r.sha256}`);
    console.log("One copy on one machine is not a backup: copy it elsewhere and compare the checksum.");
  } catch (e) {
    console.error(`backup failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

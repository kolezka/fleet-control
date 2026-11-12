import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DeliveryJournal } from "./journal.ts";

// Cross-process executor lease. An open EXCLUSIVE transaction on a separate SQLite file
// holds an OS file lock; the OS drops it when the holder exits, even after a crash.
// The lease is cooperative: a writer that opens the journal without it is not stopped.
export class ExecutorLease {
  private constructor(private db: Database | undefined) {}

  static acquire(lockPath: string): ExecutorLease {
    if (typeof lockPath !== "string" || !lockPath.trim()) throw new Error("executor lock path is required");
    let db: Database;
    try {
      db = new Database(lockPath);
    } catch (error) {
      throw new Error(`cannot open executor lock ${lockPath}`, { cause: error });
    }
    try {
      db.run("PRAGMA busy_timeout = 0");
      db.run("PRAGMA journal_mode = DELETE");
      db.run("BEGIN EXCLUSIVE");
    } catch (error) {
      db.close();
      const code = (error as { code?: unknown }).code;
      if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
        throw new Error("another executor holds the delivery journal lease", { cause: error });
      }
      throw new Error(`cannot open executor lock ${lockPath}`, { cause: error });
    }
    return new ExecutorLease(db);
  }

  get held(): boolean {
    return this.db !== undefined;
  }

  release(): void {
    const db = this.db;
    this.db = undefined;
    if (!db) return;
    try {
      db.run("ROLLBACK");
    } finally {
      db.close();
    }
  }
}

export type ExclusiveJournal = { journal: DeliveryJournal; reconciled: number; close(): void };

// Symlinks and relative spellings resolve to one lock file. Hard links do not.
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return join(realpathSync(dirname(path)), basename(path));
  }
}

// Takes the lease before reconciling, so restart reconciliation cannot mark another
// live executor's started attempts as unknown. The journal holds the lease and refuses
// writes once it is released.
export function openExclusiveJournal(journalPath: string): ExclusiveJournal {
  const path = canonical(journalPath);
  const lease = ExecutorLease.acquire(`${path}.executor-lock`);
  let db: Database | undefined;
  try {
    db = new Database(path);
    const journal = new DeliveryJournal(db, lease);
    const reconciled = journal.reconcileAfterRestart();
    const opened = db;
    return {
      journal,
      reconciled,
      close() {
        try {
          lease.release();
        } finally {
          opened.close();
        }
      },
    };
  } catch (error) {
    db?.close();
    lease.release();
    throw error;
  }
}

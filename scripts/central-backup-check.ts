import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { spawn } from "node:child_process";

// Read-only structural check of a pg_dump custom-format archive. It never connects to a
// database and never restores. Passing it does not prove the archive restores or matches its source.
export async function checkArchive(path: string, timeoutMs = 60_000): Promise<{ sha256: string; bytes: number; tocEntries: number; dbname: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size === 0) throw new Error("archive must be a non-empty regular file");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("PG")));
    const child = spawn("pg_restore", ["--list"], { env, stdio: ["pipe", "pipe", "ignore"] });
    const outputLimit = 16 * 1024 * 1024;
    let out = "", overflow = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { if (out.length + chunk.length > outputLimit) { overflow = true; child.kill(); } else out += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    exited.catch(() => {});
    const timer = setTimeout(() => child.kill(), timeoutMs);
    // One pass over exactly the stat size feeds both the hash and pg_restore, so they see the same bytes.
    let stdinOpen = true;
    child.stdin.on("error", () => { stdinOpen = false; });
    // A spawn failure never drains stdin, so stop feeding it.
    child.once("error", () => { stdinOpen = false; child.stdin.emit("close"); });
    const hash = createHash("sha256");
    try {
      const buffer = new Uint8Array(1024 * 1024);
      let offset = 0;
      while (offset < before.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
        if (!bytesRead) throw new Error("archive changed while reading");
        const chunk = buffer.slice(0, bytesRead);
        hash.update(chunk);
        offset += bytesRead;
        if (stdinOpen && !child.stdin.write(chunk) && stdinOpen) {
          await new Promise<void>((resolve) => { const done = () => { child.stdin.off("drain", done); child.stdin.off("close", done); resolve(); }; child.stdin.on("drain", done); child.stdin.on("close", done); });
        }
      }
      child.stdin.end();
      const code = await exited;
      // Checked after pg_restore exits so a writer still running during the listing is caught.
      const after = await file.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("archive changed while reading");
      if (code !== 0 || overflow) throw new Error("pg_restore could not read the archive");
    } catch (error) {
      child.stdin.destroy();
      child.kill();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const header = (name: string) => out.match(new RegExp(`^;\\s+${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
    const tocEntries = Number(header("TOC Entries"));
    const dbname = header("dbname");
    if (header("Format") !== "CUSTOM" || !Number.isInteger(tocEntries) || tocEntries < 1 || !dbname) throw new Error("archive listing is not a custom-format pg_dump table of contents");
    return { sha256: hash.digest("hex"), bytes: before.size, tocEntries, dbname };
  } finally {
    await file.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("Usage: bun scripts/central-backup-check.ts <archive>");
    process.exitCode = 2;
  } else {
    checkArchive(args[0]!).then((result) => console.log(JSON.stringify(result)), () => {
      console.error("Archive check failed. The file is missing, not a regular file, or not a readable custom-format pg_dump archive.");
      process.exitCode = 1;
    });
  }
}
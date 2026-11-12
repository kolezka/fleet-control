import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { spawn } from "node:child_process";

// Read-only structural check of a pg_dump custom-format archive. It never connects to a
// database and never restores. Passing it does not prove the archive restores or matches its source.
export async function checkArchive(path: string): Promise<{ sha256: string; bytes: number; tocEntries: number; dbname: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0) throw new Error("archive must be a non-empty regular file");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("PG")));
    const listing = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = spawn("pg_restore", ["--list"], { env, stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, out }));
      // Feed the already-open descriptor so a swapped path cannot change what is listed.
      file.createReadStream({ start: 0, autoClose: false }).on("error", reject).pipe(child.stdin).on("error", () => {});
    });
    if (listing.code !== 0) throw new Error("pg_restore could not read the archive");
    const header = (name: string) => listing.out.match(new RegExp(`^;\\s+${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
    const tocEntries = Number(header("TOC Entries"));
    const dbname = header("dbname");
    if (header("Format") !== "CUSTOM" || !Number.isInteger(tocEntries) || tocEntries < 1 || !dbname) throw new Error("archive listing is not a custom-format pg_dump table of contents");
    return { sha256: hash.digest("hex"), bytes: stat.size, tocEntries, dbname };
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

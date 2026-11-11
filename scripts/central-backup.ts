import { open } from "node:fs/promises";
import { spawn } from "node:child_process";

async function main(): Promise<void> {
  const [output, ...extra] = process.argv.slice(2);
  const target = process.env.CENTRAL_BACKUP_URL;
  if (!target || !output || extra.length) {
    throw new Error("Set CENTRAL_BACKUP_URL and provide one new backup file path");
  }

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error("Target must be an explicit PostgreSQL URL with host and database");
  }
  if (!(["postgres:", "postgresql:"].includes(url.protocol)) || !url.hostname ||
      !url.pathname || url.pathname === "/" || url.search || url.hash) {
    throw new Error("Target must be an explicit PostgreSQL URL with host and database, without query parameters");
  }

  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(database)) {
    throw new Error("Database name must be explicit and contain only letters, digits, underscores or hyphens");
  }

  const file = await open(output, "wx", 0o600);
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("PG") && key !== "CENTRAL_BACKUP_URL"));
    env.PGSSLMODE = "verify-full";
    env.PGHOST = url.hostname;
    env.PGPORT = url.port || "5432";
    env.PGDATABASE = database;
    if (url.username) env.PGUSER = decodeURIComponent(url.username);
    if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("pg_dump", ["--format=custom", "--no-password"], {
        env,
        stdio: ["ignore", file.fd, "ignore"],
      });
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0) throw new Error("pg_dump failed; the incomplete output file was retained");
  } finally {
    await file.close();
  }
}

if (import.meta.main) {
  main().catch(() => {
    console.error("Backup failed. Check the target, output path and pg_dump availability. An incomplete output file may remain.");
    process.exitCode = 1;
  });
}

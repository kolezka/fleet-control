import { SQL } from "bun";
import { SupervisorIdentityRegistry, type SupervisorIdentity } from "./data/identity-registry";

type Registry = Pick<SupervisorIdentityRegistry, "initialize" | "enroll" | "retire">;
type Dependencies = {
  open: (databaseUrl: string) => { registry: Registry; close: () => Promise<void> };
  stdout: (message: string) => void;
  stderr: (message: string) => void;
};

const usage = "Usage: identity-cli enroll|retire --principal-id ID --name NAME --host-id HOST --session SESSION (requires DATABASE_URL)";

function parse(args: string[]): { action: "enroll" | "retire"; identity: SupervisorIdentity } | null {
  const [action, ...rest] = args;
  if ((action !== "enroll" && action !== "retire") || rest.length !== 8) return null;
  const fields: Record<string, string> = {};
  const allowed = new Set(["--principal-id", "--name", "--host-id", "--session"]);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!;
    const value = rest[i + 1]!;
    if (!allowed.has(key) || Object.hasOwn(fields, key) || !value || value.startsWith("--") ||
        value.length > 256 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) return null;
    fields[key] = value;
  }
  return { action, identity: { principalId: fields["--principal-id"]!, name: fields["--name"]!, hostId: fields["--host-id"]!, session: fields["--session"]! } };
}

export async function runIdentityCli(args: string[], env: { DATABASE_URL?: string }, deps: Dependencies): Promise<number> {
  const input = parse(args);
  if (!input || !env.DATABASE_URL?.trim()) {
    deps.stderr(usage);
    return 1;
  }
  let connection: ReturnType<Dependencies["open"]> | undefined;
  let failed = false;
  try {
    connection = deps.open(env.DATABASE_URL);
    await connection.registry.initialize();
    await connection.registry[input.action](input.identity);
  } catch {
    failed = true;
  } finally {
    if (connection) {
      try { await connection.close(); } catch { failed = true; }
    }
  }
  if (failed) {
    deps.stderr("Identity operation failed. Check the database and binding.");
    return 1;
  }
  deps.stdout(`Supervisor identity ${input.action === "enroll" ? "enrolled" : "retired"}.`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runIdentityCli(process.argv.slice(2), { DATABASE_URL: process.env.DATABASE_URL }, {
    open(databaseUrl) {
      const db = new SQL(databaseUrl);
      return { registry: new SupervisorIdentityRegistry(db), close: () => db.close() };
    },
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  });
}

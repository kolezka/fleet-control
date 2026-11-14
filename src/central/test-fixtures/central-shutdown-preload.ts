// Test-only preload for central shutdown tests. Run it only in a spawned child process.
// It replaces the database-touching modules of src/central/data with offline fakes and swaps the
// SQL client imported by cooperative-main.ts for a fake that never opens a connection.
// Events go to stderr as "[fake] <event>" lines so the parent can check their order.
import { plugin } from "bun";
import { join } from "node:path";

const central = join(import.meta.dir, "..");
const delay = Number(process.env.FAKE_TX_MS ?? "400");
if (!Number.isSafeInteger(delay) || delay < 0) throw new Error("invalid FAKE_TX_MS");
const log = (event: string) => { process.stderr.write(`[fake] ${event}\n`); };
(globalThis as { __centralFakeLog?: typeof log }).__centralFakeLog = log;

const fakeLog = "(globalThis.__centralFakeLog)";
const fakes: Record<string, string> = {
  "data/cooperative-provision.ts": `export async function provisionCooperative() { ${fakeLog}("provision"); }`,
  "data/schema-guard.ts": "export async function withCooperativeSchema(_db, _schema, operation) { return operation({}); }",
  "data/identity-registry.ts": "export const validId = () => true; export const validIdentity = () => true; export class SupervisorIdentityRegistry { async enroll() {} async matches() { return true; } }",
  "data/incarnations.ts": "export class SupervisorIncarnations { async activate() { return { incarnationId: crypto.randomUUID(), token: 'x'.repeat(43) }; } }",
  "data/commands.ts": `export class CentralCommands {
    constructor(_db, _clock, runner) { this.runner = runner; }
    async submitBounded(input) { return this.runner(async () => { ${fakeLog}("tx begin " + input.idempotencyKey); await Bun.sleep(${delay}); ${fakeLog}("tx commit " + input.idempotencyKey); return { created: true, command: { id: "c-" + input.idempotencyKey, ...input } }; }); }
    async getBounded() { return null; }
    async listBounded() { return { commands: [], nextCursor: null }; }
  }`,
};
const realImport = 'import { SQL } from "bun";';
const fakeSql = `class SQL { constructor(url) { this.kind = String(url).includes("cooperative_runtime_") ? "runtime" : "admin"; ${fakeLog}("sql open " + this.kind); } async close() { ${fakeLog}("sql close " + this.kind); } }`;

plugin({ name: "central-shutdown-fakes", setup(build) {
  // Bun's onLoad must return contents, so the filter matches only the replaced files.
  build.onLoad({ filter: /\/src\/central\/(cooperative-main|data\/(cooperative-provision|schema-guard|identity-registry|incarnations|commands))\.ts$/ }, async ({ path }) => {
    const name = path.slice(central.length + 1);
    if (!path.startsWith(central + "/")) return { contents: await Bun.file(path).text(), loader: "ts" };
    if (name === "cooperative-main.ts") {
      const source = await Bun.file(path).text();
      // Fail loudly instead of silently running with the real SQL client.
      if (!source.includes(realImport)) throw new Error("fake SQL could not replace the SQL import");
      return { contents: source.replace(realImport, fakeSql), loader: "ts" };
    }
    const fake = fakes[name];
    if (fake === undefined) throw new Error(`no fake for ${name}`);
    return { contents: fake, loader: "ts" };
  });
} });

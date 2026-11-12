// Test-only preload for the legacy central signal test. Run it only in a spawned child process.
// It swaps the SQL client imported by src/central/main.ts for an offline fake that never connects.
// Events go to stderr as "[fake] <event>" lines so the parent can check their order.
import { plugin } from "bun";
import { join } from "node:path";
import { createLegacyFakeSql } from "./legacy-fake-sql.ts";

const mainPath = join(import.meta.dir, "..", "main.ts");
const delay = Number(process.env.FAKE_TX_MS ?? "400");
if (!Number.isSafeInteger(delay) || delay < 0) throw new Error("invalid FAKE_TX_MS");
const log = (event: string) => { process.stderr.write(`[fake] ${event}\n`); };
(globalThis as { __legacyFakeSql?: () => unknown }).__legacyFakeSql = () => createLegacyFakeSql(log, delay);

const realImport = 'import { SQL } from "bun";';
plugin({ name: "legacy-central-shutdown-fakes", setup(build) {
  // Bun's onLoad must return contents, so the filter matches only main.ts.
  build.onLoad({ filter: /\/src\/central\/main\.ts$/ }, async ({ path }) => {
    const source = await Bun.file(path).text();
    if (path !== mainPath) return { contents: source, loader: "ts" };
    // Fail loudly instead of silently running with the real SQL client.
    if (!source.includes(realImport)) throw new Error("fake SQL could not replace the SQL import");
    return { contents: source.replace(realImport, "const SQL = function () { return globalThis.__legacyFakeSql(); };"), loader: "ts" };
  });
} });

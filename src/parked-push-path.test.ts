// The push delivery path is parked by owner decision (2026-11-15): central does not push text into terminals.
// These modules stay as tested building blocks. This test fails if a runtime starts using them,
// so that step is taken on purpose, with the owner's authorization, and not by an import.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const parked = [
  "src/host-agent/client.ts",
  "src/host-agent/application/executor.ts",
  "src/host-agent/data/journal.ts",
  "src/host-agent/data/outbox.ts",
  "src/host-agent/data/executor-lease.ts",
  "src/central/data/attempts.ts",
];
const runtime = [
  "index.ts", "client.ts", "fleet-control.ts",
  ...new Bun.Glob("src/**/*.ts").scanSync({ cwd: root }),
  ...new Bun.Glob("scripts/**/*.ts").scanSync({ cwd: root }),
].filter((file) => !file.endsWith(".test.ts") && !file.includes("/test-fixtures/"));
const read = (file: string) => Bun.file(join(root, file)).text();

test("the parked modules and the runtime files to check exist", () => {
  expect(parked.filter((file) => !existsSync(join(root, file)))).toEqual([]);
  expect(runtime.length).toBeGreaterThanOrEqual(80);
  for (const file of ["index.ts", "src/central/main.ts", "src/central/cooperative-service.ts", "src/host-agent/cooperative-main.ts"]) expect(runtime).toContain(file);
});

test("no runtime module imports a parked push-path module", async () => {
  const violations: string[] = [];
  for (const file of runtime.filter((candidate) => !parked.includes(candidate))) {
    const specs = [...(await read(file)).matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^import\s+)["']([^"']+)["']/gm)].map((match) => match[1]!);
    for (const spec of specs) {
      if (spec.startsWith(".") && parked.includes(relative(root, join(root, dirname(file), spec)))) violations.push(`${file} imports ${spec}`);
    }
  }
  expect(violations).toEqual([]);
});

test("no runtime module dispatches through the host socket registry", async () => {
  const callers: string[] = [];
  for (const file of runtime) {
    if (/\.dispatch\s*\(/.test(await read(file))) callers.push(file);
  }
  expect(callers).toEqual([]);
  // The registry still has the method, so the check above is looking for something real.
  expect(await read("src/central/agent-sockets.ts")).toMatch(/^\s*dispatch\(message: AgentDispatch\): boolean/m);
});

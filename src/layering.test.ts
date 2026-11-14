// Guards the directory layout: domain code knows nothing about storage or transport,
// storage code knows nothing about use cases or transport, and use cases know nothing about transport.
import { expect, test } from "bun:test";
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const files = [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: root })].filter((file) => !file.endsWith(".test.ts") && !file.includes("/test-fixtures/"));
const layerOf = (file: string) => /(^|\/)domain\//.test(file) ? "domain" : /(^|\/)data\//.test(file) ? "data" : /(^|\/)application\//.test(file) ? "application" : "other";
const importsOf = async (file: string) => {
  const source = await Bun.file(join(root, file)).text();
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^import\s+)["']([^"']+)["']/gm)].map((match) => match[1]!);
};
const storage = /^(bun:sqlite|bun)$/;
const transport = /^(hono|@modelcontextprotocol\/|zod$)/;

test("the source tree has domain, data and application modules to check", () => {
  expect(files.filter((file) => layerOf(file) === "domain").length).toBeGreaterThanOrEqual(10);
  expect(files.filter((file) => layerOf(file) === "data").length).toBeGreaterThanOrEqual(15);
  expect(files.filter((file) => layerOf(file) === "application").length).toBeGreaterThanOrEqual(7);
});

test("domain modules import only other domain modules", async () => {
  const violations: string[] = [];
  for (const file of files.filter((candidate) => layerOf(candidate) === "domain")) {
    for (const spec of await importsOf(file)) {
      const local = spec.startsWith(".") ? relative(root, join(root, dirname(file), spec)) : null;
      if (local ? layerOf(local) !== "domain" : true) violations.push(`${file} imports ${spec}`);
    }
  }
  expect(violations).toEqual([]);
});

test("data modules import only domain modules, data modules and the storage runtime", async () => {
  const violations: string[] = [];
  for (const file of files.filter((candidate) => layerOf(candidate) === "data")) {
    for (const spec of await importsOf(file)) {
      const local = spec.startsWith(".") ? relative(root, join(root, dirname(file), spec)) : null;
      if (local ? !["domain", "data"].includes(layerOf(local)) : !(storage.test(spec) || spec.startsWith("node:")) || transport.test(spec)) violations.push(`${file} imports ${spec}`);
    }
  }
  expect(violations).toEqual([]);
});

test("application modules import only domain, data and application modules and node built-ins", async () => {
  const violations: string[] = [];
  for (const file of files.filter((candidate) => layerOf(candidate) === "application")) {
    for (const spec of await importsOf(file)) {
      const local = spec.startsWith(".") ? relative(root, join(root, dirname(file), spec)) : null;
      if (local ? layerOf(local) === "other" : !spec.startsWith("node:")) violations.push(`${file} imports ${spec}`);
    }
  }
  expect(violations).toEqual([]);
});

test("only data modules run queries", async () => {
  const violations: string[] = [];
  for (const file of files.filter((candidate) => layerOf(candidate) !== "data")) {
    const source = await Bun.file(join(root, file)).text();
    if (/\b(?:db|tx|sql|admin)`|\bdb\.(?:query|prepare|run|exec)\(/.test(source)) violations.push(file);
  }
  expect(violations).toEqual([]);
});

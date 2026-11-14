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

// The programs that build stores and hand them to servers and tools. Deployment files start these by path.
const entryPoints = ["src/central/main.ts", "src/central/cooperative-main.ts", "src/central/cooperative-service.ts", "src/central/identity-cli.ts"];

// Servers, routes and tools may name a store's type for the dependencies they are given. Only an entry point builds one.
test("outside the layers, only entry points import data modules as values", async () => {
  const violations: string[] = [];
  const used = new Set<string>();
  for (const file of files.filter((candidate) => layerOf(candidate) === "other")) {
    const source = await Bun.file(join(root, file)).text();
    const statements = [...source.matchAll(/^import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm)].map((match) => {
      const names = match[2]!.replace(/[{}]/g, "").split(",").map((name) => name.trim()).filter(Boolean);
      return { spec: match[3]!, typeOnly: Boolean(match[1]) || (match[2]!.trim().startsWith("{") && names.every((name) => name.startsWith("type "))) };
    });
    const dynamic = [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)].map((match) => ({ spec: match[1]!, typeOnly: false }));
    for (const { spec, typeOnly } of [...statements, ...dynamic]) {
      if (typeOnly || !spec.startsWith(".") || layerOf(relative(root, join(root, dirname(file), spec))) !== "data") continue;
      if (entryPoints.includes(file)) used.add(file); else violations.push(`${file} imports ${spec}`);
    }
  }
  expect(violations).toEqual([]);
  expect([...used].sort()).toEqual([...entryPoints].sort());
});

test("the host service's server and tools reach stores only through use cases", async () => {
  for (const file of ["src/server.ts", "src/mcp.ts"]) {
    const local = (await importsOf(file)).filter((spec) => spec.startsWith(".")).map((spec) => relative(root, join(root, dirname(file), spec)));
    expect(local.filter((spec) => layerOf(spec) === "data")).toEqual([]);
    expect(local.some((spec) => layerOf(spec) === "application")).toBe(true);
  }
});

test("only data modules run queries", async () => {
  const violations: string[] = [];
  for (const file of files.filter((candidate) => layerOf(candidate) !== "data")) {
    const source = await Bun.file(join(root, file)).text();
    if (/\b(?:db|tx|sql|admin)`|\bdb\.(?:query|prepare|run|exec)\(/.test(source)) violations.push(file);
  }
  expect(violations).toEqual([]);
});

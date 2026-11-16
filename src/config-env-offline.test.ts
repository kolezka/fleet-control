import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePeers, portFromEnv } from "./config.ts";

test("peer names must be unique and plain, and URLs carry no credentials", () => {
  expect(() => parsePeers("a=http://x:1,a=http://y:2")).toThrow("repeated name");
  expect(() => parsePeers("a b=http://x:1")).toThrow("name may use");
  expect(() => parsePeers("a=https://user:pw@x:1")).toThrow("no credentials");
  expect(() => parsePeers("=http://x:1")).toThrow("expected name=url");
  expect(() => parsePeers("a=not a url")).toThrow("not a URL");
  expect(parsePeers("a=http://x:1/path, b=https://y")).toEqual([
    { name: "a", url: "http://x:1/" },
    { name: "b", url: "https://y/" },
  ]);
});

test("PORT unset or empty uses the default; anything else must be a real port", () => {
  expect(portFromEnv(undefined)).toBe(4871);
  expect(portFromEnv("")).toBe(4871);
  expect(portFromEnv("4999")).toBe(4999);
  expect(portFromEnv("65535")).toBe(65535);
  for (const bad of ["0", "abc", "-1", "4871.5", "65536", "099", " 4871"]) expect(() => portFromEnv(bad)).toThrow("PORT must be 1..65535");
});

test("entry points that allow a random port accept 0 and nothing looser", () => {
  expect(portFromEnv("0", 4870, true)).toBe(0);
  expect(portFromEnv(undefined, 4870, true)).toBe(4870);
  for (const bad of ["1e3", "0x10", " 4870", "4870.0", "00"]) expect(() => portFromEnv(bad, 4870, true)).toThrow("PORT must be 0..65535");
});

test("client entry refuses a PORT that Number() would have stretched into a port", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-client-port-"));
  try {
    const token = join(dir, "token"), config = join(dir, "client.json");
    await writeFile(token, "synthetic-private-token", { mode: 0o600 });
    await writeFile(config, JSON.stringify({ hosts: [{ id: "fixture", name: "Fixture", url: "http://127.0.0.1:4871", tokenFile: token }] }), { mode: 0o600 });
    for (const bad of ["1e3", "0x10"]) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../client.ts"), config], { env: { ...process.env, PORT: bad }, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      const code = await child.exited;
      clearTimeout(timer);
      expect(code).toBe(1);
      expect(await new Response(child.stderr).text()).toContain(`PORT must be 0..65535, got "${bad}"`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);

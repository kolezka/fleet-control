import { expect, test } from "bun:test";
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

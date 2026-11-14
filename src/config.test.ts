import { expect, test } from "bun:test";
import { parsePeers } from "./config.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";

test("peers parse to origins and reject junk", () => {
  expect(parsePeers("me-desktop=http://100.64.0.5:4871/x, mini=https://mini.tail:4871")).toEqual([
    { name: "me-desktop", url: "http://100.64.0.5:4871/" },
    { name: "mini", url: "https://mini.tail:4871/" },
  ]);
  expect(parsePeers(undefined)).toEqual([]);
  expect(() => parsePeers("noequals")).toThrow();
  expect(() => parsePeers("x=javascript:alert(1)")).toThrow();
});

test("/api/hosts names this host and lists peers without reading their sessions", async () => {
  const fleet = { screen: async () => "", status: async () => ({ raw: "", sessions: [] }) };
  const server = serve({ fleet, store: new Store() }, 0, { hostName: "mini", peers: [{ name: "desktop", url: "http://100.64.0.5:4871/" }] });
  try {
    expect(await (await fetch(`${server.url}api/hosts`)).json()).toEqual({
      self: { name: "mini", url: null },
      peers: [{ name: "desktop", url: "http://100.64.0.5:4871/" }],
    });
  } finally {
    server.stop(true);
  }
});

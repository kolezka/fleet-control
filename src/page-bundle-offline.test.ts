import { afterAll, beforeAll, expect, test } from "bun:test";
import { Commands } from "./data/commands.ts";
import { Requests } from "./data/requests.ts";
import { Deliverer } from "./application/delivery.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";

// The page is served without a token, so its bundle must not carry source maps, the original
// source or the hot reload runtime. Bun's default for Bun.serve is development mode.
const fleet = { screen: async () => "", status: async () => ({ sessions: [] }) } as never;
let server: ReturnType<typeof serve>;

beforeAll(() => {
  const store = new Store(":memory:");
  const commands = new Commands(store.db);
  server = serve({ fleet, store, control: { commands, deliverer: new Deliverer(commands, async () => ({ exitCode: 1, stdout: "", stderr: "" })), requests: new Requests(store.db) } }, 0);
});
afterAll(() => server.stop(true));

test("the page bundles are production builds without source maps or hot reload", async () => {
  for (const page of ["/", "/login"]) {
    const html = await (await fetch(new URL(page, server.url))).text();
    const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]!);
    expect({ page, scripts: scripts.length > 0 || page === "/login" }).toEqual({ page, scripts: true });
    expect(html).not.toContain("hmr");
    for (const src of scripts) {
      const response = await fetch(new URL(src, server.url));
      expect(response.status).toBe(200);
      expect(response.headers.get("sourcemap")).toBeNull();
      const js = await response.text();
      expect(js).not.toContain("sourceMappingURL");
      expect(js).not.toContain("Bun HMR Runtime");
      expect(js).not.toContain("hmr.dynamicImport");
      const map = await fetch(new URL(src + ".map", server.url));
      expect(map.status).not.toBe(200);
      await map.arrayBuffer();
    }
  }
});

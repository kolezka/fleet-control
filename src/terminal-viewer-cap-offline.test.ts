import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, ViewerSlots } from "./server.ts";
import { Store } from "./data/store.ts";

// Each terminal socket starts a PTY process. The service caps how many are open at once.
// A stub fleet CLI stands in for agent-fleet: it advertises read-only attach and then waits.
const fleet = { screen: async () => "", status: async () => ({ sessions: [] }) } as never;
let dir: string;
let server: ReturnType<typeof serve>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "viewer-cap-"));
  const bin = join(dir, "fleet");
  await writeFile(bin, '#!/bin/sh\n[ "$1" = help ] && { echo "fleet attach [--read-only] <session>"; exit 0; }\necho attached; exec sleep 30\n');
  await chmod(bin, 0o700);
  server = serve({ fleet, store: new Store(":memory:"), terminal: { fleetBin: bin, confPath: join(dir, "fleet.conf") } }, 0, { maxViewers: 2 });
});
afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

const open = () => {
  const ws = new WebSocket(`ws://${new URL(server.url).host}/api/sessions/probe/terminal?cols=80&rows=24`, { headers: { origin: server.url.origin } } as never);
  let first: ((v: "open" | "refused") => void) | undefined;
  const result = new Promise<"open" | "refused">((resolve) => { first = resolve; });
  // A refused viewer opens and closes at once with 1013; an accepted one gets the stub's first output.
  ws.onmessage = () => first?.("open");
  ws.onerror = () => first?.("refused");
  const closed = new Promise<{ code: number; reason: string }>((resolve) => { ws.onclose = (e) => { first?.("refused"); resolve({ code: e.code, reason: e.reason }); }; });
  return { ws, result, closed };
};

test("a third viewer is refused while two are open, and a closed one frees its slot", async () => {
  const first = open();
  const second = open();
  expect([await first.result, await second.result]).toEqual(["open", "open"]);
  const third = open();
  expect(await third.result).toBe("refused");
  expect(await third.closed).toEqual({ code: 1013, reason: "too many open terminal viewers" });
  // A plain request over the cap (no upgrade) still gets the JSON refusal.
  const status = await fetch(new URL("/api/sessions/probe/terminal", server.url), { headers: { origin: server.url.origin } });
  expect(status.status).toBe(503);
  expect((await status.json() as { error: { kind: string } }).error.kind).toBe("busy");

  first.ws.close();
  await first.closed;
  const fourth = open();
  expect(await fourth.result).toBe("open");
  second.ws.close();
  fourth.ws.close();
  await Promise.all([second.closed, fourth.closed]);
  // Both slots are free again.
  const again = [open(), open()];
  expect(await Promise.all(again.map((v) => v.result))).toEqual(["open", "open"]);
  for (const v of again) v.ws.close();
  await Promise.all(again.map((v) => v.closed));
});

test("two listeners given the same slots share one cap", async () => {
  const slots = new ViewerSlots(2);
  const deps = { fleet, store: new Store(":memory:"), terminal: { fleetBin: join(dir, "fleet"), confPath: join(dir, "fleet.conf") } };
  const a = serve(deps, 0, { viewerSlots: slots });
  const b = serve(deps, 0, { viewerSlots: slots });
  const at = (s: ReturnType<typeof serve>) => {
    const ws = new WebSocket(`ws://${new URL(s.url).host}/api/sessions/probe/terminal?cols=80&rows=24`, { headers: { origin: s.url.origin } } as never);
    const result = new Promise<"open" | "refused">((resolve) => { ws.onmessage = () => resolve("open"); ws.onclose = () => resolve("refused"); });
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
    return { ws, result, closed };
  };
  try {
    const one = at(a), two = at(b);
    expect([await one.result, await two.result]).toEqual(["open", "open"]);
    // Two are open across both listeners, so a third on either is refused.
    expect(await at(a).result).toBe("refused");
    expect(await at(b).result).toBe("refused");
    one.ws.close(); two.ws.close();
    await Promise.all([one.closed, two.closed]);
    expect(slots.open).toBe(0);
  } finally {
    a.stop(true); b.stop(true);
  }
});

test("maxViewers must be a positive integer", () => {
  expect(() => new ViewerSlots(0)).toThrow("maxViewers");
  expect(() => serve({ fleet, store: new Store(":memory:") }, 0, { maxViewers: 0 })).toThrow("maxViewers");
});

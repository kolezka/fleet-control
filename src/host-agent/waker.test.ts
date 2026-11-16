import { expect, test } from "bun:test";
import { adapterWait, parseWakerConfig, runWaker, type WakerConfig } from "./waker.ts";

const token = "a".repeat(43);
const config: WakerConfig = { adapterUrl: "http://127.0.0.1:4882/mcp", localToken: token, command: ["/bin/true"], waitSeconds: 20 };

test("waker config accepts only a loopback adapter, a local token and an absolute command", () => {
  expect(parseWakerConfig({ adapterUrl: "http://127.0.0.1:4882/mcp", localToken: token, command: ["/usr/bin/claude", "-p", "x"] }).waitSeconds).toBe(20);
  for (const bad of [
    { adapterUrl: "https://central.example/mcp", localToken: token, command: ["/bin/true"] },
    { adapterUrl: "http://127.0.0.1:4882/other", localToken: token, command: ["/bin/true"] },
    { adapterUrl: "http://127.0.0.1:4882/mcp", localToken: "short", command: ["/bin/true"] },
    { adapterUrl: "http://127.0.0.1:4882/mcp", localToken: token, command: ["claude"] },
    { adapterUrl: "http://127.0.0.1:4882/mcp", localToken: token, command: [] },
    { adapterUrl: "http://127.0.0.1:4882/mcp", localToken: token, command: ["/bin/true"], waitSeconds: 21 },
    { adapterUrl: "http://127.0.0.1:4882/mcp", localToken: token, command: ["/bin/true"], extra: 1 },
  ]) expect(() => parseWakerConfig(bad)).toThrow("invalid waker configuration");
});

test("waker starts the agent only when work is waiting and one at a time", async () => {
  // The last answer only lets the loop come round once more; stopping is checked before a start.
  const answers = [false, true, false, true, false];
  const runs: string[][] = [];
  let running = 0, most = 0;
  await runWaker(config, {
    wait: async () => answers.shift()!,
    run: async (command) => { running++; most = Math.max(most, running); runs.push(command); await Bun.sleep(1); running--; return 0; },
    sleep: async () => {},
    log: () => {},
  }, () => answers.length === 0);
  expect(runs).toEqual([["/bin/true"], ["/bin/true"]]);
  expect(most).toBe(1);
});

test("waker backs off after failures and after an agent that exits at once", async () => {
  const sleeps: number[] = [];
  const answers: (boolean | Error)[] = [new Error("down"), new Error("down"), true];
  await runWaker(config, {
    wait: async () => { const next = answers.shift()!; if (next instanceof Error) throw next; return next; },
    run: async () => 1,
    sleep: async (ms) => { sleeps.push(ms); },
    log: () => {},
  }, () => answers.length === 0 && sleeps.length >= 3);
  expect(sleeps).toEqual([2000, 4000, 30000]);
});

test("waker waits longer before each agent start while work stays queued, and resets once the queue is empty", async () => {
  const sleeps: number[] = [];
  const answers = [true, true, true, true, true, false, true];
  let runs = 0;
  await runWaker(config, {
    wait: async () => answers.shift()!,
    run: async () => { runs++; await Bun.sleep(1); return 0; },
    sleep: async (ms) => { sleeps.push(ms); },
    log: () => {},
  }, () => answers.length === 0 && runs >= 6);
  // Each run ends within 5 s here, so a 5 s pause follows it; the growing pause comes before the next start.
  expect(runs).toBe(6);
  expect(sleeps.filter((ms) => ms !== 5000)).toEqual([30000, 120000, 600000, 600000]);
});

test("adapterWait calls cooperative_wait through the adapter with the local token and reads pending", async () => {
  const seen: { url: string; auth: string | null; body: any }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ pending: true }) }] } });
  }) as unknown as typeof fetch;
  expect(await adapterWait(config, fake)(7)).toBe(true);
  expect(seen[0]!.url).toBe(config.adapterUrl);
  expect(seen[0]!.auth).toBe(`Bearer ${token}`);
  expect(seen[0]!.body.params).toEqual({ name: "cooperative_wait", arguments: { waitSeconds: 7 } });
  const failing = (async () => Response.json({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "request failed" }] } })) as unknown as typeof fetch;
  await expect(adapterWait(config, failing)(1)).rejects.toThrow("wait failed");
});

import { expect, test } from "bun:test";
import { createCooperativeAdapter } from "./cooperative-adapter";
import { createCooperativeListener } from "./cooperative-listener";

const localToken = "a".repeat(43);
const headers = { authorization: `Bearer ${localToken}`, "content-type": "application/json" };
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });

test("loopback listener enforces host and origin while preserving adapter auth", async () => {
  let forwarded = 0;
  const adapter = createCooperativeAdapter({
    centralUrl: "https://central.invalid/mcp",
    localToken,
    supervisorToken: "b".repeat(43),
    incarnationId: "12345678-1234-4234-8234-123456789abc",
    incarnationToken: "c".repeat(43),
    centralFetch: async () => { forwarded++; return Response.json({ jsonrpc: "2.0", id: 1, result: {} }); },
  });
  const listener = createCooperativeListener({ handler: adapter });
  const url = `http://127.0.0.1:${listener.port}/mcp`;
  const post = (extra: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { ...headers, ...extra }, body });
  try {
    expect((await post()).status).toBe(200);
    expect((await post({ host: `localhost:${listener.port}` })).status).toBe(200);
    expect((await post({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post({ host: `evil.example:${listener.port}` })).status).toBe(403);
    expect((await post({ host: `127.0.0.1.evil.example:${listener.port}` })).status).toBe(403);
    expect((await post({ host: `127.0.0.1:${listener.port + 1}` })).status).toBe(403);
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ origin: `http://127.0.0.1:${listener.port}` })).status).toBe(403);
    expect(forwarded).toBe(2);
  } finally {
    await listener.stop();
  }
  await expect(post()).rejects.toThrow();
});

test("handler exceptions return a generic 500 without leaking details", async () => {
  for (const handler of [
    () => { throw new Error("private synchronous detail"); },
    async () => { throw new Error("private asynchronous detail"); },
  ]) {
    const listener = createCooperativeListener({ handler });
    try {
      const response = await fetch(`http://127.0.0.1:${listener.port}/`);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");
    } finally {
      await listener.stop();
    }
  }
});

test("stop drains an active request and is idempotent", async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const listener = createCooperativeListener({ handler: async () => { enter(); await gate; return new Response("done"); }, shutdownTimeoutMs: 500 });
  const url = `http://127.0.0.1:${listener.port}/`;
  const request = fetch(url);
  try {
    await entered;
    let settled = false;
    const stop = listener.stop();
    void stop.then(() => { settled = true; });
    expect(listener.stop()).toBe(stop);
    await Bun.sleep(30);
    expect(settled).toBe(false);
    await expect(fetch(url)).rejects.toThrow();
    release();
    expect(await (await request).text()).toBe("done");
    await stop;
    expect(listener.stop()).toBe(stop);
  } finally { release(); await listener.stop(); }
});

test("stop waits for an accepted handler after the client disconnects", async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const listener = createCooperativeListener({ handler: async () => { enter(); await gate; return new Response("done"); }, shutdownTimeoutMs: 500 });
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${listener.port}/`, { signal: controller.signal }).catch(() => undefined);
  try {
    await entered;
    controller.abort();
    await request;
    let settled = false;
    const stop = listener.stop();
    void stop.then(() => { settled = true; });
    await Bun.sleep(50);
    expect(settled).toBe(false);
    release();
    await stop;
  } finally { release(); await listener.stop(); }
});

test("shutdown deadline bounds disconnected handler work", async () => {
  let enter!: () => void;
  let release!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const listener = createCooperativeListener({ handler: async () => { enter(); await gate; finish(); return new Response("done"); }, shutdownTimeoutMs: 60 });
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${listener.port}/`, { signal: controller.signal }).catch(() => undefined);
  try {
    await entered;
    controller.abort();
    await request;
    const stop = listener.stop();
    expect(await Promise.race([stop.then(() => "stopped"), Bun.sleep(20).then(() => "waiting")])).toBe("waiting");
    expect(await Promise.race([stop.then(() => "stopped"), Bun.sleep(1000).then(() => "timeout")])).toBe("stopped");
    release();
    await finished;
  } finally { release(); await listener.stop(); }
});

test("shutdown times out without claiming to cancel an upstream effect", async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let finished = false;
  const listener = createCooperativeListener({ handler: async () => { calls++; enter(); await gate; finished = true; return new Response("done"); }, shutdownTimeoutMs: 50 });
  const url = `http://127.0.0.1:${listener.port}/`;
  const request = fetch(url).then(() => "response", () => "closed");
  try {
    await entered;
    let settled = false;
    const stop = listener.stop();
    void stop.then(() => { settled = true; });
    expect(listener.stop()).toBe(stop);
    await Bun.sleep(15);
    expect(settled).toBe(false);
    expect(await Promise.race([stop.then(() => "stopped"), Bun.sleep(2000).then(() => "timeout")])).toBe("stopped");
    expect(finished).toBe(false);
    expect(await request).toBe("closed");
    await expect(fetch(url)).rejects.toThrow();
    expect(calls).toBe(1);
    release();
    await Bun.sleep(20);
    expect(finished).toBe(true);
    expect(calls).toBe(1);
  } finally { release(); await listener.stop(); }
});

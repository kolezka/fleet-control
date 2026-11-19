// The host service entry point with a second (tailnet) listener: both answer with the same state,
// the second only over TLS with the certificate for its own name. ::1 stands in for the tailnet IP.
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenLine } from "./auth.ts";

const dir = await mkdtemp(join(tmpdir(), "tailnet-listener-"));
let proc: ReturnType<typeof Bun.spawn> | undefined;
afterAll(async () => { proc?.kill(); await proc?.exited; await rm(dir, { recursive: true, force: true }); });

const freePort = () => new Promise<number>((done) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); });
});

test("one command posted on the LAN listener is read on the tailnet listener, which needs TLS for its name", async () => {
  const cert = join(dir, "cert.pem"), key = join(dir, "key.pem");
  const ssl = Bun.spawn(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,DNS:box.tail.ts.net", "-days", "30", "-keyout", key, "-out", cert], { stdout: "ignore", stderr: "ignore" });
  expect(await ssl.exited).toBe(0);
  const token = "tailnet-test-token";
  await writeFile(join(dir, "tokens"), `${tokenLine("gw", token)}\n`, { mode: 0o600 });
  await writeFile(join(dir, "fleet.conf"), `FLEET=tailnet-test-${process.pid}\nFLEET_DIR=${dir}\nAGENTS=()\n`);
  const port = await freePort();
  proc = Bun.spawn(["bun", "index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env, PORT: String(port), FLEET_CONF: join(dir, "fleet.conf"), FLEET_CONTROL_DB: join(dir, "state.db"),
      FLEET_CONTROL_HOST: "127.0.0.1", FLEET_CONTROL_TOKENS: join(dir, "tokens"),
      FLEET_CONTROL_TAILNET_HOST: "::1", FLEET_CONTROL_TAILNET_NAME: "box.tail.ts.net",
      FLEET_CONTROL_TAILNET_TLS_CERT: cert, FLEET_CONTROL_TAILNET_TLS_KEY: key,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const lan = `http://127.0.0.1:${port}`, tailnet = `https://localhost:${port}`;
  const auth = { authorization: `Bearer ${token}` };
  const tls = { ca: await Bun.file(cert).text() };
  // Wait for the LAN listener; both listeners are bound before the service starts serving.
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${lan}/api/whoami`, { headers: auth })).ok; } catch { await Bun.sleep(100); }
  }
  if (!up) { proc.kill(); throw new Error(`service did not start: ${await new Response(proc.stderr as ReadableStream).text()}`); }
  const viaTailnet = await fetch(`${tailnet}/api/whoami`, { headers: auth, tls } as RequestInit).catch((e: Error) => e.message);
  expect(viaTailnet instanceof Response ? viaTailnet.status : viaTailnet).toBe(200);

  const posted = await fetch(`${lan}/api/commands`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "tailnet-0001", target: "nobody", text: "hello" }),
  });
  expect([200, 201]).toContain(posted.status);
  const id = (await posted.json()).command.id;
  const read = await fetch(`${tailnet}/api/commands/${id}`, { headers: auth, tls } as RequestInit);
  expect(read.status).toBe(200);
  expect((await read.json()).command.text).toBe("hello");

  // Without a token the tailnet listener answers 401, and it does not speak plain HTTP.
  expect((await fetch(`${tailnet}/api/commands`, { tls } as RequestInit)).status).toBe(401);
  await expect(fetch(`http://[::1]:${port}/api/whoami`, { headers: auth })).rejects.toThrow();
  // MCP checks the Host header: the tailnet name is accepted, a foreign name is not. The certificate names
  // localhost too, so the client dials localhost while the Host header carries the MagicDNS name.
  const mcp = (host: string) => fetch(`${tailnet}/mcp`, {
    method: "POST", tls,
    headers: { ...auth, host, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  } as RequestInit);
  expect((await mcp(`box.tail.ts.net:${port}`)).status).toBe(200);
  expect((await mcp(`evil.example:${port}`)).status).toBe(403);
  // The certificate names localhost, not the IP, so dialing the IP fails verification.
  await expect(fetch(`https://[::1]:${port}/api/whoami`, { headers: auth, tls } as RequestInit)).rejects.toThrow();
}, 30_000);

test("when the tailnet address cannot be bound the service stops instead of serving only the LAN", async () => {
  const port = await freePort();
  // A Tailscale address this machine does not own, so the second bind fails after the LAN one succeeded.
  const failed = Bun.spawn(["bun", "index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env, PORT: String(port), FLEET_CONF: join(dir, "fleet.conf"), FLEET_CONTROL_DB: join(dir, "state-2.db"),
      FLEET_CONTROL_HOST: "127.0.0.1", FLEET_CONTROL_TOKENS: join(dir, "tokens"),
      FLEET_CONTROL_TAILNET_HOST: "100.127.255.254", FLEET_CONTROL_TAILNET_NAME: "box.tail.ts.net",
      FLEET_CONTROL_TAILNET_TLS_CERT: join(dir, "cert.pem"), FLEET_CONTROL_TAILNET_TLS_KEY: join(dir, "key.pem"),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const code = await Promise.race([failed.exited, Bun.sleep(20_000).then(() => "timeout" as const)]);
  if (code === "timeout") failed.kill();
  expect(code).toBe(1);
  expect(await new Response(failed.stderr as ReadableStream).text()).toContain("tailnet listener failed");
  expect(await new Response(failed.stdout as ReadableStream).text()).not.toContain("Fleet Control service on");
  await expect(fetch(`http://127.0.0.1:${port}/api/whoami`)).rejects.toThrow();
}, 30_000);

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A new Bun process is needed: NODE_EXTRA_CA_CERTS is read at startup.
test("gateway verifies TLS for HTTP and terminal sockets and accepts an explicitly trusted certificate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-control-gateway-tls-"));
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  let host: ReturnType<typeof Bun.serve> | undefined;
  try {
    const generated = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], { stdout: "ignore", stderr: "pipe" });
    expect(await generated.exited).toBe(0);
    host = Bun.serve({
      hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) },
      fetch(req, server) {
        if (req.headers.get("authorization") !== "Bearer tls-fixture") return new Response(null, { status: 401 });
        if (new URL(req.url).pathname.endsWith("/terminal")) return server.upgrade(req, { data: undefined }) ? undefined : new Response(null, { status: 400 });
        return Response.json({ sessions: [{ name: "tls-positive-control" }] });
      },
      websocket: { open(ws) { ws.send("TLS-TERMINAL-POSITIVE-CONTROL"); }, message() {} },
    });
    const program = `
      import { Credentials, startGateway } from ${JSON.stringify(join(import.meta.dir, "client-gateway.ts"))};
      const gateway = startGateway({ hosts: [{id:"tls",name:"tls",origin:${JSON.stringify(host.url.origin)}}], credentials:new Credentials(new Map([["tls","tls-fixture"]])) }, {port:0, timeoutMs:1000});
      try {
        const http = await fetch(gateway.url + "api/hosts/tls/sessions");
        const body = await http.json();
        const terminal = await new Promise(resolve => {
          const socket = new WebSocket(gateway.url.toString().replace("http:","ws:") + "api/hosts/tls/sessions/main/terminal", { headers:{origin:gateway.url.origin} });
          const timer = setTimeout(() => {socket.close();resolve("timeout");},2000);
          socket.onmessage = e => { clearTimeout(timer); socket.close(); resolve(e.data); };
          socket.onerror = () => {clearTimeout(timer);resolve("refused");};
        });
        console.log(JSON.stringify({status:http.status,body,terminal}));
      } finally {gateway.stop(true);}
    `;
    const run = async (trusted: boolean) => {
      const env = { ...process.env };
      delete env.NODE_TLS_REJECT_UNAUTHORIZED;
      delete env.NODE_EXTRA_CA_CERTS;
      if (trusted) env.NODE_EXTRA_CA_CERTS = cert;
      const proc = Bun.spawn([process.execPath, "-e", program], { env, stdout: "pipe", stderr: "pipe" });
      const [out, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code, error).toBe(0);
      return JSON.parse(out.trim().split("\n").at(-1)!);
    };
    const refused = await run(false);
    expect(refused.status).toBe(502);
    expect(refused.terminal).toBe("refused");
    const trusted = await run(true);
    expect(trusted.status).toBe(200);
    expect(trusted.body.sessions[0].name).toBe("tls-positive-control");
    expect(trusted.terminal).toBe("TLS-TERMINAL-POSITIVE-CONTROL");
  } finally {
    host?.stop(true);
    // Only this test's freshly allocated certificate directory is removed.
    if (dir.startsWith(join(tmpdir(), "fleet-control-gateway-tls-"))) await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Auth, AuthConfigError, parseTokens, tokenLine } from "./auth.ts";
import { Commands } from "./data/commands.ts";
import { Deliverer, type Sender } from "./delivery.ts";
import { Requests } from "./data/requests.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";

describe("tokens file", () => {
  test("stores only hashes and maps a token to its principal", () => {
    const line = tokenLine("macbook", "secret-a");
    expect(line).not.toContain("secret-a");
    const auth = new Auth(parseTokens(`# comment\n${line}\n${tokenLine("web", "secret-b")}\n`));
    expect(auth.check("secret-a")).toEqual({ name: "macbook" });
    expect(auth.check("secret-b")).toEqual({ name: "web" });
    expect(auth.check("secret-c")).toBeNull();
    expect(auth.check("")).toBeNull();
  });

  test("bad, duplicate or empty files are rejected at start, not ignored", () => {
    expect(() => parseTokens("macbook plaintext-token")).toThrow(AuthConfigError);
    expect(() => parseTokens(`${tokenLine("a", "x")}\n${tokenLine("a", "y")}`)).toThrow(AuthConfigError);
    expect(() => parseTokens("# nothing\n")).toThrow(AuthConfigError);
  });
});

test("binding a non-loopback address without auth is refused", () => {
  const fleet = { screen: async () => "", status: async () => ({ raw: "", sessions: [] }) };
  expect(() => serve({ fleet, store: new Store() }, 0, { hostname: "0.0.0.0" })).toThrow(/without auth/);
});

describe("service with auth", () => {
  const sent: string[] = [];
  const fakeSend: Sender = async (session, file) => {
    sent.push(await Bun.file(file).text());
    return { exitCode: 0, stdout: `${session}: delivered`, stderr: "" };
  };
  const fleet = { screen: async () => "", status: async () => ({ raw: "", sessions: [] }) };
  const tokens = { orch: "tok-orchestrator", worker: "tok-worker", web: "tok-web" };
  let server: ReturnType<typeof serve>;
  let requests: Requests;

  beforeAll(() => {
    const store = new Store();
    const commands = new Commands(store.db);
    requests = new Requests(store.db);
    const auth = new Auth(parseTokens(Object.entries(tokens).map(([n, t]) => tokenLine(n, t)).join("\n")));
    server = serve({ fleet, store, control: { commands, deliverer: new Deliverer(commands, fakeSend), requests } }, 0, { auth });
  });
  afterAll(() => server.stop(true));

  const url = (p: string) => `${server.url}${p.replace(/^\//, "")}`;
  async function mcp(token: string | null) {
    const client = new Client({ name: "auth-test", version: "0" });
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    await client.connect(new StreamableHTTPClientTransport(new URL(url("/mcp")), { requestInit: { headers } }));
    return client;
  }
  const body = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

  test("every API, MCP and terminal route needs a token", async () => {
    for (const p of ["/api/sessions", "/api/commands", "/api/requests", "/api/whoami", "/api/sessions/x/screen"]) {
      expect((await fetch(url(p))).status).toBe(401);
      expect((await fetch(url(p), { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    }
    expect((await fetch(url("/api/commands"), { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(url("/mcp"), { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(url("/api/sessions/x/terminal"))).status).toBe(401);
    await expect(mcp(null)).rejects.toThrow();
    // the sign-in page itself stays reachable
    expect((await fetch(url("/login"))).status).toBe(200);
  });

  test("the token's principal is the recorded actor; a claimed actor is ignored", async () => {
    const res = await fetch(url("/api/commands"), {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.web}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "auth-web-0001", target: "sup", text: "hello", actor: "orch" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).command.actor).toBe("web");

    const client = await mcp(tokens.worker);
    const r = body(await client.callTool({ name: "command_submit", arguments: { target: "sup", text: "x", idempotencyKey: "auth-mcp-0001", actor: "orch" } }));
    expect(r.command.actor).toBe("worker");
    expect(sent.at(-1)).toContain("from worker:");
    await client.close();
  });

  test("a worker token cannot write the orchestrator's phase record, even when it claims the name", async () => {
    const orch = await mcp(tokens.orch);
    const run = body(await orch.callTool({ name: "run_register", arguments: { runId: "auth-run", orchestrator: "someone-else", phase: "p1" } }));
    expect(run.run.orchestrator).toBe("orch");
    const worker = await mcp(tokens.worker);
    const denied = await worker.callTool({ name: "phase_update", arguments: { runId: "auth-run", actor: "orch", expectedRevision: 1, phaseStatus: "done", newRevision: false } });
    expect(denied.isError).toBe(true);
    expect(requests.runs().find((r) => r.id === "auth-run")?.phaseStatus).not.toBe("done");
    await orch.close();
    await worker.close();
  });

  test("the browser signs in with a token and gets an HttpOnly cookie; a bad token gets none", async () => {
    const form = (t: string) => { const f = new FormData(); f.set("token", t); return f; };
    const origin = server.url.origin;
    const bad = await fetch(url("/api/login"), { method: "POST", body: form("nope"), headers: { origin }, redirect: "manual" });
    expect(bad.headers.get("set-cookie")).toBeNull();
    const cross = await fetch(url("/api/login"), { method: "POST", body: form(tokens.web), headers: { origin: "http://evil.example" }, redirect: "manual" });
    expect(cross.status).toBe(403);
    const ok = await fetch(url("/api/login"), { method: "POST", body: form(tokens.web), headers: { origin }, redirect: "manual" });
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const who = await fetch(url("/api/whoami"), { headers: { cookie: cookie.split(";")[0]! } });
    expect(await who.json()).toEqual({ principal: "web", auth: true });
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Auth, AuthConfigError, newToken, parseTokens, TOKEN_LENGTH, tokenLine } from "./auth.ts";
import { Commands } from "./data/commands.ts";
import { Deliverer } from "./application/delivery.ts";
import type { Sender } from "./domain/delivery.ts";
import { Requests } from "./data/requests.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";

describe("tokens file", () => {
  test("stores only hashes and maps a token to its principal", () => {
    const line = tokenLine("macbook", "secret-a");
    expect(line).not.toContain("secret-a");
    const auth = new Auth(parseTokens(`# comment\n${line}\n${tokenLine("web", "secret-b")}\n`));
    expect(auth.check("secret-a")).toEqual({ name: "macbook", role: "agent" });
    expect(auth.check("secret-b")).toEqual({ name: "web", role: "agent" });
    expect(auth.check("secret-c")).toBeNull();
    expect(auth.check("")).toBeNull();
  });

  test("a generated token is found in text even when glued to other characters", () => {
    const live = newToken(), other = newToken();
    expect(live.length).toBe(TOKEN_LENGTH);
    const auth = new Auth(parseTokens(tokenLine("web", live)));
    for (const text of [`echo pre${live}`, `echo ${live}suffix`, `pre_${live}_post`, `pre-${live}-post`, `x${live}y`]) {
      expect({ text, found: auth.appearsIn(text) }).toEqual({ text, found: true });
    }
    // Controls: another token, and the live one with a character changed, are not reported.
    expect(auth.appearsIn(`echo pre${other}`)).toBe(false);
    const changed = (live[0] === "A" ? "B" : "A") + live.slice(1);
    expect(auth.appearsIn(`echo pre${changed}x`)).toBe(false);
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
  let commands: Commands;

  beforeAll(() => {
    const store = new Store();
    commands = new Commands(store.db);
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
    expect((await fetch(url("/api/terminal?session=x"))).status).toBe(401);
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
    expect(await who.json()).toEqual({ principal: "web", role: "agent", auth: true });
  });

  // A delivered command lands in the pane's scrollback, where every terminal viewer can read it.
  test("a command whose text carries a live token is refused on REST and MCP and never delivered", async () => {
    const before = sent.length;
    for (const text of [
      `login with ${tokens.orch} please`,
      `curl -H "Authorization: Bearer ${tokens.web}"`,
      tokens.worker,
      `export token=${tokens.orch}`,
      `open https://host:4871/?t=${tokens.web}`,
    ]) {
      const res = await fetch(url("/api/commands"), {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.web}`, "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: `leak-${text.length}-rest`, target: "sup", text }),
      });
      expect({ text, status: res.status }).toEqual({ text, status: 400 });
      expect((await res.json()).error.message).toContain("token");
    }
    const client = await mcp(tokens.worker);
    const denied = await client.callTool({ name: "command_submit", arguments: { target: "sup", text: `here: ${tokens.orch}`, idempotencyKey: "leak-mcp-0001", actor: "x" } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("token");
    await client.close();
    expect(sent.length).toBe(before);
    // Text over the length cap gets the store's length error without a token scan.
    const long = await fetch(url("/api/commands"), {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.web}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "leak-long-0001", target: "sup", text: `${tokens.orch} ${"x ".repeat(2100)}` }),
    });
    expect(long.status).toBe(400);
    expect((await long.json()).error.message).toContain("longer than");
    // Padding that the store trims away does not skip the scan.
    const padded = await fetch(url("/api/commands"), {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.web}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "leak-padded-0001", target: "sup", text: `${tokens.web}${" ".repeat(4200)}` }),
    });
    expect(padded.status).toBe(400);
    expect((await padded.json()).error.message).toContain("token");
    expect(sent.length).toBe(before);
    // Refused texts are not stored either, so command_list cannot show them.
    const stored = commands.list().map((c) => c.text).join("\n");
    for (const token of Object.values(tokens)) expect(stored).not.toContain(token);
    // Control: the same shape of text without a token still goes through.
    const ok = await fetch(url("/api/commands"), {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.web}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "leak-control-0001", target: "sup", text: "login with tok-nothing please" }),
    });
    expect(ok.status).toBe(201);
    expect(sent.length).toBe(before + 1);
  });

  // A row queued before the guard existed, or by an instance without auth, must not reach the pane either.
  test("command_deliver refuses a queued command whose text carries a live token", async () => {
    const { command } = commands.submit({ idempotencyKey: "seeded-leak-0001", target: "sup", actor: "old", text: `please use ${tokens.web} now` });
    const { command: clean } = commands.submit({ idempotencyKey: "seeded-clean-0001", target: "sup", actor: "old", text: "please use nothing now" });
    const before = sent.length;
    const client = await mcp(tokens.worker);
    const denied = await client.callTool({ name: "command_deliver", arguments: { id: command.id } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("token");
    expect(sent.length).toBe(before);
    // Control: a clean queued row is still delivered through the same tool.
    const ok = await client.callTool({ name: "command_deliver", arguments: { id: clean.id } });
    expect(ok.isError).toBeFalsy();
    expect(sent.length).toBe(before + 1);
    // A row already delivered before the guard comes back unchanged, as the tool describes.
    const { command: old } = commands.submit({ idempotencyKey: "seeded-done-0001", target: "sup", actor: "old", text: `done with ${tokens.web}` });
    expect((await new Deliverer(commands, fakeSend).deliver(old.id)).status).toBe("delivered");
    const sentBefore = sent.length;
    const again = await client.callTool({ name: "command_deliver", arguments: { id: old.id } });
    expect(again.isError).toBeFalsy();
    expect(JSON.stringify(again.content)).toContain("delivered");
    expect(sent.length).toBe(sentBefore);
    await client.close();
  });
});

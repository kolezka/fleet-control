import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupCooperativeRole, disposableCooperativeRole } from "./test-fixtures/disposable-role-fixture.ts";

const databaseUrl = process.env.CENTRAL_TEST_DATABASE_URL;
const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

(databaseUrl ? test : test.skip)("cooperative process bounds operator MCP pages and escaped response wire bytes", async () => {
  const url = new URL(databaseUrl!);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" || url.port !== "57507" || url.pathname !== "/fleet_control_test" || url.search || url.hash) throw new Error("refusing non-disposable test database");
  const schema = `cooperative_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(join(tmpdir(), "fleet-mcp-envelope-"));
  const credentialsFile = join(directory, "credentials.json");
  const incarnationFile = join(directory, "incarnation.json");
  const operator = token(), supervisor = token();
  const admin = new SQL(databaseUrl!);
  let fixture: Awaited<ReturnType<typeof disposableCooperativeRole>> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let stdout: Promise<string> | undefined;
  let stderr: Promise<string> | undefined;
  let ownedSchema = false;
  try {
    fixture = await disposableCooperativeRole(databaseUrl!);
    await writeFile(credentialsFile, JSON.stringify([
      { tokenHash: hash(operator), principal: { role: "operator", name: "operator" } },
      { tokenHash: hash(supervisor), principal: { role: "supervisor", name: "owner", principalId: "owner", hostId: "host", session: "session" } },
    ]), { mode: 0o600, flag: "wx" });
    child = Bun.spawn([process.execPath, "src/central/cooperative-main.ts"], { env: { ...process.env, COOPERATIVE_DATABASE_URL: databaseUrl!, COOPERATIVE_RUNTIME_DATABASE_URL: fixture.runtimeUrl, COOPERATIVE_SCHEMA: schema, COOPERATIVE_CREDENTIALS_FILE: credentialsFile, COOPERATIVE_INCARNATION_FILE: incarnationFile, COOPERATIVE_PORT: "0" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) throw new Error("process streams unavailable");
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let announce!: (line: string) => void, fail!: (error: Error) => void;
    const ready = new Promise<string>((resolve, reject) => { announce = resolve; fail = reject; });
    stdout = (async () => {
      let output = "", announced = false;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value, { stream: true });
        const newline = output.indexOf("\n");
        if (!announced && newline >= 0) { announced = true; announce(output.slice(0, newline)); }
      }
      if (!announced) fail(new Error("central process exited before readiness"));
      return output + decoder.decode();
    })();
    stderr = new Response(child.stderr).text();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const line = await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("central process startup timeout")), 10000); })]).finally(() => { if (timer) clearTimeout(timer); });
    const central = JSON.parse(line) as { url: string };
    ownedSchema = true;
    expect(central.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const call = async (name: string, args: object) => {
      const response = await fetch(`${central.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(10000) });
      const wire = await response.text();
      expect(response.status).toBe(200);
      expect(new TextEncoder().encode(wire).byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(wire).not.toContain(operator);
      expect(wire).not.toContain(supervisor);
      const envelope = JSON.parse(wire);
      expect(envelope.jsonrpc).toBe("2.0");
      expect(envelope.id).toBe(1);
      return envelope.result;
    };
    const text = "\u0001".repeat(4000);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await call("command_submit", { hostId: "host", target: "session", text, idempotencyKey: `key-${i}` });
      expect(result.isError).not.toBe(true);
      const value = JSON.parse(result.content[0].text);
      expect(value.command.text).toBe(text);
      ids.push(value.command.id);
    }
    const ordered = await admin`SELECT id FROM ${admin(schema)}.central_commands ORDER BY created_at, id`;
    const orderedIds = ordered.map((row: { id: string }) => row.id);
    expect(new Set(orderedIds)).toEqual(new Set(ids));
    const get = await call("command_get", { id: ids[0] });
    expect(JSON.parse(get.content[0].text).command.text).toBe(text);
    const first = JSON.parse((await call("command_list", {})).content[0].text);
    expect(first.commands).toHaveLength(4);
    expect(first.commands.map((item: { id: string }) => item.id)).toEqual(orderedIds.slice(0, 4));
    expect(first.commands.every((item: { text: string }) => item.text === text)).toBe(true);
    expect(typeof first.nextCursor).toBe("string");
    const second = JSON.parse((await call("command_list", { cursor: first.nextCursor })).content[0].text);
    expect(second.commands.map((item: { id: string }) => item.id)).toEqual(orderedIds.slice(4));
    expect(second.nextCursor).toBeNull();
    expect((await call("command_list", { limit: 5 })).isError).toBe(true);
    const escaped = "\u0001".repeat(250000);
    for (const id of orderedIds.slice(0, 4)) await admin`UPDATE ${admin(schema)}.central_commands SET text = ${escaped} WHERE id = ${id}`;
    const escapedPage = await call("command_list", {});
    expect(escapedPage.isError).toBe(true);
    expect(JSON.stringify(escapedPage).length).toBeLessThan(1024);
    for (const id of orderedIds.slice(0, 4)) await admin`UPDATE ${admin(schema)}.central_commands SET text = ${text} WHERE id = ${id}`;
    await admin`UPDATE ${admin(schema)}.central_commands SET actor = repeat('é', 140000) WHERE id = ${orderedIds[4]}`;
    const oversizedGet = await call("command_get", { id: orderedIds[4] });
    expect(oversizedGet.isError).toBe(true);
    expect(JSON.stringify(oversizedGet)).not.toContain("éééé");
    const oversizedLookahead = await call("command_list", {});
    expect(oversizedLookahead.isError).not.toBe(true);
    const safePage = JSON.parse(oversizedLookahead.content[0].text);
    expect(safePage.commands).toHaveLength(4);
    expect((await call("command_list", { cursor: safePage.nextCursor })).isError).toBe(true);
  } finally {
    if (child) { child.kill("SIGKILL"); await child.exited; }
    try {
      const output = (await stdout ?? "") + (await stderr ?? "");
      expect(output).not.toContain(operator);
      expect(output).not.toContain(supervisor);
    } finally {
      try { if (ownedSchema) await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`; }
      finally { try { if (fixture) await cleanupCooperativeRole(fixture, schema, !ownedSchema && !!child); } finally { try { await admin.close(); } finally { await rm(directory, { recursive: true, force: true }); } } }
    }
  }
}, 60000);

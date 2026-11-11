import { SQL } from "bun";
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CentralCommands } from "./commands.ts";
import { buildCentralMcpServer } from "./mcp.ts";
import type { Principal } from "./auth.ts";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "./test-database-url.ts";

const url = centralTestDatabaseUrl(process.env);
const integration = url ? test : test.skip;

// Store cursors are capped at 8192 characters (decodeCursor in commands.ts). MCP must accept every cursor the
// store can emit for a valid scope (host and target up to 256 UTF-16 units) and still refuse anything larger.
const STORE_CURSOR_LIMIT = 8192;

const parse = (response: unknown) => JSON.parse((response as { content: { text: string }[] }).content[0]!.text);
const pad = (seed: string, unit: string, length: number) => (seed + unit.repeat(length)).slice(0, length);

async function connect(commands: CentralCommands, principal: Principal) {
  const server = buildCentralMcpServer({ commands }, principal);
  const client = new Client({ name: "cursor-length-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

integration("MCP accepts store-generated cursors for maximum-length unicode scopes and keeps a finite bound", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const store = new CentralCommands(db, () => new Date("2025-01-01T00:00:00.000Z"));
  const run = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  // Worst case for JSON/UTF-8 size per UTF-16 unit: BMP CJK is 3 bytes per unit (astral emoji is 2 per unit).
  // Auth ids (validId) allow up to 256 UTF-16 units and no control characters. The heaviest legal unit in the
  // cursor JSON is a BMP CJK character (3 UTF-8 bytes), so two such 256 unit scopes are the real maximum.
  const hosts = [pad(`cjk-${run}-`, "日", 256), pad(`emoji-${run}-`, "😀", 256), pad(`quote-${run}-`, "\"\\", 256)];
  const hostsSeen: string[] = [];
  try {
    await store.initialize();
    for (const hostId of hosts) {
      expect(hostId.length).toBe(256);
      // Submit only allows [A-Za-z0-9._-] targets, so the longest real target is 256 ASCII characters.
      const target = pad(`t-${run}-`, "a", 256);
      expect(target.length).toBe(256);
      const principal: Principal = { name: `sup-${run}`, role: "supervisor", principalId: `id-${run}`, hostId, session: target };
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const { command } = await store.submit({ idempotencyKey: `${run}-${hosts.indexOf(hostId)}-${i}`, hostId, target, actor: "test", text: "test" });
        ids.push(command.id);
      }
      ids.sort();
      const direct = await store.list(undefined, { hostId, target }, { limit: 1 });
      expect(direct.nextCursor).toBeTruthy();
      expect(direct.nextCursor!.length).toBeGreaterThan(512);
      expect(direct.nextCursor!.length).toBeLessThanOrEqual(STORE_CURSOR_LIMIT);

      const { client, server } = await connect(store, principal);
      try {
        const call = (args: Record<string, unknown>) => client.callTool({ name: "command_list", arguments: args });
        const firstResponse = await call({ limit: 1 });
        expect(firstResponse.isError).not.toBe(true);
        const first = parse(firstResponse);
        expect(first.commands.map((command: { id: string }) => command.id)).toEqual(ids.slice(0, 1));
        expect(first.nextCursor).toBe(direct.nextCursor);
        hostsSeen.push(`${hostId.codePointAt(0)}:${first.nextCursor.length}`);
        const secondResponse = await call({ limit: 1, cursor: first.nextCursor });
        expect(secondResponse.isError).not.toBe(true);
        const second = parse(secondResponse);
        expect(second.commands.map((command: { id: string }) => command.id)).toEqual(ids.slice(1));
        expect(second.nextCursor).toBeNull();
        // Bound stays finite: the schema refuses what the store would refuse anyway.
        expect((await call({ cursor: "A".repeat(STORE_CURSOR_LIMIT) })).isError).toBe(true); // store rejects (not a real cursor)
        const tooLong = await call({ cursor: "A".repeat(STORE_CURSOR_LIMIT + 1) });
        expect(tooLong.isError).toBe(true);
        expect(JSON.stringify(tooLong.content)).toMatch(/too_big|Too big|8192|at most/i);
      } finally {
        await client.close();
        await server.close();
      }
    }
    expect(hostsSeen.length).toBe(3);
  } finally {
    for (const hostId of hosts) {
      await db`DELETE FROM central_command_events WHERE command_id IN (SELECT id FROM central_commands WHERE host_id = ${hostId})`;
      await db`DELETE FROM central_commands WHERE host_id = ${hostId}`;
    }
    await db.close();
  }
});

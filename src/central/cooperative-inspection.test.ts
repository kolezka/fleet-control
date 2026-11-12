import { SQL, type TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./commands.ts";
import { CentralAttempts } from "./attempts.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";
import { CooperativeClaims } from "./cooperative-claims.ts";
import { CooperativeLifecycle } from "./cooperative-lifecycle.ts";
import { CooperativeInspection } from "./cooperative-inspection.ts";

const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;

pgTest("inspection reads physical command, claim and ordered paginated lifecycle without credentials", async () => {
  const admin = new SQL(url!);
  const schema = `inspection_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const db = new SQL(url!, { connection: { search_path: schema } });
  try {
    expect((await db`SELECT current_schema() AS name`)[0]!.name).toBe(schema);
    const principal = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    const commands = new CentralCommands(db);
    const registry = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    const claims = new CooperativeClaims(db, incarnations);
    const lifecycle = new CooperativeLifecycle(db, incarnations);
    const inspection = new CooperativeInspection(db);
    await commands.initialize(); await new CentralAttempts(db).initialize(); await registry.initialize(); await incarnations.initialize(); await claims.initialize(); await lifecycle.initialize();
    await registry.enroll(principal);
    const credential = await incarnations.activate(principal);
    const command = (await commands.submit({ idempotencyKey: "one", hostId: "host", target: "session", actor: "operator", text: "work" })).command;
    const before = await inspection.inspect(command.id);
    expect(before?.command.status).toBe("queued");
    expect(before?.claim).toBeNull();
    expect(before?.events).toEqual([]);
    expect(await inspection.inspect("missing")).toBeNull();
    await claims.claim(principal, credential, "claim-one");
    await db`SELECT setval(pg_get_serial_sequence('central_cooperative_lifecycle_events', 'seq'), 9007199254740992)`;
    await lifecycle.report(principal, credential, command.id, "accept", "accepted", "accepted detail");
    await lifecycle.report(principal, credential, command.id, "run", "running", "running detail");
    await lifecycle.report(principal, credential, command.id, "done", "completed", "done detail");
    const page = await inspection.inspect(command.id, { limit: 2 });
    expect(page?.command.status).toBe("claimed");
    expect(page?.claim).toEqual({ incarnationId: credential.incarnationId, requestId: "claim-one", createdAt: page!.command.updatedAt });
    expect(page?.events.map((event) => [event.seq, event.status])).toEqual([["9007199254740993", "accepted"], ["9007199254740994", "running"]]);
    expect(page?.nextCursor).toBe("9007199254740994");
    const last = await inspection.inspect(command.id, { limit: 2, cursor: page!.nextCursor! });
    expect(last?.events.map((event) => [event.seq, event.status])).toEqual([["9007199254740995", "completed"]]);
    expect(last?.nextCursor).toBeNull();
    expect(JSON.stringify(page)).not.toContain(credential.token);
    expect(JSON.stringify(page)).not.toMatch(/token|hash/i);
    expect((await commands.get(command.id)).status).toBe("claimed");
    expect((await db`SELECT count(*)::int AS count FROM central_cooperative_lifecycle_events`)[0]!.count).toBe(3);
    for (const options of [{ limit: 0 }, { limit: 1001 }, { cursor: "01" }, { cursor: "9223372036854775808" }, { cursor: "-1" }]) await expect(inspection.inspect(command.id, options)).rejects.toThrow();
    await expect(inspection.inspect("")).rejects.toThrow();

    // Capture the actual PostgreSQL result before inspectBounded processes it.
    let sqlRows: Record<string, unknown>[] = [];
    const capturingDb = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = db(strings, ...values);
      return query.then((rows: Record<string, unknown>[]) => { sqlRows = rows; return rows; });
    }) as unknown as TransactionSQL;
    const bounded = new CooperativeInspection(db, async (operation) => operation(capturingDb));
    const firstEvent = page!.events[0]!;
    const rowFields = [...Object.values(page!.command), ...Object.values(page!.claim!), ...Object.values(firstEvent)];
    const baseBytes = rowFields.reduce((sum, value) => sum + Buffer.byteLength(String(value), "utf8"), 0) - Buffer.byteLength(firstEvent.detail, "utf8");
    const detailBytes = 270336 - baseBytes;
    const boundaryDetail = "é".repeat(Math.floor(detailBytes / 2)) + (detailBytes % 2 ? "x" : "");
    expect(Buffer.byteLength(boundaryDetail, "utf8") + baseBytes).toBe(270336);
    await db`UPDATE central_cooperative_lifecycle_events SET detail = ${boundaryDetail} WHERE seq = ${firstEvent.seq}::bigint`;
    const boundary = await bounded.inspectBounded(command.id, { limit: 1 });
    expect(boundary!.events[0]!.detail).toBe(boundaryDetail);
    expect(boundary!.nextCursor).toBe(firstEvent.seq);
    expect(sqlRows[0]!.oversized).toBe(false);
    expect(sqlRows[0]!.eventDetail).toBe(boundaryDetail);

    await db`UPDATE central_cooperative_lifecycle_events SET detail = ${boundaryDetail + "x"} WHERE seq = ${firstEvent.seq}::bigint`;
    await expect(bounded.inspectBounded(command.id, { limit: 1 })).rejects.toThrow("inspection page too large");
    expect(sqlRows[0]!.oversized).toBe(true);
    expect(Object.entries(sqlRows[0]!).filter(([key]) => key !== "oversized").every(([, value]) => value === null)).toBe(true);
    await db`UPDATE central_cooperative_lifecycle_events SET detail = ${boundaryDetail} WHERE seq = ${firstEvent.seq}::bigint`;
    await db`UPDATE central_cooperative_lifecycle_events SET detail = ${boundaryDetail + "xxxxxxxxxx"} WHERE seq = ${page!.events[1]!.seq}::bigint`;
    await expect(bounded.inspectBounded(command.id, { limit: 1 })).rejects.toThrow("inspection page too large");
    expect(sqlRows[0]!.oversized).toBe(false);
    expect(sqlRows[1]!.oversized).toBe(true);
    expect(Object.entries(sqlRows[1]!).filter(([key]) => key !== "oversized").every(([, value]) => value === null)).toBe(true);

  } finally {
    await db.close();
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
  }
});

import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./commands.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "../test-database-url.ts";

const url = centralTestDatabaseUrl(process.env);
const integration = url ? test : test.skip;

integration("command pagination filters before slicing and orders tied timestamps by id", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const hostId = `pagination-${crypto.randomUUID()}`;
  const store = new CentralCommands(db, () => new Date("2025-01-01T00:00:00.000Z"));
  try {
    await store.initialize();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { command } = await store.submit({ idempotencyKey: `${hostId}-${i}`, hostId, target: i === 4 ? "other" : "session", actor: "test", text: "test" });
      if (i === 1) await store.transition(command.id, "accepted", "test", "accepted");
      if (i < 4 && i !== 1) ids.push(command.id);
    }
    ids.sort();
    const scope = { hostId, target: "session" };
    const first = await store.list("queued", scope, { limit: 2 });
    expect(first.commands.map((command) => command.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).toBeTruthy();
    const second = await store.list("queued", scope, { limit: 2, cursor: first.nextCursor! });
    expect(second.commands.map((command) => command.id)).toEqual(ids.slice(2));
    expect(second.nextCursor).toBeNull();
    expect((await store.list("queued", scope, { limit: 3 })).nextCursor).toBeNull();
    expect((await store.list("queued", { hostId }, { limit: 10 })).commands).toHaveLength(4);
    expect((await store.list("accepted", scope, { limit: 10 })).commands).toHaveLength(1);
    const beyond = await store.list("queued", scope, { limit: 2, cursor: second.commands.length ? Buffer.from(JSON.stringify([second.commands[0]!.createdAt, second.commands[0]!.id, hostId, "session", "queued"])).toString("base64url") : "bad" });
    expect(beyond).toEqual({ commands: [], nextCursor: null });
    for (const limit of [0, -1, 1.5, 1001, NaN]) await expect(store.list(undefined, scope, { limit })).rejects.toThrow();
    for (const cursor of ["", "bad", "eyJ4IjoxfQ"]) await expect(store.list(undefined, scope, { cursor })).rejects.toThrow();
  } finally {
    await db`DELETE FROM central_command_events WHERE command_id IN (SELECT id FROM central_commands WHERE host_id = ${hostId})`;
    await db`DELETE FROM central_commands WHERE host_id = ${hostId}`;
    await db.close();
  }
});

integration("claimed records are readable but legacy transitions cannot enter or leave them", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const hostId = `claimed-${crypto.randomUUID()}`;
  const store = new CentralCommands(db);
  try {
    await store.initialize();
    const { command } = await store.submit({ idempotencyKey: hostId, hostId, target: "session", actor: "test", text: "test" });
    await expect(store.transition(command.id, "claimed", "test", "reserve")).rejects.toThrow(/cannot become claimed/);
    await db`UPDATE central_commands SET status = 'claimed' WHERE id = ${command.id}`;
    expect((await store.get(command.id)).status).toBe("claimed");
    expect((await store.list("claimed", { hostId })).commands.map((row) => row.id)).toEqual([command.id]);
    for (const status of ["queued", "delivering", "delivered", "delivery_unknown", "claimed", "accepted", "rejected", "running", "completed", "failed"] as const) {
      await expect(store.transition(command.id, status, "test", "legacy transition")).rejects.toThrow(/cannot become/);
    }
    await expect(store.transitionScoped(command.id, "accepted", "test", "accept", { hostId, session: "session" }, async () => true)).rejects.toThrow(/cannot become accepted/);
    expect((await store.events(command.id)).map((event) => event.status)).toEqual(["queued"]);
  } finally {
    await db`DELETE FROM central_command_events WHERE command_id IN (SELECT id FROM central_commands WHERE host_id = ${hostId})`;
    await db`DELETE FROM central_commands WHERE host_id = ${hostId}`;
    await db.close();
  }
});

integration("PostgreSQL command contract survives concurrency and reconnect", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const other = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const key = `test-${crypto.randomUUID()}`;
  const input = { idempotencyKey: key, hostId: "host-a", target: "supervisor", actor: "client", text: "run tests" };
  try {
    const store = new CentralCommands(db);
    const second = new CentralCommands(other);
    await store.initialize();
    await second.initialize();
    const submissions = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? store : second).submit(input)));
    expect(submissions.filter((result) => result.created)).toHaveLength(1);
    const id = submissions[0]!.command.id;
    expect(new Set(submissions.map((result) => result.command.id)).size).toBe(1);
    expect((await store.events(id)).map((event) => event.status)).toEqual(["queued"]);
    await expect(second.submit({ ...input, hostId: "host-b" })).rejects.toThrow(/different command/);
    await expect(store.submit({ ...input, text: "other" })).rejects.toThrow(/different command/);
    await expect(store.submit({ ...input, idempotencyKey: `${key}-bad`, target: "bad name" })).rejects.toThrow(/invalid target/);
    await expect(store.transition(id, "completed", "worker", "done")).rejects.toThrow(/cannot become completed/);
    await expect(store.transition(id, "delivering", null as unknown as string, "invalid event")).rejects.toThrow();
    expect((await store.get(id)).status).toBe("queued");
    expect((await store.events(id)).map((event) => event.status)).toEqual(["queued"]);
    const attempts = await Promise.allSettled([
      store.transition(id, "delivering", "service", "send"),
      second.transition(id, "delivering", "service", "send"),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await store.events(id)).map((event) => event.status)).toEqual(["queued", "delivering"]);
    await db.close();
    expect(await second.reconcileAfterRestart()).toContain(id);
    expect((await second.get(id)).status).toBe("delivery_unknown");
    expect((await second.submit(input)).created).toBe(false);
    await expect(second.transition(id, "delivering", "service", "retry")).rejects.toThrow(/cannot become delivering/);
    await second.transition(id, "accepted", "worker", "accepted");
    await second.transition(id, "completed", "worker", "done");
    const events = await second.events(id);
    expect(events.map((event) => event.status)).toEqual(["queued", "delivering", "delivery_unknown", "accepted", "completed"]);
    expect((await second.events(id, events[1]!.seq)).map((event) => event.status)).toEqual(["delivery_unknown", "accepted", "completed"]);
    const another = await second.submit({ ...input, idempotencyKey: `${key}-other-host`, hostId: "host-b" });
    expect(another.command.hostId).toBe("host-b");
    expect(another.command.target).toBe(input.target);
  } finally {
    await db.close();
    await other.close();
  }
});


integration("scoped supervisor transitions guard and write atomically", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const hostId = `scoped-${crypto.randomUUID()}`;
  const store = new CentralCommands(db);
  const scope = { hostId, session: "supervisor" };
  try {
    await store.initialize();
    const { command } = await store.submit({ idempotencyKey: hostId, hostId, target: scope.session, actor: "operator", text: "original" });
    const guardWrite = async (tx: import("bun").TransactionSQL) => {
      await tx`UPDATE central_commands SET text = 'guard write' WHERE id = ${command.id}`;
      return true;
    };
    await expect(store.transitionScoped(command.id, "accepted", "supervisor", "accept", scope, async (tx) => {
      await guardWrite(tx);
      return false;
    })).rejects.toThrow("access denied");
    expect((await store.get(command.id)).text).toBe("original");
    expect((await store.get(command.id)).status).toBe("queued");
    expect((await store.events(command.id)).map((event) => event.status)).toEqual(["queued"]);

    for (const [id, otherScope] of [
      [command.id, { hostId: "wrong", session: scope.session }],
      [command.id, { hostId, session: "wrong" }],
      ["missing", scope],
    ] as const) {
      await expect(store.transitionScoped(id, "accepted", "supervisor", "accept", otherScope, guardWrite)).rejects.toThrow("access denied");
    }
    await expect(store.transitionScoped(command.id, "completed", "supervisor", "done", scope, guardWrite)).rejects.toThrow("cannot become completed");
    expect((await store.get(command.id)).text).toBe("original");
    expect((await store.events(command.id)).map((event) => event.status)).toEqual(["queued"]);

    const accepted = await store.transitionScoped(command.id, "accepted", "supervisor", "accept", scope, guardWrite);
    expect(accepted.status).toBe("accepted");
    expect(accepted.text).toBe("guard write");
    await store.transitionScoped(command.id, "completed", "supervisor", "evidence", scope, async () => true);
    expect((await store.events(command.id)).map(({ status, actor, detail }) => ({ status, actor, detail }))).toEqual([
      { status: "queued", actor: "operator", detail: "stored on central server" },
      { status: "accepted", actor: "supervisor", detail: "accept" },
      { status: "completed", actor: "supervisor", detail: "evidence" },
    ]);
  } finally {
    await db`DELETE FROM central_command_events WHERE command_id IN (SELECT id FROM central_commands WHERE host_id = ${hostId})`;
    await db`DELETE FROM central_commands WHERE host_id = ${hostId}`;
    await db.close();
  }
});

integration("command event cursors preserve exact PostgreSQL bigint values", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const store = new CentralCommands(db);
  const id = `cursor-${crypto.randomUUID()}`;
  try {
    await store.initialize();
    await db`INSERT INTO central_commands (id, idempotency_key, host_id, target, actor, text, status, created_at, updated_at) VALUES (${id}, ${id}, 'test', 'test', 'test', 'test', 'queued', 'now', 'now')`;
    await db`INSERT INTO central_command_events (seq, command_id, status, actor, detail, at) VALUES (9007199254740992, ${id}, 'queued', 'test', '', 'now'), (9007199254740993, ${id}, 'accepted', 'test', '', 'now'), (9007199254740994, ${id}, 'completed', 'test', '', 'now')`;
    await db`INSERT INTO central_command_events (seq, command_id, status, actor, detail, at) VALUES (999999999999999, ${id}, 'queued', 'test', '', 'now')`;
    expect((await store.events(id, "999999999999998")).map((event) => event.seq)).toEqual(["999999999999999", "9007199254740992", "9007199254740993", "9007199254740994"]);
    const events = await store.events(id, "9007199254740991");
    expect(events.map((event) => event.seq)).toEqual(["9007199254740992", "9007199254740993", "9007199254740994"]);
    expect((await store.events(id, events[0]!.seq)).map((event) => event.seq)).toEqual(["9007199254740993", "9007199254740994"]);
    expect((await store.events(undefined, "9007199254740993")).filter((event) => event.commandId === id).map((event) => event.seq)).toEqual(["9007199254740994"]);
    for (const cursor of ["-1", "01", "1.0", " 1", "9223372036854775808", "", 1, null]) {
      await expect(store.events(id, cursor as string)).rejects.toMatchObject({ kind: "invalid" });
    }
    expect(await store.events(id, "9223372036854775807")).toEqual([]);
  } finally {
    await db`DELETE FROM central_command_events WHERE command_id = ${id}`;
    await db`DELETE FROM central_commands WHERE id = ${id}`;
    await db.close();
  }
});

integration("guarded reads enforce scope and share the guard transaction", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const hostId = `read-${crypto.randomUUID()}`;
  const store = new CentralCommands(db);
  const scope = { hostId, session: "supervisor" };
  try {
    await store.initialize();
    const a = (await store.submit({ idempotencyKey: `${hostId}-a`, hostId, target: scope.session, actor: "operator", text: "one" })).command;
    const b = (await store.submit({ idempotencyKey: `${hostId}-b`, hostId, target: "other", actor: "operator", text: "two" })).command;
    const guard = async (tx: import("bun").TransactionSQL, actual: typeof scope) => {
      expect(actual).toEqual(scope);
      await tx`UPDATE central_commands SET text = 'transactional' WHERE id = ${a.id}`;
      return true;
    };
    expect((await store.getScoped(a.id, scope, guard)).text).toBe("transactional");
    expect((await store.listScoped(undefined, scope, guard)).commands.map((c) => c.id)).toEqual([a.id]);
    expect((await store.eventsScoped(a.id, scope, guard)).map((e) => e.commandId)).toEqual([a.id]);
    for (const read of [() => store.getScoped(b.id, scope, guard), () => store.eventsScoped(b.id, scope, guard), () => store.getScoped("missing", scope, guard)]) {
      await expect(read()).rejects.toThrow("access denied");
    }
    for (const read of [() => store.getScoped(a.id, scope, async () => false), () => store.listScoped(undefined, scope, async () => false), () => store.eventsScoped(a.id, scope, async () => false)]) {
      await expect(read()).rejects.toThrow("access denied");
    }
    const page = await store.listScoped(undefined, scope, guard, { limit: 1 });
    const forged = Buffer.from(JSON.stringify([a.createdAt, a.id, hostId, "other", null])).toString("base64url");
    expect(page.commands).toHaveLength(1);
    await expect(store.listScoped(undefined, scope, guard, { cursor: forged })).rejects.toThrow("invalid cursor");
    expect((await store.get(b.id)).id).toBe(b.id);
    expect((await store.list(undefined, { hostId })).commands).toHaveLength(2);
  } finally {
    await db`DELETE FROM central_command_events WHERE command_id IN (SELECT id FROM central_commands WHERE host_id = ${hostId})`;
    await db`DELETE FROM central_commands WHERE host_id = ${hostId}`;
    await db.close();
  }
});

integration("guarded reads serialize with incarnation replacement in both orders", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const other = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const inspector = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const registry = new SupervisorIdentityRegistry(db);
  const incarnations = new SupervisorIncarnations(db);
  const rivalConnection = await other.reserve();
  const rival = new SupervisorIncarnations(rivalConnection);
  const store = new CentralCommands(db);
  const identity = { principalId: crypto.randomUUID(), name: "supervisor", hostId: `read-lock-${crypto.randomUUID()}`, session: "session" };
  let release = () => {};
  const blocked = async (pid: number, blocker: number) => {
    for (let i = 0; i < 200; i++) {
      const [row] = await inspector<{ blocked: boolean }[]>`SELECT ${blocker} = ANY(pg_blocking_pids(${pid})) AS blocked`;
      if (row!.blocked) return true;
      await Bun.sleep(10);
    }
    return false;
  };
  try {
    await store.initialize(); await registry.initialize(); await incarnations.initialize(); await registry.enroll(identity);
    const original = await incarnations.activate(identity);
    const command = (await store.submit({ idempotencyKey: identity.hostId, hostId: identity.hostId, target: identity.session, actor: "operator", text: "work" })).command;
    let locked!: (pid: number) => void;
    const ready = new Promise<number>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = store.getScoped(command.id, identity, async (tx) => {
      const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const valid = await incarnations.lockForClaim(tx, identity, original);
      locked(row!.pid); await gate; return valid;
    });
    const readPid = await ready;
    const [rivalPid] = await rivalConnection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const replacement = rival.activate(identity);
    const wasBlocked = await blocked(rivalPid!.pid, readPid);
    release(); expect((await read).id).toBe(command.id); expect(wasBlocked).toBe(true);
    const current = await replacement;
    await expect(store.getScoped(command.id, identity, (tx) => incarnations.lockForClaim(tx, identity, original))).rejects.toThrow("access denied");

    let replacementReady!: (pid: number) => void;
    const replacementLocked = new Promise<number>((resolve) => { replacementReady = resolve; });
    const replacementGate = new Promise<void>((resolve) => { release = resolve; });
    const revoke = rivalConnection.begin(async (tx) => {
      const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT host_id FROM central_supervisor_slots_v2 WHERE host_id = ${identity.hostId} AND session = ${identity.session} FOR UPDATE`;
      await tx`UPDATE central_supervisor_incarnations_v2 SET active = FALSE WHERE id = ${current.incarnationId}`;
      replacementReady(row!.pid); await replacementGate;
    });
    const revokePid = await replacementLocked;
    let readStarted!: (pid: number) => void;
    const started = new Promise<number>((resolve) => { readStarted = resolve; });
    const denied = store.listScoped(undefined, identity, async (tx) => {
      const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      readStarted(row!.pid);
      return incarnations.lockForClaim(tx, identity, current);
    });
    const observed = await blocked(await started, revokePid);
    release(); await revoke; await expect(denied).rejects.toThrow("access denied"); expect(observed).toBe(true);
  } finally {
    release();
    await db`DELETE FROM central_command_events WHERE command_id IN (SELECT id FROM central_commands WHERE host_id = ${identity.hostId})`;
    await db`DELETE FROM central_commands WHERE host_id = ${identity.hostId}`;
    await db`DELETE FROM central_supervisor_incarnations_v2 WHERE principal_id = ${identity.principalId}`;
    await db`DELETE FROM central_supervisor_identities_v2 WHERE principal_id = ${identity.principalId}`;
    await db`DELETE FROM central_supervisor_slots_v2 WHERE host_id = ${identity.hostId} AND session = ${identity.session}`;
    await rivalConnection.release(); await db.close(); await other.close(); await inspector.close();
  }
});

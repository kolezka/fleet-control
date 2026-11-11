import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands, type CentralCommand } from "./commands.ts";
import { CentralAttempts } from "./attempts.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";
import { CooperativeClaims } from "./cooperative-claims.ts";

const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;

async function isolatedDatabase() {
  const admin = new SQL(url!);
  const schema = `cooperative test"${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await admin`CREATE SCHEMA ${admin(schema)}`;
  } catch (error) {
    await admin.close();
    throw error;
  }
  const options = { connection: { search_path: `"${schema.replaceAll('"', '""')}"` } };
  const db = new SQL(url!, options);
  const other = new SQL(url!, options);
  return {
    db, other, schema,
    async close() {
      try {
        await Promise.all([db.close(), other.close()]);
      } finally {
        try {
          await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
        } finally {
          await admin.close();
        }
      }
    },
  };
}

pgTest("claims serialize, persist empty requests, fence legacy mutations and replacement", async () => {
  const isolated = await isolatedDatabase();
  const { db, other } = isolated;
  const hostId = `claim-${crypto.randomUUID()}`;
  const principal = { role: "supervisor" as const, principalId: hostId, name: hostId, hostId, session: "session" };
  const commands = new CentralCommands(db, () => new Date("2025-01-01T00:00:00.000Z"));
  const identities = new SupervisorIdentityRegistry(db);
  const incarnations = new SupervisorIncarnations(db);
  const claims = new CooperativeClaims(db, incarnations);
  const rival = new CooperativeClaims(other, new SupervisorIncarnations(other));
  try {
    await commands.initialize();
    await new CentralAttempts(db).initialize();
    await identities.initialize();
    await incarnations.initialize();
    await claims.initialize();
    const [location] = await db`SELECT current_schema() AS schema, (SELECT n.nspname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE t.tgname = 'central_block_cooperative_claim_mutation' AND n.nspname = current_schema()) AS trigger_schema`;
    expect(location.schema).toBe(isolated.schema);
    expect(location.trigger_schema).toBe(isolated.schema);
    const [otherLocation] = await other`SELECT current_schema() AS schema`;
    expect(otherLocation.schema).toBe(isolated.schema);
    const aliasBase = `alias-${crypto.randomUUID()}`;
    const malformed = { ...principal, principalId: `${aliasBase}\ud800` };
    const replacementIdentity = { ...principal, principalId: `${aliasBase}\ufffd` };
    await expect(identities.enroll(malformed)).rejects.toThrow("invalid supervisor identity");
    expect(await identities.matches(malformed)).toBe(false);
    await identities.enroll(replacementIdentity);
    await expect(incarnations.activate(malformed)).rejects.toThrow();
    const replacementCredential = await incarnations.activate(replacementIdentity);
    await expect(claims.claim(malformed, replacementCredential, "alias-claim")).rejects.toThrow("access denied");
    expect(await db`SELECT 1 FROM central_cooperative_claims WHERE request_id = ${"alias-claim"}`).toHaveLength(0);
    expect(await identities.matches(replacementIdentity)).toBe(true);
    await identities.enroll(principal);
    const credential = await incarnations.activate(principal);
    const badInput = { idempotencyKey: `unicode-${crypto.randomUUID()}`, hostId, target: "session", actor: "operator", text: "bad\ud800" };
    for (const field of ["idempotencyKey", "hostId", "target", "actor", "text"] as const) {
      const input = { ...badInput, text: "work", [field]: `bad\ud800` };
      for (const submit of [commands.submit.bind(commands), commands.submitBounded.bind(commands)]) {
        await expect(submit(input)).rejects.toThrow("invalid command encoding");
      }
    }
    expect(await db`SELECT id FROM central_commands`).toHaveLength(0);
    const validInput = { ...badInput, target: "other", text: "work 😀" };
    expect((await commands.submitBounded(validInput)).created).toBe(true);
    expect((await commands.submitBounded(validInput)).created).toBe(false);
    for (const requestId of ["bad\ud800", "bad\udc00"]) {
      await expect(claims.claim(principal, credential, requestId)).rejects.toThrow("invalid claim request ID");
    }
    expect(await db`SELECT request_id FROM central_cooperative_claims`).toHaveLength(0);
    expect(await claims.claim(principal, credential, "valid-😀")).toBeNull();
    expect(await claims.claim(principal, credential, "empty")).toBeNull();
    await expect(claims.claim(principal, credential, "empty", () => false)).rejects.toThrow("unsafe claim response");
    const submit = (i: string, target = "session") => commands.submit({ idempotencyKey: `${hostId}-${i}`, hostId, target, actor: "operator", text: i });
    const one = (await submit("one")).command;
    const two = (await submit("two")).command;
    await submit("other", "other");
    expect(await claims.claim(principal, credential, "empty")).toBeNull();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? claims : rival).claim(principal, credential, "same")));
    expect(new Set(results.map((item) => item?.id)).size).toBe(1);
    expect(results[0]?.id).toBe([one.id, two.id].sort()[0]);
    const first = results[0]!;
    await expect(claims.claim(principal, credential, "same", () => { throw new Error("private guard detail"); })).rejects.toThrow("unsafe claim response");
    expect(await claims.claim(principal, credential, "same")).toEqual(first);
    await expect(claims.claim(principal, credential, "rejected", () => false)).rejects.toThrow("unsafe claim response");
    expect(await db`SELECT 1 FROM central_cooperative_claims WHERE request_id = ${"rejected"}`).toHaveLength(0);
    const remainingId = first.id === one.id ? two.id : one.id;
    expect((await commands.get(remainingId)).status).toBe("queued");
    for (const failure of ["false", "throw"] as const) {
      const candidates: (CentralCommand | null)[] = [];
      const before = await other`SELECT * FROM central_commands WHERE id = ${remainingId}`;
      const requestId = `post-update-${failure}`;
      await expect(claims.claim(principal, credential, requestId, (candidate) => {
        candidates.push(candidate);
        if (candidates.length === 1) return true;
        if (failure === "throw") throw new Error("private guard detail");
        return false;
      })).rejects.toThrow("unsafe claim response");
      expect(candidates).toHaveLength(2);
      expect(candidates[0]?.id).toBe(remainingId);
      expect(candidates[0]?.status).toBe("claimed");
      expect(candidates[1]).toEqual(candidates[0]);
      expect(await other`SELECT * FROM central_commands WHERE id = ${remainingId}`).toEqual(before);
      expect(await other`SELECT 1 FROM central_cooperative_claims WHERE request_id = ${requestId}`).toHaveLength(0);
      expect((await other<{ status: string }[]>`SELECT status FROM central_command_events WHERE command_id = ${remainingId} ORDER BY seq`).map((event) => event.status)).toEqual(["queued"]);
    }
    const second = (await claims.claim(principal, credential, "next"))!;
    expect(second.id).not.toBe(first.id);
    expect(await claims.claim(principal, credential, "end")).toBeNull();
    expect((await commands.events(first.id)).map((e) => e.status)).toEqual(["queued", "claimed"]);
    await expect(commands.transition(first.id, "accepted", "legacy", "accept")).rejects.toThrow(/claimed/);
    await expect(new CentralAttempts(other).begin(first.id, hostId)).rejects.toThrow(/claimed/);
    expect(await other`SELECT id FROM central_delivery_attempts WHERE command_id = ${first.id}`).toHaveLength(0);
    expect((await commands.get(first.id)).status).toBe("claimed");
    await expect(claims.claim({ role: "operator", name: "operator" }, credential, "bad")).rejects.toThrow(/denied/);
    await expect(claims.claim(principal, credential, "x".repeat(257))).rejects.toThrow(/invalid/);
    const replacement = await incarnations.activate(principal);
    await expect(claims.claim(principal, credential, "same")).rejects.toThrow(/denied/);
    expect(await claims.claim(principal, replacement, "same")).toBeNull();
  } finally {
    await isolated.close();
  }
});

pgTest("safeResponse mutations cannot alter new claims or exact replays", async () => {
  const isolated = await isolatedDatabase();
  const { db, other } = isolated;
  const hostId = `claim-mutation-${crypto.randomUUID()}`;
  const principal = { role: "supervisor" as const, principalId: hostId, name: hostId, hostId, session: "session" };
  const commands = new CentralCommands(db, () => new Date("2025-01-01T00:00:00.000Z"));
  const identities = new SupervisorIdentityRegistry(db);
  const incarnations = new SupervisorIncarnations(db);
  const claims = new CooperativeClaims(db, incarnations, () => new Date("2025-01-02T00:00:00.000Z"));
  try {
    await commands.initialize(); await new CentralAttempts(db).initialize(); await identities.initialize(); await incarnations.initialize(); await claims.initialize();
    await identities.enroll(principal);
    const credential = await incarnations.activate(principal);
    const { command } = await commands.submit({ idempotencyKey: hostId, hostId, target: "session", actor: "operator", text: "original work" });
    const expected: CentralCommand = { ...command, status: "claimed", updatedAt: "2025-01-02T00:00:00.000Z" };
    const seen: (CentralCommand | null)[] = [];
    const mutate = (candidate: CentralCommand | null) => {
      seen.push(candidate ? { ...candidate } : null);
      if (candidate) Object.assign(candidate, { id: "mutated-id", text: "mutated text", status: "completed", updatedAt: "mutated time" });
      return true;
    };
    expect(await claims.claim(principal, credential, "request", mutate)).toEqual(expected);
    expect(seen).toEqual([expected, expected]);
    const durableCommand = await other`SELECT * FROM central_commands WHERE id = ${command.id}`;
    const durableClaim = await other`SELECT * FROM central_cooperative_claims WHERE incarnation_id = ${credential.incarnationId} AND request_id = ${"request"}`;
    const durableEvents = await other<{ status: string; command_id: string; actor: string; detail: string; at: string }[]>`SELECT * FROM central_command_events WHERE command_id = ${command.id} ORDER BY seq`;
    expect(durableCommand).toHaveLength(1);
    expect(durableCommand[0]).toEqual({ id: command.id, idempotency_key: command.idempotencyKey, host_id: command.hostId, target: command.target, actor: command.actor, text: command.text, status: "claimed", created_at: command.createdAt, updated_at: expected.updatedAt });
    expect(durableClaim).toHaveLength(1);
    expect(durableClaim[0]).toMatchObject({ incarnation_id: credential.incarnationId, request_id: "request", command_id: command.id, created_at: expected.updatedAt });
    expect(durableEvents.map((event) => event.status)).toEqual(["queued", "claimed"]);
    expect(durableEvents[1]).toMatchObject({ command_id: command.id, actor: principal.name, detail: `cooperative claim ${credential.incarnationId}`, at: expected.updatedAt });
    seen.length = 0;
    expect(await claims.claim(principal, credential, "request", mutate)).toEqual(expected);
    expect(seen).toEqual([expected]);
    expect(await other`SELECT * FROM central_commands WHERE id = ${command.id}`).toEqual(durableCommand);
    expect(await other`SELECT * FROM central_cooperative_claims WHERE incarnation_id = ${credential.incarnationId} AND request_id = ${"request"}`).toEqual(durableClaim);
    expect(await other`SELECT * FROM central_command_events WHERE command_id = ${command.id} ORDER BY seq`).toEqual(durableEvents);
  } finally {
    await isolated.close();
  }
});

pgTest("claimed commands remain fenced under a hostile caller search path", async () => {
  const isolated = await isolatedDatabase();
  const { db, schema } = isolated;
  const hostile = `hostile_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(url!, { max: 1 });
  const hostId = `fence-${crypto.randomUUID()}`;
  const principal = { role: "supervisor" as const, principalId: hostId, name: hostId, hostId, session: "session" };
  const commands = new CentralCommands(db);
  const identities = new SupervisorIdentityRegistry(db);
  const incarnations = new SupervisorIncarnations(db);
  try {
    await commands.initialize(); await new CentralAttempts(db).initialize(); await identities.initialize(); await incarnations.initialize();
    await new CooperativeClaims(db, incarnations).initialize();
    await identities.enroll(principal);
    const credential = await incarnations.activate(principal);
    const { command } = await commands.submit({ idempotencyKey: hostId, hostId, target: "session", actor: "operator", text: "work" });
    await new CooperativeClaims(db, incarnations).claim(principal, credential, "request");
    await admin`CREATE SCHEMA ${admin(hostile)}`;
    await admin`CREATE TABLE ${admin(hostile)}.central_cooperative_claims (command_id text)`;
    await admin`SET search_path TO ${admin(hostile)}, ${admin(schema)}, pg_catalog`;
    const [control] = await admin`SELECT count(*)::int AS count FROM central_cooperative_claims`;
    expect(control.count).toBe(0);
    await expect(admin`UPDATE ${admin(schema)}.central_commands SET status = 'accepted' WHERE id = ${command.id}`).rejects.toThrow(/claimed command cannot be mutated/);
    await expect(admin`DELETE FROM ${admin(schema)}.central_commands WHERE id = ${command.id}`).rejects.toThrow(/claimed command cannot be mutated/);
  } finally {
    try { await admin`DROP SCHEMA IF EXISTS ${admin(hostile)} CASCADE`; } finally { await admin.close(); await isolated.close(); }
  }
});

pgTest("initialization does not resolve missing tables in a later schema", async () => {
  const isolated = await isolatedDatabase();
  const { db, schema } = isolated;
  const first = `first_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(url!);
  let installer: SQL | undefined;
  try {
    await new CentralCommands(db).initialize();
    await new CentralAttempts(db).initialize();
    await new SupervisorIdentityRegistry(db).initialize();
    await new SupervisorIncarnations(db).initialize();
    await new CooperativeClaims(db, new SupervisorIncarnations(db)).initialize();
    await admin`CREATE SCHEMA ${admin(first)}`;
    const path = `"${first.replaceAll('"', '""')}","${schema.replaceAll('"', '""')}"`;
    installer = new SQL(url!, { connection: { search_path: path } });
    await expect(new CooperativeClaims(installer, new SupervisorIncarnations(installer)).initialize()).rejects.toThrow();
    const [result] = await db`SELECT count(*)::int AS count FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schema} AND t.tgname = 'central_block_cooperative_claim_mutation'`;
    expect(result.count).toBe(1);
    const [objects] = await admin`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${first} AND c.relname = 'central_cooperative_claims'`;
    expect(objects.count).toBe(0);
  } finally {
    await installer?.close();
    try { await admin`DROP SCHEMA IF EXISTS ${admin(first)} CASCADE`; } finally { await admin.close(); await isolated.close(); }
  }
});

pgTest("rollback and event-lock races exclude prior delivery and stale claims", async () => {
  const isolated = await isolatedDatabase();
  const { db, other } = isolated;
  const hostId = `claim-race-${crypto.randomUUID()}`;
  const principal = { role: "supervisor" as const, principalId: hostId, name: hostId, hostId, session: "session" };
  const commands = new CentralCommands(db);
  const attempts = new CentralAttempts(db);
  const identities = new SupervisorIdentityRegistry(db);
  const incarnations = new SupervisorIncarnations(db);
  const claims = new CooperativeClaims(db, incarnations);
  let release = () => {};
  try {
    await commands.initialize(); await attempts.initialize(); await identities.initialize(); await incarnations.initialize(); await claims.initialize();
    await identities.enroll(principal);
    const credential = await incarnations.activate(principal);
    const { command } = await commands.submit({ idempotencyKey: hostId, hostId, target: "session", actor: "operator", text: "work" });
    const broken = new CooperativeClaims(db, incarnations, () => { throw new Error("clock failure"); });
    await expect(broken.claim(principal, credential, "rollback")).rejects.toThrow("clock failure");
    expect(await db`SELECT * FROM central_cooperative_claims WHERE incarnation_id = ${credential.incarnationId}`).toHaveLength(0);
    expect(await commands.events(command.id)).toHaveLength(1);
    let locked = () => {};
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = other.begin(async (tx) => {
      await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      locked(); await gate;
      await tx`INSERT INTO central_delivery_attempts (id, command_id, host_id, status) VALUES (${`attempt-${crypto.randomUUID()}`}, ${command.id}, ${hostId}, 'unknown')`;
    });
    await ready;
    const pending = claims.claim(principal, credential, "race");
    release(); await holder;
    expect(await pending).toBeNull();
    expect(await commands.events(command.id)).toHaveLength(1);
    expect(await claims.claim(principal, credential, "after")).toBeNull();
  } finally {
    release();
    await isolated.close();
  }
});

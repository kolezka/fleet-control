import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./commands.ts";
import { CentralAttempts } from "./attempts.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";
import { CooperativeClaims } from "./cooperative-claims.ts";
import { CooperativeLifecycle } from "./cooperative-lifecycle.ts";

const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;

pgTest("claim lifecycle is atomic, owned, idempotent and leaves commands frozen", async () => {
  const admin = new SQL(url!);
  const schema = `lifecycle_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const db = new SQL(url!, { connection: { search_path: schema } });
  const other = new SQL(url!, { connection: { search_path: schema } });
  try {
    expect((await db`SELECT current_schema() AS name`)[0]!.name).toBe(schema);
    expect((await other`SELECT current_schema() AS name`)[0]!.name).toBe(schema);
    const principal = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    const commands = new CentralCommands(db);
    const registry = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    const claims = new CooperativeClaims(db, incarnations);
    const lifecycle = new CooperativeLifecycle(db, incarnations);
    const rival = new CooperativeLifecycle(other, new SupervisorIncarnations(other));
    await commands.initialize(); await new CentralAttempts(db).initialize(); await registry.initialize(); await incarnations.initialize(); await claims.initialize(); await lifecycle.initialize();
    await registry.enroll(principal);
    const credential = await incarnations.activate(principal);
    const { command } = await commands.submit({ idempotencyKey: "one", hostId: "host", target: "session", actor: "operator", text: "work" });
    await claims.claim(principal, credential, "claim-one");
    const report = (request: string, status: "accepted" | "rejected" | "running" | "completed" | "failed", detail = "evidence") => lifecycle.report(principal, credential, command.id, request, status, detail);
    await expect(report("early", "running")).rejects.toThrow(/cannot become/);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? lifecycle : rival).report(principal, credential, command.id, "accept", "accepted", "evidence")));
    expect(new Set(results.map((item) => JSON.stringify(item))).size).toBe(1);
    await expect(report("accept", "accepted", "different")).rejects.toThrow(/different intent/);
    await report("run", "running");
    await report("done", "completed");
    expect(await report("accept", "accepted")).toEqual(results[0]!);
    await expect(report("fail", "failed")).rejects.toThrow(/cannot become/);
    expect((await commands.get(command.id)).status).toBe("claimed");
    expect((await commands.events(command.id)).map((item) => item.status)).toEqual(["queued", "claimed"]);
    expect((await db<{ status: string }[]>`SELECT status FROM central_cooperative_lifecycle_events ORDER BY seq`).map((row) => row.status)).toEqual(["accepted", "running", "completed"]);
    await expect(lifecycle.report(principal, credential, "unknown", "x", "accepted", "")).rejects.toThrow(/denied/);
    const second = (await commands.submit({ idempotencyKey: "two", hostId: "host", target: "session", actor: "operator", text: "other" })).command;
    await claims.claim(principal, credential, "claim-two");
    await expect(lifecycle.report(principal, credential, second.id, "accept", "accepted", "evidence")).rejects.toThrow(/different intent/);
    const broken = new CooperativeLifecycle(db, incarnations, () => { throw new Error("clock failure"); });
    await expect(broken.report(principal, credential, second.id, "rollback", "rejected", "no")).rejects.toThrow("clock failure");
    expect(await db`SELECT request_id FROM central_cooperative_lifecycle_events WHERE command_id = ${second.id}`).toHaveLength(0);
    await lifecycle.report(principal, credential, second.id, "reject", "rejected", "no");
    await expect(lifecycle.report(principal, credential, second.id, "after-reject", "completed", "")).rejects.toThrow(/cannot become/);
    const replacement = await incarnations.activate(principal);
    await expect(report("accept", "accepted")).rejects.toThrow(/denied/);
    await expect(lifecycle.report(principal, replacement, command.id, "new", "failed", "")).rejects.toThrow(/denied/);
  } finally {
    await Promise.all([db.close(), other.close()]);
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
  }
});

pgTest("concurrent lifecycle conflicts and post-insert rollback", async () => {
  const admin = new SQL(url!);
  const schema = `lifecycle_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const db = new SQL(url!, { connection: { search_path: schema } });
  const other = new SQL(url!, { connection: { search_path: schema } });
  try {
    const principal = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    const commands = new CentralCommands(db);
    const registry = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    const claims = new CooperativeClaims(db, incarnations);
    const lifecycle = new CooperativeLifecycle(db, incarnations);
    const rival = new CooperativeLifecycle(other, new SupervisorIncarnations(other));
    await commands.initialize(); await new CentralAttempts(db).initialize(); await registry.initialize(); await incarnations.initialize(); await claims.initialize(); await lifecycle.initialize();
    await registry.enroll(principal);
    const credential = await incarnations.activate(principal);
    async function claimed(key: string) {
      const { command } = await commands.submit({ idempotencyKey: key, hostId: "host", target: "session", actor: "operator", text: key });
      await claims.claim(principal, credential, `claim-${key}`);
      return command;
    }
    const first = await claimed("competing");
    const outcomes = await Promise.allSettled([
      lifecycle.report(principal, credential, first.id, "accept", "accepted", "yes"),
      rival.report(principal, credential, first.id, "reject", "rejected", "no"),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    const events = await db`SELECT status FROM central_cooperative_lifecycle_events WHERE command_id = ${first.id}`;
    expect(events).toHaveLength(1);
    const winner = outcomes.find((r) => r.status === "fulfilled");
    expect(events[0]!.status).toBe(winner?.status === "fulfilled" ? winner.value.status : "impossible");

    const second = await claimed("same-id");
    const conflicts = await Promise.allSettled([
      lifecycle.report(principal, credential, second.id, "same", "accepted", "one"),
      rival.report(principal, credential, second.id, "same", "accepted", "two"),
    ]);
    expect(conflicts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = conflicts.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.message).toMatch(/different intent/);
    expect(await db`SELECT request_id FROM central_cooperative_lifecycle_events WHERE command_id = ${second.id}`).toHaveLength(1);

    const third = await claimed("rollback");
    await db`CREATE FUNCTION fail_lifecycle_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected post-insert failure'; END $$`;
    await db`CREATE TRIGGER fail_lifecycle_insert AFTER INSERT ON central_cooperative_lifecycle_events FOR EACH ROW EXECUTE FUNCTION fail_lifecycle_insert()`;
    await expect(lifecycle.report(principal, credential, third.id, "retry", "accepted", "evidence")).rejects.toThrow(/injected post-insert failure/);
    expect(await db`SELECT request_id FROM central_cooperative_lifecycle_events WHERE command_id = ${third.id}`).toHaveLength(0);
    await db`DROP TRIGGER fail_lifecycle_insert ON central_cooperative_lifecycle_events`;
    expect((await lifecycle.report(principal, credential, third.id, "retry", "accepted", "evidence")).status).toBe("accepted");
    await registry.retire(principal);
    await expect(lifecycle.report(principal, credential, third.id, "retry", "accepted", "evidence")).rejects.toThrow(/denied/);
    expect(await db`SELECT request_id FROM central_cooperative_lifecycle_events WHERE command_id = ${third.id}`).toHaveLength(1);
  } finally {
    await Promise.all([db.close(), other.close()]);
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
  }
});

pgTest("replacement and report serialize in both lock orders", async () => {
  const admin = new SQL(url!);
  const schema = `lifecycle_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const db = new SQL(url!, { connection: { search_path: schema, application_name: `${schema}_report` }, max: 1 });
  const other = new SQL(url!, { connection: { search_path: schema, application_name: `${schema}_replace` }, max: 1 });
  const barrier = new SQL(url!, { connection: { search_path: schema }, max: 1 });
  const observer = new SQL(url!, { connection: { search_path: schema } });
  let release: (() => void) | undefined;
  let blocker: Promise<unknown> | undefined;
  try {
    const principal = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    const commands = new CentralCommands(db);
    const registry = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    const claims = new CooperativeClaims(db, incarnations);
    const lifecycle = new CooperativeLifecycle(db, incarnations);
    const replacement = new SupervisorIncarnations(other);
    await commands.initialize(); await new CentralAttempts(db).initialize(); await registry.initialize(); await incarnations.initialize(); await claims.initialize(); await lifecycle.initialize();
    await registry.enroll(principal);
    let credential = await incarnations.activate(principal);
    async function claimed(key: string) {
      const { command } = await commands.submit({ idempotencyKey: key, hostId: "host", target: "session", actor: "operator", text: key });
      await claims.claim(principal, credential, `claim-${key}`);
      return command;
    }
    async function waitBlocked(app: string) {
      for (let i = 0; i < 200; i++) {
        const rows = await observer`SELECT 1 FROM pg_stat_activity WHERE application_name = ${app} AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`;
        if (rows.length) return;
        await observer`SELECT pg_sleep(0.01)`;
      }
      throw new Error(`timed out waiting for database lock: ${app}`);
    }
    async function holdEventLock() {
      let ready!: () => void;
      const locked = new Promise<void>((resolve) => { ready = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      blocker = barrier.begin(async (tx) => {
        await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
        ready();
        await gate;
      });
      await locked;
    }
    const first = await claimed("report-first");
    await holdEventLock();
    const report = lifecycle.report(principal, credential, first.id, "report", "accepted", "first");
    await waitBlocked(`${schema}_report`);
    const replace = replacement.activate(principal);
    await waitBlocked(`${schema}_replace`);
    release!(); await blocker; release = undefined;
    expect((await report).status).toBe("accepted");
    credential = await replace;
    expect(await db`SELECT status FROM central_cooperative_lifecycle_events WHERE command_id = ${first.id}`).toHaveLength(1);

    const second = await claimed("replacement-first");
    await barrier`SELECT pg_advisory_lock(733121)`;
    await db`CREATE FUNCTION pause_replacement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(733121); RETURN NEW; END $$`;
    await db`CREATE TRIGGER pause_replacement BEFORE UPDATE ON central_supervisor_incarnations_v2 FOR EACH ROW EXECUTE FUNCTION pause_replacement()`;
    const replaceFirst = replacement.activate(principal);
    await waitBlocked(`${schema}_replace`);
    const reportSecond = lifecycle.report(principal, credential, second.id, "report", "accepted", "second");
    const reportResult = reportSecond.then(() => "fulfilled", (error: Error) => error.message);
    await waitBlocked(`${schema}_report`);
    await barrier`SELECT pg_advisory_unlock(733121)`;
    await replaceFirst;
    expect(await reportResult).toMatch(/denied/);
    expect(await db`SELECT status FROM central_cooperative_lifecycle_events WHERE command_id = ${second.id}`).toHaveLength(0);
  } finally {
    if (release) release();
    if (blocker) await blocker.catch(() => {});
    await barrier`SELECT pg_advisory_unlock_all()`;
    await Promise.all([db.close(), other.close(), barrier.close(), observer.close()]);
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
  }
}, 15000);

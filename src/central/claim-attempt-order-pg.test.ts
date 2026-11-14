import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./commands.ts";
import { CentralAttempts } from "./attempts.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";
import { CooperativeClaims } from "./cooperative-claims.ts";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "./test-database-url.ts";

// PostgreSQL check that a cooperative claim and a delivery attempt for the same command
// are serialized by the command event lock: whichever takes it first wins, the other waits
// on that lock and then finds the command taken.

const url = centralTestDatabaseUrl(process.env);
const pgTest = url ? test : test.skip;
const supervisor = { role: "supervisor" as const, principalId: "live", name: "live", hostId: "host", session: "session" };

type Hold = { pid: number; reached: Promise<void>; release: () => void };

// Wraps a client so its next transaction stops right after it took the event lock.
function holdAfterEventLock(db: SQL): { db: SQL; hold: Hold } {
  let reached!: () => void, release!: () => void;
  const hold: Hold = { pid: 0, reached: new Promise<void>((resolve) => { reached = resolve; }), release: () => {} };
  const released = new Promise<void>((resolve) => { release = resolve; });
  hold.release = release;
  const wrap = (tx: SQL) => new Proxy(tx, {
    apply(target, self, args: [TemplateStringsArray, ...unknown[]]) {
      if (!args[0].join("?").includes("central_command_event_lock")) return Reflect.apply(target, self, args);
      return (async () => {
        hold.pid = (await target<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        const rows = await Reflect.apply(target, self, args);
        reached();
        await released;
        return rows;
      })();
    },
  });
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === "begin") return (fn: (tx: SQL) => Promise<unknown>) => target.begin((tx) => fn(wrap(tx as unknown as SQL)));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy as SQL, hold };
}

// A wait that should be short. Failing here, instead of at the test timeout, lets cleanup run.
async function within<T>(work: Promise<T>, what: string, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); })]); }
  finally { clearTimeout(timer); }
}

type Context = {
  admin: SQL; schema: string; commandId: string;
  claims: (db: SQL) => CooperativeClaims; attempts: (db: SQL) => CentralAttempts;
  credential: Awaited<ReturnType<SupervisorIncarnations["activate"]>>;
  open: () => SQL; started: (work: Promise<unknown>) => void;
  held: (client: SQL) => { db: SQL; hold: Hold };
};

async function scenario(run: (context: Context) => Promise<void>) {
  const connect = (options: Record<string, unknown> = {}) => withValidatedTestDatabaseUrl(process.env, url!, (current) => new SQL(current, options));
  const admin = connect();
  const schema = `claim_attempt_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const clients: SQL[] = [], holds: Hold[] = [], pending: Promise<unknown>[] = [];
  // One connection per client, so each has one backend to watch.
  const open = () => { const client = connect({ max: 1, connection: { search_path: schema } }); clients.push(client); return client; };
  await admin`CREATE SCHEMA ${admin(schema)}`;
  try {
    const db = open();
    const commands = new CentralCommands(db), registry = new SupervisorIdentityRegistry(db), incarnations = new SupervisorIncarnations(db);
    await commands.initialize(); await new CentralAttempts(db).initialize(); await registry.initialize(); await incarnations.initialize();
    await new CooperativeClaims(db, incarnations).initialize();
    await registry.enroll(supervisor);
    const credential = await incarnations.activate(supervisor);
    const { command } = await commands.submit({ idempotencyKey: "work", hostId: "host", target: "session", actor: "operator", text: "work" });
    await run({
      admin, schema, commandId: command.id, credential, open,
      claims: (client) => new CooperativeClaims(client, new SupervisorIncarnations(client)),
      attempts: (client) => new CentralAttempts(client),
      started: (work) => { pending.push(work.catch(() => {})); },
      held: (client) => { const wrapped = holdAfterEventLock(client); holds.push(wrapped.hold); return wrapped; },
    });
  } finally {
    // Let held transactions finish first, or dropping the schema would wait on their locks.
    for (const hold of holds) hold.release();
    await Promise.all(pending);
    for (const client of clients) await client.close().catch(() => {});
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
  }
}

// Polls until the waiter is blocked on a lock held by the holder.
// Gives up after about 3 s, inside the test timeout, so cleanup still runs.
async function blockedBy(admin: SQL, holderPid: number): Promise<number> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const rows = await admin<{ pid: number }[]>`SELECT pid FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND ${holderPid} = ANY(pg_blocking_pids(pid)) AND query LIKE '%central_command_event_lock%'`;
    if (rows[0]) return rows[0].pid;
    await Bun.sleep(25);
  }
  throw new Error("never waited on the event lock");
}

async function state({ admin, schema, commandId }: Context) {
  const [command] = await admin<{ status: string }[]>`SELECT status FROM ${admin(schema)}.central_commands WHERE id = ${commandId}`;
  const attempts = await admin<{ status: string }[]>`SELECT status FROM ${admin(schema)}.central_delivery_attempts WHERE command_id = ${commandId}`;
  const claims = await admin<{ request: string }[]>`SELECT request_id AS request FROM ${admin(schema)}.central_cooperative_claims WHERE command_id = ${commandId}`;
  const events = await admin<{ status: string }[]>`SELECT status FROM ${admin(schema)}.central_command_events WHERE command_id = ${commandId} ORDER BY seq`;
  return { command: command!.status, attempts: attempts.map((row) => row.status), claims: claims.map((row) => row.request), events: events.map((row) => row.status) };
}

const settled = async (work: Promise<unknown>) => {
  let done = false;
  void work.then(() => { done = true; }, () => { done = true; });
  await Bun.sleep(150);
  return done;
};

pgTest("PostgreSQL: a claim waits for a delivery attempt that holds the event lock, then claims nothing", async () => {
  await scenario(async (context) => {
    const { db, hold } = context.held(context.open());
    const begin = context.attempts(db).begin(context.commandId, "host");
    context.started(begin);
    await within(hold.reached, "attempt to take the event lock");
    const claim = context.claims(context.open()).claim(supervisor, context.credential, "claim");
    context.started(claim);
    await blockedBy(context.admin, hold.pid);
    expect(await settled(claim)).toBe(false);
    expect(await state(context)).toEqual({ command: "queued", attempts: [], claims: [], events: ["queued"] });
    hold.release();
    expect((await within(begin, "attempt")).status).toBe("started");
    expect(await within(claim, "claim")).toBeNull();
    expect(await state(context)).toEqual({ command: "delivering", attempts: ["started"], claims: [], events: ["queued", "delivering"] });
  });
}, 15_000);

pgTest("PostgreSQL: a delivery attempt waits for a claim that holds the event lock, then is refused", async () => {
  await scenario(async (context) => {
    const { db, hold } = context.held(context.open());
    const claim = context.claims(db).claim(supervisor, context.credential, "claim");
    context.started(claim);
    await within(hold.reached, "claim to take the event lock");
    const begin = context.attempts(context.open()).begin(context.commandId, "host");
    context.started(begin);
    await blockedBy(context.admin, hold.pid);
    expect(await settled(begin)).toBe(false);
    expect(await state(context)).toEqual({ command: "queued", attempts: [], claims: [], events: ["queued"] });
    hold.release();
    expect((await within(claim, "claim"))?.id).toBe(context.commandId);
    await expect(within(begin, "attempt")).rejects.toThrow("is claimed");
    expect(await state(context)).toEqual({ command: "claimed", attempts: [], claims: ["claim"], events: ["queued", "claimed"] });
  });
}, 15_000);

import { SQL } from "bun";
import { expect, test } from "bun:test";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "./test-database-url.ts";
import { SupervisorIdentityRegistry, type SupervisorIdentity } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";

const url = centralTestDatabaseUrl(process.env);
const pgTest = url ? test : test.skip;
const identity = (): SupervisorIdentity => ({ principalId: crypto.randomUUID(), name: "supervisor", hostId: crypto.randomUUID(), session: "session-a" });

async function isBlockedBy(db: SQL, pid: number, blockerPid: number): Promise<boolean> {
  const [row] = await db<{ waiting: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'
      AND ${blockerPid} = ANY(pg_blocking_pids(pid))
  ) AS waiting`;
  return row!.waiting;
}

async function waitForBlock(db: SQL, pid: number, blockerPid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (await isBlockedBy(db, pid, blockerPid)) return true;
    await Bun.sleep(10);
  }
  return false;
}

pgTest("activation replaces credentials without rebinding and retirement fences claims", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const registry = new SupervisorIdentityRegistry(db);
  const incarnations = new SupervisorIncarnations(db);
  const principal = identity();
  try {
    await registry.initialize();
    await incarnations.initialize();
    await expect(incarnations.activate(principal)).rejects.toThrow();
    await registry.enroll(principal);
    const first = await incarnations.activate(principal);
    const claim = (who = principal, credential = first) => db.begin((tx) => incarnations.lockForClaim(tx, who, credential));
    expect(await claim()).toBe(true);
    for (const wrong of [{ ...principal, principalId: crypto.randomUUID() }, { ...principal, name: "other" }, { ...principal, hostId: "other" }, { ...principal, session: "other" }]) {
      expect(await claim(wrong)).toBe(false);
      await expect(incarnations.activate(wrong)).rejects.toThrow();
    }
    expect(await claim(principal, { ...first, token: "x".repeat(43) })).toBe(false);
    const [stored] = await db<{ tokenHash: string }[]>`SELECT token_hash AS "tokenHash" FROM central_supervisor_incarnations_v2 WHERE id = ${first.incarnationId}`;
    expect(stored!.tokenHash).not.toBe(first.token);
    const second = await incarnations.activate(principal);
    expect(second.incarnationId).not.toBe(first.incarnationId);
    expect(second.token).not.toBe(first.token);
    expect(await claim()).toBe(false);
    expect(await claim(principal, second)).toBe(true);
    await registry.retire(principal);
    expect(await claim(principal, second)).toBe(false);
    await expect(incarnations.activate(principal)).rejects.toThrow();
  } finally { await db.close(); }
});

pgTest("concurrent activations serialize and exactly one credential remains valid", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const other = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const registry = new SupervisorIdentityRegistry(db);
  const first = new SupervisorIncarnations(db);
  const second = new SupervisorIncarnations(other);
  const principal = identity();
  try {
    await registry.initialize(); await first.initialize(); await registry.enroll(principal);
    const credentials = await Promise.all([first.activate(principal), second.activate(principal)]);
    const valid = await Promise.all(credentials.map((credential) => db.begin((tx) => first.lockForClaim(tx, principal, credential))));
    expect(valid.filter(Boolean)).toHaveLength(1);
    expect(credentials[0]!.incarnationId).not.toBe(credentials[1]!.incarnationId);
  } finally { await db.close(); await other.close(); }
});

pgTest("claim lock orders replacement and identity retirement after the claim transaction", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const other = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const registry = new SupervisorIdentityRegistry(db);
  const incarnations = new SupervisorIncarnations(db);
  const rivalConnection = await other.reserve();
  const rival = new SupervisorIncarnations(rivalConnection);
  const principal = identity();
  const replacementPrincipal = { ...principal, principalId: crypto.randomUUID() };
  let release = () => {};
  try {
    await registry.initialize(); await incarnations.initialize(); await registry.enroll(principal); await registry.enroll(replacementPrincipal);
    const original = await incarnations.activate(principal);
    let locked!: (pid: number) => void;
    const ready = new Promise<number>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const claim = db.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      expect(await incarnations.lockForClaim(tx, principal, original)).toBe(true);
      locked(backend!.pid); await gate;
    });
    const claimPid = await ready;
    const [backend] = await rivalConnection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const replacement = rival.activate(replacementPrincipal);
    const observed = await waitForBlock(db, backend!.pid, claimPid);
    expect(await isBlockedBy(db, claimPid, claimPid)).toBe(false);
    expect(await isBlockedBy(db, backend!.pid, backend!.pid)).toBe(false);
    release(); await claim;
    expect(observed).toBe(true);
    const current = await replacement;
    expect(await db.begin((tx) => incarnations.lockForClaim(tx, principal, original))).toBe(false);
    expect(await db.begin((tx) => incarnations.lockForClaim(tx, replacementPrincipal, current))).toBe(true);
    await registry.retire(replacementPrincipal);
    expect(await other.begin((tx) => rival.lockForClaim(tx, replacementPrincipal, current))).toBe(false);
  } finally { release(); await rivalConnection.release(); await db.close(); await other.close(); }
});

pgTest("replacement fences a different principal in the same slot and leaves other slots alone", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const registry = new SupervisorIdentityRegistry(db);
  const incarnations = new SupervisorIncarnations(db);
  const first = identity();
  const replacement = { ...first, principalId: crypto.randomUUID() };
  const separate = identity();
  try {
    await registry.initialize(); await incarnations.initialize();
    for (const principal of [first, replacement, separate]) await registry.enroll(principal);
    const old = await incarnations.activate(first);
    const isolated = await incarnations.activate(separate);
    const current = await incarnations.activate(replacement);
    const claim = (who: typeof first, credential: typeof old) => db.begin((tx) => incarnations.lockForClaim(tx, who, credential));
    expect(await claim(first, old)).toBe(false);
    expect(await claim(replacement, current)).toBe(true);
    expect(await claim(separate, isolated)).toBe(true);
  } finally { await db.close(); }
});

pgTest("concurrent first activations across principals leave only one valid credential", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const other = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const registry = new SupervisorIdentityRegistry(db);
  const first = new SupervisorIncarnations(db);
  const second = new SupervisorIncarnations(other);
  const a = identity();
  const b = { ...a, principalId: crypto.randomUUID() };
  try {
    await registry.initialize(); await first.initialize();
    await registry.enroll(a); await registry.enroll(b);
    const [one, two] = await Promise.all([first.activate(a), second.activate(b)]);
    const valid = await Promise.all([[a, one], [b, two]].map(([who, credential]) =>
      db.begin((tx) => first.lockForClaim(tx, who as typeof a, credential as typeof one))));
    expect(valid.filter(Boolean)).toHaveLength(1);
  } finally { await db.close(); await other.close(); }
});

pgTest("retirement waiting on identity cannot deadlock a claim behind replacement", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const rivalDb = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const claimDb = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const registry = new SupervisorIdentityRegistry(db);
  const incarnations = new SupervisorIncarnations(db);
  const rivalConnection = await rivalDb.reserve();
  const rival = new SupervisorIncarnations(rivalConnection);
  const claimant = new SupervisorIncarnations(claimDb);
  const current = identity();
  const retiring = { ...current, principalId: crypto.randomUUID() };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await registry.initialize(); await incarnations.initialize();
    await registry.enroll(current); await registry.enroll(retiring);
    const credential = await incarnations.activate(current);
    let ready!: (pid: number) => void;
    const locked = new Promise<number>((resolve) => { ready = resolve; });
    const retirement = db.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx`UPDATE central_supervisor_identities_v2 SET retired = TRUE WHERE principal_id = ${retiring.principalId}`;
      ready(backend!.pid); await gate;
    });
    const retirementPid = await locked;
    const [backend] = await rivalConnection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const activation = rival.activate(retiring).then(() => "activated", () => "retired");
    expect(await waitForBlock(db, backend!.pid, retirementPid)).toBe(true);
    let claimReady!: (pid: number) => void;
    const claimStarted = new Promise<number>((resolve) => { claimReady = resolve; });
    const claim = claimDb.begin(async (tx) => {
      const [claimBackend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      claimReady(claimBackend!.pid);
      return claimant.lockForClaim(tx, current, credential);
    });
    expect(await waitForBlock(db, await claimStarted, backend!.pid)).toBe(true);
    release(); await retirement;
    expect(await activation).toBe("retired");
    expect(await claim).toBe(true);
    expect(await registry.matches(retiring)).toBe(false);
  } finally { release(); await rivalConnection.release(); await db.close(); await rivalDb.close(); await claimDb.close(); }
});

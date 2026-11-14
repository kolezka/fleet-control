import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralRequests } from "./requests.ts";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "../test-database-url.ts";

test("request lists apply a bounded SQL limit after filtering and ordering", async () => {
  let query = "";
  const db = ((strings: TemplateStringsArray) => {
    query = strings.join("?");
    return Promise.resolve([]);
  }) as unknown as SQL;
  const store = new CentralRequests(db);
  await store.list({ runId: "run", status: "open" });
  expect(query).toMatch(/WHERE[\s\S]*run_id[\s\S]*status[\s\S]*ORDER BY created_at, id\s+LIMIT\s+\?/i);
});

test("gate selects a decisive approval independently of the display limit", async () => {
  let gateQuery = "";
  const db = ((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM central_request_event_lock")) return [{ id: 1 }];
    if (query.includes("FROM central_runs")) return Promise.resolve([{ id: "run", phase: "plan", revision: 1 }]);
    if (query.includes("FROM central_requests")) {
      gateQuery = query;
      return Promise.resolve([{ id: "declined", status: "resolved", response: "decline", resolvedBy: "human" }]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  db.begin = (async (fn: (tx: SQL) => Promise<unknown>) => fn(db)) as typeof db.begin;
  const result = await new CentralRequests(db).gate("run", "plan", 1);
  expect(result).toEqual({ approved: false, reason: "declined by human", requestId: "declined" });
  expect(gateQuery).toMatch(/ORDER BY CASE WHEN response = 'decline' THEN 0 WHEN status = 'open' THEN 1 ELSE 2 END, created_at, id LIMIT 1/);
});

test("request cursors reject malformed values before querying", async () => {
  let queries = 0;
  const db = (async () => { queries++; return []; }) as unknown as SQL;
  const store = new CentralRequests(db);
  const id = `req-${crypto.randomUUID()}`;
  const encode = (date: string, requestId: string) => Buffer.from(JSON.stringify([date, requestId, null, null])).toString("base64url");
  const date = "2026-01-01T00:00:00.000Z";
  const valid = encode(date, id);
  const alternateText = JSON.stringify([date, id, null, null]) + " ";
  const canonical = Buffer.from(alternateText).toString("base64url");
  const last = canonical.at(-1)!;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const noncanonical = canonical.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1];
  expect(Buffer.from(noncanonical, "base64url").equals(Buffer.from(canonical, "base64url"))).toBe(true);
  for (const cursor of [encode("not-a-date", id), encode("2026-02-30T00:00:00.000Z", id), encode(`${date}\u0000`, id), encode(date, "not-an-id"), encode(date, `${id}\u0000`), noncanonical]) {
    await expect(store.list({ cursor })).rejects.toMatchObject({ kind: "invalid" });
  }
  expect(queries).toBe(0);
  await expect(store.list({ runId: "run\u0000", cursor: Buffer.from(JSON.stringify([date, id, "run\u0000", null])).toString("base64url") })).rejects.toMatchObject({ kind: "invalid" });
  await store.list({ cursor: valid });
  await store.list({ cursor: encode("+010000-01-01T00:00:00.000Z", id) });
  expect(queries).toBe(2);
});

// These tests leave rows in the supplied disposable database.
const url = centralTestDatabaseUrl(process.env);
const integration = url ? test : test.skip;

integration("revision-scoped requests serialize answers and phase changes", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl)), other = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const a = new CentralRequests(db), b = new CentralRequests(other);
  const runId = `test-${crypto.randomUUID()}`;
  try {
    await a.initialize();
    await b.initialize();
    const registered = await Promise.all([a.registerRun({ runId, orchestrator: "orch", phase: "plan" }), b.registerRun({ runId, orchestrator: "orch", phase: "plan" })]);
    expect(registered[0]).toEqual(registered[1]);
    await expect(b.registerRun({ runId, orchestrator: "other", phase: "plan" })).rejects.toThrow(/belongs/);
    expect((await a.gate(runId, "plan", 1)).approved).toBe(false);
    await expect(a.create({ runId, origin: "other", expectedRevision: 1, kind: "approval", question: "Proceed?" })).rejects.toThrow(/not the orchestrator/);
    const request = await a.create({ runId, origin: "orch", expectedRevision: 1, kind: "approval", question: "Proceed?", evidence: ["tests"] });
    expect(request.evidence).toEqual(["tests"]);
    expect((await b.list({ runId, status: "open" })).requests.map((r) => r.id)).toEqual([request.id]);
    const results = await Promise.allSettled([
      a.resolve({ requestId: request.id, actor: "human-a", response: "approve", expectedRevision: 1 }),
      b.resolve({ requestId: request.id, actor: "human-b", response: "decline", expectedRevision: 1 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const answered = await a.get(request.id);
    expect((await a.gate(runId, "plan", 1)).approved).toBe(answered.response === "approve");
    expect(await b.resolve({ requestId: request.id, actor: answered.resolvedBy!, response: answered.response!, expectedRevision: 1 })).toEqual(answered);
    await expect(a.resolve({ requestId: request.id, actor: answered.resolvedBy!, response: answered.response!, expectedRevision: 2 })).rejects.toThrow(/stale/);
    await expect(b.acknowledge({ requestId: request.id, actor: "other" })).rejects.toThrow(/not the orchestrator/);
    expect((await b.acknowledge({ requestId: request.id, actor: "orch" })).status).toBe("acknowledged");
    const open = await a.create({ runId, origin: "orch", expectedRevision: 1, kind: "approval", question: "Again?" });
    const race = await Promise.allSettled([
      a.updatePhase({ runId, actor: "orch", expectedRevision: 1, phaseStatus: "planned", newRevision: true }),
      b.updatePhase({ runId, actor: "orch", expectedRevision: 1, phaseStatus: "planned", newRevision: true }),
    ]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await a.get(open.id)).status).toBe("stale");
    await expect(a.resolve({ requestId: open.id, actor: "human", response: "approve", expectedRevision: 1 })).rejects.toThrow(/stale/);
    await expect(a.create({ runId, origin: "orch", expectedRevision: 1, kind: "approval", question: "Old?" })).rejects.toThrow(/revision/);
    expect((await a.gate(runId, "plan", 1)).approved).toBe(false);
    expect((await a.gate(runId, "plan", 2)).approved).toBe(false);
    const racingRequest = await a.create({ runId, origin: "orch", expectedRevision: 2, kind: "approval", question: "Race?" });
    const mixed = await Promise.allSettled([
      a.resolve({ requestId: racingRequest.id, actor: "human", response: "approve", expectedRevision: 2 }),
      b.updatePhase({ runId, actor: "orch", expectedRevision: 2, phaseStatus: "planned", newRevision: true }),
    ]);
    expect(mixed[1]!.status).toBe("fulfilled");
    expect((await a.gate(runId, "plan", 2)).approved).toBe(false);
    expect((await a.gate(runId, "plan", 3)).approved).toBe(false);
    const events = (await a.events()).filter((e) => e.runId === runId);
    expect(events.filter((e) => e.kind === "resolved" && e.requestId === request.id)).toHaveLength(1);
    expect(events.filter((e) => e.kind === "stale" && e.requestId === open.id)).toHaveLength(1);
    expect((await a.events(events[0]!.seq)).some((e) => BigInt(e.seq) <= BigInt(events[0]!.seq))).toBe(false);
    await db.close();
    expect((await b.run(runId)).revision).toBe(3);
  } finally { await db.close(); await other.close(); }
});

integration("resolution retries require identical normalized intent", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl)), store = new CentralRequests(db), runId = `test-${crypto.randomUUID()}`;
  try {
    await store.initialize();
    await store.registerRun({ runId, orchestrator: "orch", phase: "plan" });
    const create = () => store.create({ runId, origin: "orch", expectedRevision: 1, kind: "approval", question: "Proceed?" });
    const request = await create();
    const input = { requestId: request.id, actor: "human", response: "approve", expectedRevision: 1, note: "  original note  " };
    const answered = await store.resolve(input);
    expect(answered.resolutionNote).toBe(input.note);
    expect(await store.resolve({ ...input, actor: " human " })).toEqual(answered);
    for (const changed of [{ note: "different" }, { note: "original note" }, { note: "" }, { actor: "other" }, { response: "decline" }, { expectedRevision: 2 }]) {
      await expect(store.resolve({ ...input, ...changed })).rejects.toMatchObject({ kind: "conflict" });
    }
    const acknowledged = await store.acknowledge({ requestId: request.id, actor: "orch" });
    expect(await store.resolve(input)).toEqual(acknowledged);
    await expect(store.resolve({ ...input, note: "different" })).rejects.toMatchObject({ kind: "conflict" });
    expect(await store.get(request.id)).toEqual(acknowledged);
    expect((await store.events()).filter((event) => event.requestId === request.id && event.kind === "resolved")).toHaveLength(1);
    const empty = await create();
    const noNote = { requestId: empty.id, actor: "human", response: "approve", expectedRevision: 1 };
    const emptyAnswer = await store.resolve(noNote);
    expect(emptyAnswer.resolutionNote).toBe("");
    expect(await store.resolve({ ...noNote, note: "" })).toEqual(emptyAnswer);
    await expect(store.resolve({ ...noNote, note: " " })).rejects.toMatchObject({ kind: "conflict" });
  } finally { await db.close(); }
});

integration("gate blocks open approvals while preserving declines and withdrawals", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl)), store = new CentralRequests(db), runId = `test-${crypto.randomUUID()}`;
  try {
    await store.initialize();
    await store.registerRun({ runId, orchestrator: "orch", phase: "plan" });
    const create = () => store.create({ runId, origin: "orch", expectedRevision: 1, kind: "approval", question: "Proceed?" });
    const approved = await create();
    await store.resolve({ requestId: approved.id, actor: "human", response: "approve", expectedRevision: 1 });
    const open = await create();
    expect(await store.gate(runId, "plan", 1)).toEqual({ approved: false, reason: "approval requested, no answer yet", requestId: open.id });
    await store.withdraw({ requestId: open.id, actor: "orch", reason: "No longer needed" });
    expect((await store.gate(runId, "plan", 1)).approved).toBe(true);
    const declined = await create();
    await store.resolve({ requestId: declined.id, actor: "human", response: "decline", expectedRevision: 1 });
    await create();
    expect(await store.gate(runId, "plan", 1)).toEqual({ approved: false, reason: "declined by human", requestId: declined.id });
  } finally { await db.close(); }
});

integration("request pages discover every matching row without truncating gate decisions", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl)), store = new CentralRequests(db), runId = `test-${crypto.randomUUID()}`;
  try {
    await store.initialize();
    await store.registerRun({ runId, orchestrator: "orch", phase: "plan" });
    await db`INSERT INTO central_requests (id, run_id, phase, revision, kind, question, proposed_action, scope, evidence, allowed_responses, blocking, origin, status, created_at)
      SELECT 'req-' || substring(${runId} from 6 for 8) || '-0000-4000-8000-' || lpad(i::text, 12, '0'), ${runId}, 'plan', 1, 'clarification', 'Question', '', '', '[]', '["answer"]', true, 'orch', CASE WHEN i <= 1001 THEN 'open' ELSE 'withdrawn' END, '2026-01-01T00:00:00.000Z' FROM generate_series(1, 1002) AS i`;
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ runId, limit: 127, cursor });
      expect(page.requests.length).toBeLessThanOrEqual(127);
      ids.push(...page.requests.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(Array.from({ length: 1002 }, (_, i) => `req-${runId.slice(5, 13)}-0000-4000-8000-${String(i + 1).padStart(12, "0")}`));
    expect(new Set(ids).size).toBe(1002);
    const first = await store.list({ runId, status: "open", limit: 1000 });
    expect(first.requests).toHaveLength(1000);
    expect(first.nextCursor).not.toBeNull();
    const last = await store.list({ runId, status: "open", limit: 1000, cursor: first.nextCursor! });
    expect(last.requests.map((r) => r.id)).toEqual([`req-${runId.slice(5, 13)}-0000-4000-8000-000000001001`]);
    expect(last.nextCursor).toBeNull();
    expect((await store.list({ runId, status: "withdrawn" })).requests.map((r) => r.id)).toEqual([`req-${runId.slice(5, 13)}-0000-4000-8000-000000001002`]);
    await expect(store.list({ runId, status: "withdrawn", cursor: first.nextCursor! })).rejects.toThrow(/cursor/);
    await expect(store.list({ limit: 1001 })).rejects.toThrow(/limit/);
    const approval = await store.create({ runId, origin: "orch", expectedRevision: 1, kind: "approval", question: "Proceed?" });
    expect(await store.gate(runId, "plan", 1)).toEqual({ approved: false, reason: "approval requested, no answer yet", requestId: approval.id });
    await store.resolve({ requestId: approval.id, actor: "human", response: "approve", expectedRevision: 1 });
    expect((await store.gate(runId, "plan", 1)).approved).toBe(true);
    const decline = await store.create({ runId, origin: "orch", expectedRevision: 1, kind: "approval", question: "Still proceed?" });
    await store.resolve({ requestId: decline.id, actor: "human", response: "decline", expectedRevision: 1 });
    expect(await store.gate(runId, "plan", 1)).toEqual({ approved: false, reason: "declined by human", requestId: decline.id });
  } finally { await db.close(); }
});

integration("keyset pages remain stable across concurrent inserts and status changes", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl)), other = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl)), store = new CentralRequests(db), runId = `test-${crypto.randomUUID()}`;
  try {
    await store.initialize();
    await store.registerRun({ runId, orchestrator: "orch", phase: "plan" });
    await db`INSERT INTO central_requests (id, run_id, phase, revision, kind, question, proposed_action, scope, evidence, allowed_responses, blocking, origin, status, created_at)
      SELECT 'req-' || substring(${runId} from 6 for 8) || '-0000-4000-8000-' || lpad(i, 12, '0'), ${runId}, 'plan', 1, 'clarification', 'Question', '', '', '[]', '["answer"]', true, 'orch', 'open', '2026-01-01T00:00:00.000Z' FROM unnest(ARRAY['b', 'd', 'f']) AS i`;
    const first = await store.list({ runId, status: "open", limit: 2 });
    expect(first.requests.map((r) => r.id)).toEqual([`req-${runId.slice(5, 13)}-0000-4000-8000-00000000000b`, `req-${runId.slice(5, 13)}-0000-4000-8000-00000000000d`]);
    await other`INSERT INTO central_requests (id, run_id, phase, revision, kind, question, proposed_action, scope, evidence, allowed_responses, blocking, origin, status, created_at)
      SELECT 'req-' || substring(${runId} from 6 for 8) || '-0000-4000-8000-' || lpad(i, 12, '0'), ${runId}, 'plan', 1, 'clarification', 'Question', '', '', '[]', '["answer"]', true, 'orch', 'open', '2026-01-01T00:00:00.000Z' FROM unnest(ARRAY['a', 'e']) AS i`;
    await other`UPDATE central_requests SET status = 'withdrawn' WHERE id = ${`req-${runId.slice(5, 13)}-0000-4000-8000-00000000000f`}`;
    const second = await store.list({ runId, status: "open", limit: 2, cursor: first.nextCursor! });
    expect(second.requests.map((r) => r.id)).toEqual([`req-${runId.slice(5, 13)}-0000-4000-8000-00000000000e`]);
    expect(second.nextCursor).toBeNull();
    expect((await store.list({ runId, status: "open" })).requests.map((r) => r.id)).toEqual([`req-${runId.slice(5, 13)}-0000-4000-8000-00000000000a`, `req-${runId.slice(5, 13)}-0000-4000-8000-00000000000b`, `req-${runId.slice(5, 13)}-0000-4000-8000-00000000000d`, `req-${runId.slice(5, 13)}-0000-4000-8000-00000000000e`]);
  } finally { await db.close(); await other.close(); }
});

integration("failed event insertion rolls back the request transition", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl)), store = new CentralRequests(db), runId = `test-${crypto.randomUUID()}`;
  try {
    await store.initialize();
    await store.registerRun({ runId, orchestrator: "orch", phase: "plan" });
    const r = await store.create({ runId, origin: "orch", expectedRevision: 1, kind: "approval", question: "Proceed?" });
    await expect(store.withdraw({ requestId: r.id, actor: "orch", reason: "invalid\u0000event" })).rejects.toThrow();
    expect((await store.get(r.id)).status).toBe("open");
    expect((await store.events()).filter((e) => e.requestId === r.id).map((e) => e.kind)).toEqual(["opened"]);
  } finally { await db.close(); }
});


integration("request event cursors preserve exact PostgreSQL bigint values", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl)), store = new CentralRequests(db), runId = `cursor-${crypto.randomUUID()}`;
  try {
    await store.initialize();
    await db`INSERT INTO central_request_events (seq, request_id, run_id, kind, actor, detail, at) VALUES (9007199254740992, NULL, ${runId}, 'first', 'test', '', 'now'), (9007199254740993, NULL, ${runId}, 'second', 'test', '', 'now'), (9007199254740994, NULL, ${runId}, 'third', 'test', '', 'now')`;
    await db`INSERT INTO central_request_events (seq, request_id, run_id, kind, actor, detail, at) VALUES (999999999999999, NULL, ${runId}, 'earlier', 'test', '', 'now')`;
    expect((await store.events("999999999999998")).filter((event) => event.runId === runId).map((event) => event.seq)).toEqual(["999999999999999", "9007199254740992", "9007199254740993", "9007199254740994"]);
    const events = (await store.events("9007199254740991")).filter((event) => event.runId === runId);
    expect(events.map((event) => event.seq)).toEqual(["9007199254740992", "9007199254740993", "9007199254740994"]);
    expect((await store.events(events[0]!.seq)).filter((event) => event.runId === runId).map((event) => event.seq)).toEqual(["9007199254740993", "9007199254740994"]);
    for (const cursor of ["-1", "01", "1.0", " 1", "9223372036854775808", "", 1, null]) {
      await expect(store.events(cursor as string)).rejects.toMatchObject({ kind: "invalid" });
    }
    expect(await store.events("9223372036854775807")).toEqual([]);
  } finally {
    await db`DELETE FROM central_request_events WHERE run_id = ${runId}`;
    await db.close();
  }
});

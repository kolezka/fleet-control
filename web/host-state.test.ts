import { expect, test } from "bun:test";
import {
  beginPageRead, finishPageRead, parseCommandPage, parseInspection, selectCommand,
  beginAnswer, beginRead, beginSend, classifySend, composerTarget, describeSessions, emptyFleet, finishAnswer, finishRead, finishSend,
  interpretResponse, paneKey, parseCoord, parseHostList, parseSessions, selectHost, selectSession, selectedHostState, sendGate, setDraft, setHosts,
  type Fleet, type HostInfo, type Session,
} from "./host-state.ts";

const info = (id: string, base = `/api/hosts/${id}`): HostInfo => ({ id, name: id.toUpperCase(), apiBase: base, direct: false });
const sess = (name: string, running = true): Session => ({ name, host: null, role: null, registered: true, running, model: { state: "not_applicable" } });
const ok = (sessions: Session[]) => ({ ok: true as const, data: { sessions, readAt: null } });
const down = { ok: false as const, kind: "network" as const, message: "Unreachable" };
const emptyCoord = { ok: true as const, data: { runs: [], requests: [], commands: [] } };

function read(f: Fleet, id: string, kind: "sessions" | "coord", result: any, at = "2026-11-09T10:00:00Z"): Fleet {
  const b = beginRead(f, id, kind);
  return finishRead(b.fleet, id, kind, b.token!, result, at);
}
function ready(ids: string[], sessions: Record<string, Session[]> = {}): Fleet {
  let f = setHosts(emptyFleet(), ids.map((i) => info(i)));
  for (const id of ids) {
    f = read(f, id, "sessions", ok(sessions[id] ?? [sess("main")]));
    f = read(f, id, "coord", emptyCoord);
  }
  return f;
}

test("host list: gateway shape, direct shape, and refusal of unsafe apiBase", () => {
  const g = parseHostList({ hosts: [{ id: "a", name: "A", apiBase: "/api/hosts/a" }, { id: "b", apiBase: "https://evil.example/x" }, { id: "a", apiBase: "/api/hosts/a" }] });
  expect(g?.mode).toBe("gateway");
  expect(g?.hosts.map((h) => h.id)).toEqual(["a"]);
  const d = parseHostList({ self: { name: "mini", url: null }, peers: [{ name: "x", url: "http://h/" }, { name: "bad", url: "javascript:1" }] });
  expect(d?.mode).toBe("direct");
  expect(d?.hosts[0]).toMatchObject({ apiBase: "/api", direct: true, name: "mini" });
  expect(d?.peers).toEqual([{ name: "x", url: "http://h/" }]);
  expect(parseHostList({})).toBeNull();
});

test("equal session names on two hosts stay separate", () => {
  let f = ready(["a", "b"], { a: [sess("main"), sess("w1")], b: [sess("main", false)] });
  f = selectSession(f, "b", "main");
  expect(f.selectedHost).toBe("b");
  expect(f.hosts.a!.selectedSession).toBe("main"); // default, untouched by b's selection
  f = selectSession(f, "a", "w1");
  expect(f.hosts.a!.selectedSession).toBe("w1");
  expect(f.hosts.b!.selectedSession).toBe("main"); // b keeps its own selection
  expect(f.selectedHost).toBe("a");
  expect(paneKey(f.hosts.a)).not.toBe(paneKey(f.hosts.b));
  // a name that does not exist on that host is not selectable there
  expect(selectSession(f, "b", "w1").hosts.b!.selectedSession).toBe(f.hosts.b!.selectedSession);
});

test("a delayed poll result lands on its own host after a host switch and is not applied twice", () => {
  let f = ready(["a", "b"]);
  const slow = beginRead(f, "a", "sessions");
  f = slow.fleet;
  f = selectHost(f, "b");
  expect(beginRead(f, "a", "sessions").token).toBeNull(); // no overlapping read for the same host
  f = finishRead(f, "a", "sessions", slow.token!, ok([sess("late")]), "t");
  expect(f.hosts.a!.sessions.map((s) => s.name)).toEqual(["late"]);
  expect(f.hosts.b!.sessions.map((s) => s.name)).toEqual(["main"]);
  expect(f.selectedHost).toBe("b");
  // replaying the same token is dropped
  const again = finishRead(f, "a", "sessions", slow.token!, ok([sess("replay")]), "t");
  expect(again).toBe(f);
});

test("a read for a replaced or removed host is dropped", () => {
  let f = ready(["a"]);
  const stale = beginRead(f, "a", "sessions");
  f = setHosts(stale.fleet, [info("a", "/api/hosts/a2")]); // apiBase changed: new life
  const after = finishRead(f, "a", "sessions", stale.token!, ok([sess("old")]), "t");
  expect(after).toBe(f);
  expect(after.hosts.a!.sessions).toEqual([]);
  f = setHosts(f, []);
  expect(finishRead(f, "a", "sessions", stale.token!, ok([]), "t")).toBe(f);
});

test("one host failing marks only that host unknown; old data is flagged, not erased", () => {
  let f = ready(["a", "b"], { a: [sess("x"), sess("y")] });
  f = read(f, "a", "sessions", down);
  const v = describeSessions(f.hosts.a!);
  expect(v).toMatchObject({ kind: "unknown", lastKnownCount: 2 });
  expect(describeSessions(f.hosts.b!).kind).toBe("ready");
  // never read: unknown without pretending to know a count
  let g = setHosts(emptyFleet(), [info("c")]);
  g = read(g, "c", "sessions", down);
  expect(describeSessions(g.hosts.c!)).toMatchObject({ kind: "unknown", lastKnownCount: null });
  // recovery
  f = read(f, "a", "sessions", ok([sess("x")]));
  expect(describeSessions(f.hosts.a!)).toMatchObject({ kind: "ready", count: 1 });
});

test("sends are disabled while state is loading or unknown, per host", () => {
  let f = setHosts(emptyFleet(), [info("a"), info("b")]);
  expect(sendGate(f.hosts.a!, "main", "hi")).toEqual({ ok: false, reason: "loading" });
  f = read(f, "a", "sessions", ok([sess("main")]));
  f = read(f, "a", "coord", emptyCoord);
  expect(sendGate(f.hosts.a!, "main", "hi")).toEqual({ ok: true });
  expect(sendGate(f.hosts.b!, "main", "hi").ok).toBe(false);
  f = read(f, "a", "coord", { ok: false, kind: "unauthorized", message: "401" });
  expect(sendGate(f.hosts.a!, "main", "hi")).toEqual({ ok: false, reason: "unknown" });
  expect(beginSend(f, "a", "main", "hi", () => "k").intent).toBeNull();
});

test("idempotency key is reused only for the same host, target and text", () => {
  let n = 0;
  const key = () => `k${++n}`;
  let f = ready(["a", "b"]);
  const first = beginSend(f, "a", "main", "deploy", key);
  expect(first.intent!.key).toBe("k1");
  f = finishSend(first.fleet, first.intent!, "uncertain", "unknown");
  expect(f.hosts.a!.intent?.key).toBe("k1");
  expect(f.hosts.a!.sending).toBe(false);
  // same retry: same key
  const retry = beginSend(f, "a", "main", " deploy ", key);
  expect(retry.intent!.key).toBe("k1");
  f = finishSend(retry.fleet, retry.intent!, "uncertain", "unknown");
  // changed text: new key
  const edited = beginSend(f, "a", "main", "deploy now", key);
  expect(edited.intent!.key).toBe("k2");
  f = finishSend(edited.fleet, edited.intent!, "uncertain", "unknown");
  // changed target: new key
  f = read(f, "a", "sessions", ok([sess("main"), sess("w1")]));
  const retarget = beginSend(f, "a", "w1", "deploy now", key);
  expect(retarget.intent!.key).toBe("k3");
  // other host with identical target and text never inherits a key
  const other = beginSend(ready(["a", "b"]), "b", "main", "deploy", key);
  expect(other.intent!.key).toBe("k4");
  expect(other.intent!.hostId).toBe("b");
});

test("the captured intent is immutable and finishing it ignores later edits and host switches", () => {
  let f = ready(["a", "b"]);
  f = setDraft(f, "a", "run tests");
  const begun = beginSend(f, "a", "main", "run tests", () => "k");
  const intent = begun.intent!;
  expect(Object.isFrozen(intent)).toBe(true);
  f = selectHost(begun.fleet, "b");
  f = setDraft(f, "b", "b's own draft");
  f = setDraft(f, "a", "run tests, then lint"); // edited while the request was in flight
  f = finishSend(f, intent, "queued", "a: queued");
  expect(f.hosts.a!.notice).toBe("a: queued");
  expect(f.hosts.a!.draft).toBe("run tests, then lint"); // the newer draft is kept
  expect(f.hosts.a!.intent).toBeNull();
  expect(f.hosts.b!.draft).toBe("b's own draft");
  expect(f.hosts.b!.notice).toBe("");
  // unedited draft is cleared on success, kept on rejection and on uncertainty
  for (const [outcome, cleared] of [["queued", true], ["rejected", false], ["uncertain", false]] as const) {
    let g = setDraft(ready(["a"]), "a", "x");
    const b = beginSend(g, "a", "main", "x", () => "k");
    g = finishSend(b.fleet, b.intent!, outcome, "n");
    expect(g.hosts.a!.draft).toBe(cleared ? "" : "x");
  }
});

test("a send that finishes after its host was replaced does not touch the new host", () => {
  let f = setDraft(ready(["a"]), "a", "go");
  const b = beginSend(f, "a", "main", "go", () => "k");
  f = setHosts(b.fleet, [info("a", "/api/hosts/other")]);
  f = setDraft(f, "a", "fresh");
  expect(finishSend(f, b.intent!, "queued", "late")).toBe(f);
});

test("send status classification", () => {
  expect(classifySend(null)).toBe("uncertain");
  expect(classifySend(201)).toBe("queued");
  expect(classifySend(200)).toBe("queued");
  expect(classifySend(502)).toBe("uncertain");
  expect(classifySend(504)).toBe("uncertain");
  expect(classifySend(400)).toBe("rejected");
  expect(classifySend(401)).toBe("rejected");
  expect(classifySend(403)).toBe("rejected");
});

test("answers are bound to host, request and revision; one at a time; settle on their own host", () => {
  let f = ready(["a", "b"]);
  const one = beginAnswer(f, "a", "r1", 2);
  expect(one.handle).toMatchObject({ hostId: "a", requestId: "r1", revision: 2 });
  expect(beginAnswer(one.fleet, "a", "r1", 2).handle).toBeNull();
  expect(beginAnswer(one.fleet, "a", "r1", 3).handle).not.toBeNull(); // new revision is a different decision
  expect(beginAnswer(one.fleet, "b", "r1", 2).handle).not.toBeNull(); // same id on another host is independent
  f = selectHost(one.fleet, "b");
  f = finishAnswer(f, one.handle!, "a: done");
  expect(f.hosts.a!.answering).toEqual([]);
  expect(f.hosts.a!.notice).toBe("a: done");
  expect(f.hosts.b!.notice).toBe("");
});

test("response interpretation: 401 is distinct, bodies and errors", () => {
  expect(interpretResponse(401, { error: { message: "no" } })).toMatchObject({ ok: false, kind: "unauthorized" });
  expect(interpretResponse(503, { error: { message: "queue off" } })).toMatchObject({ ok: false, kind: "http", message: "queue off" });
  expect(interpretResponse(502, null)).toMatchObject({ ok: false, message: "HTTP 502" });
  expect(interpretResponse(200, null)).toMatchObject({ ok: false, kind: "invalid" });
  expect(interpretResponse(200, { sessions: [] })).toMatchObject({ ok: true });
  expect(parseSessions({ nope: 1 }).ok).toBe(false);
  const bad = parseCoord(interpretResponse(200, { runs: [], requests: [] }), interpretResponse(503, null));
  expect(bad.ok).toBe(false); // half a picture is unknown
});

test("composer target follows the selected host's own orchestrator and selection", () => {
  let f = ready(["a", "b"], { a: [sess("main"), sess("orch")], b: [sess("main")] });
  f = read(f, "a", "coord", { ok: true, data: { runs: [{ id: "run1", orchestrator: "orch", phase: "p", revision: 1, phaseStatus: "s", updatedAt: "" }], requests: [], commands: [] } });
  expect(composerTarget(f.hosts.a!)).toBe("orch");
  expect(composerTarget(f.hosts.b!)).toBe("main");
  expect(selectedHostState(selectHost(f, "b"))?.info.id).toBe("b");
});

test("host list refresh keeps state for unchanged hosts and drops removed ones", () => {
  let f = setDraft(ready(["a", "b"]), "a", "keep me");
  f = selectHost(f, "b");
  const g = setHosts(f, [info("a"), info("c")]);
  expect(g.hosts.a!.draft).toBe("keep me");
  expect(g.hosts.b).toBeUndefined();
  expect(g.selectedHost).toBe("a"); // selected host vanished: fall back to the first
  expect(g.hosts.c!.sessionsRead.status).toBe("loading");
});

const mapped = (id = "a", session = "supervisor"): HostInfo => ({ ...info(id), supervisor: { hostId: "central-" + id, session } });
const command = (id = "cmd-1") => ({ id, hostId: "central-a", target: "supervisor", actor: "operator", text: "task", status: "claimed", response: null, createdAt: "t", updatedAt: "t" });
const inspection = (id = "cmd-1", seq = "1", nextCursor: string | null = null) => ({ command: command(id), claim: { incarnationId: "inc", incarnationActive: false, settled: true, requestId: "claim", createdAt: "t" }, events: [{ seq, requestId: "report", status: "completed", detail: "done", at: "t" }], nextCursor });
function commandRead(f: Fleet, ids = ["cmd-1", "cmd-2"], nextCursor: string | null = "next"): Fleet {
  const b = beginPageRead(f, "a", "commands");
  return finishPageRead(b.fleet, b.handle!, parseCommandPage({ commands: ids.map(id => command(id)), nextCursor }, mapped()), "t");
}
test("explicit mapping targets cooperative supervisor despite unavailable legacy sessions and approvals", () => {
  let f = setHosts(emptyFleet(), [mapped()]);
  f = read(f, "a", "sessions", down);
  f = read(f, "a", "coord", down);
  expect(composerTarget(f.hosts.a!)).toBe("supervisor");
  expect(sendGate(f.hosts.a!, "supervisor", "hi")).toEqual({ ok: true });
  expect(sendGate(f.hosts.a!, "main", "hi")).toEqual({ ok: false, reason: "no-target" });
  expect(beginAnswer(f, "a", "req", 1).handle).toBeNull();
  f = read(f, "a", "sessions", ok([sess("legacy")]));
  expect(composerTarget(selectSession(f, "a", "legacy").hosts.a!)).toBe("supervisor");
});
test("mapped unknown send keeps key; mapping changes reset intents and reject late reads and writes", () => {
  let f = setHosts(emptyFleet(), [mapped()]);
  const b = beginSend(f, "a", "supervisor", "hi", () => "key");
  f = finishSend(b.fleet, b.intent!, "uncertain", "unknown");
  expect(beginSend(f, "a", "supervisor", "hi", () => "wrong").intent?.key).toBe("key");
  const read = beginPageRead(f, "a", "commands");
  f = setHosts(read.fleet, [mapped("a", "replacement")]);
  expect(f.hosts.a!.intent).toBeNull();
  expect(f.hosts.a!.commands).toEqual([]);
  expect(f.hosts.a!.gen).not.toBe(b.intent!.gen);
  expect(finishSend(f, b.intent!, "queued", "old")).toBe(f);
  expect(finishPageRead(f, read.handle!, parseCommandPage({ commands: [command()], nextCursor: null }, mapped()), "t")).toBe(f);
  const same = setHosts(f, [mapped("a", "replacement")]);
  expect(same.hosts.a!.gen).toBe(f.hosts.a!.gen);
  expect(setHosts(same, [info("a")]).hosts.a!.gen).not.toBe(f.hosts.a!.gen);
});
test("mapped discovery fails closed on malformed explicit mapping", () => {
  expect(parseHostList({ hosts: [mapped()] })?.hosts[0]?.supervisor).toEqual(mapped().supervisor);
  for (const supervisor of [null, {}, { hostId: "a", session: "" }, { hostId: 2, session: "main" }]) expect(parseHostList({ hosts: [{ ...info("a"), supervisor }] })).toBeNull();
});
test("cooperative pages reject malformed or out-of-scope commands and events", () => {
  for (const body of [null, {}, { commands: [null], nextCursor: null }, { commands: [command()] }, { commands: Array(5).fill(command()), nextCursor: null }, { commands: [{ ...command(), hostId: "other" }], nextCursor: null }, { commands: [{ ...command(), text: {} }], nextCursor: null }]) expect(parseCommandPage(body, mapped()).ok).toBe(false);
  expect(parseCommandPage({ commands: [command("z"), command("a")], nextCursor: null }, mapped()).ok).toBe(false);
  expect(parseCommandPage({ commands: [command()], nextCursor: "same" }, mapped(), "same").ok).toBe(false);
  const good = inspection();
  expect(parseInspection(good, mapped(), "cmd-1", null).ok).toBe(true);
  for (const bad of [{ ...good, claim: {} }, { ...good, command: command("other") }, { ...good, nextCursor: "7" }, { ...good, events: [...good.events, ...good.events] }, { ...good, events: [{ ...good.events[0], detail: null }] }]) expect(parseInspection(bad, mapped(), "cmd-1", null).ok).toBe(false);
  expect(parseInspection(good, mapped(), "cmd-1", "1").ok).toBe(false);
});
test("command pagination is explicit, host scoped, single flight and replay resistant", () => {
  let f = commandRead(setHosts(emptyFleet(), [mapped(), mapped("b")]));
  const b = beginPageRead(f, "a", "commands", true);
  expect(b.handle?.cursor).toBe("next");
  expect(beginPageRead(b.fleet, "a", "commands", true).handle).toBeNull();
  f = selectHost(b.fleet, "b");
  f = finishPageRead(f, b.handle!, parseCommandPage({ commands: [command("cmd-3")], nextCursor: null }, mapped()), "t");
  expect(f.hosts.a!.commands.map(c => c.id)).toEqual(["cmd-1", "cmd-2", "cmd-3"]);
  expect(f.hosts.b!.commands).toEqual([]);
  expect(f.selectedHost).toBe("b");
  expect(finishPageRead(f, b.handle!, down, "t")).toBe(f);
  expect(beginPageRead(f, "a", "commands", true).handle).toBeNull();
});
test("inspection selection and cursor scope reject stale completions and failed reads erase current inspection", () => {
  let f = commandRead(setHosts(emptyFleet(), [mapped()]));
  f = selectCommand(f, "a", "cmd-1");
  const old = beginPageRead(f, "a", "inspection");
  f = selectCommand(old.fleet, "a", "cmd-2");
  expect(finishPageRead(f, old.handle!, parseInspection(inspection(), mapped(), "cmd-1", null), "t")).toBe(f);
  f = selectCommand(f, "a", "cmd-1");
  const b = beginPageRead(f, "a", "inspection");
  f = finishPageRead(b.fleet, b.handle!, parseInspection(inspection("cmd-1", "1", "1"), mapped(), "cmd-1", null), "t");
  expect(f.hosts.a!.inspection?.command.status).toBe("claimed");
  expect(f.hosts.a!.inspection?.events[0]?.status).toBe("completed");
  expect(f.hosts.a!.inspection?.claim).toMatchObject({ incarnationActive: false, settled: true });
  const more = beginPageRead(f, "a", "inspection", true);
  expect(more.handle?.cursor).toBe("1");
  f = finishPageRead(more.fleet, more.handle!, parseInspection(inspection("cmd-1", "2"), mapped(), "cmd-1", "1"), "t");
  expect(f.hosts.a!.inspection?.events.map(e => e.seq)).toEqual(["1", "2"]);
  const fail = beginPageRead(f, "a", "inspection");
  f = finishPageRead(fail.fleet, fail.handle!, down, "t");
  expect(f.hosts.a!.inspectionRead.status).toBe("unknown");
  expect(f.hosts.a!.inspection).toBeNull();
});

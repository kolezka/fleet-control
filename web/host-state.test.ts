import { expect, test } from "bun:test";
import {
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

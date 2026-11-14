import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FleetCli, FleetError, type FleetReader } from "./fleet/cli.ts";
import { createTestFleet, defaultFleetBin, type TestFleet } from "./fleet/fixture.ts";
import { createApp, serve } from "./server.ts";
import { Store } from "./data/store.ts";

const read = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
function stubFleet(over: Partial<FleetReader> = {}): FleetReader {
  return {
    screen: async () => "hello\n",
    status: async () => ({ raw: "", sessions: [
      { name: "watch", running: true, contextPct: null },
      { name: "agent", running: true, contextPct: 12 },
      { name: "stray", running: false, contextPct: null },
    ] }),
    ...over,
  };
}

function seeded() {
  const store = new Store();
  store.upsertSession({ name: "watch", host: "local", role: "watchdog", kind: "script", configuredModel: null });
  store.upsertSession({ name: "agent", host: "local", role: "worker", kind: "agent", configuredModel: "opus" });
  return store;
}

describe("service with a stub fleet", () => {
  test("sessions carry explicit model states", async () => {
    const body = await read(await createApp({ fleet: stubFleet(), store: seeded() }).sessions());
    const byName = Object.fromEntries(body.sessions.map((s: any) => [s.name, s]));
    expect(byName.watch.model).toEqual({ state: "not_applicable" });
    expect(byName.agent.model).toEqual({ state: "configured", model: "opus", note: "configured, not observed" });
    expect(byName.stray).toMatchObject({ registered: false, running: false, model: { state: "unknown" } });
  });

  test("a recorded observation is not shown as current without a runtime instance", async () => {
    const store = seeded();
    store.recordObservation("agent", { model: "m", source: "s", observedAt: new Date().toISOString(), runtimeInstance: "i1" });
    const body = await read(await createApp({ fleet: stubFleet(), store }).sessions());
    expect(body.sessions.find((s: any) => s.name === "agent").model.state).toBe("unknown");
  });

  test("a live observation is shown as observed and kept as history", async () => {
    const store = seeded();
    const observation = { model: "m1", source: "claude-code transcript", observedAt: "2026-11-09T10:00:00Z", runtimeInstance: "claude:1:s" };
    const observer = { observe: async () => ({ kind: "observed" as const, runtimeInstance: "claude:1:s", observation }) };
    const app = createApp({ fleet: stubFleet(), store, observer });
    let body = await read(app.sessions());
    expect(body.sessions.find((s: any) => s.name === "agent").model)
      .toEqual({ state: "observed", model: "m1", source: "claude-code transcript", observedAt: "2026-11-09T10:00:00Z" });
    expect(body.sessions.find((s: any) => s.name === "watch").model).toEqual({ state: "not_applicable" });
    await app.sessions(); // polling again must not duplicate history
    expect(store.db.query("SELECT count(*) AS n FROM model_observations").get()).toEqual({ n: 1 });

    // the agent is replaced: the old model stays history, never current
    const replaced = createApp({ fleet: stubFleet(), store, observer: { observe: async () => ({ kind: "no_turn_yet" as const, runtimeInstance: "claude:2:t" }) } });
    body = await read(replaced.sessions());
    expect(body.sessions.find((s: any) => s.name === "agent").model)
      .toEqual({ state: "unknown", lastObserved: observation, reason: "agent running, no main-thread turn yet" });

    // the agent process is gone
    const gone = createApp({ fleet: stubFleet(), store, observer: { observe: async () => ({ kind: "no_agent_process" as const }) } });
    expect((await read(gone.sessions())).sessions.find((s: any) => s.name === "agent").model)
      .toMatchObject({ state: "unknown", reason: "no claude process in this session" });
  });

  test("an observer failure is unknown, not an error and not observed", async () => {
    const app = createApp({ fleet: stubFleet(), store: seeded(), observer: { observe: async () => { throw new Error("boom"); } } });
    const res = await app.sessions();
    expect(res.status).toBe(200);
    expect((await read(res)).sessions.find((s: any) => s.name === "agent").model)
      .toEqual({ state: "configured", model: "opus", note: "configured, not observed" });
  });

  test("fleet failures map to explicit errors, never an empty list", async () => {
    for (const [kind, code] of [["config", 503], ["malformed_output", 502], ["cli_failed", 502]] as const) {
      const fleet = stubFleet({ status: async () => { throw new FleetError(kind, "x"); } });
      const res = await createApp({ fleet, store: seeded() }).sessions();
      expect(res.status).toBe(code);
      expect((await read(res)).error.kind).toBe(kind);
    }
  });

  test("a missing session screen is 404", async () => {
    const fleet = stubFleet({ screen: async () => { throw new FleetError("session_missing", "gone"); } });
    expect((await createApp({ fleet, store: seeded() }).screen("x", 40)).status).toBe(404);
  });
});

const haveFleet = await Bun.file(defaultFleetBin).exists();

describe.skipIf(!haveFleet)("HTTP on 127.0.0.1 over the real fleet CLI and a test session", () => {
  let fleet: TestFleet;
  let server: ReturnType<typeof serve>;
  beforeAll(async () => {
    fleet = await createTestFleet();
    const store = new Store();
    store.upsertSession({ name: fleet.session, host: "local", role: "probe", kind: "script", configuredModel: null });
    server = serve({ fleet: new FleetCli({ fleetBin: defaultFleetBin, confPath: fleet.confPath }), store }, 0);
  });
  afterAll(async () => { server?.stop(true); await fleet?.cleanup(); });

  test("binds only to loopback", () => {
    expect(server.hostname).toBe("127.0.0.1");
  });

  test("GET /api/sessions lists the probe session with no model", async () => {
    const body = await read(await fetch(new URL("/api/sessions", server.url)));
    expect(body.sessions).toEqual([{ name: fleet.session, host: "local", role: "probe", registered: true,
      running: true, contextPct: null, model: { state: "not_applicable" } }]);
  });

  test("GET screen returns the known tokens", async () => {
    const body = await read(await fetch(new URL(`/api/sessions/${fleet.session}/screen?lines=20`, server.url)));
    for (const t of fleet.tokens) expect(body.text).toContain(t);
  });

  test("GET screen for a missing session is 404 and an invalid line count is 400", async () => {
    expect((await fetch(new URL("/api/sessions/nope/screen", server.url))).status).toBe(404);
    expect((await fetch(new URL(`/api/sessions/${fleet.session}/screen?lines=abc`, server.url))).status).toBe(400);
  });

  test("session survives the HTTP reads", async () => {
    expect((await fleet.tmux("has-session", "-t", fleet.session)).exitCode).toBe(0);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FleetCli, parseStatus } from "./cli.ts";
import { FleetError } from "../domain/fleet.ts";
import { createTestFleet, defaultFleetBin, type TestFleet } from "./fixture.ts";

const haveFleet = await Bun.file(defaultFleetBin).exists();
if (!haveFleet) console.warn(`SKIP live fleet tests: agent-fleet CLI not found at ${defaultFleetBin} (set FLEET_BIN)`);

describe.skipIf(!haveFleet)("FleetCli against the selected agent-fleet and a private tmux socket", () => {
  let fleet: TestFleet;
  let cli: FleetCli;
  beforeAll(async () => {
    fleet = await createTestFleet();
    cli = new FleetCli({ fleetBin: defaultFleetBin, confPath: fleet.confPath });
  });
  afterAll(async () => fleet?.cleanup());

  test("screen returns the known tokens from the test session", async () => {
    const out = await cli.screen(fleet.session);
    for (const token of fleet.tokens) expect(out).toContain(token);
  });

  test("status lists the session as running with unknown context", async () => {
    const status = await cli.status();
    expect(status.sessions).toEqual([{ name: fleet.session, running: true, contextPct: null }]);
  });

  test("a missing session is an explicit error, not empty output", async () => {
    const err = await cli.screen("no-such-session").catch((e) => e);
    expect(err).toBeInstanceOf(FleetError);
    expect(err.kind).toBe("session_missing");
  });

  test("a missing fleet.conf is a config error", async () => {
    const bad = new FleetCli({ fleetBin: defaultFleetBin, confPath: join(fleet.dir, "absent.conf") });
    const err = await bad.status().catch((e) => e);
    expect(err).toBeInstanceOf(FleetError);
    expect(err.kind).toBe("config");
  });

  test("a fleet.conf without FLEET is a config error", async () => {
    const path = join(fleet.dir, "broken.conf");
    await Bun.write(path, "REMOTE_SSH=\n");
    const err = await new FleetCli({ fleetBin: defaultFleetBin, confPath: path }).status().catch((e) => e);
    expect(err.kind).toBe("config");
  });

  test("unsafe session names never reach the CLI", async () => {
    const err = await cli.screen("x; rm -rf /").catch((e) => e);
    expect(err.kind).toBe("invalid_name");
  });

  test("the session is still alive after all reads", async () => {
    expect((await fleet.tmux("has-session", "-t", fleet.session)).exitCode).toBe(0);
  });
});

describe("parseStatus", () => {
  test("a stopped session is reported as not running", () => {
    const s = parseStatus("no fleet tmux sessions\n--- last state per agent (watchdog.log)\na: no log lines\n--- context\na ctx=?%\n");
    expect(s.sessions).toEqual([{ name: "a", running: false, contextPct: null }]);
  });
  test("context percent is parsed", () => {
    const s = parseStatus("a: 1 windows (created x)\n--- last state per agent (watchdog.log)\n--- context\na ctx=42%\n");
    expect(s.sessions[0]).toEqual({ name: "a", running: true, contextPct: 42 });
  });
  test("unknown output is malformed, not an empty fleet", () => {
    expect(() => parseStatus("")).toThrow(FleetError);
    expect(() => parseStatus("garbage\n--- last state per agent (watchdog.log)\n--- context\n")).toThrow(/unexpected tmux line/);
  });
});

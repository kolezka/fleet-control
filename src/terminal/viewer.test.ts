import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FleetError } from "../fleet/cli.ts";
import { createTestFleet, defaultFleetBin, type TestFleet } from "../fleet/fixture.ts";
import { clampSize, openViewer, supportsReadOnlyAttach } from "./viewer.ts";

// Until agent-fleet ships `attach --read-only`, point READONLY_FLEET_BIN at a checkout that has it.
const roBin =
  process.env.READONLY_FLEET_BIN ??
  join(process.env.HOME ?? "", "Development/agent-fleet.worktrees/attach-read-only/scripts/fleet");
const haveRo = (await Bun.file(roBin).exists()) && (await supportsReadOnlyAttach(roBin));
if (!haveRo) console.warn(`SKIP viewer tests: no fleet CLI with attach --read-only at ${roBin}`);

const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) if (await cond()) return true;
  return false;
};

describe.skipIf(!haveRo)("read-only viewer over fleet attach --read-only", () => {
  let fleet: TestFleet;
  beforeAll(async () => { fleet = await createTestFleet(roBin); });
  afterAll(async () => fleet?.cleanup());

  test("streams the session screen, is a read-only client, keeps the window size, and detach leaves the session", async () => {
    let out = "";
    const decoder = new TextDecoder();
    const viewer = await openViewer({
      fleetBin: roBin, confPath: fleet.confPath, session: fleet.session, cols: 40, rows: 10,
      onData: (d) => { out += decoder.decode(d, { stream: true }); }, onExit: () => {},
    });
    expect(await until(() => fleet.tokens.every((t) => out.includes(t)))).toBe(true);

    const clients = await fleet.tmux("list-clients", "-F", "#{client_readonly} #{client_flags}");
    expect(clients.stdout).toMatch(/^1 .*ignore-size/m);

    const size = await fleet.tmux("display-message", "-p", "-t", fleet.session, "#{window_width}x#{window_height}");
    expect(size.stdout.trim()).toBe("120x30");

    viewer.close();
    await viewer.exited;
    expect(await until(async () => (await fleet.tmux("list-clients")).stdout.trim() === "")).toBe(true);
    expect((await fleet.tmux("has-session", "-t", fleet.session)).exitCode).toBe(0);
  });

  test("a missing session ends the viewer with a non-zero exit", async () => {
    const viewer = await openViewer({
      fleetBin: roBin, confPath: fleet.confPath, session: "no-such", cols: 80, rows: 24, onData: () => {}, onExit: () => {},
    });
    expect(await viewer.exited).not.toBe(0);
  });
});

test("a CLI without attach --read-only is refused instead of attaching writable", async () => {
  if (!(await Bun.file(defaultFleetBin).exists()) || (await supportsReadOnlyAttach(defaultFleetBin))) return;
  const err = await openViewer({
    fleetBin: defaultFleetBin, confPath: "/nonexistent", session: "x", cols: 80, rows: 24, onData() {}, onExit() {},
  }).catch((e) => e);
  expect(err).toBeInstanceOf(FleetError);
  expect(err.message).toContain("refusing a writable attach");
});

test("clampSize rejects nonsense sizes", () => {
  expect(clampSize(80, 24)).toEqual({ cols: 80, rows: 24 });
  expect(clampSize(80.5, 24)).toBeNull();
  expect(clampSize(5, 24)).toBeNull();
  expect(clampSize("80", 24)).toBeNull();
});

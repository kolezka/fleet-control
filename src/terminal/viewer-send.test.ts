import { resolveFleetBin } from "../fleet/path.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Commands } from "../commands.ts";
import { Deliverer, fleetSender } from "../delivery.ts";
import { createTestFleet, type TestFleet } from "../fleet/fixture.ts";
import { openViewer, supportsReadOnlyAttach } from "./viewer.ts";

// Regression for docs/bugs/agent-fleet-send-keys-read-only-viewer.md: an open page (read-only
// viewer) must not stop fleet send from pressing Enter. Needs an agent-fleet with the fix.
const fleetBin = resolveFleetBin();
const usable = (await Bun.file(fleetBin).exists()) && (await supportsReadOnlyAttach(fleetBin));
const fixed = usable && /^keys\(\)/m.test(await Bun.file(join(fleetBin, "..", "watchdog.sh")).text());
if (usable && !fixed) console.warn(`SKIP viewer+send test: ${fleetBin} predates the agent-fleet send-keys fix`);

const until = async (cond: () => Promise<boolean>, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await cond()) return true;
  return false;
};

describe.skipIf(!fixed)("fleet send while the page has a read-only viewer open", () => {
  let fleet: TestFleet;
  beforeAll(async () => {
    fleet = await createTestFleet(fleetBin);
    // A reader that only prints GOT-ENTER once Enter ends the line.
    await fleet.tmux("new-session", "-d", "-s", "reader", "-x", "120", "-y", "30",
      "stty -echo; while IFS= read -r l; do printf 'GOT-ENTER %s\\n' \"$l\"; done");
  });
  afterAll(async () => fleet?.cleanup());

  test("the command is delivered and Enter reaches the session", async () => {
    const viewer = await openViewer({
      fleetBin, confPath: fleet.confPath, session: "reader", cols: 120, rows: 31, onData() {}, onExit() {},
    });
    try {
      expect(await until(async () => /read-only/.test((await fleet.tmux("list-clients", "-F", "#{client_flags}")).stdout))).toBe(true);
      // control: with the viewer on, plain send-keys is refused by tmux
      expect((await fleet.tmux("send-keys", "-t", "=reader:", "x")).exitCode).not.toBe(0);

      const commands = new Commands(new Database(":memory:"));
      const id = commands.submit({ idempotencyKey: "viewer-send-1", target: "reader", actor: "test", text: "hello" }).command.id;
      const after = await new Deliverer(commands, fleetSender(fleetBin, fleet.confPath)).deliver(id);
      expect(after.status).toBe("delivered");
      const pane = async () => (await fleet.tmux("capture-pane", "-p", "-J", "-t", "reader")).stdout;
      expect(await until(async () => (await pane()).includes(`GOT-ENTER Fleet Control command ${id}`))).toBe(true);
    } finally {
      viewer.close();
      await viewer.exited;
    }
  });
});

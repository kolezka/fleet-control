import { expect, test } from "bun:test";
import { leaseDead, type Lease } from "./leases.ts";

const lease = (instance: string): Lease => ({ id: "l", session: "s", instance, holder: "op", socketId: "k", grantedAt: "2026-11-20T00:00:00Z", expiresAt: "2026-11-20T01:00:00Z", endedAt: null, endReason: null });
const at = new Date("2026-11-20T00:30:00Z");

test("an agent that exits ends the lease; a shell pane stays leased while the holder runs commands in it", () => {
  // Review 3 F1: the agent leaves, the pane shell reads the keys.
  expect(leaseDead(lease("$1:5:9:app"), at, "$1:5:9:shell")).toBe("the agent exited; the pane is at a shell prompt");
  // The holder types a command into a shell pane, and it ends again: same instance throughout.
  expect(leaseDead(lease("$1:5:9:shell"), at, "$1:5:9:app")).toBeNull();
  expect(leaseDead(lease("$1:5:9:shell"), at, "$1:5:9:shell")).toBeNull();
  expect(leaseDead(lease("$1:5:9:app"), at, "$1:5:9:app")).toBeNull();
  // A new window is a restart whatever runs in it.
  expect(leaseDead(lease("$1:5:9:app"), at, "$1:5:10:app")).toBe("session restarted");
  expect(leaseDead(lease("$1:5:9:app"), at, null)).toBe("session ended");
  // A lease stored before the last part was added compares on the rest.
  expect(leaseDead(lease("$1:5:9"), at, "$1:5:9:shell")).toBeNull();
  expect(leaseDead(lease("$1:5:9"), at, "$1:5:10:app")).toBe("session restarted");
});

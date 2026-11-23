import { expect, test } from "bun:test";
import { emptyAdmin, fillStart, startCommandGate } from "./fleet-admin.ts";

test("a running session whose command tmux shows with unreadable escapes fills in its folder but no command", () => {
  const v = emptyAdmin();
  v.sessions = [
    { session: "odd", inConf: false, running: true, saved: null, pane: { command: null, cwd: "/w" } },
    { session: "conf", inConf: true, running: true, saved: null, pane: { command: "exec cat", cwd: "/f" } },
  ];
  v.restartSession = "odd";
  v.startCommand = "left over";
  fillStart(v);
  expect([v.startCommand, v.startCwd]).toEqual(["", ""]);
  // A fleet.conf session never gets a saved start from the page.
  v.restartSession = "conf";
  v.startConfirm = "conf";
  expect(startCommandGate(v)).toEqual({ ok: false, reason: "conf starts from fleet.conf" });
});

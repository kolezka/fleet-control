import { expect, test } from "bun:test";
import { leaseButton, leaseStatus, mayType, noLease, onControlFrame, onLeaseAnswer, onLeaseClick } from "./lease.ts";

const frame = (o: object) => JSON.stringify(o);
const withSocket = onControlFrame(noLease, frame({ type: "socket", id: "sock-1", session: "probe" }));

test("no button and no keys until the host names this socket; two clicks are needed to ask", () => {
  expect(leaseButton(noLease, "probe").hidden).toBe(true);
  expect(onLeaseClick(noLease).request).toBeNull();
  expect(leaseButton(withSocket, "probe")).toEqual({ hidden: false, label: "Type…", disabled: false, danger: false });

  const first = onLeaseClick(withSocket);
  expect(first.request).toBeNull();
  expect(leaseButton(first.view, "probe")).toEqual({ hidden: false, label: "Confirm: type into probe for 5 min", disabled: false, danger: true });
  expect(leaseStatus(first.view, new Date())).toContain("Only one person can type at a time");
  expect(mayType(first.view)).toBe(false);

  const second = onLeaseClick(first.view);
  expect(second.request).toEqual({ method: "POST", body: { socket: "sock-1", minutes: 5 } });
  expect(mayType(second.view)).toBe(false);
});

test("keys flow only after the host grants; a refusal, an end or a reconnect stops them", () => {
  const asking = onLeaseClick(onLeaseClick(withSocket).view).view;
  const refused = onLeaseAnswer(asking, "POST", 409, { error: { message: "probe is held by dsh-panel until 10:05" } });
  expect(mayType(refused)).toBe(false);
  expect(leaseStatus(refused, new Date())).toBe("Not typing: probe is held by dsh-panel until 10:05");

  const held = onControlFrame(asking, frame({ type: "lease", state: "granted", session: "probe", expiresAt: "2026-11-20T10:05:00.000Z" }));
  expect(mayType(held)).toBe(true);
  expect(leaseStatus(held, new Date("2026-11-20T10:02:30Z"))).toBe("Typing · your keys go to the session · 3 min left");
  // The POST answer arriving after the frame changes nothing.
  expect(onLeaseAnswer(held, "POST", 201, { lease: { expiresAt: "2026-11-20T10:05:00.000Z" } })).toEqual(held);

  const ended = onControlFrame(held, frame({ type: "lease", state: "ended", reason: "revoked by dsh-panel: taking over" }));
  expect(mayType(ended)).toBe(false);
  expect(leaseStatus(ended, new Date())).toBe("Typing ended: revoked by dsh-panel: taking over");

  // A new socket id means a new connection: back to read-only.
  expect(mayType(onControlFrame(held, frame({ type: "socket", id: "sock-2" })))).toBe(false);
  // Garbage and grants for an unnamed socket are ignored.
  expect(onControlFrame(held, "not json")).toEqual(held);
  expect(mayType(onControlFrame(noLease, frame({ type: "lease", state: "granted", expiresAt: "2026-11-20T10:05:00.000Z" })))).toBe(false);
  expect(onControlFrame(withSocket, frame({ type: "socket", id: "x\u0007" }))).toEqual(withSocket);
});

test("stopping asks the host and keeps typing if the host says no", () => {
  const held = onControlFrame(withSocket, frame({ type: "lease", state: "granted", expiresAt: "2026-11-20T10:05:00.000Z" }));
  const step = onLeaseClick(held);
  expect(step.request).toEqual({ method: "DELETE" });
  expect(mayType(step.view)).toBe(false);
  expect(mayType(onLeaseAnswer(step.view, "DELETE", 500, null))).toBe(true);
  expect(onLeaseAnswer(step.view, "DELETE", 200, { ended: true }).state).toBe("off");
});

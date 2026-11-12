import { expect, test } from "bun:test";
import { HostAgentClient, type HostSocket } from "./client.ts";

class FakeSocket implements HostSocket {
  listeners = new Map<string, (event: any) => void>();
  onClose: () => void = () => {};
  closes: [number | undefined, string | undefined][] = [];
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, listener); }
  send() {}
  close(code?: number, reason?: string) { this.closes.push([code, reason]); this.onClose(); }
  invalid() { this.listeners.get("message")!({ data: "invalid" }); }
}

for (const mode of ["restart", "factory-failure", "stop", "ordinary"] as const) {
  test(`invalid close reentry: ${mode}`, () => {
    const sockets: FakeSocket[] = [], timers: { callback: () => void; delay: number }[] = [], errors: unknown[] = [];
    let calls = 0;
    const client = new HostAgentClient({
      url: "wss://example.com", hostId: "h", token: "secret",
      socketFactory: () => { calls++; if (calls === 2 && mode === "factory-failure") throw new Error("factory failed"); const socket = new FakeSocket(); sockets.push(socket); return socket; },
      execute: async (dispatch) => ({ id: dispatch.attemptId, status: "delivered" }),
      setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
      clearTimer: () => {}, onError: (error) => errors.push(error),
    });
    client.start();
    sockets[0]!.onClose = () => { if (mode !== "ordinary") { client.stop(); if (mode !== "stop") client.start(); } };
    sockets[0]!.invalid();
    expect(sockets[0]!.closes).toEqual([[1008, "invalid dispatch"]]);
    if (mode === "ordinary") expect(timers.map((timer) => timer.delay)).toEqual([1000]);
    else if (mode === "factory-failure") { expect(timers.map((timer) => timer.delay)).toEqual([1000]); expect(errors).toHaveLength(1); }
    else expect(timers).toEqual([]);
    if (mode === "restart") { expect(sockets).toHaveLength(2); sockets[1]!.listeners.get("close")!({}); expect(timers.map((timer) => timer.delay)).toEqual([1000]); }
    if (mode === "factory-failure") { timers[0]!.callback(); expect(sockets).toHaveLength(2); sockets[1]!.listeners.get("close")!({}); expect(timers.map((timer) => timer.delay)).toEqual([1000, 2000]); }
    client.stop();
  });
}

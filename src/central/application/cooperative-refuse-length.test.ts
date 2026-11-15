import { expect, test } from "bun:test";
import { cooperativeSupervisor } from "./cooperative.ts";
import type { IncarnationCredential, Principal } from "../domain/identity.ts";

// Secrets in `refuse` shorter than 16 characters are not checked, so ordinary words are never refused.
const supervisor: Principal = { name: "sup", role: "supervisor", principalId: "p-1", hostId: "host", session: "session" };
const incarnation: IncarnationCredential = { incarnationId: "inc-1", token: "incarnation-token-0001" };

const fifteen = "abcdefghijklmno";
const sixteen = "abcdefghijklmnop";

function stores() {
  const calls: unknown[][] = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return name as never; };
  return { calls, deps: { claims: { claim: record("claim") }, lifecycle: { report: record("report") } } as never };
}

test("a 15 character refuse secret is not checked in report detail or requestId", async () => {
  expect(fifteen).toHaveLength(15);
  const { calls, deps } = stores();
  const use = cooperativeSupervisor(deps, supervisor, incarnation, [fifteen]);
  expect(await use.report("c-1", `r-${fifteen}`, "completed", `ran ${fifteen} ok`)).toBe("report" as never);
  expect(await use.claim(`r-${fifteen}`)).toBe("claim" as never);
  expect(calls).toEqual([
    ["report", supervisor, incarnation, "c-1", `r-${fifteen}`, "completed", `ran ${fifteen} ok`],
    ["claim", supervisor, incarnation, `r-${fifteen}`, expect.any(Function)],
  ]);
});

test("a 16 character refuse secret is refused in report detail and requestId and no store is called", async () => {
  expect(sixteen).toHaveLength(16);
  const { calls, deps } = stores();
  const use = cooperativeSupervisor(deps, supervisor, incarnation, [sixteen]);
  await expect(use.report("c-1", "r-1", "completed", `ran ${sixteen} ok`)).rejects.toThrow("sensitive request");
  await expect(use.report("c-1", `r-${sixteen}`, "completed", "ok")).rejects.toThrow("sensitive request");
  await expect(use.claim(`r-${sixteen}`)).rejects.toThrow("sensitive request");
  expect(calls).toEqual([]);
});

test("non-string refuse entries are ignored without throwing", async () => {
  const { calls, deps } = stores();
  const odd = [12345678901234567, null, undefined, {}, ["x".repeat(20)]] as unknown as string[];
  const use = cooperativeSupervisor(deps, supervisor, incarnation, odd);
  const detail = `12345678901234567 null undefined [object Object] ${"x".repeat(20)}`;
  expect(await use.report("c-1", "r-1", "completed", detail)).toBe("report" as never);
  expect(await use.claim("r-1")).toBe("claim" as never);
  expect(calls).toHaveLength(2);
});

test("the incarnation token is always refused, even when it is short", async () => {
  for (const token of ["tok", fifteen, incarnation.token]) {
    const { calls, deps } = stores();
    const use = cooperativeSupervisor(deps, supervisor, { incarnationId: "inc-1", token });
    await expect(use.report("c-1", "r-1", "completed", `ran ${token} ok`)).rejects.toThrow("sensitive request");
    await expect(use.report("c-1", `r-${token}`, "completed", "ok")).rejects.toThrow("sensitive request");
    await expect(use.claim(`r-${token}`)).rejects.toThrow("sensitive request");
    expect(calls).toEqual([]);
  }
});
